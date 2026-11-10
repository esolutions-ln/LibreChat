"""Settings, read once from the environment. Every limit has a default that is safe for a first deployment."""
from __future__ import annotations

import os
from dataclasses import dataclass


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    return int(raw) if raw else default


@dataclass(frozen=True)
class Settings:
    scanner_url: str
    service_key: str
    # Authenticates the caller (LibreChat or the gateway); the caller names the end user in `user_header`.
    server_token: str
    user_header: str
    # Stdio/demo only: act as this user when no header is present. Never set it on a network listener.
    dev_user: str
    public_url: str
    # Smallest group a real-data aggregate may expose. Smaller groups are dropped, not rounded.
    min_group: int
    max_groups: int
    max_group_by: int
    sample_rows: int
    max_text: int
    rate_per_minute: int

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            scanner_url=os.environ.get("NMB_SCANNER_URL", "http://nmb-scanner:8088").rstrip("/"),
            service_key=os.environ.get("NMB_SERVICE_KEY", ""),
            server_token=os.environ.get("NMB_MCP_TOKEN", ""),
            user_header=os.environ.get("NMB_MCP_USER_HEADER", "x-nmb-user").lower(),
            dev_user=os.environ.get("NMB_MCP_DEV_USER", ""),
            public_url=os.environ.get("NMB_MCP_PUBLIC_URL", "").rstrip("/"),
            min_group=max(2, _int("NMB_MCP_MIN_GROUP", 10)),
            max_groups=_int("NMB_MCP_MAX_GROUPS", 50),
            max_group_by=_int("NMB_MCP_MAX_GROUP_BY", 2),
            sample_rows=_int("NMB_MCP_SAMPLE_ROWS", 20),
            max_text=_int("NMB_MCP_MAX_TEXT", 4000),
            rate_per_minute=_int("NMB_MCP_RATE_PER_MINUTE", 30),
        )
