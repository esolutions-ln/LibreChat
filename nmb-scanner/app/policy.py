from __future__ import annotations

import copy
from pathlib import Path

import yaml

ACTIONS = {"MASK", "BLOCK", "ALLOW"}

ANALYSIS_DEFAULTS: dict = {
    "enabled": True,
    "engine": "builtin",  # builtin | sdv (sdv only if installed)
    "max_upload_bytes": 26_214_400,
    "max_rows": 500_000,
    "max_columns": 500,
    "max_code_chars": 50_000,
    "timeout_s": 30,
    "memory_mb": 2048,
    "max_output_bytes": 200_000,
    "max_output_file_bytes": 5_242_880,
    "max_output_files": 20,
    "max_concurrent_runs": 2,
    "synthetic_max_rows": 1000,
    "synthetic_min_category_count": 5,
    "dataset_ttl_hours": 168,
    "run_ttl_hours": 72,
    "allowed_imports": ["pandas", "numpy", "math", "statistics", "datetime", "json", "re", "collections",
                        "itertools", "decimal", "matplotlib", "plotly"],
}


class Policy:
    def __init__(self, data: dict):
        self.data = data
        self.default_action = data.get("default_action", "MASK").upper()
        self.min_score = float(data.get("min_score", 0.4))
        self.max_findings = int(data.get("max_findings", 5000))
        self.entities: dict = data.get("entities", {})
        self.departments: dict = data.get("departments", {})
        self.files: dict = data.get("files", {})
        self.analysis: dict = {**ANALYSIS_DEFAULTS, **(data.get("analysis") or {})}
        self.unmask_roles = set(data.get("unmask", {}).get("allowed_roles", []))
        self.reviewer_roles = set(data.get("review", {}).get("reviewer_roles", ["reviewer", "admin"]))
        for name, cfg in self._all_entity_cfgs():
            act = cfg.get("action")
            if act is not None and act.upper() not in ACTIONS:
                raise ValueError(f"invalid action {act!r} for {name}")

    def _all_entity_cfgs(self):
        for n, c in self.entities.items():
            yield n, c
        for d in self.departments.values():
            for n, c in d.get("entities", {}).items():
                yield n, c

    @classmethod
    def load(cls, path: Path) -> "Policy":
        return cls(yaml.safe_load(Path(path).read_text()) or {})

    def entity_cfg(self, entity: str, department: str | None = None) -> dict:
        cfg = copy.deepcopy(self.entities.get(entity, {}))
        if department and department in self.departments:
            cfg.update(self.departments[department].get("entities", {}).get(entity, {}))
        cfg.setdefault("action", self.default_action)
        cfg["action"] = cfg["action"].upper()
        cfg.setdefault("type", "other")
        cfg.setdefault("prefix", entity)
        cfg.setdefault("reversible", True)
        cfg.setdefault("block_outcome", "review")
        return cfg

    def summary(self) -> dict:
        return {
            "default_action": self.default_action,
            "min_score": self.min_score,
            "entities": {k: {"action": v.get("action", self.default_action), "type": v.get("type")}
                         for k, v in self.entities.items()},
            "departments": list(self.departments),
            "files": self.files,
            "analysis": {"enabled": self.analysis["enabled"], "engine": self.analysis["engine"]},
        }
