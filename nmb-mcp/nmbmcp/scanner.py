"""Thin client for the scanner's /analysis/* API. The scanner trusts the `user` we pass, so callers must take it
from an authenticated identity, never from a tool argument."""
from __future__ import annotations

from typing import Any

import httpx


class ScannerError(Exception):
    """A failure the tools can report without leaking scanner internals."""

    def __init__(self, code: str, status: int = 0):
        super().__init__(code)
        self.code = code
        self.status = status


_CODES = {401: "scanner_auth", 404: "not_found", 409: "no_twin", 422: "invalid_request", 429: "busy"}


class Scanner:
    def __init__(self, base_url: str, service_key: str, http: httpx.Client | None = None, timeout: float = 90.0):
        headers = {"X-NMB-Service-Key": service_key} if service_key else {}
        self._http = http or httpx.Client(base_url=base_url, headers=headers, timeout=timeout)
        self._owned = http is None
        self._extra = headers if http is not None else {}

    def close(self) -> None:
        if self._owned:
            self._http.close()

    def _call(self, method: str, path: str, **kw: Any) -> Any:
        try:
            res = self._http.request(method, "/analysis" + path, headers=self._extra or None, **kw)
        except httpx.HTTPError as exc:
            raise ScannerError("scanner_unavailable") from exc
        if res.status_code >= 500:
            raise ScannerError("scanner_unavailable", res.status_code)
        if res.status_code >= 400:
            raise ScannerError(_CODES.get(res.status_code, "scanner_rejected"), res.status_code)
        return res.json()

    def datasets(self, user: str) -> list[dict]:
        return self._call("GET", "/datasets", params={"user": user})["items"]

    def dataset(self, user: str, dataset_id: str) -> dict:
        return self._call("GET", f"/datasets/{dataset_id}", params={"user": user})

    def synthesize(self, user: str, dataset_id: str, columns: list[str], rows: int) -> dict:
        body = {"user": user, "columns": columns, "rows": rows}
        return self._call("POST", f"/datasets/{dataset_id}/synthesize", json=body)

    def synthetic(self, user: str, dataset_id: str) -> dict:
        return self._call("GET", f"/datasets/{dataset_id}/synthetic", params={"user": user})

    def execute(self, user: str, dataset_id: str, code: str, target: str) -> dict:
        body = {"user": user, "code": code, "target": target}
        return self._call("POST", f"/datasets/{dataset_id}/execute", json=body)

    def limits(self) -> dict:
        return self._call("GET", "/limits")
