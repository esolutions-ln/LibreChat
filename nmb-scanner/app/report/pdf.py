"""PDF export: title, vector chart, data table, source line, and a verification footer."""
from __future__ import annotations

import io
from xml.sax.saxutils import escape

from reportlab.graphics.charts.barcharts import VerticalBarChart
from reportlab.graphics.charts.legends import Legend
from reportlab.graphics.charts.lineplots import LinePlot
from reportlab.graphics.charts.piecharts import Pie
from reportlab.graphics.shapes import Drawing, String
from reportlab.graphics.widgets.markers import makeMarker
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from .spec import ChartSpec, footer_text

# Okabe-Ito first (colour-blind safe), then extra distinguishable hues.
PALETTE = ["#0072B2", "#E69F00", "#009E73", "#D55E00", "#CC79A7", "#56B4E9",
           "#882255", "#44AA99", "#117733", "#999933", "#AA4499", "#666666"]


def _fmt(v: float | None, decimals: int | None = None) -> str:
    """Thousands-separated figure. `decimals=None` keeps whole numbers whole and others at 2 places."""
    if v is None:
        return "–"
    if decimals is None:
        decimals = 0 if float(v).is_integer() else 2
    return f"{v:,.{decimals}f}"


def _axis_fmt(v: float) -> str:
    return f"{v:,.2f}".rstrip("0").rstrip(".") if not float(v).is_integer() else f"{v:,.0f}"


def _decimals(values: list[float | None]) -> int:
    return 2 if any(v is not None and not float(v).is_integer() for v in values) else 0


def _clip(s: str, n: int) -> str:
    return s if len(s) <= n else s[: n - 1] + "…"


def _legend_layout(n: int) -> tuple[int, int]:
    cols = 1 if n <= 4 else (2 if n <= 8 else 3)
    return cols, -(-n // cols)


def _legend(drawing: Drawing, names: list[str], colors_: list, x: float, width: float, top: float) -> None:
    """Draws a multi-column legend whose top-left corner is at (x, top)."""
    cols, per_col = _legend_layout(len(names))
    legend = Legend()
    legend.x, legend.y = x, top
    legend.alignment = "right"
    legend.fontName, legend.fontSize = "Helvetica", 7
    legend.columnMaximum = per_col
    legend.deltax = width / cols
    legend.deltay = 10
    legend.dxTextSpace = 5
    legend.boxAnchor = "nw"
    legend.colorNamePairs = [(c, _clip(n, 34)) for c, n in zip(colors_, names)]
    drawing.add(legend)


def _frame(spec: ChartSpec, width: float, height: float):
    """Shared layout: a drawing with its legend, plus the plot rectangle and category label settings."""
    d = Drawing(width, height)
    n_series = len(spec.series)
    cols = [colors.HexColor(PALETTE[i % len(PALETTE)]) for i in range(n_series)]
    cats = [_clip(c, 18) for c in spec.categories]
    legend_h = _legend_layout(n_series)[1] * 10 + 6
    _legend(d, [s.name for s in spec.series], cols, 8, width - 16, legend_h)
    tall = not (max(len(c) for c in cats) <= 6 and len(cats) <= 8)
    bottom = legend_h + (52 if tall else 14) + 10
    return d, cols, cats, tall, (58, bottom, width - 74, height - bottom - 28)


def _style_labels(labels, n_cats: int, tall: bool) -> None:
    labels.fontName = "Helvetica"
    labels.fontSize = 6 if n_cats > 12 else 7
    if tall:
        labels.angle = 45
        labels.boxAnchor = "ne"
        labels.dx, labels.dy = 2, -2


def _style_value_axis(axis) -> None:
    axis.labels.fontName = "Helvetica"
    axis.labels.fontSize = 7
    axis.labelTextFormat = lambda v: _axis_fmt(float(v))
    axis.forceZero = 1
    axis.visibleGrid = 1
    axis.gridStrokeColor = colors.HexColor("#DDDDDD")
    axis.gridStrokeWidth = 0.4


def _bar_chart(spec: ChartSpec, width: float, height: float) -> Drawing:
    d, cols, cats, tall, (x, y, w, h) = _frame(spec, width, height)
    chart = VerticalBarChart()
    chart.groupSpacing = 4 if len(cats) > 20 else 8
    chart.barSpacing = 0.5
    if spec.type == "stacked_bar":
        chart.categoryAxis.style = "stacked"
    chart.x, chart.y, chart.width, chart.height = x, y, w, h
    chart.data = [list(s.values) for s in spec.series]
    chart.categoryAxis.categoryNames = cats
    _style_labels(chart.categoryAxis.labels, len(cats), tall)
    _style_value_axis(chart.valueAxis)
    for i, c in enumerate(cols):
        chart.bars[i].fillColor = c
        chart.bars[i].strokeColor = None
    d.add(chart)
    return d


def _line_chart(spec: ChartSpec, width: float, height: float) -> Drawing:
    """Drawn as separate runs so a missing value breaks the line instead of being interpolated across."""
    d, cols, cats, tall, (x, y, w, h) = _frame(spec, width, height)
    runs: list[list[tuple[int, float]]] = []
    owner: list[int] = []
    for si, s in enumerate(spec.series):
        cur: list[tuple[int, float]] = []
        for i, v in enumerate(s.values):
            if v is None:
                if cur:
                    runs.append(cur)
                    owner.append(si)
                cur = []
            else:
                cur.append((i, v))
        if cur:
            runs.append(cur)
            owner.append(si)
    if not runs:
        d.add(String(width / 2, height / 2, "No values to chart", fontName="Helvetica", fontSize=9,
                     textAnchor="middle"))
        return d
    n = len(cats)
    chart = LinePlot()
    chart.x, chart.y, chart.width, chart.height = x, y, w, h
    chart.data = runs
    for k, si in enumerate(owner):
        chart.lines[k].strokeColor = cols[si]
        chart.lines[k].strokeWidth = 1.6
        chart.lines[k].symbol = makeMarker("FilledCircle", size=3.2, fillColor=cols[si], strokeColor=cols[si])
    step = max(1, -(-n // 30))
    chart.xValueAxis.valueMin, chart.xValueAxis.valueMax = -0.4, max(n - 1, 0) + 0.4
    chart.xValueAxis.valueSteps = list(range(0, n, step))
    chart.xValueAxis.labelTextFormat = lambda v: cats[int(round(v))] if 0 <= round(v) < n else ""
    _style_labels(chart.xValueAxis.labels, n, tall)
    _style_value_axis(chart.yValueAxis)
    d.add(chart)
    return d


def _axis_chart(spec: ChartSpec, width: float, height: float) -> Drawing:
    return _line_chart(spec, width, height) if spec.type == "line" else _bar_chart(spec, width, height)


def _pie_chart(spec: ChartSpec, width: float, height: float) -> Drawing:
    d = Drawing(width, height)
    values = [v or 0.0 for v in spec.series[0].values]
    if sum(values) <= 0:
        d.add(String(width / 2, height / 2, "No positive values to chart", fontName="Helvetica",
                     fontSize=9, textAnchor="middle"))
        return d
    total = sum(values)
    n = len(values)
    cols = [colors.HexColor(PALETTE[i % len(PALETTE)]) for i in range(n)]
    size = min(height - 50, width * 0.4)
    pie = Pie()
    pie.x, pie.y, pie.width, pie.height = 24, (height - size) / 2, size, size
    pie.data = values
    pie.sideLabels = 0
    pie.simpleLabels = 1
    pie.slices.strokeWidth = 0.5
    pie.slices.strokeColor = colors.white
    pie.slices.fontName, pie.slices.fontSize = "Helvetica", 7
    for i in range(n):
        pie.slices[i].fillColor = cols[i]
    pie.labels = [f"{v / total:.0%}" if n <= 8 and v / total >= 0.04 else "" for v in values]
    d.add(pie)
    names = [f"{_clip(c, 28)} ({v / total:.1%})" for c, v in zip(spec.categories, values)]
    per_col = min(n, max(8, int((height - 20) // 10)))
    legend = Legend()
    legend.x, legend.y = size + 50, height - 10
    legend.alignment = "right"
    legend.fontName, legend.fontSize = "Helvetica", 7
    legend.columnMaximum = per_col
    legend.deltax = max(150, (width - size - 60) / max(1, -(-n // per_col)))
    legend.deltay = 10
    legend.dxTextSpace = 5
    legend.boxAnchor = "nw"
    legend.colorNamePairs = list(zip(cols, names))
    d.add(legend)
    return d


def _page_footer(text: str):
    def draw(canvas, doc) -> None:
        canvas.saveState()
        canvas.setFont("Helvetica", 7)
        canvas.setFillColor(colors.HexColor("#555555"))
        w, _ = doc.pagesize
        canvas.drawString(doc.leftMargin, 9 * mm, text)
        canvas.drawRightString(w - doc.rightMargin, 9 * mm, f"Page {doc.page}")
        canvas.restoreState()
    return draw


def build_pdf(spec: ChartSpec) -> bytes:
    n_series = len(spec.series)
    pagesize = landscape(A4) if n_series > 5 else A4
    out = io.BytesIO()
    doc = SimpleDocTemplate(out, pagesize=pagesize, leftMargin=15 * mm, rightMargin=15 * mm,
                            topMargin=15 * mm, bottomMargin=18 * mm, title=spec.title, author="NMB")
    frame_w = pagesize[0] - doc.leftMargin - doc.rightMargin
    styles = getSampleStyleSheet()
    title = ParagraphStyle("t", parent=styles["Title"], fontName="Helvetica-Bold", fontSize=15, leading=18,
                           alignment=0, spaceAfter=2)
    meta = ParagraphStyle("m", parent=styles["Normal"], fontName="Helvetica", fontSize=8, leading=10,
                          textColor=colors.HexColor("#444444"))
    cell = ParagraphStyle("c", parent=styles["Normal"], fontName="Helvetica", fontSize=7, leading=8.5)
    cell_r = ParagraphStyle("cr", parent=cell, alignment=2)
    head = ParagraphStyle("h", parent=cell, fontName="Helvetica-Bold", alignment=2)
    head_l = ParagraphStyle("hl", parent=head, alignment=0)

    story: list = [Paragraph(escape(spec.title), title)]
    if spec.unit:
        story.append(Paragraph(f"Unit: {escape(spec.unit)}", meta))
    story.append(Spacer(1, 6))
    chart_h = 270 if spec.type != "pie" else 230
    story.append(_pie_chart(spec, frame_w, chart_h) if spec.type == "pie" else _axis_chart(spec, frame_w, chart_h))
    story.append(Spacer(1, 8))

    rows = [[Paragraph("Category", head_l)] + [Paragraph(escape(s.name), head) for s in spec.series]]
    decimals = [_decimals(s.values) for s in spec.series]
    for i, cat in enumerate(spec.categories):
        rows.append([Paragraph(escape(cat), cell)]
                    + [Paragraph(_fmt(s.values[i], dec), cell_r) for s, dec in zip(spec.series, decimals)])
    first = max(frame_w * 0.26, 70)
    rest = (frame_w - first) / n_series
    table = Table(rows, colWidths=[first] + [rest] * n_series, repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#EEEEEE")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F7F7F7")]),
        ("LINEBELOW", (0, 0), (-1, 0), 0.6, colors.HexColor("#999999")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 2), ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
    ]))
    story.append(table)
    if spec.source:
        story += [Spacer(1, 6), Paragraph(f"Source: {escape(spec.source)}", meta)]
    footer = _page_footer(footer_text(spec.origin))
    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    return out.getvalue()
