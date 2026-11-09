"""ChartSpec v1 (docs/nmb/REPORTS.md). Every limit is enforced here, whatever the caller already checked."""
from __future__ import annotations

import json
import math
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

MAX_TITLE = 120
MAX_NOTE = 120
MAX_NAME = 80
MAX_CATEGORIES = 60
MAX_SERIES = 12
DEFAULT_MAX_BYTES = 65_536

ChartType = Literal["bar", "stacked_bar", "line", "pie"]
Origin = Literal["model", "computed"]

FOOTER_MODEL = "Prepared from model-read figures; verify against the source document."
FOOTER_COMPUTED = "Computed by the analysis script from the uploaded data; verify before use."


def footer_text(origin: str) -> str:
    return FOOTER_COMPUTED if origin == "computed" else FOOTER_MODEL


class SpecError(ValueError):
    """Carries only stable codes and field paths, never the submitted values."""

    def __init__(self, code: str, errors: list[str] | None = None):
        super().__init__(code)
        self.code = code
        self.errors = errors or []


def _has_control(s: str) -> bool:
    return any(ord(c) < 32 or 127 <= ord(c) < 160 for c in s)


def _text(v: str, *, limit: int, field: str, required: bool = True) -> str:
    if not isinstance(v, str):
        raise ValueError(f"{field}: not text")
    if _has_control(v):
        raise ValueError(f"{field}: control characters")
    if required and not v.strip():
        raise ValueError(f"{field}: empty")
    if len(v) > limit:
        raise ValueError(f"{field}: too long")
    return v


class Series(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str
    values: list[float | None]

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        return _text(v, limit=MAX_NAME, field="name")

    @field_validator("values", mode="before")
    @classmethod
    def _values(cls, v: Any) -> Any:
        if not isinstance(v, list):
            raise ValueError("values: not a list")
        out: list[float | None] = []
        for x in v:
            if x is None:
                out.append(None)
            elif isinstance(x, bool) or not isinstance(x, (int, float)):
                raise ValueError("values: not a number")
            else:
                try:
                    f = float(x)
                except OverflowError:
                    raise ValueError("values: out of range")
                if not math.isfinite(f):
                    raise ValueError("values: not finite")
                out.append(f)
        return out


class ChartSpec(BaseModel):
    model_config = ConfigDict(extra="ignore")
    version: Literal[1]
    title: str
    type: ChartType
    origin: Origin = "model"
    unit: str | None = None
    source: str | None = None
    categories: list[str] = Field(min_length=1, max_length=MAX_CATEGORIES)
    series: list[Series] = Field(min_length=1, max_length=MAX_SERIES)

    @field_validator("title")
    @classmethod
    def _title(cls, v: str) -> str:
        return _text(v, limit=MAX_TITLE, field="title")

    @field_validator("unit", "source")
    @classmethod
    def _note(cls, v: str | None) -> str | None:
        if v is None:
            return None
        return _text(v, limit=MAX_NOTE, field="note", required=False)

    @field_validator("categories")
    @classmethod
    def _categories(cls, v: list[str]) -> list[str]:
        return [_text(c, limit=MAX_NAME, field="categories") for c in v]

    @model_validator(mode="after")
    def _shape(self) -> "ChartSpec":
        n = len(self.categories)
        if any(len(s.values) != n for s in self.series):
            raise ValueError("series: length differs from categories")
        if self.type == "pie" and any(v is not None and v < 0 for v in self.series[0].values):
            raise ValueError("pie: negative value")
        return self


def _reject_constant(_name: str) -> Any:
    raise ValueError("non-finite number")


def parse_spec(raw: bytes, max_bytes: int = DEFAULT_MAX_BYTES) -> ChartSpec:
    """Parses and validates a request body. Raises SpecError with a code and field paths only."""
    if len(raw) > max_bytes:
        raise SpecError("too_large")
    try:
        data = json.loads(raw.decode("utf-8"), parse_constant=_reject_constant)
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise SpecError("invalid_json")
    if not isinstance(data, dict):
        raise SpecError("invalid_spec", ["body"])
    try:
        return ChartSpec.model_validate(data)
    except ValidationError as e:
        raise SpecError("invalid_spec", sorted({".".join(str(p) for p in err["loc"]) or "body" for err in e.errors()}))
