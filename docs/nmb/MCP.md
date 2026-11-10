# NMB MCP server (reference)

`nmb-mcp/` is an MCP server that lets a model work with the bank's data without ever receiving it. It sits in front of the
scanner's data workbench (`ANALYSIS.md`) and exposes six tools. It is a reference implementation: the pattern for the
servers a bank would add for its own systems.

```
 LibreChat agent ──MCP (streamable HTTP, bearer token + user header)──▶ nmb-mcp ──/analysis/*──▶ scanner
   model sees only what a tool returns                                   policy: what may be asked,    real rows
                                                                         what may be answered          stay here
```

**The rule:** a tool result goes straight into the model's context, so no tool returns real rows. A tool returns the
schema, synthetic values, an aggregate large enough to be anonymous, or a statement that something ran. Real results are
private to the user.

## Tools

| Tool | Reads | Returns to the model |
|---|---|---|
| `list_datasets` | catalog | id, name, row count, each column's type and `sensitive` flag. No values, no statistics |
| `generate_twin` | catalog | creates the synthetic twin for chosen columns (sensitive columns become fake tokens) |
| `get_twin_sample` | twin | up to `NMB_MCP_SAMPLE_ROWS` synthetic rows, control characters stripped, cells capped |
| `test_code` | twin | stdout, stderr and file names of pandas code run on the **synthetic** data |
| `run_code_private` | real data | only status, rule ids of any violation, duration and a pointer to where the user opens the result. Output and errors are withheld |
| `aggregate` | real data | counts and sums or means per group of one or two non-sensitive categorical, boolean or datetime columns |

`aggregate` does not run model-written code. The model names columns and operations; the server validates them against
the dataset's own schema and generates a fixed script (column names enter as a JSON string literal, never as code).
Then it cuts the result down:

- Groups with fewer than `NMB_MCP_MIN_GROUP` rows (default 10) are dropped and only counted as `groups_suppressed`.
- A metric needs at least that many non-empty values or it is returned as `null`.
- Group-by columns must be non-sensitive categorical, boolean or datetime (bucketed by month or year). Numeric columns,
  identifiers and free text are refused. Metrics are `sum` or `mean` of non-sensitive numeric columns; `min` and `max`
  are not offered because they reveal one individual's value.
- At most two group-by columns, four metrics and `NMB_MCP_MAX_GROUPS` groups. A grouping with far more groups is refused.

Tool failures return `{"error": code, "message": ...}` with stable codes (`unauthenticated`, `rate_limited`,
`invalid_dataset_id`, `not_found`, `no_twin`, `column_not_groupable`, ...). A message never contains a data value or
scanner text.

## Identity and access
- The caller (LibreChat) authenticates with `Authorization: Bearer ${NMB_MCP_TOKEN}` and names the end user in
  `X-NMB-User`. The user id is never a tool argument: the model cannot ask for another user's data.
- The server passes that user to the scanner, which scopes every dataset and run to its owner (another user's id answers
  404; the tests check this over real HTTP).
- Serving HTTP without `NMB_MCP_TOKEN` (or with `NMB_MCP_DEV_USER`) refuses to start. `NMB_MCP_DEV_USER` only exists for
  stdio demos.
- Every call is rate-limited per user (`NMB_MCP_RATE_PER_MINUTE`, default 30; in-process, so run one replica or add a
  shared limiter) and audited as one JSON line on the `nmb.mcp.audit` logger: tool, hashed user, outcome and counts. Never
  code, column names or values.

## Configuration
| Variable | Default | Meaning |
|---|---|---|
| `NMB_SCANNER_URL` | `http://nmb-scanner:8088` | the scanner |
| `NMB_SERVICE_KEY` | required | scanner service key |
| `NMB_MCP_TOKEN` | required for HTTP | bearer token the caller must present |
| `NMB_MCP_USER_HEADER` | `x-nmb-user` | header carrying the end user's id |
| `NMB_MCP_PUBLIC_URL` | empty | base URL used in the "open it here" pointer |
| `NMB_MCP_MIN_GROUP` | 10 (minimum 2) | smallest group an aggregate may show |
| `NMB_MCP_MAX_GROUPS` / `MAX_GROUP_BY` | 50 / 2 | result limits |
| `NMB_MCP_SAMPLE_ROWS` / `MAX_TEXT` | 20 / 4000 | twin sample rows, characters of output |
| `NMB_MCP_RATE_PER_MINUTE` | 30 | calls per user per minute |

## Run it
```sh
# stdio, for a demo or a local client (acts as this user)
NMB_SCANNER_URL=http://localhost:8088 NMB_SERVICE_KEY=... NMB_MCP_DEV_USER=alice python -m nmbmcp

# compose (opt-in profile, internal network only)
docker compose -f docker-compose.yml -f docker-compose.nmb.yml --profile mcp up -d
```

## Connect LibreChat
In `librechat.yaml` (the user placeholder is LibreChat's own; it is the same id the workbench uses):

```yaml
mcpServers:
  nmb-data:
    type: streamable-http
    url: http://nmb-mcp:8090/mcp
    headers:
      Authorization: "Bearer ${NMB_MCP_TOKEN}"
      X-NMB-User: "{{LIBRECHAT_USER_ID}}"
    serverInstructions: true
```

LibreChat uses MCP tools through **agents**, so the Agents endpoint must be enabled and an agent given the `nmb-data`
tools. The deployment in this repo currently serves models through a custom endpoint with agents switched off, so enabling
this is a configuration decision, not only a deployment step. It also means the model call must still pass the existing
gateway so prompts are scanned. This wiring has not been tried end to end; the server has been tested over MCP's HTTP
transport with the SDK's own client, not through LibreChat.

## Tests
`nmb-mcp/tests`: policy (pure functions), the tool layer with a fake scanner (identity, limits, withheld output,
suppression), and an integration suite that starts the real scanner and the server over HTTP, uploads
`docs/nmb/demo/customers.csv` and checks aggregates against pandas, that no real name, email, phone or account number
appears in a twin sample, that a private run's real output is absent from the reply, and that another user sees nothing.
Run: `cd nmb-mcp && python -m pytest tests` (needs the scanner's dependencies for the integration suite).

## What this does not do yet
- **Tool results are not scanned by the NMB gateway.** The policy above is the only filter between a result and the model.
  Passing MCP results through the scanner as well (defence in depth) still has to be built.
- **The caller is trusted to name the user.** A shared bearer token authenticates LibreChat, not the person. For production,
  validate the user's Keycloak token in the server (the SDK has a token verifier hook) and drop the user header.
- **Aggregate release is reference-grade.** Dropping small groups does not stop differencing across many queries (for
  example two groupings whose results can be subtracted). For production use per-user query budgets and noise
  (differential privacy) or a certified query engine, and consider logging suppressed-group counts for review.
- **Data values are untrusted text.** Values are only returned inside structured JSON with control characters removed and
  length capped, but a cell can still contain words aimed at the model. Treat the model's behaviour on tool output as
  something to test, not as solved.
- **Private results have no listing.** `run_code_private` returns a pointer to Data analysis, but the page shows runs started
  from the page; a view of runs started through MCP is not built.
- **One data source.** This server fronts the uploaded-CSV workbench. A bank's own systems need their own servers with the
  same shape: a catalog over views or a semantic layer, an aggregate query tool with the policy above, and no free-form
  SQL. Writes (payments, updates) belong in a separate server behind per-action human approval.
