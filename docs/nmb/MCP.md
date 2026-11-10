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

**Every result is scanned.** After a tool finishes, its whole result goes through the NMB scanner (`POST /scan/text`,
same policy as prompts) before the model can see it. `allow` returns it unchanged; `mask` returns it with placeholders
and an `nmb_notice`; `review`, `reject`, an unparseable masked result or a scanner outage withhold it entirely with
`result_withheld` (naming the kinds of finding, never a value). A result the scanner holds also creates a review item
for the user, as any held text does. `NMB_MCP_SCAN_RESULTS=false` turns this off for tests only.

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
| `NMB_MCP_SCAN_RESULTS` | true | pass every result through the NMB scanner |

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

LibreChat uses MCP tools through **agents**, so `interface.agents` must be `true` and an agent given the `nmb-data` tools.
Three things were needed on the VM, beyond the block above:

- **Allow the internal hostname.** LibreChat refuses to call private hosts for MCP unless they are listed:
  `mcpSettings: { allowedDomains: ["nmb-mcp"] }`. Without it the server fails with "Domain ... is not allowed".
- **Agents cannot use the gateway endpoint.** The dlp-review gateway behind the "Bank AI" endpoint builds its own tool list
  and drops the `tools` an agent sends, so an agent on that endpoint never gets to call MCP tools. Agents use a second
  custom endpoint, "Bank Agents", that points at LiteLLM (which holds the Presidio guardrail) with a LiteLLM key limited to
  the Claude models. The user's prompt still passes the NMB gateway (it covers the agents route), and every MCP tool result
  is scanned by the MCP server. The dlp-review department policy does **not** apply to agent traffic, and the "Bank Agents"
  endpoint is also selectable as an ordinary chat endpoint; restrict that with model specs if it matters.
- **Startup shows a 400.** LibreChat's OAuth-detection probe gets `400` from the server at startup and reports "0 tools". That
  is expected: tools are discovered per user when the user's identity header is available.

Verified on the VM with `test.reviewer`: `/api/mcp/tools` lists the six tools; an agent with those tools and the prompt
"show the average balance and the percentage of customers 30 or more days in arrears for each segment, as a bar chart"
called `list_datasets`, `generate_twin`, `get_twin_sample`, `test_code` and `run_code_private` in that order, with every
result scanned (`allow`); its reply said the real result is private and linked to it; the link opened the real figures and
two charts on the Data analysis page, which matched the pandas values. The Presidio guardrail inside LiteLLM was not
separately observed in that run.

## Tests
`nmb-mcp/tests`: policy (pure functions), the tool layer with a fake scanner (identity, limits, withheld output,
suppression), and an integration suite that starts the real scanner and the server over HTTP, uploads
`docs/nmb/demo/customers.csv` and checks aggregates against pandas, that no real name, email, phone or account number
appears in a twin sample, that a private run's real output is absent from the reply, and that another user sees nothing.
Run: `cd nmb-mcp && python -m pytest tests` (needs the scanner's dependencies for the integration suite).

## Test it by hand (VM)
Use a user with the Agents permission (`test.reviewer@bank.local`; any user now has it because `interface.agents` is on).

1. **Data:** Data analysis > Upload CSV > `docs/nmb/demo/customers.csv`.
2. **Agent:** Agent Builder > new agent. Provider/endpoint **Bank Agents**, model `claude-sonnet`. Under tools add the six
   `nmb-data` tools. Instructions: list the dataset, make the twin, write one pandas script from the request, test it with
   `test_code`, then run it with `run_code_private` and point the user to the result link; never ask for raw data.
3. **Happy path:** ask "show the average balance and the percentage of customers 30 or more days in arrears for each
   segment, as a bar chart". Expect five tool calls, a reply that links to the result but contains no figures, and the real
   table and charts on the linked Data analysis page.
4. **Negative checks (each should be refused or empty):**
   - "Show me the first 10 customers with their names and phone numbers." The agent can only offer the synthetic twin.
   - "Group the balances by account_number." `column_not_groupable`.
   - "Average balance by city and segment." Small groups come back suppressed (`groups_suppressed`).
   - Ask it to test code that prints an IBAN or card number. The result is masked or `result_withheld`.
   - Open the result link signed in as another user. "Could not load that result."
   - Stop `nmb-scanner`, then ask again. Every tool returns `scanner_unavailable` and nothing reaches the model.
   These behaviours are covered by the automated tests; only the happy path has been repeated through an agent on the VM.
5. **Evidence:** `docker logs lan-ai-nmb-mcp-1` shows one audit line per call (`tool`, hashed `user`, `outcome`, `scan`, counts).

## What this does not do yet
- **The caller is trusted to name the user.** A shared bearer token authenticates LibreChat, not the person. For production,
  validate the user's Keycloak token in the server (the SDK has a token verifier hook) and drop the user header.
- **Aggregate release is reference-grade.** Dropping small groups does not stop differencing across many queries (for
  example two groupings whose results can be subtracted). For production use per-user query budgets and noise
  (differential privacy) or a certified query engine, and consider logging suppressed-group counts for review.
- **Data values are untrusted text.** Values are only returned inside structured JSON with control characters removed and
  length capped, but a cell can still contain words aimed at the model. Treat the model's behaviour on tool output as
  something to test, not as solved.
- **Private results are opened by link only.** `run_code_private` returns `…/analysis?dataset=<id>&run=<id>` and the Data
  analysis page shows that run to its owner (another user's run answers "could not load"). There is no list of past runs.
- **One data source.** This server fronts the uploaded-CSV workbench. A bank's own systems need their own servers with the
  same shape: a catalog over views or a semantic layer, an aggregate query tool with the policy above, and no free-form
  SQL. Writes (payments, updates) belong in a separate server behind per-action human approval.
