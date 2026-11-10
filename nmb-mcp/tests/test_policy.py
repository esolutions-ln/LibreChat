import ast
import json

import pytest

from conftest import DATASET
from nmbmcp import policy
from nmbmcp.policy import PolicyError

COLS = DATASET["columns"]


def spec(**over):
    args = dict(group_by=["segment"], metrics=[], time_bucket="month", max_group_by=2)
    args.update(over)
    return policy.validate_aggregate(COLS, args["group_by"], args["metrics"], args["time_bucket"], args["max_group_by"])


def refused(**over) -> str:
    with pytest.raises(PolicyError) as exc:
        spec(**over)
    return exc.value.code


def test_clean_text_strips_control_characters_and_caps_length():
    assert policy.clean_text("a\x00b\x07c\nd", 50) == "abc\nd"
    assert policy.clean_text("x" * 100, 10) == "x" * 10 + "…[truncated]"


def test_describe_dataset_exposes_schema_and_flags_only():
    out = policy.describe_dataset(DATASET)
    assert out["has_twin"] is True
    assert {"name", "kind", "sensitive"} == set(out["columns"][0])
    assert "null_fraction" not in json.dumps(out)


def test_valid_aggregate_spec_with_datetime_and_metrics():
    s = spec(
        group_by=["segment", "opened_date"],
        metrics=[{"column": "balance_usd", "op": "mean"}],
        time_bucket="year",
    )
    assert s["datetime"] == ["opened_date"] and s["bucket"] == "year"
    assert s["metrics"] == [{"column": "balance_usd", "op": "mean"}]


@pytest.mark.parametrize(
    "over,code",
    [
        ({"group_by": []}, "group_by_required"),
        ({"group_by": ["segment", "city", "opened_date"]}, "too_many_group_by"),
        ({"group_by": ["segment", "segment"]}, "duplicate_group_by"),
        ({"group_by": ["account_number"]}, "column_not_groupable"),
        ({"group_by": ["full_name"]}, "column_not_groupable"),
        ({"group_by": ["balance_usd"]}, "column_not_groupable"),
        ({"group_by": ["nope"]}, "unknown_column"),
        ({"time_bucket": "day"}, "invalid_time_bucket"),
        ({"metrics": [{"column": "balance_usd", "op": "max"}]}, "invalid_op"),
        ({"metrics": [{"column": "balance_usd", "op": "min"}]}, "invalid_op"),
        ({"metrics": [{"column": "segment", "op": "sum"}]}, "column_not_numeric"),
        ({"metrics": [{"column": "nope", "op": "sum"}]}, "unknown_column"),
        ({"metrics": [{"column": "balance_usd", "op": "sum"}] * 5}, "too_many_metrics"),
    ],
)
def test_aggregate_requests_the_policy_refuses(over, code):
    assert refused(**over) == code


def test_sensitive_numeric_columns_are_not_metrics():
    cols = COLS + [{"name": "salary", "kind": "numeric", "sensitive": True}]
    with pytest.raises(PolicyError) as exc:
        policy.validate_aggregate(cols, ["segment"], [{"column": "salary", "op": "sum"}], "month", 2)
    assert exc.value.code == "column_not_numeric"


def test_script_carries_column_names_as_data_not_code():
    # A hostile column name used as test data only: it is parsed by ast.parse and never executed.
    hostile = 'x"); import os; os.system("id"); ("'
    cols = COLS + [{"name": hostile, "kind": "categorical", "sensitive": False}]
    s = policy.validate_aggregate(cols, [hostile], [], "month", 2)
    src = policy.build_script(s, 50)
    tree = ast.parse(src)  # still valid Python, and nothing extra was injected
    imports = [n for n in ast.walk(tree) if isinstance(n, (ast.Import, ast.ImportFrom))]
    assert [i.names[0].name for i in imports] == ["json", "pandas"]
    literal = next(
        n.value.args[0].value
        for n in tree.body
        if isinstance(n, ast.Assign) and n.targets[0].id == "SPEC"  # type: ignore[attr-defined]
    )
    assert json.loads(literal) == s


def _stdout(rows):
    return json.dumps({"rows": rows})


def test_small_groups_are_dropped_and_counted():
    s = spec(metrics=[{"column": "balance_usd", "op": "sum"}])
    out = policy.shape_aggregate(
        _stdout(
            [
                {"group": ["Retail"], "n": 80, "m": [{"c": 80, "v": 1000.123}]},
                {"group": ["TINY-GROUP-SECRET"], "n": 3, "m": [{"c": 3, "v": 99999.0}]},
            ]
        ),
        s,
        10,
        50,
    )
    assert out["groups_suppressed"] == 1
    assert [g["group"]["segment"] for g in out["groups"]] == ["Retail"]
    text = json.dumps(out)
    assert "TINY-GROUP-SECRET" not in text and "99999" not in text
    assert out["groups"][0]["metrics"] == {"sum(balance_usd)": 1000.12}


def test_metric_with_too_few_values_is_withheld_even_when_the_group_is_large():
    s = spec(metrics=[{"column": "balance_usd", "op": "mean"}])
    out = policy.shape_aggregate(_stdout([{"group": ["SME"], "n": 50, "m": [{"c": 2, "v": 123.0}]}]), s, 10, 50)
    assert out["groups"][0]["metrics"] == {"mean(balance_usd)": None}


def test_groups_are_sorted_largest_first_and_capped():
    s = spec()
    rows = [{"group": [f"g{i}"], "n": 10 + i, "m": []} for i in range(8)]
    out = policy.shape_aggregate(_stdout(rows), s, 10, 3)
    assert [g["count"] for g in out["groups"]] == [17, 16, 15]


@pytest.mark.parametrize("stdout", ["", "not json", "{\"x\": 1"])
def test_unparseable_script_output_is_a_policy_error(stdout):
    with pytest.raises(PolicyError) as exc:
        policy.shape_aggregate(stdout, spec(), 10, 50)
    assert exc.value.code == "aggregate_failed"


def test_too_many_groups_is_reported_without_data():
    with pytest.raises(PolicyError) as exc:
        policy.shape_aggregate(json.dumps({"error": "too_many_groups"}), spec(), 10, 50)
    assert exc.value.code == "too_many_groups"


def test_twin_sample_cleans_cells_and_honours_the_limit():
    out = policy.twin_sample({"columns": ["a"], "rows": [["x\x07"], ["y"], ["z"]]}, 2)
    assert out["rows"] == [["x"], ["y"]] and out["synthetic"] is True
