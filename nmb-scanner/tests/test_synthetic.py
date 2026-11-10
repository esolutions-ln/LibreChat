"""Synthetic approval of held prompts (docs/nmb/SYNTHETIC.md, "Scanner")."""
import random
import re

import pytest

from app import main, synth
from app.recognizers import _ssn_validator, iban_ok, luhn_ok

SCOPE = "u:user-1"
SAMPLE = ("Wire from Project Falcon: account 1234567890123, IBAN GB82 WEST 1234 5698 7654 32, SWIFT ABCDZWHX, "
          "phone +263 77 123 4567, id 63-123456 A 12, ssn 123-45-6789, card 4111 1111 1111 1111, "
          "mail jane.doe@example.com, key sk-ant-ABCDEFGHIJKLMNOPQRSTUV1234")
REAL_VALUES = ["1234567890123", "GB82 WEST 1234 5698 7654 32", "GB82WEST12345698765432", "ABCDZWHX",
               "+263 77 123 4567", "63-123456 A 12", "123-45-6789", "4111 1111 1111 1111", "4111111111111111",
               "jane.doe@example.com", "sk-ant-ABCDEFGHIJKLMNOPQRSTUV1234", "Project Falcon"]
REVERSIBLE = 8   # account, iban, swift, phone, national id, ssn, email, org keyword (not the card or the key)


def shape(s: str) -> str:
    return "".join("9" if c.isdigit() else "A" if c.isupper() else "a" if c.islower() else c for c in s)


def rng(seed=1):
    return random.Random(seed)


def held(client, text=SAMPLE, scope=SCOPE, user="user-1"):
    res = client.post("/scan/text", json={"text": text, "conversation_id": scope, "user": user,
                                          "roles": ["user"]}).json()
    assert res["decision"] == "review" and res["review_id"], res
    return res["review_id"]


def approve(client, rid, **extra):
    return client.post(f"/reviews/{rid}/approve-masked",
                       json={"reviewer": "asmith", "roles": ["reviewer"], **extra})


def unmask(client, text, scope=SCOPE, synthetic=False, roles=("user",)):
    return client.post("/unmask", json={"conversation_id": scope, "text": text, "roles": list(roles),
                                        "synthetic": synthetic})


@pytest.fixture()
def vault(client):
    return main.get_scanner().vault


# ---- the generator: every entity keeps its shape and never the real value ---------------------
SHAPED = [
    ("ACCOUNT_NUMBER", "1234567890123"), ("ACCOUNT_NUMBER", "1234 5678 9012"), ("ACCOUNT_NUMBER", "1234-5678-9012"),
    ("PHONE", "+263 77 123 4567"), ("PHONE", "0772 123 456"), ("PHONE", "00263-77-123-4567"),
    ("IBAN", "GB82 WEST 1234 5698 7654 32"), ("IBAN", "GB82WEST12345698765432"),
    ("SWIFT_BIC", "ABCDZWHX"), ("SWIFT_BIC", "ABCDZWHX123"),
    ("CREDIT_CARD", "4111 1111 1111 1111"), ("CREDIT_CARD", "4111111111111111"), ("CREDIT_CARD", "4111-1111-1111-1111"),
    ("ZW_NATIONAL_ID", "63-123456 A 12"), ("ZW_NATIONAL_ID", "63123456A12"),
    ("US_SSN", "123-45-6789"),
    ("API_KEY_SECRET", "sk-ant-ABCDEFGHIJKLMNOPQRSTUV1234"), ("API_KEY_SECRET", "AKIAIOSFODNN7EXAMPLE"),
    ("PRIVATE_KEY", "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----"),
    ("CUSTOM_THING", "Alpha-77 beta_9"),
]


@pytest.mark.parametrize("entity, value", SHAPED)
def test_fake_keeps_the_shape_and_is_not_the_real_value(entity, value):
    out = synth.fake(entity, value, rng())
    assert out != value and len(out) == len(value)
    assert shape(out) == shape(value) or entity == "US_SSN"
    assert "<" not in out and ">" not in out


def test_phone_keeps_its_prefix():
    assert synth.fake("PHONE", "+263 77 123 4567", rng()).startswith("+263 ")
    assert synth.fake("PHONE", "0772 123 456", rng()).startswith("07")
    assert synth.fake("PHONE", "00263-77-123-4567", rng()).startswith("00263-")


def test_iban_keeps_country_and_length_and_stays_valid():
    out = synth.fake("IBAN", "GB82 WEST 1234 5698 7654 32", rng())
    assert out.startswith("GB") and out.count(" ") == 5 and iban_ok(out) and out != "GB82 WEST 1234 5698 7654 32"


def test_swift_keeps_the_country_code_position():
    assert synth.fake("SWIFT_BIC", "ABCDZWHX", rng())[4:6] == "ZW"


@pytest.mark.parametrize("seed", range(25))
def test_cards_are_luhn_valid_with_the_same_length_and_separators(seed):
    for real in ("4111 1111 1111 1111", "5500-0000-0000-0004", "340000000000009", "4111111111111111"):
        out = synth.fake("CREDIT_CARD", real, rng(seed))
        assert luhn_ok(re.sub(r"\D", "", out)) and shape(out) == shape(real) and out != real
        assert out[0] == real[0]


def test_ssn_is_a_valid_looking_ssn():
    for seed in range(30):
        out = synth.fake("US_SSN", "123-45-6789", rng(seed))
        assert re.fullmatch(r"\d{3}-\d{2}-\d{4}", out) and _ssn_validator(out)


def test_secrets_keep_only_character_classes_and_punctuation():
    real = "sk-ant-ABCDEFGHIJKLMNOPQRSTUV1234"
    out = synth.fake("API_KEY_SECRET", real, rng())
    assert shape(out) == shape(real)
    assert out[2] == "-" and out[6] == "-"   # punctuation stays; every letter and digit is new random content
    assert out[7:] != real[7:] and out[:2] != "sk"


def test_person_email_and_org_use_curated_values():
    p = synth.fake("PERSON", "Jane Moyo", rng())
    first, last = p.split()
    assert first in synth.FIRST and last in synth.LAST and p != "Jane Moyo"
    assert synth.fake("PERSON", "Tendai", rng()) in synth.FIRST
    assert synth.fake("PERSON", "JANE MOYO", rng()).isupper()
    e = synth.fake("EMAIL", "jane.doe@bank.co.zw", rng())
    assert re.fullmatch(r"[a-z]+\.[a-z]+@example\.org", e)
    o = synth.fake("ORG_KEYWORD", "Project Falcon", rng())
    assert re.fullmatch(r"Project [A-Z][a-z]+ [A-Z][a-z]+", o) and o != "Project Falcon"


def test_generation_is_deterministic_for_a_seed_and_varies_with_it():
    assert synth.fake("PERSON", "Jane Moyo", rng(4)) == synth.fake("PERSON", "Jane Moyo", rng(4))
    assert len({synth.fake("ACCOUNT_NUMBER", "1234567890123", rng(s)) for s in range(20)}) > 15


# ---- the vault: per-scope determinism, keys, collisions ---------------------------------------
def test_equal_values_get_equal_fakes_in_a_scope_and_different_ones_across_scopes(vault):
    a1 = vault.get_or_create_synthetic("scope-a", "ACCOUNT_NUMBER", "1234567890123", "1234567890123", True)
    a2 = vault.get_or_create_synthetic("scope-a", "ACCOUNT_NUMBER", "1234567890123", "1234 5678 90123", True)
    b = vault.get_or_create_synthetic("scope-b", "ACCOUNT_NUMBER", "1234567890123", "1234567890123", True)
    other = vault.get_or_create_synthetic("scope-a", "ACCOUNT_NUMBER", "9999999999999", "9999999999999", True)
    assert a1 == a2 and a1 != b and a1 != other


def test_a_fresh_vault_issues_the_same_fake_for_the_same_scope(vault, env):
    """Deterministic from the vault key: the same fake comes back even without the stored mapping."""
    first = vault.get_or_create_synthetic("scope-d", "PHONE", "263771234567", "+263 77 123 4567", True)
    vault._db.execute("DELETE FROM mappings WHERE conversation_id='scope-d'")
    assert vault.get_or_create_synthetic("scope-d", "PHONE", "263771234567", "+263 77 123 4567", True) == first


def test_mapping_is_stored_with_the_fake_as_key_and_real_value_encrypted_only_when_reversible(vault):
    acct = vault.get_or_create_synthetic("scope-m", "ACCOUNT_NUMBER", "1234567890123", "1234567890123", True)
    card = vault.get_or_create_synthetic("scope-m", "CREDIT_CARD", "4111111111111111", "4111111111111111", False)
    rows = dict(vault._db.execute(
        "SELECT placeholder, enc_value FROM mappings WHERE conversation_id='scope-m'").fetchall())
    assert rows[acct] is not None and b"1234567890123" not in rows[acct]
    assert vault._fernet.decrypt(rows[acct]).decode() == "1234567890123"
    assert rows[card] is None
    kinds = {r[0] for r in vault._db.execute("SELECT entity FROM mappings WHERE conversation_id='scope-m'")}
    assert kinds == {"SYN:ACCOUNT_NUMBER", "SYN:CREDIT_CARD"}


def test_a_fake_colliding_with_an_existing_key_is_regenerated(vault, monkeypatch):
    seq = iter(["FIXED-1", "FIXED-1", "FIXED-2"])
    monkeypatch.setattr(synth, "fake", lambda entity, raw, rng: next(seq))
    one = vault.get_or_create_synthetic("scope-c", "ACCOUNT_NUMBER", "AAA", "AAA", True)
    two = vault.get_or_create_synthetic("scope-c", "ACCOUNT_NUMBER", "BBB", "BBB", True)  # FIXED-1 is taken
    assert (one, two) == ("FIXED-1", "FIXED-2")


def test_a_fake_equal_to_a_real_value_is_regenerated(vault, monkeypatch):
    seq = iter(["1234567890123", "REAL-IN-TEXT", "SAFE-FAKE"])
    monkeypatch.setattr(synth, "fake", lambda entity, raw, rng: next(seq))
    out = vault.get_or_create_synthetic("scope-r", "ACCOUNT_NUMBER", "X", "1234567890123", True,
                                        is_real=lambda e, c: c in {"REAL-IN-TEXT"})
    assert out == "SAFE-FAKE"   # the real value itself and a real value elsewhere in the text were both skipped


def test_an_existing_fake_that_now_equals_a_real_value_is_replaced(vault):
    old = vault.get_or_create_synthetic("scope-e", "ACCOUNT_NUMBER", "1234567890123", "1234567890123", True)
    new = vault.get_or_create_synthetic("scope-e", "ACCOUNT_NUMBER", "1234567890123", "1234567890123", True,
                                        is_real=lambda e, c: c == old)
    assert new != old
    assert vault.get_or_create_synthetic("scope-e", "ACCOUNT_NUMBER", "1234567890123", "1234567890123", True) == new


# ---- approving in synthetic mode --------------------------------------------------------------
def test_synthetic_approval_replaces_every_finding_including_block_entities(client):
    rid = held(client)
    res = approve(client, rid, mode="synthetic")
    assert res.status_code == 200
    body = res.json()
    out = body["sanitized_content"]
    assert body["decision"] == "mask"
    for real in REAL_VALUES:
        assert real.lower() not in out.lower(), real
    assert "<" not in out and "sk-ant-" not in out and "Falcon" not in out and "jane" not in out.lower()
    assert len(body["findings"]) == 10 and {f["action"] for f in body["findings"]} == {"MASK"}
    fakes = [f["placeholder"] for f in body["findings"]]
    assert all(f and f in out for f in fakes) and len(set(fakes)) == len(fakes)
    assert re.search(r"[a-z]+\.[a-z]+@example\.org", out) and "Project " in out and "+263 " in out


def test_the_fake_never_equals_any_real_value_in_the_same_text(client):
    for i in range(8):
        text = SAMPLE.replace("1234567890123", f"123456789{i:04d}")
        rid = held(client, text, scope=f"u:other-{i}")
        body = approve(client, rid, mode="synthetic").json()
        reals = {m.lower() for m in re.findall(r"\d{13}", text)} | {r.lower() for r in REAL_VALUES}
        assert not any(r in body["sanitized_content"].lower() for r in reals)


def test_item_and_result_record_the_mode(client):
    rid = held(client)
    assert client.get(f"/reviews/{rid}").json()["mode"] is None
    approve(client, rid, mode="synthetic")
    assert client.get(f"/reviews/{rid}").json()["mode"] == "synthetic"
    result = client.get(f"/reviews/{rid}/result").json()
    assert result["mode"] == "synthetic" and result["status"] == "approved-masked"
    assert "@example.org" in result["sanitized_content"] and "<" not in result["sanitized_content"]


def test_default_mode_behaves_exactly_as_before(client):
    rid = held(client)
    body = approve(client, rid).json()
    out = body["sanitized_content"]
    assert body["decision"] == "mask" and "<SECRET_001>" in out and "<ACCOUNT_001>" in out and "<CARD_001>" in out
    assert "@example.org" not in out
    result = client.get(f"/reviews/{rid}/result").json()
    assert result["mode"] == "masked" and result["sanitized_content"] == out
    assert client.get(f"/reviews/{rid}").json()["mode"] == "masked"


def test_unknown_mode_is_rejected(client):
    rid = held(client)
    assert approve(client, rid, mode="invented").status_code == 422
    assert client.get(f"/reviews/{rid}").json()["status"] == "pending"


def test_synthetic_mappings_do_not_disturb_token_numbering(client):
    approve(client, held(client), mode="synthetic")
    res = client.post("/scan/text", json={"text": "pay account 7654321098765", "conversation_id": SCOPE,
                                          "user": "user-1", "roles": ["user"]}).json()
    assert res["sanitized_content"] == "pay account <ACCOUNT_001>"


def test_a_file_review_is_approved_synthetically_too(client):
    import io

    import openpyxl
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["Name", "Contact", "Credential"])
    ws.append(["Project Falcon", "jane.doe@example.com", "sk-ant-ABCDEFGHIJKLMNOPQRSTUV1234"])
    ws.append(["Settlement", "account 1234567890123", "card 4111 1111 1111 1111"])
    buf = io.BytesIO()
    wb.save(buf)
    res = client.post("/scan/file", files={"file": ("f.xlsx", buf.getvalue(), "application/vnd.ms-excel")},
                      data={"conversation_id": SCOPE, "user": "user-1", "roles": "user"}).json()
    assert res["decision"] == "review", res
    body = approve(client, res["review_id"], mode="synthetic").json()
    out = body["sanitized_content"]
    assert body["decision"] == "mask" and out.count("|") > 6          # still a markdown table
    for real in ["Project Falcon", "jane.doe@example.com", "sk-ant-ABCDEFGHIJKLMNOPQRSTUV1234", "1234567890123",
                 "4111 1111 1111 1111"]:
        assert real not in out, real
    assert "@example.org" in out and len(body["sanitized_segments"]) >= 6
    restored = unmask(client, out, synthetic=True).json()["text"]
    assert "Project Falcon" in restored and "jane.doe@example.com" in restored and "1234567890123" in restored


# ---- unmask ------------------------------------------------------------------------------------
def test_unmask_round_trip_restores_reversible_values_and_leaves_card_and_key_fakes(client):
    rid = held(client)
    body = approve(client, rid, mode="synthetic").json()
    out = body["sanitized_content"]
    by_entity = {f["entity"]: f["placeholder"] for f in body["findings"]}
    res = unmask(client, out, synthetic=True).json()
    assert res["restored"] == REVERSIBLE and res["unresolved"] == []
    for real in ["1234567890123", "GB82 WEST 1234 5698 7654 32", "ABCDZWHX", "+263 77 123 4567", "63-123456 A 12",
                 "123-45-6789", "jane.doe@example.com", "Project Falcon"]:
        assert real in res["text"], real
    assert by_entity["CREDIT_CARD"] in res["text"] and by_entity["API_KEY_SECRET"] in res["text"]
    assert "4111 1111 1111 1111" not in res["text"] and "sk-ant-ABCDEFGHIJKLMNOPQRSTUV1234" not in res["text"]


def test_unmask_without_synthetic_restores_tokens_only(client):
    masked = client.post("/scan/text", json={"text": "account 1234567890123", "conversation_id": SCOPE,
                                             "user": "user-1", "roles": ["user"]}).json()["sanitized_content"]
    assert masked == "account <ACCOUNT_001>"
    body = approve(client, held(client), mode="synthetic").json()
    fake_iban = next(f["placeholder"] for f in body["findings"] if f["entity"] == "IBAN")
    text = f"{masked} and {fake_iban}"
    plain = unmask(client, text, synthetic=False).json()
    assert plain["text"] == f"account 1234567890123 and {fake_iban}" and plain["restored"] == 1
    both = unmask(client, text, synthetic=True).json()
    assert both["text"] == "account 1234567890123 and GB82 WEST 1234 5698 7654 32" and both["restored"] == 2
    # the default (field omitted) is token-only
    omitted = client.post("/unmask", json={"conversation_id": SCOPE, "text": text, "roles": ["user"]}).json()
    assert omitted["text"] == plain["text"]


def test_unmask_needs_the_same_role_as_before(client):
    approve(client, held(client), mode="synthetic")
    assert unmask(client, "x", synthetic=True, roles=("guest",)).status_code == 403
    assert unmask(client, "x", synthetic=False, roles=("guest",)).status_code == 403


def test_only_values_issued_for_the_scope_are_restored(client):
    body = approve(client, held(client), mode="synthetic").json()
    fake = next(f["placeholder"] for f in body["findings"] if f["entity"] == "ACCOUNT_NUMBER")
    assert unmask(client, fake, scope="u:someone-else", synthetic=True).json()["text"] == fake


def test_fakes_are_restored_as_whole_tokens_only(client, vault):
    fake = vault.get_or_create_synthetic("scope-w", "ACCOUNT_NUMBER", "1234567890123", "1234567890123", True)
    res = unmask(client, f"in {fake}. inside A{fake}B and {fake}9 and x_{fake} ok {fake}", scope="scope-w",
                 synthetic=True).json()
    assert res["text"] == f"in 1234567890123. inside A{fake}B and {fake}9 and x_{fake} ok 1234567890123"
    assert res["restored"] == 2


def test_longest_fake_wins_and_restored_text_is_not_rescanned(client, vault):
    enc = vault._fernet.encrypt
    for fake, real in (("AB-12", "short"), ("AB-12-34", "long AB-12")):
        vault._db.execute("INSERT INTO mappings VALUES(?,?,?,?,?,?)",
                          ("scope-l", "SYN:CUSTOM", fake + "b", fake, enc(real.encode()), "now"))
    res = unmask(client, "AB-12-34 then AB-12", scope="scope-l", synthetic=True).json()
    assert res["text"] == "long AB-12 then short" and res["restored"] == 2


def test_the_same_fake_text_is_reproducible_after_a_second_approval_in_the_scope(client):
    first = approve(client, held(client), mode="synthetic").json()["sanitized_content"]
    second = approve(client, held(client), mode="synthetic").json()["sanitized_content"]
    assert first == second   # equal real values keep equal fakes inside one scope


# ---- release marker ----------------------------------------------------------------------------
def test_released_at_is_null_then_set_once_and_idempotent(client):
    rid = held(client)
    assert client.get(f"/reviews/{rid}").json()["released_at"] is None
    approve(client, rid, mode="synthetic")
    assert client.get(f"/reviews/{rid}/result").json()["released_at"] is None
    first = client.post(f"/reviews/{rid}/released")
    assert first.status_code == 200 and first.json()["id"] == rid
    stamp = first.json()["released_at"]
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T[\d:]+\+00:00", stamp)
    again = client.post(f"/reviews/{rid}/released").json()
    assert again["released_at"] == stamp and again["status"] == "approved-masked"
    assert client.get(f"/reviews/{rid}").json()["released_at"] == stamp
    assert client.get(f"/reviews/{rid}/result").json()["released_at"] == stamp
    assert [i["released_at"] for i in client.get("/reviews").json()["items"] if i["id"] == rid] == [stamp]


def test_released_for_an_unknown_review_is_404(client):
    assert client.post("/reviews/rev_000000000000/released").status_code == 404


def test_new_items_expose_released_at_and_mode_as_null(client):
    item = client.get(f"/reviews/{held(client)}").json()
    assert item["released_at"] is None and item["mode"] is None


def test_released_needs_the_service_key_when_one_is_configured(env, monkeypatch):
    monkeypatch.setenv("NMB_SERVICE_KEY", "secret-key")
    from fastapi.testclient import TestClient
    main.get_scanner.cache_clear()
    try:
        with TestClient(main.app) as c:
            rid = c.post("/scan/text", json={"text": SAMPLE, "conversation_id": SCOPE, "user": "u"},
                         headers={"X-NMB-Service-Key": "secret-key"}).json()["review_id"]
            assert c.post(f"/reviews/{rid}/released").status_code == 401
            assert c.post(f"/reviews/{rid}/released", headers={"X-NMB-Service-Key": "secret-key"}).status_code == 200
    finally:
        main.get_scanner.cache_clear()
