"""Encrypted, owner-scoped storage for uploaded datasets, synthetic twins and run output.

Everything on disk is Fernet-encrypted under a key derived (separately from the vault's) from NMB_VAULT_KEY.
Ids are validated before they touch a path, and an owner mismatch is indistinguishable from "not found".
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import shutil
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography.fernet import Fernet

DS_RE = re.compile(r"^ds_[0-9a-f]{12}$")
RUN_RE = re.compile(r"^run_[0-9a-f]{12}$")
FILE_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.isoformat(timespec="seconds")


class AnalysisStore:
    def __init__(self, data_dir: Path, vault_key: str, dataset_ttl_hours: float, run_ttl_hours: float):
        self.root = Path(data_dir) / "analysis"
        self.ds_dir = self.root / "datasets"
        self.run_dir = self.root / "runs"
        for d in (self.ds_dir, self.run_dir):
            d.mkdir(parents=True, exist_ok=True)
            os.chmod(d, 0o700)
        derived = base64.urlsafe_b64encode(hashlib.sha256(b"nmb-analysis:" + vault_key.encode()).digest())
        self._f = Fernet(derived)
        self.dataset_ttl = timedelta(hours=float(dataset_ttl_hours))
        self.run_ttl = timedelta(hours=float(run_ttl_hours))
        self._lock = threading.RLock()

    # -- low level -----------------------------------------------------------
    def _write(self, path: Path, data: bytes) -> None:
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_bytes(self._f.encrypt(data))
        os.chmod(tmp, 0o600)
        tmp.replace(path)

    def _read(self, path: Path) -> bytes | None:
        try:
            return self._f.decrypt(path.read_bytes())
        except (FileNotFoundError, OSError):
            return None

    def _read_json(self, path: Path) -> dict | None:
        raw = self._read(path)
        return json.loads(raw) if raw is not None else None

    # -- datasets ------------------------------------------------------------
    def create_dataset(self, owner: str, department: str | None, name: str, csv_bytes: bytes,
                       rows: int, columns: list[dict]) -> dict:
        ds_id = f"ds_{uuid.uuid4().hex[:12]}"
        now = utcnow()
        meta = {"id": ds_id, "owner": owner, "department": department, "name": name, "rows": rows,
                "created_at": iso(now), "expires_at": iso(now + self.dataset_ttl),
                "columns": columns, "synthetic": None}
        with self._lock:
            d = self.ds_dir / ds_id
            d.mkdir(mode=0o700)
            self._write(d / "data.enc", csv_bytes)
            self._write(d / "meta.enc", json.dumps(meta).encode())
        return meta

    def get_dataset(self, ds_id: str, owner: str, now: datetime | None = None) -> dict | None:
        if not DS_RE.match(ds_id or ""):
            return None
        meta = self._read_json(self.ds_dir / ds_id / "meta.enc")
        if meta is None or meta.get("owner") != owner:
            return None
        if datetime.fromisoformat(meta["expires_at"]) <= (now or utcnow()):
            self.delete_dataset(ds_id)
            return None
        return meta

    def list_datasets(self, owner: str) -> list[dict]:
        self.purge_expired()
        out = []
        for d in self.ds_dir.iterdir():
            meta = self._read_json(d / "meta.enc") if DS_RE.match(d.name) else None
            if meta and meta.get("owner") == owner:
                out.append(meta)
        return sorted(out, key=lambda m: m["created_at"], reverse=True)

    def update_dataset(self, meta: dict) -> None:
        with self._lock:
            self._write(self.ds_dir / meta["id"] / "meta.enc", json.dumps(meta).encode())

    def read_dataset_csv(self, ds_id: str) -> bytes | None:
        return self._read(self.ds_dir / ds_id / "data.enc")

    def write_synthetic(self, ds_id: str, csv_text: str) -> None:
        with self._lock:
            self._write(self.ds_dir / ds_id / "synthetic.enc", csv_text.encode())

    def read_synthetic(self, ds_id: str) -> str | None:
        raw = self._read(self.ds_dir / ds_id / "synthetic.enc")
        return raw.decode() if raw is not None else None

    def delete_dataset(self, ds_id: str) -> bool:
        if not DS_RE.match(ds_id or ""):
            return False
        with self._lock:
            for r in list(self.run_dir.iterdir()):
                meta = self._read_json(r / "run.enc") if RUN_RE.match(r.name) else None
                if meta and meta.get("dataset_id") == ds_id:
                    shutil.rmtree(r, ignore_errors=True)
            d = self.ds_dir / ds_id
            existed = d.exists()
            shutil.rmtree(d, ignore_errors=True)
            return existed

    # -- runs ----------------------------------------------------------------
    def create_run(self, run: dict, owner: str, files: dict[str, bytes]) -> dict:
        rid = f"run_{uuid.uuid4().hex[:12]}"
        now = utcnow()
        meta = {**run, "id": rid, "owner": owner, "created_at": iso(now),
                "expires_at": iso(now + self.run_ttl)}
        with self._lock:
            d = self.run_dir / rid
            (d / "files").mkdir(parents=True, mode=0o700)
            for name, data in files.items():
                if FILE_RE.match(name):
                    self._write(d / "files" / (name + ".enc"), data)
            self._write(d / "run.enc", json.dumps(meta).encode())
        return meta

    def get_run(self, rid: str, owner: str, now: datetime | None = None) -> dict | None:
        if not RUN_RE.match(rid or ""):
            return None
        meta = self._read_json(self.run_dir / rid / "run.enc")
        if meta is None or meta.get("owner") != owner:
            return None
        if datetime.fromisoformat(meta["expires_at"]) <= (now or utcnow()):
            shutil.rmtree(self.run_dir / rid, ignore_errors=True)
            return None
        return meta

    def read_run_file(self, rid: str, owner: str, name: str) -> bytes | None:
        if self.get_run(rid, owner) is None or not FILE_RE.match(name or ""):
            return None
        return self._read(self.run_dir / rid / "files" / (name + ".enc"))

    # -- retention -----------------------------------------------------------
    def purge_expired(self, now: datetime | None = None) -> tuple[int, int]:
        now = now or utcnow()
        datasets = runs = 0
        with self._lock:
            for d in list(self.ds_dir.iterdir()):
                meta = self._read_json(d / "meta.enc") if DS_RE.match(d.name) else None
                if meta and datetime.fromisoformat(meta["expires_at"]) <= now:
                    self.delete_dataset(d.name)
                    datasets += 1
            for r in list(self.run_dir.iterdir()):
                meta = self._read_json(r / "run.enc") if RUN_RE.match(r.name) else None
                if meta and datetime.fromisoformat(meta["expires_at"]) <= now:
                    shutil.rmtree(r, ignore_errors=True)
                    runs += 1
        return datasets, runs
