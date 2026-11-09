"""Excel export: a `Data` sheet with the figures and a `Chart` sheet holding a native Excel chart."""
from __future__ import annotations

import io

from openpyxl import Workbook
from openpyxl.chart import BarChart, LineChart, PieChart, Reference
from openpyxl.styles import Alignment, Font
from openpyxl.utils import get_column_letter

from .spec import ChartSpec, footer_text

DANGEROUS_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def safe_text(s: str) -> str:
    """Stops a spreadsheet application from reading model-supplied text as a formula."""
    return "'" + s if s.startswith(DANGEROUS_PREFIXES) else s


def _put_text(ws, row: int, col: int, text: str, **style):
    cell = ws.cell(row=row, column=col, value=safe_text(text))
    cell.data_type = "s"
    if style.get("bold"):
        cell.font = Font(bold=True)
    return cell


def _is_whole(spec: ChartSpec) -> bool:
    return all(v is None or float(v).is_integer() for s in spec.series for v in s.values)


def _chart(spec: ChartSpec, data_ws, n_rows: int, n_series: int):
    cats = Reference(data_ws, min_col=1, min_row=2, max_row=1 + n_rows)
    if spec.type == "pie":
        chart = PieChart()
        chart.add_data(Reference(data_ws, min_col=2, min_row=1, max_row=1 + n_rows), titles_from_data=True)
        chart.set_categories(cats)
    else:
        chart = LineChart() if spec.type == "line" else BarChart()
        if spec.type != "line":
            chart.type = "col"
            if spec.type == "stacked_bar":
                chart.grouping = "stacked"
                chart.overlap = 100
        chart.add_data(
            Reference(data_ws, min_col=2, max_col=1 + n_series, min_row=1, max_row=1 + n_rows),
            titles_from_data=True,
        )
        chart.set_categories(cats)
        chart.x_axis.delete = False
        chart.y_axis.delete = False
        if spec.unit:
            chart.y_axis.title = safe_text(spec.unit)
        chart.y_axis.number_format = "#,##0" if _is_whole(spec) else "#,##0.00"
        chart.x_axis.tickLblPos = "low"
    chart.title = safe_text(spec.title)
    chart.legend.position = "b"
    chart.width, chart.height = 26, 14
    return chart


def build_xlsx(spec: ChartSpec) -> bytes:
    wb = Workbook()
    data = wb.active
    data.title = "Data"
    n_rows, n_series = len(spec.categories), len(spec.series)

    _put_text(data, 1, 1, "Category", bold=True)
    for j, s in enumerate(spec.series, start=2):
        _put_text(data, 1, j, s.name, bold=True).alignment = Alignment(horizontal="right", wrap_text=True)
    fmt = "#,##0" if _is_whole(spec) else "#,##0.00"
    for i, cat in enumerate(spec.categories, start=2):
        _put_text(data, i, 1, cat)
        for j, s in enumerate(spec.series, start=2):
            v = s.values[i - 2]
            if v is not None:
                cell = data.cell(row=i, column=j, value=int(v) if float(v).is_integer() else v)
                cell.number_format = fmt

    r = n_rows + 3
    _put_text(data, r, 1, "Title", bold=True)
    _put_text(data, r, 2, spec.title)
    if spec.unit:
        r += 1
        _put_text(data, r, 1, "Unit", bold=True)
        _put_text(data, r, 2, spec.unit)
    if spec.source:
        r += 1
        _put_text(data, r, 1, "Source", bold=True)
        _put_text(data, r, 2, spec.source)
    r += 1
    _put_text(data, r, 1, "Note", bold=True)
    _put_text(data, r, 2, footer_text(spec.origin))

    longest = max([len(c) for c in spec.categories] + [8])
    data.column_dimensions["A"].width = min(max(longest + 2, 14), 48)
    for j, s in enumerate(spec.series, start=2):
        data.column_dimensions[get_column_letter(j)].width = min(max(len(s.name) + 2, 14), 32)
    data.freeze_panes = "B2"

    chart_ws = wb.create_sheet("Chart")
    chart_ws.add_chart(_chart(spec, data, n_rows, n_series), "A1")

    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()
