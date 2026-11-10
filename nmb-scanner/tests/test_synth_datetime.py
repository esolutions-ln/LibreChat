"""The synthetic datetime column must stay inside the real range whatever unit/timezone pandas stores."""
import csv
import io
import random
from datetime import date, timedelta

import numpy as np
import pandas as pd
import pytest

from app.analysis import synth as synthmod
from test_analysis import U, execute, synth as synth_api, upload  # noqa: F401  (client helpers)

DAYS = pd.Series(pd.date_range("2024-01-01", "2024-12-31", freq="D"))
STAMPS = pd.Series(pd.date_range("2024-01-01 00:00:07", periods=400, freq="53min"))


def meta(name="txn_date", kind="datetime"):
    return {"name": name, "kind": kind, "sensitive": False, "null_fraction": 0.0}


def make(series: pd.Series):
    """(raw, typed, columns) the way the service builds them: a datetime column plus a continuous amount.

    The amount keeps rows distinct from real rows. A date-only selection over a dense date range cannot, because
    every date it generates also exists in the real data, and the generator refuses to reproduce real rows.
    """
    amounts = pd.Series(np.random.default_rng(0).lognormal(4, 0.8, len(series)).round(2))
    raw = pd.DataFrame({"txn_date": series.astype(str), "amount": amounts.astype(str)})
    typed = pd.DataFrame({"txn_date": series, "amount": amounts})
    return raw, typed, [meta(), meta("amount", "numeric")]


SELECTED = ["txn_date", "amount"]


def twin(series: pd.Series, rows: int, seed: int) -> pd.DataFrame:
    return synthmod.synthesize(*make(series), SELECTED, rows, seed=seed)[0]


def naive(series: pd.Series) -> pd.Series:
    s = pd.to_datetime(series, errors="coerce", utc=True) if series.dtype == object else series
    if getattr(s.dt, "tz", None) is not None:
        s = s.dt.tz_localize(None)
    return s.dropna().astype("datetime64[us]")


VARIANTS = {
    "ns": DAYS.astype("datetime64[ns]"),
    "us": DAYS.astype("datetime64[us]"),
    "ms": DAYS.astype("datetime64[ms]"),
    "s": DAYS.astype("datetime64[s]"),
    "tz_harare": DAYS.astype("datetime64[ns]").dt.tz_localize("Africa/Harare"),
    "tz_utc": DAYS.astype("datetime64[us]").dt.tz_localize("UTC"),
    "nat": DAYS.astype("datetime64[ns]").where(DAYS.index % 7 != 0, pd.NaT),
    "timestamps_us": STAMPS.astype("datetime64[us]"),
    "timestamps_s": STAMPS.astype("datetime64[s]"),
    "parsed_strings": pd.to_datetime(DAYS.dt.strftime("%Y-%m-%d"), format="mixed"),
    # an object column of Timestamps with different offsets, which is what mixed-offset CSV text parses to
    "mixed_offsets": pd.Series([pd.Timestamp(t) for t in [
        "2024-03-01T10:00:00+02:00", "2024-05-17T08:30:00+00:00", "2024-07-04T23:10:00-05:00",
        "2024-09-30T01:00:00+02:00", "2024-11-12T12:00:00+00:00"] * 20], dtype=object),
}


@pytest.mark.parametrize("name", sorted(VARIANTS))
def test_synthetic_dates_stay_inside_the_real_range(name):
    series = VARIANTS[name]
    out = twin(series, 200, 11)
    got = pd.to_datetime(out["txn_date"])
    real = naive(series)
    assert len(got) == 200
    assert got.min() >= real.min().normalize() and got.max() <= real.max(), (got.min(), got.max())
    assert got.min().year == 2024 and got.max().year == 2024  # never the 1970 epoch
    assert got.nunique() > 20
    spread = min(6, real.dt.month.nunique())
    assert got.dt.month.nunique() >= spread, "values should be spread over the real range, not clustered"


@pytest.mark.parametrize("name", ["ns", "us", "s", "tz_harare", "nat"])
def test_date_only_columns_stay_date_only_and_timestamps_keep_the_time(name):
    out = twin(VARIANTS[name], 50, 2)
    assert out["txn_date"].str.fullmatch(r"\d{4}-\d{2}-\d{2}").all()
    out = twin(VARIANTS["timestamps_us"], 50, 2)
    assert out["txn_date"].str.fullmatch(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}").all()


@pytest.mark.parametrize("name", ["ns", "us", "s", "tz_harare"])
def test_same_dates_whatever_the_unit_and_seedable(name):
    """The unit is an implementation detail: equal instants give equal synthetic output for a seed."""
    base = twin(VARIANTS["ns"], 80, 5)
    assert twin(VARIANTS[name], 80, 5)["txn_date"].tolist() == base["txn_date"].tolist()
    assert twin(VARIANTS[name], 80, 6)["txn_date"].tolist() != base["txn_date"].tolist()


def test_a_single_distinct_date_is_reproduced_not_corrupted():
    out = twin(pd.Series(pd.to_datetime(["2024-06-15"] * 30)), 10, 1)
    assert set(out["txn_date"]) == {"2024-06-15"}


def test_values_outside_the_nanosecond_range_do_not_overflow():
    series = pd.Series(pd.to_datetime(["1500-01-01", "1600-06-01", "2500-12-31", "1900-03-03"] * 10)
                       ).astype("datetime64[us]")
    out = twin(series, 20, 3)
    assert out["txn_date"].str.fullmatch(r"\d{4}-\d{2}-\d{2}").all()  # ISO dates compare as text
    assert out["txn_date"].min() >= "1500-01-01" and out["txn_date"].max() <= "2500-12-31"
    assert out["txn_date"].nunique() > 5


# ---- the 400-row transactions shape, end to end ------------------------------------------------
MERCHANTS = ["Pick n Pay", "OK Zimbabwe", "TM Pick n Pay", "Zuva Petroleum", "Econet", "Delta Beverages", "Innscor", "Nandos"]


def transactions(n=400) -> bytes:
    rng = random.Random(21)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["txn_date", "merchant", "amount", "account_number"])
    for i in range(n):
        day = date(2024, 1, 1) + timedelta(days=int(i * 365 / n))
        w.writerow([day.isoformat(), rng.choice(MERCHANTS), f"{rng.lognormvariate(4, 0.8):.2f}",
                    f"ACC{rng.randint(10**12, 10**13 - 1)}"])
    return buf.getvalue().encode()


@pytest.mark.parametrize("rows", [60, 400])
def test_twin_of_the_transactions_shape_resembles_the_real_data(client, rows):
    data = transactions()
    head = b"\n".join(data.splitlines()[: rows + 1]) + b"\n"
    real = pd.read_csv(io.BytesIO(head))
    ds = upload(client, head).json()
    kinds = {c["name"]: c["kind"] for c in ds["columns"]}
    assert kinds["txn_date"] == "datetime" and kinds["amount"] == "numeric" and kinds["merchant"] == "categorical"
    assert synth_api(client, ds["id"], ["txn_date", "merchant", "amount"], rows=100, seed=4).status_code == 200
    csv_text = client.get(f"/analysis/datasets/{ds['id']}/synthetic", params={"user": U}).json()["csv"]
    twin = pd.read_csv(io.StringIO(csv_text))

    dates, real_dates = pd.to_datetime(twin["txn_date"]), pd.to_datetime(real["txn_date"])
    assert dates.min() >= real_dates.min() and dates.max() <= real_dates.max()
    assert dates.dt.year.eq(2024).all() and dates.nunique() > 10
    real_months = real_dates.dt.to_period("M").nunique()  # 2 for the first 60 rows, 12 for all 400
    assert dates.dt.to_period("M").nunique() >= min(real_months, 8)

    assert set(twin["merchant"]) <= set(real["merchant"]) | {"other"}
    assert twin["merchant"].nunique() >= 3
    assert twin["amount"].between(real["amount"].min(), real["amount"].max()).all()
    assert abs(twin["amount"].mean() - real["amount"].mean()) < 0.5 * real["amount"].mean()
    assert not np.isclose(twin["amount"].std(), 0)


def test_a_synthetic_run_sees_the_realistic_dates(client):
    data = transactions()
    ds = upload(client, data).json()
    synth_api(client, ds["id"], ["txn_date", "amount"], rows=50, seed=9)
    code = "import pandas as pd\nd = pd.to_datetime(pd.read_csv(DATA_PATH)['txn_date'])\nprint(d.min().year, d.max().year, d.nunique())"
    run = execute(client, ds["id"], code).json()
    assert run["status"] == "ok" and run["stdout"].split()[:2] == ["2024", "2024"]
    assert int(run["stdout"].split()[2]) > 10
