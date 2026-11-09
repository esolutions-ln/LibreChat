"""POST /report/xlsx and /report/pdf. Mounted under the app-wide service-key dependency."""
from __future__ import annotations

from typing import Callable

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response

from .pdf import build_pdf
from .spec import SpecError, parse_spec
from .xlsx import build_xlsx

XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
PDF = "application/pdf"


async def _read_capped(request: Request, limit: int) -> bytes:
    """Reads the body but stops as soon as it exceeds the limit, so an oversize body is never buffered whole."""
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            raise SpecError("too_large")
        chunks.append(chunk)
    return b"".join(chunks)


def build_router(get_scanner: Callable) -> APIRouter:
    router = APIRouter()

    async def export(request: Request, sc, builder, media: str, filename: str) -> Response:
        cfg = sc.policy.reports
        if not cfg.get("enabled", True):
            raise HTTPException(404, "reports are disabled")
        try:
            raw = await _read_capped(request, int(cfg["max_spec_bytes"]))
            spec = parse_spec(raw, int(cfg["max_spec_bytes"]))
        except SpecError as e:
            raise HTTPException(422, {"code": e.code, "fields": e.errors})
        data = await run_in_threadpool(builder, spec)
        return Response(
            content=data,
            media_type=media,
            headers={"Content-Disposition": f'attachment; filename="{filename}"', "Cache-Control": "no-store",
                     "X-Content-Type-Options": "nosniff"},
        )

    @router.post("/report/xlsx")
    async def report_xlsx(request: Request, sc=Depends(get_scanner)):
        return await export(request, sc, build_xlsx, XLSX, "nmb-report.xlsx")

    @router.post("/report/pdf")
    async def report_pdf(request: Request, sc=Depends(get_scanner)):
        return await export(request, sc, build_pdf, PDF, "nmb-report.pdf")

    return router
