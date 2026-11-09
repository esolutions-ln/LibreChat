"""Static validation and constrained execution of analyst/LLM-written pandas code.

Defence in depth, not a security boundary on its own: (1) AST allow-list, (2) child process with cleared env,
self-applied rlimits, wall-clock timeout, own session, (3) a PEP 578 audit hook in the child that blocks
sockets, process creation and any file access outside the run directory and the Python/system library
roots. Deploy the scanner on a network-less (`internal`) network with a memory limit as well.

The harness injects three globals for user code: DATA_PATH, OUTPUT_DIR and `save_chart(spec, name="chart")`, which
writes a ChartSpec to OUTPUT_DIR/<name>.chart.json without the code needing open() or os (see charts.py).
"""
from __future__ import annotations

import ast
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

from . import charts

FORBIDDEN_BUILTINS = {"open", "eval", "exec", "compile", "__import__", "input", "breakpoint", "globals",
                      "locals", "vars", "getattr", "setattr", "delattr", "memoryview"}
FORBIDDEN_ATTRS = {"eval", "exec", "query", "system", "popen", "read_pickle", "to_pickle", "read_clipboard",
                   "to_clipboard", "read_sql", "read_sql_query", "read_sql_table", "to_sql", "read_html",
                   "read_hdf", "read_feather", "read_parquet", "read_excel", "read_orc", "read_sas",
                   "read_spss", "read_stata", "read_xml", "load", "loadtxt", "fromfile", "memmap"}
OUT_EXT = {".csv": "csv", ".json": "json", ".html": "html", ".png": "png", ".txt": "txt"}
_FILE_NAME = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$")
_PATH = re.compile(r"(?:/[\w.+@=-]+){2,}")


def kind_of(name: str) -> str:
    """The run-file kind reported to clients: `chart` for `*.chart.json`, otherwise by extension."""
    return "chart" if charts.is_chart(name) else OUT_EXT[os.path.splitext(name)[1].lower()]


def validate(code: str, allowed_imports: list[str]) -> list[str]:
    """Rule ids with line numbers only (`import_not_allowed@L3`); never any source text."""
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        return [f"syntax_error@L{e.lineno or 0}"]
    allowed = set(allowed_imports)
    found: set[str] = set()
    for node in ast.walk(tree):
        line = getattr(node, "lineno", 0)
        if isinstance(node, ast.Import):
            if any(a.name.split(".")[0] not in allowed for a in node.names):
                found.add(f"import_not_allowed@L{line}")
        elif isinstance(node, ast.ImportFrom):
            if node.level or (node.module or "").split(".")[0] not in allowed:
                found.add(f"import_not_allowed@L{line}")
        elif isinstance(node, ast.Name):
            if node.id in FORBIDDEN_BUILTINS:
                found.add(f"forbidden_builtin@L{line}")
            elif node.id.startswith("__"):
                found.add(f"dunder_access@L{line}")
        elif isinstance(node, ast.Attribute):
            if node.attr.startswith("__"):
                found.add(f"dunder_access@L{line}")
            elif node.attr in FORBIDDEN_ATTRS:
                found.add(f"forbidden_attribute@L{line}")
    return sorted(found, key=lambda v: (int(v.split("@L")[1]), v))


# Runs inside the child. Keep it self-contained (the child is `python -I harness.py ...`).
_HARNESS = r'''
import json, os, re, sys, traceback

_CHART_NAME = re.compile(r"[A-Za-z0-9_-]{1,40}")

def _plain(o):
    # numpy/pandas scalars and arrays serialise through tolist(); anything else is a clear error
    if hasattr(o, "tolist"):
        return o.tolist()
    raise TypeError("save_chart: spec contains a value that is not plain data")

def main():
    data_path, out_dir, code_path, workdir, cfg = sys.argv[1:6]
    cfg = json.loads(cfg)
    try:
        import resource
        for name, val in (("RLIMIT_CPU", cfg["cpu_s"]), ("RLIMIT_AS", cfg["memory_bytes"]),
                          ("RLIMIT_FSIZE", cfg["fsize_bytes"]), ("RLIMIT_NOFILE", 256), ("RLIMIT_CORE", 0)):
            try:
                resource.setrlimit(getattr(resource, name), (val, val))
            except (ValueError, OSError, AttributeError):
                pass
    except ImportError:
        pass
    import sysconfig
    import numpy, pandas
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot  # builds the font cache now: it scans user font dirs, which the hook denies
    src =open(code_path, encoding="utf-8").read()
    code = compile(src, "<analysis>", "exec")
    real = os.path.realpath
    roots = {sys.prefix, sys.base_prefix, sys.exec_prefix, sys.base_exec_prefix, *sysconfig.get_paths().values(),
             "/usr", "/lib", "/lib64", "/System", "/Library", "/opt", "/etc/localtime", "/etc/ssl", "/proc/self",
             "/proc/meminfo", "/proc/cpuinfo", "/sys/devices/system/cpu", "/sys/fs/cgroup", "/dev/null",
             "/dev/urandom", "/dev/random", "/private/var/db/timezone"}
    R = tuple(sorted({real(r) for r in roots if r and os.path.isabs(r)}))
    W = real(workdir)
    def inside(p, bases):
        return any(p == b or p.startswith(b.rstrip(os.sep) + os.sep) for b in bases)
    def path_of(x):
        if isinstance(x, int) or x is None:
            return None
        try:
            return real(os.fsdecode(x))
        except Exception:
            return None
    DENY = {"socket.__new__", "socket.connect", "socket.bind", "socket.sendto", "socket.getaddrinfo",
            "socket.gethostbyname", "socket.gethostbyaddr", "subprocess.Popen", "os.system", "os.exec",
            "os.posix_spawn", "os.spawn", "os.fork", "os.forkpty", "os.kill", "os.killpg", "ctypes.dlopen"}
    WRITE = {"os.remove", "os.rename", "os.mkdir", "os.rmdir", "os.chmod", "os.chown", "os.truncate",
             "os.utime", "os.symlink", "os.link", "shutil.rmtree", "shutil.copyfile", "shutil.move",
             "shutil.copytree", "os.mkfifo", "os.mknod"}
    READ = {"os.listdir", "os.scandir", "glob.glob", "os.walk"}
    def hook(event, args):
        if event == "open":
            p = path_of(args[0])
            if p is None:
                return
            mode, flags = args[1], args[2]
            write = (isinstance(mode, str) and any(c in mode for c in "wax+")) or (
                isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND))
            if not (inside(p, [W]) or (not write and inside(p, R))):
                raise PermissionError("blocked by sandbox policy")
        elif event in DENY:
            raise PermissionError("blocked by sandbox policy")
        elif event in WRITE:
            for a in args[:2]:
                p = path_of(a)
                if p is not None and not inside(p, [W]):
                    raise PermissionError("blocked by sandbox policy")
        elif event in READ:
            p = path_of(args[0]) if args else None
            if p is not None and not (inside(p, [W]) or inside(p, R)):
                raise PermissionError("blocked by sandbox policy")
    sys.addaudithook(hook)
    saved = {"n": 0}
    def save_chart(spec, name="chart"):
        """Writes OUTPUT_DIR/<name>.chart.json. The scanner validates it as a ChartSpec after the run."""
        if not isinstance(spec, dict):
            raise ValueError("save_chart: spec must be a dict")
        if not isinstance(name, str) or not _CHART_NAME.fullmatch(name):
            raise ValueError("save_chart: name must match [A-Za-z0-9_-]{1,40}")
        if saved["n"] >= cfg["max_charts"]:
            raise ValueError("save_chart: at most %d charts per run" % cfg["max_charts"])
        text = json.dumps(spec, default=_plain)
        if len(text.encode("utf-8")) > cfg["max_chart_bytes"]:
            raise ValueError("save_chart: spec is larger than %d bytes" % cfg["max_chart_bytes"])
        with open(os.path.join(out_dir, name + ".chart.json"), "w", encoding="utf-8") as f:
            f.write(text)
        saved["n"] += 1
    g = {"__name__": "__main__", "DATA_PATH": data_path, "OUTPUT_DIR": out_dir, "save_chart": save_chart}
    try:
        exec(code, g)
    except SystemExit:
        pass
    except BaseException:
        traceback.print_exc(file=sys.stderr)
        sys.stderr.flush()
        sys.stdout.flush()
        os._exit(1)
    sys.stdout.flush()

main()
'''


def _clean_stderr(text: str, cap: int, hide: list[str]) -> str:
    for h in hide:
        if h:
            text = text.replace(h, "<dir>")
    text = _PATH.sub(lambda m: "<path>/" + m.group(0).rsplit("/", 1)[-1], text)
    lines = text.strip().splitlines()[-40:]
    return "\n".join(lines)[-cap:]


def _drain(stream, cap: int, sink: list[bytes]) -> None:
    kept = 0
    while True:
        chunk = stream.read(65536)
        if not chunk:
            return
        if kept < cap:
            sink.append(chunk[: cap - kept])
            kept += len(chunk[: cap - kept])


def _collect(out_dir: Path, limits: dict) -> dict[str, bytes]:
    files: dict[str, bytes] = {}
    total = 0
    for entry in sorted(os.scandir(out_dir), key=lambda e: e.name):
        if len(files) >= limits["max_output_files"] or not entry.is_file(follow_symlinks=False):
            continue
        ext = os.path.splitext(entry.name)[1].lower()
        size = entry.stat(follow_symlinks=False).st_size
        if ext not in OUT_EXT or not _FILE_NAME.match(entry.name) or size > limits["max_output_file_bytes"]:
            continue
        if total + size > 4 * limits["max_output_file_bytes"]:
            continue
        files[entry.name] = Path(entry.path).read_bytes()
        total += size
    return files


def run(code: str, csv_bytes: bytes, limits: dict) -> dict:
    """Execute already-validated `code` against `csv_bytes`. The decrypted CSV exists only in a 0700 temp dir."""
    work = Path(tempfile.mkdtemp(prefix="nmbrun_"))
    try:
        os.chmod(work, 0o700)
        out_dir = work / "out"
        for d in (out_dir, work / "tmp", work / "mpl"):
            d.mkdir()
        data = work / "data.csv"
        data.write_bytes(csv_bytes)
        os.chmod(data, 0o600)
        (work / "code.py").write_text(code, encoding="utf-8")
        (work / "harness.py").write_text(_HARNESS, encoding="utf-8")
        timeout = float(limits["timeout_s"])
        cfg = {"cpu_s": int(timeout) + 2, "memory_bytes": int(limits["memory_mb"]) * 1024 * 1024,
               "fsize_bytes": int(limits["max_output_file_bytes"]),
               "max_charts": int(limits.get("max_charts", 5)),
               "max_chart_bytes": int(limits.get("max_chart_bytes", 65_536))}
        env = {"PATH": "/usr/bin:/bin", "HOME": str(work), "TMPDIR": str(work / "tmp"),
               "MPLCONFIGDIR": str(work / "mpl"), "MPLBACKEND": "Agg", "PYTHONHASHSEED": "0",
               "PYTHONDONTWRITEBYTECODE": "1", "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1",
               "MKL_NUM_THREADS": "1", "LC_ALL": "C.UTF-8"}
        started = time.monotonic()
        proc = subprocess.Popen(
            [sys.executable, "-I", str(work / "harness.py"), str(data), str(out_dir), str(work / "code.py"),
             str(work), json.dumps(cfg)],
            cwd=str(out_dir), env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            start_new_session=True)
        cap = int(limits["max_output_bytes"])
        so: list[bytes] = []
        se: list[bytes] = []
        threads = [threading.Thread(target=_drain, args=(proc.stdout, cap, so), daemon=True),
                   threading.Thread(target=_drain, args=(proc.stderr, cap, se), daemon=True)]
        for t in threads:
            t.start()
        status = "ok"
        try:
            rc = proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            status, rc = "timeout", None
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                proc.kill()
            proc.wait()
        for t in threads:
            t.join(timeout=2)
        stdout = b"".join(so).decode("utf-8", "replace")
        stderr = _clean_stderr(b"".join(se).decode("utf-8", "replace"), cap, [str(work), sys.prefix, sys.base_prefix])
        if status == "ok" and rc != 0:
            status = "error"
            if rc is not None and rc < 0:
                stderr = (stderr + f"\nProcess terminated by signal {-rc} (resource limit).").strip()
        # Failed runs (limits can leave truncated files) return no files.
        files = _collect(out_dir, limits) if status == "ok" else {}
        if files:
            files, rejected = charts.finalize(files, int(limits.get("max_charts", 5)),
                                              int(limits.get("max_chart_bytes", 65_536)))
            if rejected:
                stderr = (stderr + "\n" + "\n".join(rejected)).strip()
        return {"status": status, "stdout": stdout, "stderr": stderr, "files": files,
                "duration_ms": int((time.monotonic() - started) * 1000)}
    finally:
        shutil.rmtree(work, ignore_errors=True)
