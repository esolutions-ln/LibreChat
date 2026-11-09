"""save_chart in the analysis sandbox (docs/nmb/REPORTS.md, "Workbench charts")."""
import json
import re

import pytest

from test_analysis import ALL, U, cfg, ds, execute, real, synth  # noqa: F401  (fixtures + helpers)

CHART_CODE = """
import pandas as pd
df = pd.read_csv(DATA_PATH)
g = df.groupby('category')['amount'].sum()
save_chart({"version": 1, "title": "Spend by category", "type": "bar", "unit": "ZWL",
            "categories": list(g.index), "series": [{"name": "Spend", "values": g.values}]}, "spend")
print('done')
"""

GOOD = '{"version":1,"title":"T","type":"bar","categories":["a","b"],"series":[{"name":"S","values":[1,2]}]}'


def files_of(run):
    return {f["name"]: f for f in run["files"]}


def rejected_lines(run):
    return [ln for ln in run["stderr"].splitlines() if ln.startswith("chart_rejected:")]


def get_file(client, run, name, user=U):
    return client.get(f"/analysis/runs/{run['id']}/files/{name}", params={"user": user})


# ---- the happy path ------------------------------------------------------------------------------
def test_synthetic_run_emits_a_chart_marked_computed(client, ds):
    synth(client, ds["id"], ["amount", "category"], rows=80)
    run = execute(client, ds["id"], CHART_CODE).json()
    assert run["status"] == "ok", run
    assert files_of(run)["spend.chart.json"]["kind"] == "chart"
    f = get_file(client, run, "spend.chart.json")
    assert f.status_code == 200
    assert f.headers["content-type"].startswith("application/json")
    assert f.headers["cache-control"] == "no-store" and f.headers["x-content-type-options"] == "nosniff"
    spec = f.json()
    assert spec["origin"] == "computed" and spec["title"] == "Spend by category" and spec["type"] == "bar"
    assert spec["series"][0]["name"] == "Spend"
    assert len(spec["categories"]) == len(spec["series"][0]["values"])


def test_real_run_chart_matches_the_data_and_is_not_llm_safe(client, ds, real):
    run = execute(client, ds["id"], CHART_CODE, target="real").json()
    assert run["status"] == "ok" and run["llm_safe"] is False
    assert files_of(run)["spend.chart.json"]["kind"] == "chart"
    spec = get_file(client, run, "spend.chart.json").json()
    expected = {}
    for row in real[1]:
        expected[row["category"]] = expected.get(row["category"], 0.0) + float(row["amount"])
    got = dict(zip(spec["categories"], spec["series"][0]["values"]))
    assert set(got) == set(expected)
    assert all(abs(got[k] - expected[k]) < 1e-6 for k in expected)


@pytest.mark.parametrize("claimed", ['"model"', '"computed"'])
def test_origin_is_always_set_to_computed(client, ds, claimed):
    synth(client, ds["id"], ["amount"], rows=30)
    code = f'save_chart({{"version":1,"title":"T","type":"bar","origin":{claimed},"categories":["a"],' \
           f'"series":[{{"name":"S","values":[1]}}]}})'
    run = execute(client, ds["id"], code).json()
    assert run["status"] == "ok", run
    assert get_file(client, run, "chart.chart.json").json()["origin"] == "computed"


def test_missing_values_and_numpy_scalars_survive_normalisation(client, ds):
    synth(client, ds["id"], ["amount"], rows=30)
    code = """
import numpy as np
save_chart({"version": 1, "title": "T", "type": "line", "categories": ["a", "b", "c"],
            "series": [{"name": "S", "values": [np.int64(1), None, np.float64(2.5)]}]})
"""
    run = execute(client, ds["id"], code).json()
    assert run["status"] == "ok", run
    spec = get_file(client, run, "chart.chart.json").json()
    assert spec["series"][0]["values"] == [1, None, 2.5]
    assert "unit" not in spec and "source" not in spec  # unset optionals are not written back as nulls


def test_several_charts_up_to_the_limit(client, ds):
    synth(client, ds["id"], ["amount"], rows=30)
    code = "\n".join(f'save_chart({GOOD}, "c{i}")' for i in range(5))
    run = execute(client, ds["id"], code).json()
    assert run["status"] == "ok"
    assert sorted(files_of(run)) == [f"c{i}.chart.json" for i in range(5)]


# ---- limits and bad input ------------------------------------------------------------------------
def test_sixth_chart_is_an_error(client, ds):
    synth(client, ds["id"], ["amount"], rows=30)
    code = "\n".join(f'save_chart({GOOD}, "c{i}")' for i in range(6))
    run = execute(client, ds["id"], code).json()
    assert run["status"] == "error" and run["files"] == []
    assert "at most 5 charts" in run["stderr"]


@pytest.mark.parametrize("name", ['"../x"', '"a/b"', '""', '"x" * 41', '"a.b"', '"..\\\\x"', "5", "None", '"é"'])
def test_bad_names_are_an_error(client, ds, name):
    synth(client, ds["id"], ["amount"], rows=30)
    run = execute(client, ds["id"], f"save_chart({GOOD}, {name})").json()
    assert run["status"] == "error" and run["files"] == []
    assert "name must match" in run["stderr"]


@pytest.mark.parametrize("spec", ["[1, 2]", '"text"', "None", "5"])
def test_spec_must_be_a_dict(client, ds, spec):
    synth(client, ds["id"], ["amount"], rows=30)
    run = execute(client, ds["id"], f"save_chart({spec})").json()
    assert run["status"] == "error" and "spec must be a dict" in run["stderr"]


def test_oversize_spec_is_an_error(client, ds):
    synth(client, ds["id"], ["amount"], rows=30)
    code = 'save_chart({"version": 1, "pad": "x" * 70000})'
    run = execute(client, ds["id"], code).json()
    assert run["status"] == "error" and "larger than" in run["stderr"] and run["files"] == []


def test_non_plain_values_are_an_error(client, ds):
    synth(client, ds["id"], ["amount"], rows=30)
    run = execute(client, ds["id"], 'save_chart({"version": 1, "title": {1, 2}})').json()
    assert run["status"] == "error" and "not plain data" in run["stderr"]


# ---- rejection after the run ---------------------------------------------------------------------
CANARY = "CANARY-ZZZ-9"
BAD_SPECS = {
    "unequal": ('{"version": 1, "title": "CANARY-ZZZ-9", "type": "bar", "categories": ["CANARY-ZZZ-9", "b"],'
                ' "series": [{"name": "S", "values": [7777.123]}]}'),
    "nan": ('{"version": 1, "title": "CANARY-ZZZ-9", "type": "bar", "categories": ["a"],'
            ' "series": [{"name": "S", "values": [float("nan")]}]}'),
    "inf": ('{"version": 1, "title": "CANARY-ZZZ-9", "type": "bar", "categories": ["a"],'
            ' "series": [{"name": "S", "values": [float("inf")]}]}'),
    "pie_negative": ('{"version": 1, "title": "CANARY-ZZZ-9", "type": "pie", "categories": ["a", "b"],'
                     ' "series": [{"name": "S", "values": [7777.123, -5]}]}'),
    "bad_origin": ('{"version": 1, "title": "CANARY-ZZZ-9", "type": "bar", "origin": "CANARY-ZZZ-9",'
                   ' "categories": ["a"], "series": [{"name": "S", "values": [7777.123]}]}'),
    "control_chars": ('{"version": 1, "title": "CANARY\\x07-ZZZ-9", "type": "bar", "categories": ["a"],'
                      ' "series": [{"name": "S", "values": [7777.123]}]}'),
    "too_many_series": ('{"version": 1, "title": "CANARY-ZZZ-9", "type": "bar", "categories": ["a"], "series":'
                        ' [{"name": "S%d" % i, "values": [7777.123]} for i in range(13)]}'),
}


@pytest.mark.parametrize("target", ["synthetic", "real"])
@pytest.mark.parametrize("kind", sorted(BAD_SPECS))
def test_invalid_chart_is_dropped_and_reported_by_code_only(client, ds, kind, target):
    synth(client, ds["id"], ["amount"], rows=30)
    code = f'save_chart({BAD_SPECS[kind]}, "bad")\nprint("after")'
    run = execute(client, ds["id"], code, target=target).json()
    assert run["status"] == "ok", run  # a rejected chart does not fail the run
    assert "after" in run["stdout"]
    assert "bad.chart.json" not in files_of(run) and run["files"] == []
    lines = rejected_lines(run)
    assert len(lines) == 1
    assert re.fullmatch(r"chart_rejected:bad:(invalid_spec|invalid_json)(,[A-Za-z0-9_.]+)*", lines[0]), lines[0]
    text = json.dumps(run)
    assert CANARY not in text and "7777" not in text
    assert get_file(client, run, "bad.chart.json").status_code == 404


def test_a_good_and_a_bad_chart_in_one_run(client, ds):
    synth(client, ds["id"], ["amount"], rows=30)
    code = f'save_chart({GOOD}, "good")\nsave_chart({BAD_SPECS["unequal"]}, "bad")'
    run = execute(client, ds["id"], code).json()
    assert list(files_of(run)) == ["good.chart.json"]
    assert [ln.split(":")[1] for ln in rejected_lines(run)] == ["bad"]


AROUND = (
    'pd.Series({"version": 1, "title": "T", "type": "bar", "origin": "model", "categories": ["a", "b"],'
    ' "series": [{"name": "S", "values": [1, 2]}]}).to_json(OUTPUT_DIR + "/%s.chart.json")'
)


def test_a_chart_file_written_around_save_chart_is_still_validated(client, ds):
    """pandas can write any file name, so the parent must not trust the harness alone."""
    synth(client, ds["id"], ["amount"], rows=30)
    code = 'import pandas as pd\npd.Series([1]).to_json(OUTPUT_DIR + "/sneaky.chart.json")\n' + AROUND % "fine"
    run = execute(client, ds["id"], code).json()
    assert list(files_of(run)) == ["fine.chart.json"]
    assert get_file(client, run, "fine.chart.json").json()["origin"] == "computed"
    lines = rejected_lines(run)
    assert len(lines) == 1 and lines[0].startswith("chart_rejected:sneaky:")


def test_more_chart_files_than_allowed_are_rejected_not_kept(client, ds):
    synth(client, ds["id"], ["amount"], rows=30)
    code = "import pandas as pd\n" + "\n".join(AROUND % f"f{i}" for i in range(7))
    run = execute(client, ds["id"], code).json()
    assert run["status"] == "ok"
    assert sorted(files_of(run)) == [f"f{i}.chart.json" for i in range(5)]
    assert rejected_lines(run) == ["chart_rejected:f5:too_many", "chart_rejected:f6:too_many"]


# ---- storage, ownership, caps --------------------------------------------------------------------
def test_chart_download_is_owner_scoped(client, ds):
    synth(client, ds["id"], ["amount", "category"], rows=40)
    run = execute(client, ds["id"], CHART_CODE).json()
    assert get_file(client, run, "spend.chart.json", user="bob").status_code == 404
    assert get_file(client, run, "spend.chart.json").status_code == 200
    assert client.get(f"/analysis/runs/{run['id']}", params={"user": "bob"}).status_code == 404


def test_chart_is_encrypted_at_rest_and_deleted_with_the_run(client, ds, env):
    run = execute(client, ds["id"], CHART_CODE, target="real").json()
    assert run["status"] == "ok"
    root = env / "data" / "analysis"
    blobs = [p for p in root.rglob("*") if p.is_file()]
    assert blobs and all(b"Spend by category" not in p.read_bytes() for p in blobs)
    assert client.delete(f"/analysis/datasets/{ds['id']}", params={"user": U}).json() == {"deleted": True}
    assert get_file(client, run, "spend.chart.json").status_code == 404
    assert list((root / "runs").iterdir()) == []


def test_chart_files_count_against_the_output_file_cap(client, ds, cfg):  # noqa: F811
    cfg["max_output_files"] = 2
    synth(client, ds["id"], ["amount"], rows=30)
    code = "\n".join(f'save_chart({GOOD}, "c{i}")' for i in range(4))
    run = execute(client, ds["id"], code).json()
    assert run["status"] == "ok" and sorted(files_of(run)) == ["c0.chart.json", "c1.chart.json"]


def test_chart_files_count_against_the_output_size_cap(client, ds, cfg):  # noqa: F811
    cfg["max_output_file_bytes"] = 2000
    synth(client, ds["id"], ["amount"], rows=30)
    big = ("import pandas as pd\n"
           "cats = ['category number %02d with a fairly long label' % i for i in range(60)]\n"
           "save_chart({'version': 1, 'title': 'T', 'type': 'bar', 'categories': cats,"
           " 'series': [{'name': 'S', 'values': [1.5] * 60}]}, 'big')")
    run = execute(client, ds["id"], big).json()
    assert "big.chart.json" not in files_of(run) and run["files"] == []


def test_chart_limits_come_from_policy(client, ds, cfg):  # noqa: F811
    cfg["max_charts"] = 1
    synth(client, ds["id"], ["amount"], rows=30)
    run = execute(client, ds["id"], f'save_chart({GOOD}, "a")\nsave_chart({GOOD}, "b")').json()
    assert run["status"] == "error" and "at most 1 charts" in run["stderr"]


# ---- the AST validator and the audit hook --------------------------------------------------------
def test_save_chart_passes_the_ast_validator_but_os_is_still_rejected(cfg):  # noqa: F811
    from app.analysis import sandbox
    allowed = cfg["allowed_imports"]
    assert sandbox.validate('save_chart({"version": 1}, "x")', allowed) == []
    assert sandbox.validate("import pandas as pd\nsave_chart({}, name='x')\nsave_chart({})", allowed) == []
    assert sandbox.validate("import os\nsave_chart({})", allowed) == ["import_not_allowed@L1"]
    assert sandbox.validate("save_chart.__globals__", allowed) == ["dunder_access@L1"]
    assert sandbox.validate("open('x', 'w')", allowed) == ["forbidden_builtin@L1"]


def test_user_code_never_needs_open_or_os_to_save_a_chart(client, ds):
    synth(client, ds["id"], ["amount"], rows=30)
    run = execute(client, ds["id"], f"save_chart({GOOD})").json()
    assert run["status"] == "ok" and run["violations"] == []


@pytest.mark.parametrize("snippet", [
    "import pandas as pd\npd.Series([1]).to_csv('/tmp/nmb_escape.csv')",
    "import pandas as pd\npd.read_csv('/etc/passwd')",
    "import pandas as pd\npd.Series([1]).to_json('/tmp/nmb_escape.chart.json')",
])
def test_audit_hook_still_blocks_everything_else(client, ds, snippet):
    synth(client, ds["id"], ["amount"], rows=30)
    run = execute(client, ds["id"], f"save_chart({GOOD})\n{snippet}").json()
    assert run["status"] == "error" and "blocked by sandbox policy" in run["stderr"]
    assert run["files"] == []
