import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from nmbmcp.config import Settings  # noqa: E402
from nmbmcp.scanner import ScannerError  # noqa: E402


def make_settings(**over) -> Settings:
    base = dict(
        scanner_url="http://scanner",
        service_key="svc",
        server_token="caller-token",
        user_header="x-nmb-user",
        dev_user="alice",
        public_url="https://chat.example",
        min_group=10,
        max_groups=50,
        max_group_by=2,
        sample_rows=20,
        max_text=4000,
        rate_per_minute=30,
    )
    base.update(over)
    return Settings(**base)


DATASET = {
    "id": "ds_0123456789ab",
    "name": "customers.csv",
    "rows": 120,
    "synthetic": {"rows": 100, "columns": ["segment"], "engine": "builtin", "generated_at": "x"},
    "columns": [
        {"name": "full_name", "kind": "text", "sensitive": True},
        {"name": "account_number", "kind": "identifier", "sensitive": True},
        {"name": "segment", "kind": "categorical", "sensitive": False},
        {"name": "city", "kind": "categorical", "sensitive": False},
        {"name": "opened_date", "kind": "datetime", "sensitive": False},
        {"name": "balance_usd", "kind": "numeric", "sensitive": False},
        {"name": "days_in_arrears", "kind": "integer", "sensitive": False},
    ],
}


class FakeScanner:
    """Stands in for the scanner. Records calls; every result can be replaced per test."""

    def __init__(self):
        self.calls = []
        self.dataset_result = DATASET
        self.run_result = {"status": "ok", "stdout": "", "stderr": "", "files": [], "violations": [], "duration_ms": 5}
        self.fail = None

    def _go(self, name, *args):
        self.calls.append((name, args))
        if self.fail:
            raise self.fail

    def datasets(self, user):
        self._go("datasets", user)
        return [self.dataset_result]

    def dataset(self, user, dataset_id):
        self._go("dataset", user, dataset_id)
        return self.dataset_result

    def synthesize(self, user, dataset_id, columns, rows):
        self._go("synthesize", user, dataset_id, columns, rows)
        return self.dataset_result

    def synthetic(self, user, dataset_id):
        self._go("synthetic", user, dataset_id)
        return {"columns": ["segment"], "rows": [["Retail"], ["SME\x07"]], "csv": "segment\nRetail\n"}

    def execute(self, user, dataset_id, code, target):
        self._go("execute", user, dataset_id, code, target)
        return self.run_result


@pytest.fixture()
def fake():
    return FakeScanner()


@pytest.fixture()
def failing():
    return lambda code: ScannerError(code)


def parse(result) -> dict:
    return json.loads(result.content[0].text)
