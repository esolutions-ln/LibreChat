import io
import json
import zipfile

import openpyxl
import pdfplumber
import pytest

TYPES = ["bar", "stacked_bar", "line", "pie"]
XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def spec(**over):
    base = {
        "version": 1,
        "title": "Net interest income",
        "type": "bar",
        "unit": "USD m",
        "source": "Annual report, income statement",
        "categories": ["2022", "2023", "2024"],
        "series": [
            {"name": "Net interest income", "values": [41.2, 44.0, 48.9]},
            {"name": "Fee income", "values": [12, 14, 15]},
        ],
    }
    base.update(over)
    return base


def post(client, kind, body, headers=None):
    raw = body if isinstance(body, (bytes, str)) else json.dumps(body)
    return client.post(f"/report/{kind}", content=raw, headers={"content-type": "application/json", **(headers or {})})


def chart_xml(xlsx: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(xlsx)) as z:
        names = [n for n in z.namelist() if n.startswith("xl/charts/chart")]
        assert len(names) == 1, names
        return z.read(names[0]).decode()


def pdf_text(data: bytes) -> tuple[int, str]:
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        return len(pdf.pages), "\n".join(p.extract_text() or "" for p in pdf.pages)


# ---- xlsx --------------------------------------------------------------------------------------
@pytest.mark.parametrize("kind", TYPES)
def test_xlsx_has_data_sheet_and_a_native_chart_of_the_requested_type(client, kind):
    res = post(client, "xlsx", spec(type=kind))
    assert res.status_code == 200, res.text
    assert res.headers["content-type"] == XLSX_MIME
    assert res.headers["content-disposition"].startswith("attachment;")
    assert res.headers["cache-control"] == "no-store"

    wb = openpyxl.load_workbook(io.BytesIO(res.content))
    assert wb.sheetnames == ["Data", "Chart"]
    ws = wb["Data"]
    assert [c.value for c in ws[1]][:3] == ["Category", "Net interest income", "Fee income"]
    assert [ws.cell(row=r, column=1).value for r in (2, 3, 4)] == ["2022", "2023", "2024"]
    assert [ws.cell(row=r, column=2).value for r in (2, 3, 4)] == [41.2, 44, 48.9]
    assert [ws.cell(row=r, column=3).value for r in (2, 3, 4)] == [12, 14, 15]

    xml = chart_xml(res.content)
    xml = xml.replace("<c:", "<").replace("</c:", "</")  # tolerate a namespace prefix
    tag = {"bar": "barChart", "stacked_bar": "barChart", "line": "lineChart", "pie": "pieChart"}[kind]
    assert f"<{tag}>" in xml or f"<{tag} " in xml
    if kind == "stacked_bar":
        assert 'grouping val="stacked"' in xml
    if kind == "bar":
        assert 'grouping val="clustered"' in xml
    assert xml.count("<ser>") == (1 if kind == "pie" else 2)


def test_xlsx_numbers_are_numbers_and_unit_and_source_sit_below_the_table(client):
    ws = openpyxl.load_workbook(io.BytesIO(post(client, "xlsx", spec()).content))["Data"]
    assert isinstance(ws["B2"].value, float) and isinstance(ws["C2"].value, int)
    below = {ws.cell(row=r, column=1).value: ws.cell(row=r, column=2).value for r in range(6, 12)}
    assert below["Unit"] == "USD m"
    assert below["Source"] == "Annual report, income statement"
    assert "verify against the source document" in below["Note"]


def test_nulls_are_empty_cells_and_the_chart_still_builds(client):
    body = spec(series=[{"name": "A", "values": [1, None, 3]}], categories=["a", "b", "c"])
    for kind in ("xlsx", "pdf"):
        assert post(client, kind, body).status_code == 200
    ws = openpyxl.load_workbook(io.BytesIO(post(client, "xlsx", body).content))["Data"]
    assert ws["B3"].value is None and ws["B2"].value == 1 and ws["B4"].value == 3


def test_formula_injection_is_neutralised_everywhere(client):
    evil = ["=SUM(A1)", "+1+1", "-2+3", "@cmd", "=HYPERLINK(\"http://x\")"]
    body = spec(
        title="=HYPERLINK(\"http://evil\",\"x\")",
        unit="=1+1",
        source="@SUM(1)",
        categories=evil,
        series=[{"name": "=cmd|' /C calc'!A0", "values": list(range(len(evil)))}],
    )
    res = post(client, "xlsx", body)
    assert res.status_code == 200
    wb = openpyxl.load_workbook(io.BytesIO(res.content))
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for cell in row:
                assert cell.data_type != "f", (ws.title, cell.coordinate)
                if isinstance(cell.value, str):
                    assert not cell.value.startswith(("=", "+", "-", "@", "\t", "\r")), cell.coordinate
    ws = wb["Data"]
    assert ws["A2"].value == "'=SUM(A1)" and ws["B1"].value == "'=cmd|' /C calc'!A0"
    with zipfile.ZipFile(io.BytesIO(res.content)) as z:
        for name in z.namelist():
            if name.startswith("xl/worksheets/"):
                assert "<f>" not in z.read(name).decode(), name


def test_tab_and_cr_prefixes_are_rejected_by_the_spec_and_neutralised_by_the_writer(client):
    from app.report.xlsx import safe_text
    assert safe_text("\tx") == "'\tx" and safe_text("\rx") == "'\rx"
    assert safe_text("=x") == "'=x" and safe_text("+x") == "'+x"
    assert safe_text("-x") == "'-x" and safe_text("@x") == "'@x" and safe_text("plain") == "plain"
    assert post(client, "xlsx", spec(categories=["\tTab", "b", "c"])).status_code == 422
    assert post(client, "xlsx", spec(categories=["\rCR", "b", "c"])).status_code == 422


def test_ordinary_text_is_not_altered(client):
    ws = openpyxl.load_workbook(io.BytesIO(post(client, "xlsx", spec()).content))["Data"]
    assert ws["A2"].value == "2022" and ws["B1"].value == "Net interest income"


# ---- pdf ---------------------------------------------------------------------------------------
@pytest.mark.parametrize("kind", TYPES)
def test_pdf_is_a_real_pdf_with_title_table_source_and_footer(client, kind):
    res = post(client, "pdf", spec(type=kind))
    assert res.status_code == 200, res.text
    assert res.headers["content-type"] == "application/pdf"
    assert res.headers["content-disposition"].startswith("attachment;")
    assert res.content.startswith(b"%PDF")
    pages, text = pdf_text(res.content)
    assert pages >= 1
    assert "Net interest income" in text
    assert "2023" in text and "48.90" in text
    assert "Annual report, income statement" in text
    assert "verify against the source document" in text


def test_pdf_text_is_literal_not_markup(client):
    res = post(client, "pdf", spec(title="<b>Bold</b> & <i>x</i> <para>", source="<a href='x'>y</a>"))
    assert res.status_code == 200
    _, text = pdf_text(res.content)
    assert "<b>Bold</b>" in text and "<a href='x'>y</a>" in text


def test_pdf_pie_with_only_zero_or_missing_values_still_renders(client):
    body = spec(type="pie", series=[{"name": "S", "values": [0, None, 0]}])
    res = post(client, "pdf", body)
    assert res.status_code == 200 and res.content.startswith(b"%PDF")


def test_pdf_handles_long_labels(client):
    long = "A very long category label that would overflow any axis " * 2
    body = spec(categories=[long[:80], "b", "c"], series=[{"name": long[:80], "values": [1, 2, 3]}])
    assert post(client, "pdf", body).status_code == 200


# ---- limits and invalid specs ------------------------------------------------------------------
def extreme():
    n, m = 60, 12
    return spec(
        title="T" * 120,
        categories=[f"Category number {i:02d} with a long label" for i in range(n)],
        series=[{"name": f"Series {j} " + "x" * 60, "values": [float(i * j) + 0.5 for i in range(n)]} for j in range(m)],
    )


@pytest.mark.parametrize("kind", ["xlsx", "pdf"])
@pytest.mark.parametrize("chart", TYPES)
def test_extreme_spec_60_by_12_builds(client, kind, chart):
    res = post(client, kind, {**extreme(), "type": chart})
    assert res.status_code == 200, res.text[:200]
    if kind == "pdf":
        pages, _ = pdf_text(res.content)
        assert pages >= 1


def bad(**over):
    return spec(**over)


INVALID = {
    "unequal_lengths": bad(series=[{"name": "A", "values": [1, 2]}]),
    "too_many_series": bad(series=[{"name": f"S{i}", "values": [1, 2, 3]} for i in range(13)]),
    "too_many_categories": bad(categories=[str(i) for i in range(61)],
                               series=[{"name": "A", "values": [1] * 61}]),
    "no_categories": bad(categories=[], series=[{"name": "A", "values": []}]),
    "no_series": bad(series=[]),
    "string_value": bad(series=[{"name": "A", "values": [1, "2", 3]}]),
    "bool_value": bad(series=[{"name": "A", "values": [1, True, 3]}]),
    "control_in_title": bad(title="bad\x07title"),
    "newline_in_category": bad(categories=["a\nb", "c", "d"]),
    "control_in_series_name": bad(series=[{"name": "x\x00y", "values": [1, 2, 3]}]),
    "title_too_long": bad(title="t" * 121),
    "name_too_long": bad(series=[{"name": "n" * 81, "values": [1, 2, 3]}]),
    "unit_too_long": bad(unit="u" * 121),
    "empty_title": bad(title="   "),
    "wrong_version": bad(version=2),
    "unknown_type": bad(type="radar"),
    "pie_negative": bad(type="pie", series=[{"name": "A", "values": [1, -2, 3]}]),
    "huge_number": bad(series=[{"name": "A", "values": [1, 10 ** 400, 3]}]),
}


@pytest.mark.parametrize("kind", ["xlsx", "pdf"])
@pytest.mark.parametrize("name", sorted(INVALID))
def test_invalid_specs_answer_422_without_echoing_the_input(client, kind, name):
    body = INVALID[name]
    res = post(client, kind, json.dumps(body))
    assert res.status_code == 422, (name, res.text[:200])
    detail = res.json()["detail"]
    assert detail["code"] in {"invalid_spec", "invalid_json"}
    for needle in ("bad\x07title", "Net interest income", "'2'"):
        assert needle not in res.text


@pytest.mark.parametrize("raw", ["NaN", "Infinity", "-Infinity"])
def test_non_finite_numbers_are_rejected(client, raw):
    body = json.dumps(spec()).replace("41.2", raw)
    res = post(client, "xlsx", body)
    assert res.status_code == 422 and res.json()["detail"]["code"] == "invalid_json"


@pytest.mark.parametrize("body", ["", "not json", "[]", "null", '{"version":1}', b"\xff\xfe"])
def test_malformed_bodies_are_422(client, body):
    assert post(client, "pdf", body).status_code == 422


def test_oversize_body_is_422_too_large(client):
    body = spec(categories=["c"], series=[{"name": "A", "values": [1]}], source="x" * 70_000)
    res = post(client, "xlsx", json.dumps(body))
    assert res.status_code == 422 and res.json()["detail"]["code"] == "too_large"


def test_boundary_values_are_accepted(client):
    body = spec(title="t" * 120, unit="u" * 120, source="s" * 120, categories=["c" * 80, "d", "e"],
                series=[{"name": "n" * 80, "values": [0, -1.5, 1e15]}])
    assert post(client, "xlsx", body).status_code == 200
    assert post(client, "pdf", body).status_code == 200


# ---- auth and switches -------------------------------------------------------------------------
def test_service_key_is_required_when_configured(env, monkeypatch):
    monkeypatch.setenv("NMB_SERVICE_KEY", "secret-key")
    from fastapi.testclient import TestClient
    from app import main
    main.get_scanner.cache_clear()
    try:
        with TestClient(main.app) as c:
            for kind in ("xlsx", "pdf"):
                assert post(c, kind, spec()).status_code == 401
                assert post(c, kind, spec(), {"X-NMB-Service-Key": "wrong"}).status_code == 401
                assert post(c, kind, spec(), {"X-NMB-Service-Key": "secret-key"}).status_code == 200
    finally:
        main.get_scanner.cache_clear()


def test_reports_can_be_disabled_by_policy(client):
    from app import main
    main.get_scanner().policy.reports["enabled"] = False
    assert post(client, "xlsx", spec()).status_code == 404
    assert post(client, "pdf", spec()).status_code == 404


def test_the_policy_size_limit_is_honoured(client):
    from app import main
    main.get_scanner().policy.reports["max_spec_bytes"] = 100
    res = post(client, "xlsx", spec())
    assert res.status_code == 422 and res.json()["detail"]["code"] == "too_large"


# ---- degenerate shapes -------------------------------------------------------------------------
@pytest.mark.parametrize("kind", ["xlsx", "pdf"])
@pytest.mark.parametrize("chart", TYPES)
def test_every_value_missing_still_exports(client, kind, chart):
    body = spec(type=chart, categories=["a", "b"], series=[{"name": "A", "values": [None, None]}])
    res = post(client, kind, body)
    assert res.status_code == 200 and len(res.content) > 500


@pytest.mark.parametrize("kind", ["xlsx", "pdf"])
@pytest.mark.parametrize("chart", TYPES)
def test_a_single_category_exports(client, kind, chart):
    body = spec(type=chart, categories=["only"], series=[{"name": "A", "values": [5]}])
    assert post(client, kind, body).status_code == 200


def test_pdf_table_uses_consistent_decimals_per_column(client):
    _, text = pdf_text(post(client, "pdf", spec()).content)
    assert "41.20" in text and "44.00" in text and "48.90" in text  # a whole value shares its column's decimals
    assert "12.00" not in text  # the all-whole column stays whole


# ---- origin ------------------------------------------------------------------------------------
COMPUTED = "Computed by the analysis script from the uploaded data; verify before use."
MODEL = "Prepared from model-read figures; verify against the source document."


def note_of(xlsx: bytes) -> str:
    ws = openpyxl.load_workbook(io.BytesIO(xlsx))["Data"]
    return next(ws.cell(row=r, column=2).value for r in range(1, ws.max_row + 1) if ws.cell(row=r, column=1).value == "Note")


@pytest.mark.parametrize("body", [spec(), spec(origin="model")])
def test_origin_model_is_the_default_and_keeps_the_original_wording(client, body):
    assert note_of(post(client, "xlsx", body).content) == MODEL
    _, text = pdf_text(post(client, "pdf", body).content)
    assert MODEL in text and "Computed by" not in text


def test_origin_computed_changes_the_footer_and_the_note(client):
    body = spec(origin="computed")
    assert note_of(post(client, "xlsx", body).content) == COMPUTED
    _, text = pdf_text(post(client, "pdf", body).content)
    assert COMPUTED in text and "model-read" not in text


def test_the_footer_is_on_every_page_of_a_long_pdf(client):
    n, m = 60, 12
    body = spec(origin="computed", categories=[f"Category {i}" for i in range(n)],
                series=[{"name": f"S{j}", "values": [float(i * j) for i in range(n)]} for j in range(m)])
    pages, _ = pdf_text(post(client, "pdf", body).content)
    assert pages >= 2
    with pdfplumber.open(io.BytesIO(post(client, "pdf", body).content)) as pdf:
        assert all(COMPUTED in (p.extract_text() or "") for p in pdf.pages)


@pytest.mark.parametrize("origin", ["human", "", "MODEL", "Computed", 1, None, ["model"], True])
@pytest.mark.parametrize("kind", ["xlsx", "pdf"])
def test_any_other_origin_is_invalid(client, kind, origin):
    res = post(client, kind, json.dumps(spec(origin=origin)))
    assert res.status_code == 422 and res.json()["detail"]["code"] == "invalid_spec"
    assert "origin" in res.json()["detail"]["fields"]
