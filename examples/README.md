# Rubric Integration Examples

Real, copy-pasteable patterns for integrating Rubric into your multi-agent pipelines.

## Files

| File | What it shows |
|---|---|
| `langgraph-passive.ts` | Passive mode: zero agent changes, just trace ingestion after each node |
| `langgraph-adapter.ts` | Adapter mode: wrap nodes with `wrapAgent()` for automatic capture |
| `curl.sh` | curl examples: raw HTTP API for any language/framework |
| `custom-pipeline.ts` | Custom pipeline: manual frame emission for highest fidelity |

## Quick decision guide

| If you... | Use |
|---|---|
| Just want to see what Rubric catches in your existing pipeline | `langgraph-passive.ts` |
| Want automatic capture with one line per agent node | `langgraph-adapter.ts` |
| Use anything other than TypeScript/Python | `curl.sh` |
| Want the highest-fidelity epistemic record | `custom-pipeline.ts` |

## Setup

```bash
# Create an ingest key in your Rubric dashboard → Ingest keys
export RUBRIC_BASE_URL="https://<your-project>.functions.insforge.app"
export RUBRIC_API_KEY="rbk_..."
```
