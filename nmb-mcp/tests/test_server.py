import json

import pytest
from mcp import Client

from conftest import DATASET, make_settings, parse
from nmbmcp.policy import PolicyError
from nmbmcp.scanner import ScannerError
from nmbmcp.server import Limiter, build_server, resolve_user

DS = DATASET["id"]
SECRET = "REAL-SECRET-123"


async def call(fake, tool, args=None, **cfg):
    server = build_server(make_settings(**cfg), fake)
    async with Client(server) as client:
        return parse(await client.call_tool(tool, args or {}))


# ---- identity -----------------------------------------------------------
def test_stdio_acts_as_the_dev_user_only_when_configured():
    assert resolve_user(make_settings(), None) == "alice"
    with pytest.raises(PolicyError):
        resolve_user(make_settings(dev_user=""), None)


def test_network_calls_need_the_callers_token_and_a_user():
    cfg = make_settings()
    ok = {"authorization": "Bearer caller-token", "x-nmb-user": "u-42"}
    assert resolve_user(cfg, ok) == "u-42"
    for bad in (
        {"x-nmb-user": "u-42"},
        {"authorization": "Bearer wrong", "x-nmb-user": "u-42"},
        {"authorization": "Bearer caller-token"},
        {"authorization": "Bearer caller-token", "x-nmb-user": "bad user;drop"},
    ):
        with pytest.raises(PolicyError):
            resolve_user(cfg, bad)


def test_a_network_request_is_refused_when_no_token_is_configured():
    with pytest.raises(PolicyError):
        resolve_user(make_settings(server_token=""), {"authorization": "Bearer ", "x-nmb-user": "u1"})


def test_the_dev_user_does_not_apply_to_requests_that_carry_headers():
    with pytest.raises(PolicyError):
        resolve_user(make_settings(), {"x-nmb-user": "someone-else"})


def test_limiter_blocks_after_the_per_minute_budget_and_recovers():
    lim = Limiter(2)
    assert lim.allow("u", 0) and lim.allow("u", 1)
    assert not lim.allow("u", 2)
    assert lim.allow("other", 2)
    assert lim.allow("u", 62)


# ---- the tool surface ---------------------------------------------------
@pytest.mark.anyio
async def test_the_model_cannot_pass_a_user_and_no_tool_returns_raw_rows(fake):
    async with Client(build_server(make_settings(), fake)) as client:
        tools = {t.name: t for t in (await client.list_tools()).tools}
    assert set(tools) == {"list_datasets", "generate_twin", "get_twin_sample", "test_code", "run_code_private", "aggregate"}
    for tool in tools.values():
        assert "user" not in tool.input_schema.get("properties", {})


@pytest.mark.anyio
async def test_list_datasets_returns_schema_without_values(fake):
    out = await call(fake, "list_datasets")
    assert out["datasets"][0]["id"] == DS
    assert fake.calls[0] == ("datasets", ("alice",))
    assert "null_fraction" not in json.dumps(out)


@pytest.mark.anyio
async def test_twin_sample_is_capped_and_cleaned(fake):
    out = await call(fake, "get_twin_sample", {"dataset_id": DS, "limit": 500}, sample_rows=1)
    assert out["rows"] == [["Retail"]] and out["synthetic"] is True


@pytest.mark.anyio
async def test_generate_twin_validates_the_row_count(fake):
    out = await call(fake, "generate_twin", {"dataset_id": DS, "columns": ["segment"], "rows": 5000})
    assert out["error"] == "invalid_rows"
    assert not any(c[0] == "synthesize" for c in fake.calls)


@pytest.mark.anyio
async def test_test_code_runs_on_the_twin_and_returns_clean_output(fake):
    fake.run_result = {"status": "ok", "stdout": "ok\x07 done", "stderr": "", "files": [{"name": "a.csv"}], "violations": []}
    out = await call(fake, "test_code", {"dataset_id": DS, "code": "print(1)"})
    assert out["stdout"] == "ok done" and out["files"] == ["a.csv"] and out["synthetic"] is True
    assert fake.calls[-1][1][-1] == "synthetic"


@pytest.mark.anyio
async def test_private_run_never_returns_output_from_the_real_data(fake):
    fake.run_result = {
        "status": "ok", "stdout": SECRET, "stderr": SECRET, "files": [{"name": "r.csv"}],
        "violations": [], "duration_ms": 9,
    }
    out = await call(fake, "run_code_private", {"dataset_id": DS, "code": "print(1)"})
    assert SECRET not in json.dumps(out)
    assert out["private"] is True and out["status"] == "ok"
    assert out["result_location"] == "https://chat.example/analysis"
    assert fake.calls[-1][1][-1] == "real"


@pytest.mark.anyio
async def test_private_run_failures_do_not_leak_the_traceback(fake):
    fake.run_result = {"status": "error", "stdout": "", "stderr": f"KeyError: {SECRET}", "files": [], "violations": []}
    out = await call(fake, "run_code_private", {"dataset_id": DS, "code": "boom"})
    assert SECRET not in json.dumps(out) and out["status"] == "error"


@pytest.mark.anyio
async def test_aggregate_runs_a_generated_script_and_suppresses_small_groups(fake):
    fake.run_result = {
        "status": "ok",
        "stdout": json.dumps({"rows": [
            {"group": ["Retail"], "n": 90, "m": [{"c": 90, "v": 12.5}]},
            {"group": [SECRET], "n": 2, "m": [{"c": 2, "v": 1.0}]},
        ]}),
        "stderr": "", "files": [], "violations": [],
    }
    out = await call(fake, "aggregate", {
        "dataset_id": DS, "group_by": ["segment"], "metrics": [{"column": "balance_usd", "op": "sum"}],
    })
    assert out["groups_suppressed"] == 1 and out["groups"][0]["count"] == 90
    assert SECRET not in json.dumps(out)
    code = fake.calls[-1][1][2]
    assert "read_csv(DATA_PATH)" in code and fake.calls[-1][1][-1] == "real"


@pytest.mark.anyio
async def test_aggregate_refuses_sensitive_grouping_before_touching_real_data(fake):
    out = await call(fake, "aggregate", {"dataset_id": DS, "group_by": ["account_number"]})
    assert out["error"] == "column_not_groupable"
    assert not any(c[0] == "execute" for c in fake.calls)


@pytest.mark.anyio
async def test_a_malformed_dataset_id_never_reaches_the_scanner(fake):
    out = await call(fake, "get_twin_sample", {"dataset_id": "../../etc/passwd"})
    assert out["error"] == "invalid_dataset_id" and fake.calls == []


@pytest.mark.anyio
async def test_scanner_failures_become_codes_without_scanner_text(fake):
    fake.fail = ScannerError("not_found", 404)
    out = await call(fake, "list_datasets")
    assert out["error"] == "not_found" and "404" not in json.dumps(out)


@pytest.mark.anyio
async def test_unexpected_errors_are_reported_generically(fake):
    fake.fail = RuntimeError(f"db password {SECRET}")
    out = await call(fake, "list_datasets")
    assert out == {"error": "internal", "message": "Unexpected error."}


@pytest.mark.anyio
async def test_the_rate_limit_applies_per_user(fake):
    server = build_server(make_settings(rate_per_minute=2), fake)
    async with Client(server) as client:
        results = [parse(await client.call_tool("list_datasets", {})) for _ in range(3)]
    assert "error" not in results[0] and results[2]["error"] == "rate_limited"


@pytest.mark.anyio
async def test_without_an_identity_every_tool_refuses(fake):
    out = await call(fake, "list_datasets", dev_user="")
    assert out["error"] == "unauthenticated" and fake.calls == []
