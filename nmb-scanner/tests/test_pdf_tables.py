"""Financial tables in PDFs must reach the model intact (only real identifiers masked)."""
import io
import re

import pytest
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.pdfgen import canvas
from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from app.engine import Ctx

CTX = Ctx("conv-pdf", "u1", "Wealth", ["user"])

HEADER = ["USD millions", "2022", "2023", "2024"]
ROWS = [
    ["Net interest income", "1 234 567 890", "1 100 000 000", "1 480 200 000"],
    ["Fee income", "310 400 000", "342 900 000", "401 700 000"],
    ["Operating expenses", "812 300 000", "905 100 000", "988 400 000"],
    ["Profit before tax", "512 667 890", "537 800 000", "893 500 000"],
]
FIGURES = [c for r in ROWS for c in r[1:]]
YEARS = HEADER[1:]
ACCOUNT_LINE = "Treasury settlement account number: 1234567890123. Contact: treasury.ops@example.com"


def make_pdf(grid: bool, tail=True) -> bytes:
    ss = getSampleStyleSheet()
    style = [("FONTSIZE", (0, 0), (-1, -1), 9)]
    if grid:
        style.append(("GRID", (0, 0), (-1, -1), 0.5, colors.black))
    table = Table([HEADER] + ROWS, colWidths=[160, 90, 90, 90])
    table.setStyle(TableStyle(style))
    story = [Paragraph("NMB Bank Zimbabwe - Summary Financial Results", ss["Title"]),
             Paragraph("Extract from the income statement (fictitious figures for testing).", ss["Normal"]),
             Spacer(1, 12), table, Spacer(1, 12)]
    if tail:
        story.append(Paragraph(ACCOUNT_LINE, ss["Normal"]))
    out = io.BytesIO()
    SimpleDocTemplate(out, pagesize=A4).build(story)
    return out.getvalue()


def ents(res):
    return [f["entity"] for f in res["findings"]]


def scan(scanner, data, name="results.pdf"):
    return scanner.scan_file(name, data, CTX)


# ---- ruled grid: cells become segments and pipe-table rows -------------------------------------
def test_ruled_table_figures_and_years_survive_and_identifiers_are_masked(scanner):
    res = scan(scanner, make_pdf(grid=True))
    out = res["sanitized_content"]
    assert res["decision"] == "mask"
    for token in FIGURES + YEARS:
        assert out.count(token) == 1, token  # present, and never duplicated by the page text
    assert sorted(set(ents(res))) == ["ACCOUNT_NUMBER", "EMAIL"] and len(res["findings"]) == 2
    assert "1234567890123" not in out and "treasury.ops@example.com" not in out
    assert "<ACCOUNT_001>" in out and "<EMAIL_001>" in out


def test_ruled_table_is_rendered_as_a_markdown_pipe_table(scanner):
    out = scan(scanner, make_pdf(grid=True))["sanitized_content"]
    lines = out.splitlines()
    assert "| USD millions | 2022 | 2023 | 2024 |" in lines
    assert "|---|---|---|---|" in lines
    assert "| Net interest income | 1 234 567 890 | 1 100 000 000 | 1 480 200 000 |" in lines
    assert lines.index("| USD millions | 2022 | 2023 | 2024 |") < lines.index("|---|---|---|---|")
    # text before and after the table keeps its place
    assert out.index("Summary Financial Results") < out.index("| USD millions") < out.index("<ACCOUNT_001>")


def test_every_cell_is_its_own_content_free_segment(scanner):
    res = scan(scanner, make_pdf(grid=True))
    locs = [s["location"] for s in res["sanitized_segments"]]
    cells = [loc for loc in locs if ".t[1]." in loc]
    assert len(cells) == 5 * 4
    assert "page[1].t[1].r[3].c[2]" in locs
    for loc in locs:
        assert re.fullmatch(r"page\[\d+\](?:\.(?:title|p\[\d+\]|t\[\d+\]\.r\[\d+\]\.c\[\d+\]))?|props\.\w+", loc), loc
        assert not re.search(r"\d{4}|treasury|salary", loc.replace("page[", "").replace("]", ""))


def test_table_is_not_also_extracted_as_page_text(scanner):
    res = scan(scanner, make_pdf(grid=True))
    page_text = [s["text"] for s in res["sanitized_segments"] if re.fullmatch(r"page\[1\]\.p\[\d+\]", s["location"])]
    assert page_text, "text outside the table is kept"
    assert not any(t in p for p in page_text for t in FIGURES + ["Net interest income", "USD millions"])


def test_document_metadata_counts_tables(scanner):
    assert scan(scanner, make_pdf(grid=True))["document"]["tables"] == 1
    assert scan(scanner, make_pdf(grid=False))["document"]["tables"] == 0


def test_the_http_endpoint_returns_the_same_result(client):
    res = client.post("/scan/file", files={"file": ("results.pdf", make_pdf(grid=True), "application/pdf")},
                      data={"conversation_id": "c-http", "user": "u1", "roles": "user"}).json()
    assert res["decision"] == "mask"
    assert "| Fee income | 310 400 000 | 342 900 000 | 401 700 000 |" in res["sanitized_content"]
    assert "<ACCOUNT_001>" in res["sanitized_content"]


# ---- borderless layout: cells merge into one line, the recognisers must cope -------------------
def test_borderless_table_figures_and_years_survive(scanner):
    res = scan(scanner, make_pdf(grid=False))
    out = res["sanitized_content"]
    for token in FIGURES + YEARS:
        assert out.count(token) == 1, token
    assert "USD millions 2022 2023 2024" in out
    assert "Net interest income 1 234 567 890 1 100 000 000 1 480 200 000" in out
    assert sorted(set(ents(res))) == ["ACCOUNT_NUMBER", "EMAIL"] and len(res["findings"]) == 2
    assert "1234567890123" not in out and "<ACCOUNT_001>" in out and "<EMAIL_001>" in out


# ---- several tables and pages ------------------------------------------------------------------
def test_two_tables_and_a_second_page(scanner):
    ss = getSampleStyleSheet()
    grid = TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.black)])
    t1 = Table([["Item", "2023", "2024"], ["Loans", "1 000 000 000", "1 250 000 000"]])
    t2 = Table([["Ratio", "2023", "2024"], ["Cost to income", "61.2", "58.9"]])
    for t in (t1, t2):
        t.setStyle(grid)
    out = io.BytesIO()
    SimpleDocTemplate(out, pagesize=A4).build([
        Paragraph("Balance sheet", ss["Heading2"]), t1, Spacer(1, 18), Paragraph("Key ratios", ss["Heading2"]), t2,
        PageBreak(), Paragraph("Notes: figures are fictitious. Total assets 5 000 000 000 000.", ss["Normal"])])
    res = scan(scanner, out.getvalue())
    text = res["sanitized_content"]
    assert res["decision"] == "allow" and not res["findings"], res["findings"]
    assert "| Loans | 1 000 000 000 | 1 250 000 000 |" in text and "| Cost to income | 61.2 | 58.9 |" in text
    assert text.index("Balance sheet") < text.index("| Loans") < text.index("Key ratios") < text.index("| Cost to income")
    assert "Total assets 5 000 000 000 000" in text
    locs = [s["location"] for s in res["sanitized_segments"]]
    assert any(loc.startswith("page[1].t[1].") for loc in locs) and any(loc.startswith("page[1].t[2].") for loc in locs)
    assert "page[2]" in locs


# ---- scanned PDFs behave as before -------------------------------------------------------------
def test_pdf_without_a_text_layer_still_goes_to_review(scanner):
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.rect(100, 100, 200, 200)  # a drawing, no text
    c.showPage()
    c.save()
    res = scan(scanner, buf.getvalue(), "scan.pdf")
    assert res["decision"] == "review"
    assert "no usable text layer" in res["review_required_reason"]
    assert res["document"]["pages_without_text"] == [1]


# ---- recogniser hardening on plain text --------------------------------------------------------
@pytest.mark.parametrize("line", [
    "Net interest income 1 234 567 890 1 100 000 000 1 480 200 000",
    "Fee income 310 400 000 342 900 000 401 700 000",
    "Operating expenses 812 300 000 905 100 000 988 400 000",
    "Profit before tax 512 667 890 537 800 000 893 500 000",
    "USD millions 2022 2023 2024",
    "Years 2019 2020 2021 2022 2023",
    "Revenue 000 000 1 480 200 000",
    "Total 5 000 000 000 000",
    "| Net interest income | 1 234 567 890 | 1 100 000 000 |",
    "Trade accounts receivable 1 234 567 890 1 100 000 000",
])
def test_merged_figures_are_not_identifiers(scanner, line):
    res = scanner.scan_text(line, CTX)
    assert not res["findings"], (line, ents(res))
    assert res["sanitized_content"] == line


@pytest.mark.parametrize("figure", ["1 234 567 890 003", "12 345 678 901 005"])
def test_luhn_valid_figure_runs_are_not_cards_without_a_label(scanner, figure):
    assert not scanner.scan_text(f"Revenue {figure}", CTX)["findings"]


@pytest.mark.parametrize("text, entity", [
    ("ref 1234567890123", "ACCOUNT_NUMBER"),                # contiguous
    ("ref 1234-5678-9012", "ACCOUNT_NUMBER"),               # hyphen separated
    ("ref 1234 5678 9012", "ACCOUNT_NUMBER"),               # 4-4-4 groups
    ("Account number: 123 456 789 012", "ACCOUNT_NUMBER"),  # label beats the figure shape
    ("Acct no 2022 2023 2024", "ACCOUNT_NUMBER"),
    ("card 4111 1111 1111 1111", "CREDIT_CARD"),
    ("4111111111111111", "CREDIT_CARD"),
    ("4111-1111-1111-1111", "CREDIT_CARD"),
    ("Visa card 1 234 567 890 003", "CREDIT_CARD"),         # label beats the figure shape
    ("phone +263 77 123 4567", "PHONE"),
    ("call 0772 123 456", "PHONE"),
    ("+263-77-123-4567", "PHONE"),
    ("tel 000 1 480 200 000", "PHONE"),
])
def test_real_identifiers_stay_detectable(scanner, text, entity):
    assert entity in ents(scanner.scan_text(text, CTX)), text


def test_a_label_far_from_the_number_does_not_count(scanner):
    far = "Account number is listed in the annex of this document, see the total: 1 234 567 890 1 100 000 000"
    assert not scanner.scan_text(far, CTX)["findings"]
