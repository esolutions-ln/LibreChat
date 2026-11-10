"""What the model may ask for and what it may be told. Pure functions: no network, no I/O.

The rule for every tool is the same: real values never go back to the model. A real-data aggregate is produced by a
script this module writes (the model supplies column names and operations, never code), and the result is cut down
to groups of at least `min_group` rows before it is returned.
"""
from __future__ import annotations

import json
import re
from typing import Any

GROUPABLE = {"categorical", "boolean", "datetime"}
NUMERIC = {"numeric", "integer"}
OPS = {"sum", "mean"}
BUCKETS = {"month", "year"}
MAX_METRICS = 4
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


class PolicyError(Exception):
    """A request the policy refuses. `code` is stable and safe to show; `detail` never contains a data value."""

    def __init__(self, code: str, detail: str = ""):
        super().__init__(code)
        self.code = code
        self.detail = detail


def clean_text(text: Any, limit: int) -> str:
    """Strip control characters and cap the length. Data is untrusted: a cell can carry instructions for the model,
    so text is only ever returned inside structured JSON, never as free prose, and never longer than `limit`."""
    out = _CONTROL.sub("", str(text))
    return out if len(out) <= limit else out[:limit] + "…[truncated]"


def describe_dataset(ds: dict) -> dict:
    """Schema and flags only. No statistics and no values."""
    return {
        "id": ds["id"],
        "name": clean_text(ds.get("name", ""), 120),
        "rows": ds.get("rows"),
        "has_twin": ds.get("synthetic") is not None,
        "columns": [
            {"name": c["name"], "kind": c["kind"], "sensitive": bool(c.get("sensitive"))} for c in ds.get("columns", [])
        ],
    }


def twin_sample(twin: dict, limit: int, cell_limit: int = 80) -> dict:
    rows = [[None if v is None else clean_text(v, cell_limit) for v in r] for r in twin["rows"][:limit]]
    return {"columns": twin["columns"], "rows": rows, "rows_returned": len(rows), "synthetic": True}


def validate_aggregate(
    columns: list[dict],
    group_by: list[str],
    metrics: list[dict],
    time_bucket: str,
    max_group_by: int,
) -> dict:
    """Checks an aggregate request against the dataset's own schema and returns the normalised spec."""
    by_name = {c["name"]: c for c in columns}
    if not group_by:
        raise PolicyError("group_by_required", "Name at least one column to group by.")
    if len(group_by) > max_group_by:
        raise PolicyError("too_many_group_by", f"At most {max_group_by} group-by columns.")
    if len(set(group_by)) != len(group_by):
        raise PolicyError("duplicate_group_by")
    if time_bucket not in BUCKETS:
        raise PolicyError("invalid_time_bucket", "time_bucket is 'month' or 'year'.")
    datetimes: list[str] = []
    for name in group_by:
        col = by_name.get(name)
        if col is None:
            raise PolicyError("unknown_column", "A group-by column is not in this dataset.")
        if col.get("sensitive") or col["kind"] not in GROUPABLE:
            raise PolicyError("column_not_groupable", "Only non-sensitive categorical, boolean or datetime columns.")
        if col["kind"] == "datetime":
            datetimes.append(name)
    if len(metrics) > MAX_METRICS:
        raise PolicyError("too_many_metrics", f"At most {MAX_METRICS} metrics.")
    spec_metrics = []
    for m in metrics:
        name, op = m.get("column"), m.get("op")
        col = by_name.get(name) if isinstance(name, str) else None
        if col is None:
            raise PolicyError("unknown_column", "A metric column is not in this dataset.")
        if op not in OPS:
            raise PolicyError("invalid_op", "Operations are 'sum' and 'mean'. Row counts are always included.")
        if col.get("sensitive") or col["kind"] not in NUMERIC:
            raise PolicyError("column_not_numeric", "Metrics need a non-sensitive numeric column.")
        spec_metrics.append({"column": name, "op": op})
    return {"group_by": group_by, "datetime": datetimes, "bucket": time_bucket, "metrics": spec_metrics}


_SCRIPT = '''import json
import pandas as pd

SPEC = json.loads({literal})
LIMIT = {limit}
df = pd.read_csv(DATA_PATH)
keys = []
for name in SPEC["group_by"]:
    col = "k_" + name
    if name in SPEC["datetime"]:
        stamp = pd.to_datetime(df[name], errors="coerce")
        df[col] = stamp.dt.to_period("Y" if SPEC["bucket"] == "year" else "M").astype("string")
    else:
        df[col] = df[name].astype("string")
    df[col] = df[col].fillna("(missing)")
    keys.append(col)
groups = df.groupby(keys, dropna=False)
if groups.ngroups > LIMIT:
    print(json.dumps({{"error": "too_many_groups"}}))
else:
    rows = []
    for key, part in groups:
        key = key if isinstance(key, tuple) else (key,)
        row = {{"group": [str(k) for k in key], "n": int(len(part)), "m": []}}
        for m in SPEC["metrics"]:
            vals = pd.to_numeric(part[m["column"]], errors="coerce")
            seen = int(vals.notna().sum())
            if seen == 0:
                row["m"].append({{"c": 0, "v": None}})
            else:
                total = float(vals.sum()) if m["op"] == "sum" else float(vals.mean())
                row["m"].append({{"c": seen, "v": total}})
        rows.append(row)
    print(json.dumps({{"rows": rows}}))
'''


def build_script(spec: dict, max_groups: int) -> str:
    """The only code that ever runs against real data on behalf of the model. Column names are validated against
    the dataset first and enter the script as a JSON string literal, so they cannot change its structure."""
    literal = json.dumps(json.dumps(spec))
    return _SCRIPT.format(literal=literal, limit=int(max_groups) * 4)


def shape_aggregate(stdout: str, spec: dict, min_group: int, max_groups: int, cell_limit: int = 80) -> dict:
    """Turns the script's output into what the model may see: groups of at least `min_group` rows only, metric values
    only where at least `min_group` non-empty values contributed, everything else counted and dropped."""
    try:
        raw = json.loads(stdout)
    except (ValueError, TypeError) as exc:
        raise PolicyError("aggregate_failed", "The aggregate script did not return a result.") from exc
    if raw.get("error") == "too_many_groups":
        raise PolicyError("too_many_groups", "That grouping has too many distinct values. Use a coarser column.")
    kept, suppressed = [], 0
    for row in raw.get("rows", []):
        if row["n"] < min_group:
            suppressed += 1
            continue
        metrics = {}
        for m, cfg in zip(row["m"], spec["metrics"]):
            label = f"{cfg['op']}({cfg['column']})"
            metrics[label] = round(m["v"], 2) if m["v"] is not None and m["c"] >= min_group else None
        key = {name: clean_text(val, cell_limit) for name, val in zip(spec["group_by"], row["group"])}
        kept.append({"group": key, "count": row["n"], "metrics": metrics})
    kept.sort(key=lambda g: -g["count"])
    return {
        "groups": kept[:max_groups],
        "groups_returned": min(len(kept), max_groups),
        "groups_suppressed": suppressed,
        "min_group": min_group,
        "note": f"Groups with fewer than {min_group} rows are not shown. A null metric means too few values.",
    }
