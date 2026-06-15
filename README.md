# Rubric

**Audit-grade reasoning provenance for multi-agent AI.**
See — and prove — what your agents *knew, assumed, doubted, and dropped* at every handoff.

🔗 **Live:** https://2gakxc8u.insforge.site
🔐 **Demo login:** `rubric-test@example.com` / `testpass123` (or sign up — then click **Load demo pipeline**)

---

## The gap nobody solves right

In a multi-agent pipeline (`research → write → review`), only the *output* crosses each
handoff. What an agent assumed, doubted, tried-and-rejected, or deliberately excluded is
destroyed at the boundary. The next agent acts on a guess as if it were a fact.

- **Observability tools** (Langfuse, Arize, Braintrust, LangSmith) show you *spans* — raw execution, not structured epistemics.
- **A2A / agent protocols** pass *prose messages*, not grounded reasoning state.
- **Memory tools** (Mem0, Zep, Letta) store *facts across sessions*, not in-pipeline handoff reasoning.

None of them catch the moment a **critical assumption or uncertainty is silently dropped**
between agents — the exact failure that corrupts downstream output and breaks audit trails
in regulated domains (finance, healthcare, legal).

## What Rubric does

1. **Grounded extraction** — turns raw agent traces into structured *epistemic frames*: assumptions, uncertainties, decisions (+ rejected alternatives), exclusions, evidence. Every item is tied to a source trace span or flagged `inferred`. (faithfulness, not LLM-as-judge hand-waving.)
2. **Drop-detection** — for each handoff, lists exactly which assumptions / blocking uncertainties / open threads the prior agent surfaced that the next agent never carried forward. **This is the differentiator.**
3. **Handoff Health Score** — five dimensions (completeness, faithfulness, continuity, information-retention, grounding) → a per-frame and pipeline score, with audit-ready provenance.

## Architecture

Full design in [ARCHITECTURE.md](./ARCHITECTURE.md). Built on [InsForge](https://insforge.dev) (Postgres + auth + storage + edge functions + AI gateway).

```
your agents → traces → [ingest] → raw_traces
                          │
                    [extract] ── AI gateway ──▶ frames (grounded epistemics)
                          │
                     [score] ── AI gateway ──▶ scores (+ dropped-context detection)
                          │
                  [get-handoff] ──▶ dashboard + next-agent compact payload
```

### Backend (`functions/`, `migrations/`)
| Edge function | Purpose | Auth |
|---|---|---|
| `keys-create` | mint `rbk_` ingest keys (hash-only, shown once) | user JWT |
| `ingest` | passive trace ingestion → `raw_traces` (rate-limited) | `rbk_` key |
| `extract` | grounded frame extraction via AI gateway + embedding generation | `rbk_` key / user JWT |
| `score` | Rubric scoring engine + drop-detection | `rbk_` key / user JWT |
| `get-handoff` | consumption: handoff payload + audit view | `rbk_` key / user JWT |
| `ask` | semantic search over epistemic items (**the moat**) | `rbk_` key / user JWT |
| `process` | full pipeline: extract → score in one call (idempotent) | `rbk_` key / user JWT |
| `demo-seed` | loads a regulated credit-underwriting demo | user JWT |

- **Tables:** `pipelines`, `context_objects`, `frames` (epistemics as queryable JSONB + GIN + vector), `raw_traces`, `scores`, `api_keys`, `epistemic_items` (flattened + vector-embedded) — all owner-scoped RLS.
- **Storage:** `trace-payloads`, `agent-outputs` (private).
- **SDK:** `@rubric/sdk` at `sdk/` — TypeScript client with `ingest()`, `extract()`, `score()`, `process()`, `getHandoff()`, `ask()`.

### Frontend (`src/`)
Vite + React + TypeScript + Tailwind, using `@insforge/sdk` (RLS-scoped reads).
Pages: auth · pipelines list · **handoff graph + drop-detection audit panel + grounded frame inspector** · ingest-key management.

## Local development

```bash
npm install
npm run dev          # uses .env (VITE_INSFORGE_URL, VITE_INSFORGE_ANON_KEY)
npm run build        # production build
```

Backend changes:
```bash
npx @insforge/cli db migrations up --all
npx @insforge/cli functions deploy <slug> --file ./functions/<slug>.ts
npx @insforge/cli deployments deploy .
```

## Send your own traces

```bash
curl -X POST https://2gakxc8u.functions.insforge.app/ingest \
  -H "x-rubric-key: rbk_..." -H "Content-Type: application/json" \
  -d '{ "pipeline_name":"my-pipeline", "task":{"goal":"..."}, "source":"langgraph",
        "spans":[ { "span":"agent_a", "role":"researcher", "events":[ ... ] } ] }'
# then: POST /extract and /score with { "context_object_id": "..." }
```

## Pre-launch hardening

- [x] Rate-limit ingestion per key (configurable via `RUBRIC_RATE_LIMIT_MAX`/`RUBRIC_RATE_LIMIT_WINDOW_MS`).
- [x] Semantic `ask(co, question)` over epistemic items (ARCHITECTURE.md §6) — implemented as `ask` edge function + UI panel.
- [x] Full pipeline orchestration (`process` edge function: extract → embed → score in one call).
- [x] `@rubric/sdk` TypeScript client at `sdk/`.
- [x] Test suite (30 tests: SDK contract, UI components, scoring logic, types).
- [ ] Re-enable `require_email_verification` (toggled off so the live demo is instantly usable).
- [ ] Auto-trigger `extract`+`score` on ingest (currently explicit) via a schedule or post-ingest hook.
- [ ] pgvector index tuning (IVFFlat) once `epistemic_items` reaches meaningful volume.
