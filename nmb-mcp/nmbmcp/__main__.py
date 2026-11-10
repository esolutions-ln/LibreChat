"""Entry point: `python -m nmbmcp` (stdio) or `python -m nmbmcp --http` (streamable HTTP on /mcp)."""
from __future__ import annotations

import argparse
import logging
import sys

from .config import Settings
from .scanner import Scanner
from .server import build_server


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="nmb-mcp")
    parser.add_argument("--http", action="store_true", help="serve streamable HTTP instead of stdio")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8090)
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(message)s")
    cfg = Settings.from_env()
    if args.http and not cfg.server_token:
        parser.error("NMB_MCP_TOKEN is required to serve HTTP: the caller must be authenticated")
    if args.http and cfg.dev_user:
        parser.error("NMB_MCP_DEV_USER is for stdio only; unset it when serving HTTP")
    server = build_server(cfg, Scanner(cfg.scanner_url, cfg.service_key))
    if args.http:
        server.run("streamable-http", host=args.host, port=args.port)
    else:
        server.run("stdio")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
