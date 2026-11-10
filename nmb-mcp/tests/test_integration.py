"""The MCP server against the real scanner (started as a subprocess) and the demo CSV. Skipped when the scanner's
dependencies are not installed."""
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest
from mcp import Client

from conftest import make_settings, parse
from nmbmcp.scanner import Scanner
from nmbmcp.server import build_server

ROOT = Path(__file__).resolve().parents[2]
SCANNER = ROOT / "nmb-scanner"
CSV = ROOT / "docs" / "nmb" / "demo" / "customers.csv"
KEY = "integration-service-key"

pd = pytest.importorskip("pandas")
pytest.importorskip("uvicorn")
pytest.importorskip("cryptography")


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def scanner_url(tmp_path_factory):
    from cryptography.fernet import Fernet

    data = tmp_path_factory.mktemp("scanner")
    port = _free_port()
    env = {
        **os.environ,
        "NMB_VAULT_KEY": Fernet.generate_key().decode(),
        "NMB_SERVICE_KEY": KEY,
        "NMB_DATA_DIR": str(data),
        "NMB_POLICY_FILE": str(SCANNER / "config" / "policy.yaml"),
        "NMB_BLOCKLIST_FILE": str(SCANNER / "config" / "blocklist.yaml"),
    }
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--port", str(port), "--log-level", "warning"],
        cwd=SCANNER, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    url = f"http://127.0.0.1:{port}"
    try:
        for _ in range(120):
            try:
                if httpx.get(url + "/health", headers={"X-NMB-Service-Key": KEY}, timeout=1).status_code == 200:
                    break
            except httpx.HTTPError:
                pass
            time.sleep(0.5)
        else:
            pytest.skip("the scanner did not start")
        yield url
    finally:
        proc.terminate()
        proc.wait(timeout=20)


@pytest.fixture(scope="module")
def real():
    return pd.read_csv(CSV)


@pytest.fixture(scope="module")
def dataset_id(scanner_url):
    with CSV.open("rb") as fh:
        res = httpx.post(
            scanner_url + "/analysis/datasets",
            headers={"X-NMB-Service-Key": KEY},
            data={"user": "alice"},
            files={"file": ("customers.csv", fh, "text/csv")},
            timeout=60,
        )
    res.raise_for_status()
    return res.json()["id"]


def server(scanner_url, user="alice", **cfg):
    return build_server(make_settings(dev_user=user, **cfg), Scanner(scanner_url, KEY))


async def call(srv, tool, args=None):
    async with Client(srv) as client:
        return parse(await client.call_tool(tool, args or {}))


@pytest.mark.anyio
async def test_catalog_and_twin_never_carry_real_values(scanner_url, dataset_id, real):
    srv = server(scanner_url)
    listed = await call(srv, "list_datasets")
    ds = listed["datasets"][0]
    sensitive = {c["name"] for c in ds["columns"] if c["sensitive"]}
    assert {"full_name", "email", "phone", "account_number"} <= sensitive

    cols = [c["name"] for c in ds["columns"]]
    twin = await call(srv, "generate_twin", {"dataset_id": dataset_id, "columns": cols, "rows": 100})
    assert twin["has_twin"] is True
    sample = await call(srv, "get_twin_sample", {"dataset_id": dataset_id, "limit": 20})
    text = json.dumps(sample)
    for col in ("full_name", "email", "phone", "account_number"):
        assert not any(str(v) in text for v in real[col].head(60)), col
    assert sample["synthetic"] is True and sample["rows_returned"] <= 20


@pytest.mark.anyio
async def test_test_code_runs_on_the_twin(scanner_url, dataset_id):
    srv = server(scanner_url)
    code = "import pandas as pd\ndf = pd.read_csv(DATA_PATH)\nprint(len(df))\n"
    out = await call(srv, "test_code", {"dataset_id": dataset_id, "code": code})
    assert out["status"] == "ok" and out["stdout"].strip() == "100" and out["synthetic"] is True


@pytest.mark.anyio
async def test_private_run_computes_on_real_data_but_returns_nothing(scanner_url, dataset_id, real):
    total = str(round(float(real["balance_usd"].sum()), 2))
    code = f"import pandas as pd\ndf = pd.read_csv(DATA_PATH)\nprint('TOTAL', round(df['balance_usd'].sum(), 2))\n"
    srv = server(scanner_url)
    out = await call(srv, "run_code_private", {"dataset_id": dataset_id, "code": code})
    assert out["status"] == "ok" and out["private"] is True
    assert total not in json.dumps(out) and "TOTAL" not in json.dumps(out)
    # the same code does produce the real total in the scanner itself, so the check above is meaningful
    run = httpx.post(
        scanner_url + f"/analysis/datasets/{dataset_id}/execute",
        headers={"X-NMB-Service-Key": KEY},
        json={"user": "alice", "code": code, "target": "real"},
        timeout=60,
    ).json()
    assert total in run["stdout"]


@pytest.mark.anyio
async def test_aggregate_matches_pandas_and_drops_the_smallest_group(scanner_url, dataset_id, real):
    sizes = real.groupby("segment").size().sort_values()
    floor = int(sizes.iloc[0]) + 1  # suppresses exactly the smallest segment
    assert int(sizes.iloc[1]) >= floor
    srv = server(scanner_url, min_group=floor)
    out = await call(srv, "aggregate", {
        "dataset_id": dataset_id, "group_by": ["segment"],
        "metrics": [{"column": "balance_usd", "op": "sum"}, {"column": "balance_usd", "op": "mean"}],
    })
    assert "error" not in out, out
    assert out["groups_suppressed"] == 1
    shown = {g["group"]["segment"]: g for g in out["groups"]}
    assert sizes.index[0] not in shown
    for seg, grp in real.groupby("segment"):
        if seg in shown:
            assert shown[seg]["count"] == len(grp)
            assert shown[seg]["metrics"]["sum(balance_usd)"] == round(float(grp["balance_usd"].sum()), 2)
            assert shown[seg]["metrics"]["mean(balance_usd)"] == round(float(grp["balance_usd"].mean()), 2)


@pytest.mark.anyio
async def test_aggregate_by_month_and_two_columns(scanner_url, dataset_id):
    srv = server(scanner_url, min_group=2)
    out = await call(srv, "aggregate", {
        "dataset_id": dataset_id, "group_by": ["segment", "opened_date"], "time_bucket": "year",
    })
    assert "error" not in out, out
    assert all(len(g["group"]["opened_date"]) == 4 for g in out["groups"])


@pytest.mark.anyio
async def test_sensitive_and_unknown_columns_are_refused(scanner_url, dataset_id):
    srv = server(scanner_url)
    assert (await call(srv, "aggregate", {"dataset_id": dataset_id, "group_by": ["account_number"]}))["error"] == "column_not_groupable"
    assert (await call(srv, "aggregate", {"dataset_id": dataset_id, "group_by": ["nope"]}))["error"] == "unknown_column"


TOKEN = "caller-token-for-http"


@pytest.fixture(scope="module")
def http_url(scanner_url, dataset_id):
    port = _free_port()
    env = {**os.environ, "NMB_SCANNER_URL": scanner_url, "NMB_SERVICE_KEY": KEY, "NMB_MCP_TOKEN": TOKEN}
    env.pop("NMB_MCP_DEV_USER", None)
    proc = subprocess.Popen(
        [sys.executable, "-m", "nmbmcp", "--http", "--port", str(port)],
        cwd=ROOT / "nmb-mcp", env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        for _ in range(60):
            with socket.socket() as s:
                if s.connect_ex(("127.0.0.1", port)) == 0:
                    break
            time.sleep(0.5)
        else:
            pytest.skip("the MCP server did not start")
        yield f"http://127.0.0.1:{port}/mcp"
    finally:
        proc.terminate()
        proc.wait(timeout=20)


async def http_call(url, headers, tool, args=None):
    httpx2 = pytest.importorskip("httpx2")
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client

    async with httpx2.AsyncClient(headers=headers) as http:
        async with streamable_http_client(url, http_client=http) as streams:
            async with ClientSession(streams[0], streams[1]) as session:
                await session.initialize()
                return parse(await session.call_tool(tool, args or {}))


@pytest.mark.anyio
async def test_over_http_the_caller_must_authenticate_and_names_the_user(http_url, dataset_id):
    assert (await http_call(http_url, {}, "list_datasets"))["error"] == "unauthenticated"
    bad = {"Authorization": "Bearer nope", "X-NMB-User": "alice"}
    assert (await http_call(http_url, bad, "list_datasets"))["error"] == "unauthenticated"
    no_user = {"Authorization": f"Bearer {TOKEN}"}
    assert (await http_call(http_url, no_user, "list_datasets"))["error"] == "unauthenticated"

    alice = {"Authorization": f"Bearer {TOKEN}", "X-NMB-User": "alice"}
    assert (await http_call(http_url, alice, "list_datasets"))["datasets"][0]["id"] == dataset_id
    bob = {"Authorization": f"Bearer {TOKEN}", "X-NMB-User": "bob"}
    assert (await http_call(http_url, bob, "list_datasets"))["datasets"] == []


def test_serving_http_refuses_to_start_without_a_token_or_with_a_dev_user():
    base = {k: v for k, v in os.environ.items() if not k.startswith("NMB_MCP_")}
    cmd = [sys.executable, "-m", "nmbmcp", "--http", "--port", str(_free_port())]
    for extra in ({}, {"NMB_MCP_TOKEN": "t", "NMB_MCP_DEV_USER": "alice"}):
        res = subprocess.run(cmd, cwd=ROOT / "nmb-mcp", env={**base, **extra}, capture_output=True, text=True, timeout=30)
        assert res.returncode != 0


@pytest.mark.anyio
async def test_another_user_cannot_see_or_use_the_dataset(scanner_url, dataset_id):
    srv = server(scanner_url, user="bob")
    assert (await call(srv, "list_datasets"))["datasets"] == []
    assert (await call(srv, "aggregate", {"dataset_id": dataset_id, "group_by": ["segment"]}))["error"] == "not_found"
    assert (await call(srv, "get_twin_sample", {"dataset_id": dataset_id}))["error"] == "not_found"
