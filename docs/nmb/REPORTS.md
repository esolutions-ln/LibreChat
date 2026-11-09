# NMB financial-results charts and export

Ask the model to analyse an attached financial-results PDF and get an inline chart that can be exported to Excel or PDF.
Off unless `NMB_REPORTS_ENABLED=true` (the gateway must be on).

```
PDF ──upload gate──▶ masked markdown (tables as `| a | b |`) ──▶ model
                                                                   │ replies with prose + ```nmb-chart {ChartSpec}```
browser renders the chart inline  ◀────────────────────────────────┘
   │ Export XLSX / PDF
   ▼
POST /api/nmb/reports/export ──▶ scanner /report/xlsx | /report/pdf ──▶ file download
```

The model reads the table text already cleared by the gateway and writes the numbers into the spec, so a spec can contain
a transcription error. Every export therefore includes the data table next to the chart so a reader can check it
against the PDF.

## How the model is asked
When reports are enabled and a message carries an attachment or mentions a chart/graph/plot/visual, the gateway appends a
chart note (marker `\n\n[NMB chart note:`) to the model-bound text, like the redaction note. The client strips both notes
from the displayed message (`stripNmbMaskNote` handles either marker). The note tells the model to answer with a fenced
block whose info string is `nmb-chart` containing one `ChartSpec`.

## ChartSpec (version 1)
```json
{"version":1,"title":"Net interest income","type":"bar","unit":"USD m",
 "categories":["2023","2024"],
 "series":[{"name":"Net interest income","values":[41.2,48.9]},{"name":"Fee income","values":[12.0,null]}],
 "source":"Annual report, income statement"}
```
- `type`: `bar | stacked_bar | line | pie` (`pie` uses the first series only).
- Limits (enforced by client, gateway and scanner): title <= 120 chars, `unit`/`source` <= 120, 1-60 categories,
  1-12 series, each series `values.length === categories.length`, values finite numbers or `null`, names <= 80 chars,
  total spec <= 64 KB. Control characters are rejected.
- Pie values must be non-negative.

## Gateway API (`/api/nmb/reports/export`, JWT, rate limited like execute)
`POST` body `{"format":"xlsx"|"pdf","spec":ChartSpec}` -> file bytes with `Content-Disposition: attachment`
(`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` or `application/pdf`),
`Cache-Control: no-store`. 400 invalid spec, 404 when disabled, 429 rate limited, 503 scanner unavailable.
`GET /api/nmb/me` gains `reports: boolean`. Each export is audited as `nmb_report.exported` (format, series, points,
bytes; never titles, names or values).

## Scanner endpoints (`X-NMB-Service-Key`)
`POST /report/xlsx` and `POST /report/pdf`, body: `ChartSpec`. 422 for an invalid spec. Output:
- **xlsx**: sheet `Data` (categories x series, header row, unit and source below the table) and sheet `Chart` with a
  native Excel chart of the requested type.
- **pdf**: A4, title, the chart drawn as vector graphics, the data table, the source line, and a footer
  "Prepared from model-read figures; verify against the source document."

## Workbench charts (CSV transaction data)
Analysis code run in the workbench (`ANALYSIS.md`) can emit the same chart. The sandbox injects a third global next to
`DATA_PATH` and `OUTPUT_DIR`: `save_chart(spec: dict, name: str = "chart")`. It writes `OUTPUT_DIR/<name>.chart.json`
(`name` must match `[A-Za-z0-9_-]{1,40}`; at most 5 charts per run). Code needs no file access, so the existing
import/`open` restrictions are unchanged.
- After the run the scanner validates every `*.chart.json` as a `ChartSpec`, sets `origin` to `computed`, and rewrites the
  normalised spec. An invalid chart is deleted from the run's files and one line is appended to `stderr`:
  `chart_rejected:<name>:<code>[,<code>]` (spec error codes only, never values). Valid charts list as a run file with
  `kind: "chart"`.
- The browser fetches `*.chart.json` run files (owner-scoped, `no-store`), shows them inline in the result panel, and offers
  the same Export XLSX/PDF. Export sends the spec to the scanner inside the boundary and is audited with counts only.
  Nothing from a real run is ever added to a conversation, so the model never sees these values.
- Synthetic runs render the same way, which is how a user checks the chart before running on real data.

## `origin`
`ChartSpec` has an optional `origin`: `"model"` (default; figures read by the AI from a document) or `"computed"` (produced
by analysis code from uploaded data). It only changes wording: the PDF footer and xlsx note read
"Computed by the analysis script from the uploaded data; verify before use." for `computed`, and the on-screen note says
the figures were computed by the user's script. Any other value is invalid.

## Placeholders
Exports carry text exactly as written in the spec. Placeholders such as `<ACCOUNT_001>` are not restored server-side, and
a chart of financial totals should not contain any.
