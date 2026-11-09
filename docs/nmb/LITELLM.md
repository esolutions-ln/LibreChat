# LiteLLM egress proxy

```
LibreChat (NMB gateway scanner) ──▶ litellm ──▶ Presidio ──▶ LLM provider
                                    keys, routing, budgets   masks PII in each prompt
```

`docker-compose.nmb.yml` adds three services: `litellm`, `presidio-analyzer`, `presidio-anonymizer`.
LiteLLM is the only service with internet access and the only holder of the provider key. The NMB gateway
scanner still runs first in LibreChat; Presidio here is a second check on what actually leaves.

## Setup
1. In `.env` set `LITELLM_MASTER_KEY` (any long random string), `LITELLM_UPSTREAM_MODEL` (for example
   `anthropic/claude-sonnet-5-5`) and `LITELLM_UPSTREAM_API_KEY`. Optionally pin `LITELLM_TAG` and `PRESIDIO_TAG`.
2. Add a custom endpoint to `librechat.yaml`:
   ```yaml
   endpoints:
     custom:
       - name: "NMB LLM"
         baseURL: "http://litellm:4000/v1"
         apiKey: "${LITELLM_MASTER_KEY}"
         models:
           default: ["default"]
           fetch: false
         titleConvo: false
   ```
3. `docker compose -f docker-compose.yml -f docker-compose.nmb.yml up -d`

Add more providers by adding entries to `litellm/config.yaml` `model_list`, and list their names under `models.default`.

## Behaviour to know
- The guardrail masks before the call and restores values in the reply (`output_parse_pii`). Prompts already
  carrying the scanner's `<ACCOUNT_001>` style placeholders pass through unchanged.
- `turn_off_message_logging` keeps prompts and completions out of LiteLLM logs.
- Presidio detects PII (names, emails, card and account numbers). It does not hide amounts, dates or balances,
  which is why analysis of bank datasets still uses the synthetic twin (see `ANALYSIS.md`).
- To forbid any other route to a provider, keep other API keys out of `.env` and leave `litellm` as the only endpoint.
