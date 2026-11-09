# NMB synthetic-data analysis

Lets analysts use a cloud LLM to write analysis code for confidential bank data (statements, transactions)
without the model ever seeing a real value. Pattern from "Don't Give AI Your Data" (Thu Vu): the model works on a
synthetic twin, and the code it writes runs on the real data inside our boundary.

```
 real CSV ──upload──▶ scanner (encrypted at rest, never returned)
    │                    │ profile columns, flag sensitive ones
    │                    ▼
    │             synthetic twin (selected columns only)  ──▶ user pastes schema + sample into chat
    │                                                              │ (still passes the chat gateway)
    │                                                              ▼
    │                                                      LLM writes pandas code
    │                                                              │
    ▼                                                              ▼
 sandbox run (real) ◀── user pastes code ── validate/test on the synthetic twin first
    │
    ▼
 results retained encrypted for the owner only; NEVER fed back to the model
```

## Guarantees
- Real rows are stored Fernet-encrypted in the scanner volume. No endpoint returns them. Only sandbox runs read them.
- Output of a `real` run is returned to the owning user's browser only (`llm_safe: false`). It is never inserted into a
  conversation by the gateway. Anything the user pastes into chat is scanned/masked by the existing chat gateway.
- The synthetic twin contains no real value from sensitive/identifier columns (fake tokens), rare categories are
  folded into `other`, and numeric ranges are clipped to a trimmed range.
- Every dataset/run endpoint is owner-scoped: another user's id answers 404.

## Code contract (what the LLM is told)
Python 3, a single script. Globals injected by the harness: `DATA_PATH` (str, path to the CSV) and `OUTPUT_DIR` (str).
- Read with `pd.read_csv(DATA_PATH)`. Write results only under `OUTPUT_DIR` (`.csv`, `.json`, `.html`, `.png`, `.txt`).
- Print summaries with `print()` (stdout is captured, capped).
- Allowed imports: `pandas, numpy, math, statistics, datetime, json, re, collections, itertools, decimal, matplotlib, plotly`.
- Forbidden: network, subprocess, `os`/`sys`/`pathlib`/`shutil`, `open`, `eval/exec/compile/__import__`, dunder attribute access.
- Aggregate: do not print or save raw rows beyond what the analysis needs.

## Scanner endpoints (`/analysis/*`, header `X-NMB-Service-Key`; `user` = authenticated user id from the backend)
`Dataset`:
```json
{"id":"ds_3f9a1c20d4be","name":"statements.csv","rows":18234,"created_at":"...","expires_at":"...",
 "columns":[{"name":"amount","kind":"numeric","null_fraction":0.0,"sensitive":false,"sensitive_entities":[],"share":true}],
 "synthetic":null}
```
`kind`: `numeric | integer | datetime | boolean | categorical | text | identifier`. `share` is the default selection
(`false` for sensitive columns). `synthetic`: `null` or `{"rows":100,"columns":["amount",...],"engine":"builtin|sdv","generated_at":"..."}`.

| method | path | body / query | response |
|---|---|---|---|
| POST | `/analysis/datasets` | multipart `file` (.csv), `user`, `department?` | `Dataset` (422 bad/oversize CSV) |
| GET | `/analysis/datasets?user=` | | `{"items":[Dataset]}` |
| GET | `/analysis/datasets/{id}?user=` | | `Dataset` (404 if not owner) |
| DELETE | `/analysis/datasets/{id}?user=` | | `{"deleted":true}` (also removes runs) |
| POST | `/analysis/datasets/{id}/synthesize` | `{"user","columns":[..],"rows":100,"seed?"}` | `Dataset` |
| GET | `/analysis/datasets/{id}/synthetic?user=` | | `{"columns":[..],"rows":[[..]],"csv":"..."}` (409 if none yet) |
| POST | `/analysis/datasets/{id}/execute` | `{"user","code","target":"synthetic\|real"}` | `Run` |
| GET | `/analysis/runs/{rid}?user=` | | `Run` |
| GET | `/analysis/runs/{rid}/files/{name}?user=` | | file bytes (`Content-Disposition: attachment`) |
| GET | `/analysis/limits` | | `{"max_code_chars","timeout_s","max_output_bytes","allowed_imports":[..],"max_upload_bytes","synthetic_max_rows"}` |

`Run`:
```json
{"id":"run_9c1e77aa03bd","dataset_id":"ds_...","target":"real","status":"ok|error|rejected|timeout",
 "stdout":"...","stderr":"...","files":[{"name":"summary.csv","bytes":812,"kind":"csv"}],
 "violations":[],"duration_ms":2310,"llm_safe":false,"created_at":"..."}
```
`rejected` = static check failed (`violations` lists rule ids and line numbers, no source text). `stderr` is the last
lines of the traceback with host paths removed. Synthetic runs have `llm_safe: true`.

## Backend (`/api/nmb/analysis/*`, JWT, owner = session user)
Same routes, mapped 1:1 from the scanner:
`GET|POST /datasets`, `GET|DELETE /datasets/:id`, `POST /datasets/:id/synthesize`, `GET /datasets/:id/synthetic`,
`POST /datasets/:id/execute`, `GET /runs/:id`, `GET /runs/:id/files/:name`, `GET /limits`.
`GET /api/nmb/me` gains `analysis: boolean`. Enabled by `NMB_ANALYSIS_ENABLED` (requires the gateway to be on).
Every upload, synthesize, execute and delete is audited with counts and ids only (never code, values or column names).
