"""Format-preserving fakes for synthetic approval (docs/nmb/SYNTHETIC.md, "Scanner").

`fake(entity, value, rng)` returns a realistic stand-in that keeps the shape of `value` (length, separators, digit and
letter positions) but none of its content. Secrets and keys are random tokens that keep only the character classes.
The caller supplies the RNG; the vault seeds it from an HMAC of (scope, entity, normalised value, attempt), so a value
always gets the same fake inside one scope and a collision can be resolved by retrying with the next attempt.
"""
from __future__ import annotations

import random
import re
import string

FIRST = (
    "Tendai", "Farai", "Chipo", "Tatenda", "Rudo", "Kudzai", "Nyasha", "Tafadzwa", "Ruvimbo", "Blessing", "Simbarashe",
    "Tinashe", "Chiedza", "Munashe", "Shamiso", "Anesu", "Panashe", "Vimbai", "Takudzwa", "Rutendo", "Thabo", "Nomsa",
    "Sipho", "Lindiwe", "Themba", "Zanele", "Mthunzi", "Nokuthula", "Bongani", "Ayanda", "Sizwe", "Thandiwe", "James",
    "Mary", "David", "Sarah", "Michael", "Grace", "Peter", "Ruth", "Daniel", "Esther", "Joseph", "Rebecca", "Samuel",
    "Naomi", "Andrew", "Patience", "Brian", "Memory", "Collen", "Precious", "Kelvin", "Faith", "Trevor", "Hazel",
    "Leon", "Tracy", "Martin", "Joyce", "Walter", "Irene", "Victor", "Lorraine", "Edmore", "Constance",
)
LAST = (
    "Moyo", "Ncube", "Sibanda", "Dube", "Ndlovu", "Nkomo", "Mpofu", "Khumalo", "Tshuma", "Mlambo", "Chikwanha", "Mutasa",
    "Chimbira", "Gumbo", "Makoni", "Mukamuri", "Zhou", "Marufu", "Chigumba", "Nyathi", "Mahlangu", "Masuku", "Mapfumo",
    "Mhlanga", "Banda", "Phiri", "Tembo", "Mwale", "Zulu", "Dlamini", "Nkosi", "Sithole", "Mokoena", "Molefe", "Naidoo",
    "Pillay", "Smith", "Jones", "Taylor", "Brown", "Wilson", "Clarke", "Hughes", "Walker", "Bennett", "Fraser", "Murray",
    "Hammond", "Foster", "Gordon", "Harvey", "Palmer", "Reid", "Stewart", "Wallace", "Webb", "Hartley", "Lawson",
)
ADJECTIVE = (
    "Amber", "Silver", "Crimson", "Quiet", "Northern", "Golden", "Swift", "Granite", "Coastal", "Ivory", "Scarlet",
    "Verdant", "Hollow", "Bright", "Distant", "Lucid", "Rustic", "Solar", "Velvet", "Wild", "Azure", "Cobalt", "Dusky",
    "Eastern", "Frosted", "Gentle", "Hidden", "Iron", "Jade", "Keen", "Lunar", "Misty", "Noble", "Opal", "Plain",
)
NOUN = (
    "Harbor", "Meadow", "Osprey", "Compass", "Lantern", "Summit", "Orchard", "Beacon", "Cedar", "Delta", "Ember",
    "Forge", "Glacier", "Horizon", "Island", "Junction", "Keystone", "Lagoon", "Mesa", "Nexus", "Oasis", "Pinnacle",
    "Quarry", "Ridge", "Spire", "Thicket", "Union", "Vista", "Willow", "Zenith", "Anchor", "Bridge", "Canyon", "Dune",
)
EMAIL_DOMAIN = "example.org"  # reserved by RFC 2606, so a fake address can never reach a real mailbox

_UP, _LOW, _DIG = string.ascii_uppercase, string.ascii_lowercase, string.digits


def _like(value: str, rng: random.Random, keep=lambda i, c: False) -> str:
    """Random characters in the same classes and positions; everything else is kept (`<` and `>` never are)."""
    out = []
    for i, c in enumerate(value):
        if keep(i, c):
            out.append(c)
        elif c in _DIG:
            out.append(rng.choice(_DIG))
        elif c in _UP:
            out.append(rng.choice(_UP))
        elif c in _LOW:
            out.append(rng.choice(_LOW))
        elif c in "<>":
            out.append("-")
        else:
            out.append(c)
    return "".join(out)


def _case_like(text: str, value: str) -> str:
    letters = [c for c in value if c.isalpha()]
    if letters and all(c.isupper() for c in letters):
        return text.upper()
    if letters and all(c.islower() for c in letters):
        return text.lower()
    return text


def luhn_digit(payload: str) -> str:
    total = 0
    for i, ch in enumerate(reversed(payload)):
        d = int(ch)
        if i % 2 == 0:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return str((10 - total % 10) % 10)


def _person(value: str, rng: random.Random) -> str:
    words = value.split()
    text = rng.choice(FIRST) if len(words) <= 1 else f"{rng.choice(FIRST)} {rng.choice(LAST)}"
    return _case_like(text, value)


def _email(value: str, rng: random.Random) -> str:
    return f"{rng.choice(FIRST).lower()}.{rng.choice(LAST).lower()}@{EMAIL_DOMAIN}"


def _phone(value: str, rng: random.Random) -> str:
    """Same prefix and digit grouping: a leading `+`/`00` country code is kept, otherwise the first two digits."""
    if value.startswith(("+", "00")):
        m = re.match(r"\+?\d+", value)
        kept = m.end() if m else 0
    else:
        kept, seen = 0, 0
        for i, c in enumerate(value):
            if c.isdigit():
                seen += 1
                if seen == 2:
                    kept = i + 1
                    break
    return _like(value, rng, keep=lambda i, c: i < kept)


def _digits_like(value: str, rng: random.Random) -> str:
    out = _like(value, rng)
    first = next((i for i, c in enumerate(value) if c.isdigit()), None)
    if first is not None and value[first] != "0" and out[first] == "0":
        out = out[:first] + str(rng.randrange(1, 10)) + out[first + 1:]
    return out


def _iban(value: str, rng: random.Random) -> str:
    compact = re.sub(r"\s", "", value)
    if len(compact) < 5 or not compact[:2].isalpha():
        return _like(value, rng)
    upper = compact.upper() == compact
    body = _like(compact[4:], rng)
    body = body if upper else body.lower()
    country = compact[:2]
    numeric = "".join(str(int(c, 36)) for c in (body + country + "00").upper())
    new = f"{country}{98 - int(numeric) % 97:02d}{body}"
    it = iter(new)
    return "".join(c if c.isspace() else next(it) for c in value)


def _swift(value: str, rng: random.Random) -> str:
    return _like(value, rng, keep=lambda i, c: i in (4, 5))  # the country code stays so the shape reads as a BIC


def _card(value: str, rng: random.Random) -> str:
    pos = [i for i, c in enumerate(value) if c.isdigit()]
    if len(pos) < 2:
        return _like(value, rng)
    digits = [value[pos[0]]] + [rng.choice(_DIG) for _ in pos[1:-1]]
    digits.append(luhn_digit("".join(digits)))
    out = list(value)
    for p, d in zip(pos, digits):
        out[p] = d
    return "".join(out)


def _ssn(value: str, rng: random.Random) -> str:
    area = rng.choice([a for a in range(1, 900) if a != 666])
    return f"{area:03d}-{rng.randrange(1, 100):02d}-{rng.randrange(1, 10000):04d}"


def _org(value: str, rng: random.Random) -> str:
    return _case_like(f"Project {rng.choice(ADJECTIVE)} {rng.choice(NOUN)}", value)


def _token(value: str, rng: random.Random) -> str:
    return _like(value, rng)


_BY_ENTITY = {
    "PERSON": _person, "EMAIL": _email, "PHONE": _phone, "ACCOUNT_NUMBER": _digits_like, "IBAN": _iban,
    "SWIFT_BIC": _swift, "CREDIT_CARD": _card, "ZW_NATIONAL_ID": _token, "US_SSN": _ssn,
    "API_KEY_SECRET": _token, "PRIVATE_KEY": _token, "ORG_KEYWORD": _org,
}


def fake(entity: str, value: str, rng: random.Random) -> str:
    """A stand-in for `value` of kind `entity`. Never contains `<`, so it cannot be mistaken for a `<TYPE_nnn>` token."""
    return _BY_ENTITY.get(entity, _token)(value, rng)
