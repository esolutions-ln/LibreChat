"""HTTP surface for docs/nmb/ANALYSIS.md. Mounted under the app-level service-key dependency."""
from __future__ import annotations

import csv
import io
import logging
import os
import threading
from pathlib import Path
from typing import Callable, Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from pydantic import BaseModel, Field

from . import profile, sandbox, synth
from .store import AnalysisStore, iso, utcnow

log = logging.getLogger("nmb.analysis")
MEDIA = {"csv": "text/csv", "json": "application/json", "html": "text/html", "png": "image/png",
         "txt": "text/plain", "chart": "application/json"}


class SynthIn(BaseModel):
    user: str = Field(min_length=1)
    columns: list[str] = Field(min_length=1, max_length=500)
    rows: int = 100
    seed: int | None = None


class ExecIn(BaseModel):
    user: str = Field(min_length=1)
    code: str = Field(min_length=1)
    target: Literal["synthetic", "real"]


class Service:
    def __init__(self, scanner):
        self.cfg = scanner.policy.analysis
        s = scanner.settings
        self.store = AnalysisStore(Path(s.data_dir), s.vault_key, self.cfg["dataset_ttl_hours"],
                                   self.cfg["run_ttl_hours"])
        self.slots = threading.BoundedSemaphore(int(self.cfg["max_concurrent_runs"]))
        self.store.purge_expired()


def _public(meta: dict) -> dict:
    return {k: v for k, v in meta.items() if k not in ("owner", "department")}


def _public_run(meta: dict, files: list[dict]) -> dict:
    out = {k: v for k, v in meta.items() if k not in ("owner", "expires_at")}
    out["files"] = files
    return out


def build_router(get_scanner: Callable) -> APIRouter:
    def service(sc=Depends(get_scanner)) -> Service:
        svc = getattr(sc, "_analysis", None)
        if svc is None:
            svc = sc._analysis = Service(sc)
        if not svc.cfg["enabled"]:
            raise HTTPException(404, "analysis is disabled")
        return svc

    router = APIRouter(prefix="/analysis")

    def dataset(svc: Service, ds_id: str, user: str) -> dict:
        meta = svc.store.get_dataset(ds_id, user)
        if meta is None:
            raise HTTPException(404, "dataset not found")
        return meta

    @router.get("/limits")
    def limits(svc: Service = Depends(service)):
        c = svc.cfg
        return {"max_code_chars": c["max_code_chars"], "timeout_s": c["timeout_s"],
                "max_output_bytes": c["max_output_bytes"], "allowed_imports": c["allowed_imports"],
                "max_upload_bytes": c["max_upload_bytes"], "synthetic_max_rows": c["synthetic_max_rows"]}

    @router.post("/datasets")
    def upload(file: UploadFile = File(...), user: str = Form(..., min_length=1),
               department: str | None = Form(None), svc: Service = Depends(service)):
        c = svc.cfg
        name = os.path.basename((file.filename or "").replace("\\", "/"))[:120]
        name = "".join(ch for ch in name if ch.isprintable())
        if not name.lower().endswith(".csv"):
            raise HTTPException(422, "Only .csv files are supported.")
        data = file.file.read(int(c["max_upload_bytes"]) + 1)
        if len(data) > int(c["max_upload_bytes"]):
            raise HTTPException(422, "The file is larger than allowed.")
        try:
            df = profile.read_csv(data, int(c["max_rows"]), int(c["max_columns"]))
        except profile.CsvError as e:
            raise HTTPException(422, str(e))
        columns = profile.profile_frame(df)
        meta = svc.store.create_dataset(user, department, name, data, len(df), columns)
        log.info("dataset created id=%s rows=%d cols=%d sensitive=%d", meta["id"], len(df), len(columns),
                 sum(c["sensitive"] for c in columns))
        return _public(meta)

    @router.get("/datasets")
    def list_datasets(user: str, svc: Service = Depends(service)):
        return {"items": [_public(m) for m in svc.store.list_datasets(user)]}

    @router.get("/datasets/{ds_id}")
    def get_dataset(ds_id: str, user: str, svc: Service = Depends(service)):
        return _public(dataset(svc, ds_id, user))

    @router.delete("/datasets/{ds_id}")
    def delete_dataset(ds_id: str, user: str, svc: Service = Depends(service)):
        dataset(svc, ds_id, user)
        svc.store.delete_dataset(ds_id)
        return {"deleted": True}

    @router.post("/datasets/{ds_id}/synthesize")
    def synthesize(ds_id: str, body: SynthIn, svc: Service = Depends(service)):
        meta = dataset(svc, ds_id, body.user)
        known = {c["name"] for c in meta["columns"]}
        selected = list(dict.fromkeys(body.columns))
        if not set(selected) <= known:
            raise HTTPException(422, "Unknown column selected.")
        cap = int(svc.cfg["synthetic_max_rows"])
        if not 1 <= body.rows <= cap:
            raise HTTPException(422, f"rows must be between 1 and {cap}.")
        raw = svc.store.read_dataset_csv(ds_id)
        if raw is None:
            raise HTTPException(404, "dataset not found")
        df = profile.read_csv(raw, int(svc.cfg["max_rows"]), int(svc.cfg["max_columns"]))
        typed = profile.to_typed(df, meta["columns"])
        try:
            out, engine = synth.synthesize(df, typed, meta["columns"], selected, body.rows, body.seed,
                                           str(svc.cfg["engine"]), int(svc.cfg["synthetic_min_category_count"]))
        except synth.SynthesisError as e:
            log.error("synthesis failed id=%s reason=%s", ds_id, e)
            raise HTTPException(422, "A safe synthetic sample could not be produced for these columns.")
        svc.store.write_synthetic(ds_id, out.to_csv(index=False))
        meta["synthetic"] = {"rows": len(out), "columns": selected, "engine": engine,
                             "generated_at": iso(utcnow())}
        svc.store.update_dataset(meta)
        log.info("synthetic created id=%s rows=%d cols=%d engine=%s", ds_id, len(out), len(selected), engine)
        return _public(meta)

    @router.get("/datasets/{ds_id}/synthetic")
    def get_synthetic(ds_id: str, user: str, svc: Service = Depends(service)):
        dataset(svc, ds_id, user)
        text = svc.store.read_synthetic(ds_id)
        if text is None:
            raise HTTPException(409, "No synthetic data has been generated yet.")
        rows = list(csv.reader(io.StringIO(text)))
        return {"columns": rows[0], "rows": rows[1:], "csv": text}

    @router.post("/datasets/{ds_id}/execute")
    def execute(ds_id: str, body: ExecIn, svc: Service = Depends(service)):
        c = svc.cfg
        meta = dataset(svc, ds_id, body.user)
        if len(body.code) > int(c["max_code_chars"]):
            raise HTTPException(422, "The code is longer than allowed.")
        base = {"dataset_id": ds_id, "target": body.target, "llm_safe": body.target == "synthetic",
                "stdout": "", "stderr": "", "violations": [], "duration_ms": 0}
        violations = sandbox.validate(body.code, c["allowed_imports"])
        if violations:
            run = svc.store.create_run({**base, "status": "rejected", "violations": violations}, body.user, {})
            log.info("run rejected id=%s dataset=%s violations=%d", run["id"], ds_id, len(violations))
            return _public_run(run, [])
        if body.target == "synthetic":
            text = svc.store.read_synthetic(ds_id)
            if text is None:
                raise HTTPException(409, "No synthetic data has been generated yet.")
            data = text.encode()
        else:
            data = svc.store.read_dataset_csv(meta["id"])
            if data is None:
                raise HTTPException(404, "dataset not found")
        if not svc.slots.acquire(timeout=5):
            raise HTTPException(429, "Too many analyses are running. Try again shortly.")
        try:
            result = sandbox.run(body.code, data, c)
        finally:
            svc.slots.release()
        files = result.pop("files")
        run = svc.store.create_run({**base, **result,
                                    "files": [{"name": n, "bytes": len(b),
                                               "kind": sandbox.kind_of(n)}
                                              for n, b in files.items()]}, body.user, files)
        log.info("run finished id=%s dataset=%s target=%s status=%s files=%d ms=%d", run["id"], ds_id,
                 body.target, run["status"], len(files), run["duration_ms"])
        return _public_run(run, run["files"])

    def run_of(svc: Service, rid: str, user: str) -> dict:
        meta = svc.store.get_run(rid, user)
        if meta is None:
            raise HTTPException(404, "run not found")
        return meta

    @router.get("/runs/{rid}")
    def get_run(rid: str, user: str, svc: Service = Depends(service)):
        meta = run_of(svc, rid, user)
        return _public_run(meta, meta.get("files", []))

    @router.get("/runs/{rid}/files/{name}")
    def run_file(rid: str, name: str, user: str, svc: Service = Depends(service)):
        meta = run_of(svc, rid, user)
        entry = next((f for f in meta.get("files", []) if f["name"] == name), None)
        data = svc.store.read_run_file(rid, user, name) if entry else None
        if data is None:
            raise HTTPException(404, "file not found")
        return Response(content=data, media_type=MEDIA.get(entry["kind"], "application/octet-stream"),
                        headers={"Content-Disposition": f'attachment; filename="{name}"',
                                 "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store"})

    return router
