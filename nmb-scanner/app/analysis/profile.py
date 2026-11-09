"""Column profiling: kind inference and sensitive-column flagging.

Uses the scanner's regex recognisers directly, so nothing is written to the vault and no review is created.
"""
from __future__ import annotations

import io
import re

import pandas as pd

from ..recognizers import build_static_recognizers

KINDS = ("numeric", "integer", "datetime", "boolean", "categorical", "text", "identifier")
_BOOL = {"true", "false", "yes", "no"}
_STRONG = {"iban", "card", "pan", "ssn", "passport", "national", "nid", "phone", "msisdn", "mobile",
           "email", "mail", "swift", "bic", "tin", "pin", "cvv", "creditcard", "cardnumber"}
_WEAK = {"account", "acct", "name", "address", "customer", "cust", "beneficiary", "payee", "payer", "holder"}
_MIN_SCORE = 0.6
_SAMPLE = 200
_RECS = None


class CsvError(ValueError):
    """Bad or oversize CSV. The message is safe to show (never contains cell values)."""


def _recognizers():
    global _RECS
    if _RECS is None:
        _RECS = [r for r in build_static_recognizers() if r.supported_entities[0] != "ORG_KEYWORD"]
    return _RECS


def read_csv(data: bytes, max_rows: int, max_columns: int) -> pd.DataFrame:
    try:
        df = pd.read_csv(io.BytesIO(data), dtype=str, encoding="utf-8-sig", nrows=max_rows + 1)
    except UnicodeDecodeError:
        raise CsvError("The file is not valid UTF-8 text.")
    except pd.errors.EmptyDataError:
        raise CsvError("The CSV is empty.")
    except (pd.errors.ParserError, ValueError):
        raise CsvError("The file could not be parsed as CSV.")
    if len(df) > max_rows:
        raise CsvError("The CSV has more rows than allowed.")
    if len(df) == 0 or len(df.columns) == 0:
        raise CsvError("The CSV has no data rows.")
    if len(df.columns) > max_columns:
        raise CsvError("The CSV has more columns than allowed.")
    return df


def _tokens(name: str) -> set[str]:
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", name)
    return {t for t in re.split(r"[^a-z0-9]+", spaced.lower()) if t}


def _numeric(s: pd.Series) -> pd.Series:
    return pd.to_numeric(s, errors="coerce")


def _datetime(s: pd.Series) -> pd.Series:
    return pd.to_datetime(s, errors="coerce", format="mixed")


def infer_kind(s: pd.Series) -> str:
    v = s.dropna().astype(str).str.strip()
    v = v[v != ""]
    n = len(v)
    if n == 0:
        return "text"
    uniq = v.nunique()
    if set(v.str.lower().unique()) <= _BOOL:
        return "boolean"
    nums = _numeric(v)
    if nums.notna().mean() >= 0.95:
        good = nums.dropna()
        integral = bool((good == good.round()).all()) and not v.str.contains(r"[.eE]", regex=True).any()
        if integral:
            if uniq / n > 0.9 and v.str.len().median() >= 8:
                return "identifier"
            return "integer"
        return "numeric"
    if v.str.contains(r"[-/:]", regex=True).mean() > 0.9 and _datetime(v).notna().mean() >= 0.95:
        return "datetime"
    if uniq <= max(20, 0.05 * n) and uniq < 0.5 * n:
        return "categorical"
    if uniq / n > 0.9 and v.str.len().mean() <= 40 and (~v.str.contains(r"\s", regex=True)).mean() > 0.9:
        return "identifier"
    return "text"


def sensitive_entities(name: str, kind: str, s: pd.Series) -> list[str]:
    out: list[str] = []
    v = s.dropna().astype(str)
    v = v[v.str.strip() != ""]
    if len(v):
        sample = v.sample(n=min(_SAMPLE, len(v)), random_state=0)
        hits: dict[str, int] = {}
        flagged = 0
        for val in sample:
            found = set()
            for rec in _recognizers():
                for r in rec.analyze(val[:200]):
                    if r.score >= _MIN_SCORE:
                        found.add(r.entity_type)
            flagged += bool(found)
            for e in found:
                hits[e] = hits.get(e, 0) + 1
        if flagged >= max(1, 0.2 * len(sample)):
            out = [e for e, c in sorted(hits.items(), key=lambda kv: -kv[1]) if c >= max(1, 0.1 * len(sample))]
        digits = v.str.replace(r"[ -]", "", regex=True)
        if kind == "identifier" and digits.str.fullmatch(r"\d{10,19}").mean() >= 0.8 and "ACCOUNT_NUMBER" not in out:
            out.append("ACCOUNT_NUMBER")
    toks = _tokens(name)
    strong = bool(toks & _STRONG) or any(h in name.lower() for h in ("email", "iban", "cardnum"))
    weak = bool(toks & _WEAK) and kind in ("identifier", "text")
    if (strong or weak) and not out:
        out.append("NAME_HINT")
    return out


def profile_frame(df: pd.DataFrame) -> list[dict]:
    cols = []
    for name in df.columns:
        s = df[name]
        kind = infer_kind(s)
        ents = sensitive_entities(str(name), kind, s)
        cols.append({"name": str(name), "kind": kind, "null_fraction": round(float(s.isna().mean()), 4),
                     "sensitive": bool(ents), "sensitive_entities": ents, "share": not ents})
    return cols


def to_typed(df: pd.DataFrame, columns: list[dict]) -> pd.DataFrame:
    """Real frame with numeric/datetime columns parsed; everything else stays text."""
    out = df.copy()
    for c in columns:
        n = c["name"]
        if n not in out:
            continue
        if c["kind"] in ("numeric", "integer"):
            out[n] = _numeric(out[n])
        elif c["kind"] == "datetime":
            out[n] = _datetime(out[n])
    return out
