import csv
import io
import random
import sys
from datetime import date, timedelta

import pytest

U = "alice"
N = 240


def _luhn(prefix: str) -> str:
    digits = [int(c) for c in prefix]
    total = 0
    for i, d in enumerate(reversed(digits)):
        d = d * 2 if i % 2 == 0 else d
        total += d - 9 if d > 9 else d
    return prefix + str((10 - total % 10) % 10)


def _iban(rng) -> str:
    body = "WEST" + "".join(str(rng.randint(0, 9)) for _ in range(14))
    numeric = "".join(str(int(c, 36)) for c in body + "GB00")
    check = 98 - int(numeric) % 97
    return f"GB{check:02d}{body}"


def make_csv(n: int = N) -> tuple[bytes, list[dict]]:
    rng = random.Random(7)
    rows = []
    for i in range(n):
        rows.append({
            "txn_id": f"TX{rng.randint(10**7, 10**8 - 1)}",
            "booking_date": (date(2025, 1, 1) + timedelta(days=rng.randint(0, 300))).isoformat(),
            "amount": f"{rng.lognormvariate(5, 1):.2f}",
            "category": rng.choice(["groceries", "fuel", "salary", "rent", "airtime"]),
            "iban": _iban(rng),
            "card_no": _luhn("411111" + "".join(str(rng.randint(0, 9)) for _ in range(9))),
            "email": f"user{rng.randint(1000, 9999)}{i}@example.com",
            "branch_count": str(rng.randint(1, 9)),
        })
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=list(rows[0]))
    w.writeheader()
    w.writerows(rows)
    return buf.getvalue().encode(), rows


@pytest.fixture()
def real():
    return make_csv()


@pytest.fixture()
def cfg(client):
    from app import main
    return main.get_scanner().policy.analysis


def upload(client, data, user=U, name="statement.csv"):
    return client.post("/analysis/datasets", files={"file": (name, data, "text/csv")}, data={"user": user})


@pytest.fixture()
def ds(client, real):
    r = upload(client, real[0])
    assert r.status_code == 200, r.text
    return r.json()


def synth(client, ds_id, columns, rows=60, seed=3, user=U):
    return client.post(f"/analysis/datasets/{ds_id}/synthesize",
                       json={"user": user, "columns": columns, "rows": rows, "seed": seed})


def execute(client, ds_id, code, target="synthetic", user=U):
    return client.post(f"/analysis/datasets/{ds_id}/execute", json={"user": user, "code": code, "target": target})


ALL = ["txn_id", "booking_date", "amount", "category", "iban", "card_no", "email", "branch_count"]


# ---- profiling ----------------------------------------------------------
def test_upload_profiles_columns_and_flags_sensitive(ds):
    cols = {c["name"]: c for c in ds["columns"]}
    assert ds["id"].startswith("ds_") and ds["rows"] == N and ds["synthetic"] is None
    assert "owner" not in ds
    for name, ent in (("iban", "IBAN"), ("card_no", "CREDIT_CARD"), ("email", "EMAIL")):
        assert cols[name]["sensitive"] and ent in cols[name]["sensitive_entities"] and cols[name]["share"] is False
    assert cols["amount"]["kind"] == "numeric" and not cols["amount"]["sensitive"] and cols["amount"]["share"]
    assert cols["booking_date"]["kind"] == "datetime"
    assert cols["category"]["kind"] == "categorical"
    assert cols["txn_id"]["kind"] == "identifier"
    assert cols["branch_count"]["kind"] == "integer"


@pytest.mark.parametrize("name,data,status", [
    ("x.txt", b"a,b\n1,2\n", 422),
    ("x.csv", b"", 422),
    ("x.csv", b"a,b\n", 422),
    ("x.csv", b"\xff\xfe\x00bad,\n\xff\xfe", 422),
])
def test_upload_rejects_bad_files(client, name, data, status):
    assert upload(client, data, name=name).status_code == status


def test_upload_rejects_oversize(client, cfg, real):
    cfg["max_upload_bytes"] = 1000
    assert upload(client, real[0]).status_code == 422


def test_disabled_policy_hides_feature(client, cfg, real):
    cfg["enabled"] = False
    assert upload(client, real[0]).status_code == 404
    assert client.get("/analysis/limits").status_code == 404


def test_limits(client, cfg):
    body = client.get("/analysis/limits").json()
    assert body["synthetic_max_rows"] == cfg["synthetic_max_rows"] and "pandas" in body["allowed_imports"]


# ---- synthesis ----------------------------------------------------------
def test_synthetic_contains_no_real_values_or_rows(client, ds, real):
    r = synth(client, ds["id"], ALL, rows=100)
    assert r.status_code == 200 and r.json()["synthetic"]["rows"] == 100
    assert r.json()["synthetic"]["engine"] == "builtin"
    body = client.get(f"/analysis/datasets/{ds['id']}/synthetic", params={"user": U}).json()
    assert body["columns"] == ALL and len(body["rows"]) == 100
    syn = list(csv.DictReader(io.StringIO(body["csv"])))
    real_rows = real[1]
    for col in ("txn_id", "iban", "card_no", "email"):
        assert not ({r[col] for r in syn} & {r[col] for r in real_rows}), col
    real_set = {tuple(r[c] for c in ALL) for r in real_rows}
    assert not any(tuple(r[c] for c in ALL) in real_set for r in syn)
    assert {r["category"] for r in syn} <= {"groceries", "fuel", "salary", "rent", "airtime", "other"}
    amounts = [float(r["amount"]) for r in syn]
    real_amounts = sorted(float(r["amount"]) for r in real_rows)
    assert min(amounts) >= real_amounts[0] and max(amounts) <= real_amounts[-1]


def test_synthetic_is_seedable_and_respects_selection(client, ds):
    a = synth(client, ds["id"], ["amount", "category"], rows=30, seed=11)
    ca = client.get(f"/analysis/datasets/{ds['id']}/synthetic", params={"user": U}).json()["csv"]
    synth(client, ds["id"], ["amount", "category"], rows=30, seed=11)
    cb = client.get(f"/analysis/datasets/{ds['id']}/synthetic", params={"user": U}).json()["csv"]
    assert a.json()["synthetic"]["columns"] == ["amount", "category"] and ca == cb
    assert "email" not in ca.splitlines()[0]


def test_rare_categories_fold_into_other(client):
    rows = ["amount,tier"] + [f"{100 + i},{'gold' if i % 3 else 'silver'}" for i in range(200)]
    rows += ["50,UniqueVIPName", "51,AnotherRareOne"]
    ds = upload(client, "\n".join(rows).encode()).json()
    assert {c["name"]: c["kind"] for c in ds["columns"]}["tier"] == "categorical"
    synth(client, ds["id"], ["amount", "tier"], rows=200)
    csv_text = client.get(f"/analysis/datasets/{ds['id']}/synthetic", params={"user": U}).json()["csv"]
    assert "UniqueVIPName" not in csv_text and "AnotherRareOne" not in csv_text


def test_synthesize_validation(client, ds, cfg):
    assert synth(client, ds["id"], ["nope"]).status_code == 422
    assert synth(client, ds["id"], ["amount"], rows=0).status_code == 422
    assert synth(client, ds["id"], ["amount"], rows=cfg["synthetic_max_rows"] + 1).status_code == 422
    assert client.get(f"/analysis/datasets/{ds['id']}/synthetic", params={"user": U}).status_code == 409
    assert execute(client, ds["id"], "print(1)").status_code == 409


# ---- execution ----------------------------------------------------------
CODE_SUMMARY = """
import pandas as pd
df = pd.read_csv(DATA_PATH)
s = df.groupby('category')['amount'].agg(['count', 'sum']).reset_index()
s.to_csv(OUTPUT_DIR + '/summary.csv', index=False)
print('rows', len(df))
print('total', round(df['amount'].sum(), 2))
"""


def test_execute_on_synthetic(client, ds):
    synth(client, ds["id"], ["amount", "category"], rows=50)
    r = execute(client, ds["id"], CODE_SUMMARY)
    run = r.json()
    assert r.status_code == 200 and run["status"] == "ok", run
    assert run["llm_safe"] is True and run["target"] == "synthetic" and "owner" not in run
    assert "rows 50" in run["stdout"] and [f["name"] for f in run["files"]] == ["summary.csv"]
    f = client.get(f"/analysis/runs/{run['id']}/files/summary.csv", params={"user": U})
    assert f.status_code == 200 and f.text.startswith("category,count,sum")
    assert "attachment" in f.headers["content-disposition"] and f.headers["x-content-type-options"] == "nosniff"
    assert client.get(f"/analysis/runs/{run['id']}", params={"user": U}).json()["status"] == "ok"


def test_execute_on_real_returns_aggregates_and_is_not_llm_safe(client, ds, real):
    run = execute(client, ds["id"], CODE_SUMMARY, target="real").json()
    assert run["status"] == "ok" and run["llm_safe"] is False and run["target"] == "real"
    assert f"rows {N}" in run["stdout"]
    expected = round(sum(float(r["amount"]) for r in real[1]), 2)
    assert f"total {expected}" in run["stdout"]


def test_real_data_is_encrypted_at_rest_and_temp_dir_removed(client, ds, real, env):
    execute(client, ds["id"], CODE_SUMMARY, target="real")
    needles = [real[1][0]["email"].encode(), real[1][0]["iban"].encode(), real[1][0]["card_no"].encode()]
    for p in (env / "data").rglob("*"):
        if p.is_file():
            blob = p.read_bytes()
            assert not any(n in blob for n in needles), p
    import glob
    import tempfile
    assert not glob.glob(f"{tempfile.gettempdir()}/nmbrun_*")


@pytest.mark.parametrize("code", [
    "import os\nprint(os.listdir('/'))",
    "import subprocess\nsubprocess.run(['id'])",
    "import socket\nsocket.socket()",
    "import pandas as pd\nf = open('/etc/passwd')",
    "x = __import__('os')",
    "x = ().__class__.__bases__",
    "import pandas as pd\npd.eval('1+1')",
    "eval('1')",
    "exec('1')",
    "from . import x",
    "import pandas as pd\ndef f(:\n  pass",
])
def test_static_rejections_never_echo_source(client, ds, code):
    synth(client, ds["id"], ["amount"], rows=10)
    run = execute(client, ds["id"], code).json()
    assert run["status"] == "rejected" and run["violations"] and run["stdout"] == "" and run["stderr"] == ""
    assert all("@L" in v for v in run["violations"])
    flat = str(run)
    for secret in ("subprocess", "/etc/passwd", "socket", "listdir", "__bases__"):
        assert secret not in flat


def test_code_length_cap(client, ds, cfg):
    cfg["max_code_chars"] = 20
    synth(client, ds["id"], ["amount"], rows=10)
    assert execute(client, ds["id"], "print('x' * 3)\n" * 10).status_code == 422


def test_runtime_errors_are_sanitised(client, ds):
    synth(client, ds["id"], ["amount"], rows=10)
    run = execute(client, ds["id"], "import pandas as pd\npd.read_csv(DATA_PATH)['missing']").json()
    assert run["status"] == "error" and "KeyError" in run["stderr"]
    assert "/Users" not in run["stderr"] and "/private" not in run["stderr"] and "/tmp" not in run["stderr"]


def test_timeout(client, ds, cfg):
    cfg["timeout_s"] = 2
    synth(client, ds["id"], ["amount"], rows=10)
    run = execute(client, ds["id"], "while True:\n    pass").json()
    assert run["status"] == "timeout" and run["duration_ms"] < 10_000


def test_stdout_cap(client, ds, cfg):
    cfg["max_output_bytes"] = 5000
    cfg["timeout_s"] = 20
    synth(client, ds["id"], ["amount"], rows=10)
    run = execute(client, ds["id"], "for i in range(200000):\n    print('x' * 100)").json()
    assert run["status"] == "ok" and len(run["stdout"]) <= 5000


def test_output_file_size_cap(client, ds, cfg):
    cfg["max_output_file_bytes"] = 2000
    cfg["timeout_s"] = 20
    synth(client, ds["id"], ["amount"], rows=10)
    code = "import pandas as pd\npd.DataFrame({'a': ['x' * 100] * 50000}).to_csv(OUTPUT_DIR + '/big.csv')"
    run = execute(client, ds["id"], code).json()
    assert run["status"] == "error" and run["files"] == []


@pytest.mark.skipif(sys.platform != "linux", reason="RLIMIT_AS is not enforced on macOS")
def test_memory_cap(client, ds, cfg):
    cfg["memory_mb"] = 600
    synth(client, ds["id"], ["amount"], rows=10)
    run = execute(client, ds["id"], "import numpy as np\nx = np.ones(10**9)\nprint(x.sum())").json()
    assert run["status"] == "error"


@pytest.mark.parametrize("snippet", [
    "pd.read_csv('/etc/passwd')",
    "pd.DataFrame({'a': [1]}).to_csv('/tmp/nmb_escape_test.csv')",
    "pd.read_csv('http://127.0.0.1:9/x.csv')",
    "pd.read_csv(DATA_PATH + '/../../../../etc/hosts')",
])
def test_audit_hook_blocks_file_and_network_escape(client, ds, snippet):
    synth(client, ds["id"], ["amount"], rows=10)
    run = execute(client, ds["id"], f"import pandas as pd\n{snippet}").json()
    assert run["status"] == "error", run
    import os
    assert not os.path.exists("/tmp/nmb_escape_test.csv")


def test_audit_hook_blocks_scanner_data_dir(client, ds, env):
    synth(client, ds["id"], ["amount"], rows=10)
    code = f"import pandas as pd\npd.read_csv({str(env / 'data' / 'vault.db')!r})"
    run = execute(client, ds["id"], code).json()
    assert run["status"] == "error" and "PermissionError" in run["stderr"]


def test_plotting_libraries_work(client, ds):
    synth(client, ds["id"], ["amount", "category"], rows=40)
    code = ("import pandas as pd\nimport matplotlib.pyplot as plt\nimport plotly.express as px\n"
            "df = pd.read_csv(DATA_PATH)\ndf['amount'].hist()\nplt.savefig(OUTPUT_DIR + '/h.png')\n"
            "px.histogram(df, x='amount').write_html(OUTPUT_DIR + '/h.html')\n")
    run = execute(client, ds["id"], code).json()
    assert run["status"] == "ok", run
    assert {f["name"] for f in run["files"]} == {"h.png", "h.html"}


# ---- ownership / lifecycle ---------------------------------------------
def test_other_users_get_404_everywhere(client, ds):
    synth(client, ds["id"], ["amount"], rows=10)
    run = execute(client, ds["id"], "print(1)").json()
    me = {"user": "mallory"}
    assert client.get("/analysis/datasets", params=me).json() == {"items": []}
    assert client.get(f"/analysis/datasets/{ds['id']}", params=me).status_code == 404
    assert client.delete(f"/analysis/datasets/{ds['id']}", params=me).status_code == 404
    assert client.get(f"/analysis/datasets/{ds['id']}/synthetic", params=me).status_code == 404
    assert synth(client, ds["id"], ["amount"], user="mallory").status_code == 404
    assert execute(client, ds["id"], "print(1)", user="mallory").status_code == 404
    assert client.get(f"/analysis/runs/{run['id']}", params=me).status_code == 404
    assert client.get(f"/analysis/runs/{run['id']}/files/x.csv", params=me).status_code == 404
    assert client.get(f"/analysis/datasets/{ds['id']}", params={"user": U}).status_code == 200


def test_bad_ids_and_names_are_404(client, ds):
    assert client.get("/analysis/datasets/..%2F..", params={"user": U}).status_code == 404
    assert client.get("/analysis/runs/run_nothing", params={"user": U}).status_code == 404


def test_delete_cascades_to_runs_and_files(client, ds, env):
    synth(client, ds["id"], ["amount", "category"], rows=40)
    run = execute(client, ds["id"], CODE_SUMMARY).json()
    assert client.delete(f"/analysis/datasets/{ds['id']}", params={"user": U}).json() == {"deleted": True}
    assert client.get(f"/analysis/runs/{run['id']}", params={"user": U}).status_code == 404
    assert client.get(f"/analysis/datasets/{ds['id']}", params={"user": U}).status_code == 404
    assert list((env / "data" / "analysis" / "datasets").iterdir()) == []
    assert list((env / "data" / "analysis" / "runs").iterdir()) == []


def test_ttl_expiry_purges_data(client, ds, env):
    from datetime import datetime, timedelta, timezone
    from app import main
    synth(client, ds["id"], ["amount", "category"], rows=40)
    run = execute(client, ds["id"], CODE_SUMMARY, target="real").json()
    store = main.get_scanner()._analysis.store
    future = datetime.now(timezone.utc) + timedelta(hours=store.run_ttl.total_seconds() / 3600 + 1)
    assert store.purge_expired(now=future) == (0, 1)
    assert client.get(f"/analysis/runs/{run['id']}", params={"user": U}).status_code == 404
    assert client.get(f"/analysis/datasets/{ds['id']}", params={"user": U}).status_code == 200
    far = datetime.now(timezone.utc) + timedelta(hours=store.dataset_ttl.total_seconds() / 3600 + 1)
    assert store.purge_expired(now=far)[0] == 1
    assert list((env / "data" / "analysis" / "datasets").iterdir()) == []
    assert client.get(f"/analysis/datasets/{ds['id']}", params={"user": U}).status_code == 404


def test_service_key_is_required_when_configured(env, monkeypatch, real):
    from fastapi.testclient import TestClient
    from app import main
    monkeypatch.setenv("NMB_SERVICE_KEY", "k")
    main.get_scanner.cache_clear()
    with TestClient(main.app) as c:
        assert c.get("/analysis/limits").status_code == 401
        assert c.get("/analysis/limits", headers={"X-NMB-Service-Key": "k"}).status_code == 200
    main.get_scanner.cache_clear()


def test_validate_unit():
    from app.analysis.sandbox import validate
    allowed = ["pandas", "numpy"]
    assert validate("import pandas as pd\nimport numpy as np\nprint(1)", allowed) == []
    assert validate("import os", allowed) == ["import_not_allowed@L1"]
    assert validate("x = 1\ny = x.__class__", allowed) == ["dunder_access@L2"]
    assert validate("print(getattr(1, 'real'))", allowed) == ["forbidden_builtin@L1"]
