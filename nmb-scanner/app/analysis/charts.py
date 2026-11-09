"""Charts emitted by analysis code through `save_chart` (docs/nmb/REPORTS.md, "Workbench charts").

The sandbox child only writes `<name>.chart.json`. Nothing it wrote is trusted: every chart is re-validated here as a
ChartSpec, marked `origin: "computed"`, and rewritten in normalised form. A chart that fails is dropped and reported
by code and field path only, so values from real data never reach stderr.
"""
from __future__ import annotations

import json

from ..report.spec import DEFAULT_MAX_BYTES, SpecError, parse_spec

CHART_SUFFIX = ".chart.json"
MAX_REASONS = 6


def is_chart(name: str) -> bool:
    return name.endswith(CHART_SUFFIX)


def _line(stem: str, err: SpecError) -> str:
    return f"chart_rejected:{stem}:" + ",".join([err.code, *err.errors[: MAX_REASONS - 1]])


def finalize(files: dict[str, bytes], max_charts: int = 5,
             max_bytes: int = DEFAULT_MAX_BYTES) -> tuple[dict[str, bytes], list[str]]:
    """Returns (files with valid normalised charts, one `chart_rejected:` line per dropped chart)."""
    kept: dict[str, bytes] = {}
    rejected: list[str] = []
    charts = 0
    for name in sorted(files):
        raw = files[name]
        if not is_chart(name):
            kept[name] = raw
            continue
        stem = name[: -len(CHART_SUFFIX)]
        if charts >= max_charts:
            rejected.append(f"chart_rejected:{stem}:too_many")
            continue
        try:
            spec = parse_spec(raw, max_bytes)
        except SpecError as e:
            rejected.append(_line(stem, e))
            continue
        spec.origin = "computed"
        kept[name] = json.dumps(spec.model_dump(mode="json", exclude_none=True), separators=(",", ":")).encode()
        charts += 1
    return kept, rejected
