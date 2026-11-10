"""Server-side encrypted store: placeholder mappings, review originals and review items.

Raw sensitive values only ever reach disk Fernet-encrypted. Lookups for stable
placeholders use an HMAC blind index so equal values map to the same placeholder
without storing them in clear.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import random
import re
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from cryptography.fernet import Fernet

from . import synth as syn

PLACEHOLDER_RE = re.compile(r"<([A-Z][A-Z_]*)_(\d{3,})>")


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Vault:
    def __init__(self, data_dir: Path, key: str):
        Path(data_dir).mkdir(parents=True, exist_ok=True)
        self._fernet = Fernet(key.encode())
        self._hmac_key = hashlib.sha256(b"nmb-hmac:" + key.encode()).digest()
        self._lock = threading.RLock()
        self._db = sqlite3.connect(str(Path(data_dir) / "vault.db"), check_same_thread=False)
        self._db.executescript(
            """
            CREATE TABLE IF NOT EXISTS mappings(
              conversation_id TEXT NOT NULL, entity TEXT NOT NULL, blind TEXT NOT NULL,
              placeholder TEXT NOT NULL, enc_value BLOB, created TEXT NOT NULL,
              PRIMARY KEY(conversation_id, entity, blind));
            CREATE UNIQUE INDEX IF NOT EXISTS ix_ph ON mappings(conversation_id, placeholder);
            CREATE TABLE IF NOT EXISTS blobs(ref TEXT PRIMARY KEY, enc BLOB NOT NULL, created TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY, status TEXT, department TEXT,
              created TEXT, json TEXT NOT NULL);
            """
        )

    # --- hashing -----------------------------------------------------------
    def blind(self, conversation_id: str, entity: str, norm_value: str) -> str:
        msg = f"{conversation_id}\x1f{entity}\x1f{norm_value}".encode()
        return hmac.new(self._hmac_key, msg, hashlib.sha256).hexdigest()

    def value_hash(self, entity: str, norm_value: str) -> str:
        """Keyed, non-reversible short hash for logs and finding records."""
        return hmac.new(self._hmac_key, f"{entity}\x1f{norm_value}".encode(), hashlib.sha256).hexdigest()[:12]

    # --- mappings ----------------------------------------------------------
    def get_or_create_placeholder(self, conversation_id, entity, prefix, norm_value, raw_value, reversible) -> str:
        b = self.blind(conversation_id, entity, norm_value)
        with self._lock:
            row = self._db.execute(
                "SELECT placeholder FROM mappings WHERE conversation_id=? AND entity=? AND blind=?",
                (conversation_id, entity, b)).fetchone()
            if row:
                return row[0]
            rows = self._db.execute(
                "SELECT placeholder FROM mappings WHERE conversation_id=?", (conversation_id,)).fetchall()
            rx = re.compile(rf"^<{re.escape(prefix)}_\d{{3,}}>$")
            n = sum(1 for (p_,) in rows if rx.match(p_)) + 1
            ph = f"<{prefix}_{n:03d}>"
            enc = self._fernet.encrypt(raw_value.encode()) if reversible else None
            self._db.execute("INSERT INTO mappings VALUES(?,?,?,?,?,?)",
                             (conversation_id, entity, b, ph, enc, now()))
            self._db.commit()
            return ph

    def lookup_placeholder(self, conversation_id: str, placeholder: str) -> str | None:
        with self._lock:
            row = self._db.execute(
                "SELECT enc_value FROM mappings WHERE conversation_id=? AND placeholder=?",
                (conversation_id, placeholder)).fetchone()
        if not row or row[0] is None:
            return None
        return self._fernet.decrypt(row[0]).decode()

    # --- synthetic mappings --------------------------------------------------
    # Stored in the same table: entity "SYN:<ENTITY>", the fake as `placeholder`, and the real value Fernet-encrypted
    # only for reversible entities. Token rows are never touched, so one value can have both a token and a fake.
    def synthetic_rng(self, scope: str, entity: str, norm_value: str, attempt: int = 0) -> random.Random:
        msg = f"synthetic\x1f{scope}\x1f{entity}\x1f{norm_value}\x1f{attempt}".encode()
        return random.Random(int.from_bytes(hmac.new(self._hmac_key, msg, hashlib.sha256).digest(), "big"))

    def get_or_create_synthetic(self, conversation_id: str, entity: str, norm_value: str, raw_value: str,
                                reversible: bool, is_real: Callable[[str, str], bool] | None = None) -> str:
        """The fake for a value, stable within the scope. It never equals a real value (`is_real(entity, candidate)`)
        nor an existing mapping key; either case is regenerated from the next deterministic attempt."""
        key_entity = "SYN:" + entity
        b = self.blind(conversation_id, key_entity, norm_value)
        with self._lock:
            row = self._db.execute(
                "SELECT placeholder FROM mappings WHERE conversation_id=? AND entity=? AND blind=?",
                (conversation_id, key_entity, b)).fetchone()
            if row and not (is_real and is_real(entity, row[0])):
                return row[0]
            enc = self._fernet.encrypt(raw_value.encode()) if reversible else None
            for attempt in range(80):
                cand = syn.fake(entity, raw_value, self.synthetic_rng(conversation_id, entity, norm_value, attempt))
                if cand == raw_value or (is_real and is_real(entity, cand)):
                    continue
                if self._db.execute("SELECT 1 FROM mappings WHERE conversation_id=? AND placeholder=?",
                                    (conversation_id, cand)).fetchone():
                    continue
                if row:
                    self._db.execute(
                        "UPDATE mappings SET placeholder=?, enc_value=? WHERE conversation_id=? AND entity=? AND blind=?",
                        (cand, enc, conversation_id, key_entity, b))
                else:
                    self._db.execute("INSERT INTO mappings VALUES(?,?,?,?,?,?)",
                                     (conversation_id, key_entity, b, cand, enc, now()))
                self._db.commit()
                return cand
        raise ValueError("could not generate a distinct synthetic value")

    def restore_text(self, conversation_id: str, text: str, synthetic: bool = False) -> tuple[str, int, list[str]]:
        """Restores `<TYPE_nnn>` tokens and, when asked, synthetic values issued for this scope.

        Synthetic values match exactly, longest first, and only as whole tokens (a fake inside a longer word is left
        alone). One pass, so a restored value is never re-scanned. Returns (text, restored count, unresolved tokens).
        """
        fakes: dict[str, str] = {}
        if synthetic:
            with self._lock:
                rows = self._db.execute(
                    "SELECT placeholder, enc_value FROM mappings WHERE conversation_id=? AND entity LIKE 'SYN:%' "
                    "AND enc_value IS NOT NULL", (conversation_id,)).fetchall()
            fakes = {p: self._fernet.decrypt(e).decode() for p, e in rows if p in text}
        parts = [PLACEHOLDER_RE.pattern]
        if fakes:
            alt = "|".join(re.escape(f) for f in sorted(fakes, key=len, reverse=True))
            parts.append(rf"(?<![A-Za-z0-9_])(?:{alt})(?![A-Za-z0-9_])")
        restored, unresolved = 0, []

        def sub(m: re.Match) -> str:
            nonlocal restored
            tok = m.group(0)
            if tok in fakes:
                restored += 1
                return fakes[tok]
            v = self.lookup_placeholder(conversation_id, tok) if tok.startswith("<") else None
            if v is None:
                if tok.startswith("<"):
                    unresolved.append(tok)
                return tok
            restored += 1
            return v

        return re.sub("|".join(parts), sub, text), restored, sorted(set(unresolved))

    def delete_conversation(self, conversation_id: str) -> int:
        with self._lock:
            cur = self._db.execute("DELETE FROM mappings WHERE conversation_id=?", (conversation_id,))
            self._db.commit()
            return cur.rowcount

    # --- encrypted blobs ---------------------------------------------------
    def put_blob(self, obj) -> str:
        ref = "blob_" + uuid.uuid4().hex
        with self._lock:
            self._db.execute("INSERT INTO blobs VALUES(?,?,?)",
                             (ref, self._fernet.encrypt(json.dumps(obj).encode()), now()))
            self._db.commit()
        return ref

    def get_blob(self, ref: str):
        with self._lock:
            row = self._db.execute("SELECT enc FROM blobs WHERE ref=?", (ref,)).fetchone()
        return json.loads(self._fernet.decrypt(row[0])) if row else None

    # --- review items (metadata only; no raw values) -------------------------
    def save_review(self, item: dict) -> None:
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO reviews VALUES(?,?,?,?,?)",
                (item["id"], item["status"], item.get("department"), item["created_at"], json.dumps(item)))
            self._db.commit()

    @staticmethod
    def _item(raw: str) -> dict:
        item = json.loads(raw)
        item.setdefault("mode", None)          # set at approval
        item.setdefault("released_at", None)   # set once the owner's chat has sent the approved prompt
        return item

    def get_review(self, rid: str) -> dict | None:
        with self._lock:
            row = self._db.execute("SELECT json FROM reviews WHERE id=?", (rid,)).fetchone()
        return self._item(row[0]) if row else None

    def list_reviews(self, status=None, department=None, user=None) -> list[dict]:
        q, args = "SELECT json FROM reviews WHERE 1=1", []
        if status:
            q += " AND status=?"; args.append(status)
        if department:
            q += " AND department=?"; args.append(department)
        q += " ORDER BY created DESC"
        with self._lock:
            rows = self._db.execute(q, args).fetchall()
        items = [self._item(r[0]) for r in rows]
        if user:
            items = [i for i in items if i.get("user") == user]
        return items
