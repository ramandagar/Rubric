# Rubric — Context Handoff Layer for AI Agents

> A structured **epistemic context object** that travels with a task across a multi-agent
> pipeline, accumulating what each agent *knew, tried, doubted, and decided* — and a
> scoring engine ("rubric") that grades the quality of every handoff.

---

## 1. The problem, stated precisely

In a multi-agent pipeline (`A: research → B: write → C: review`), the only thing that
crosses a handoff boundary is **the final output**. Everything that produced that output
is destroyed at the boundary:

| Lost at handoff | Why Agent B needs it |
| --- | --- |
| **Attempts** — paths A explored and rejected | B re-explores dead ends A already ruled out |
| **Decisions + rationale** — why A chose X over Y | B silently overrides A's choice without knowing the tradeoff |
| **Assumptions** — what A took for granted | B builds on a foundation it can't see, can't validate |
| **Uncertainties** — what A was unsure about | B treats a guess as a fact and amplifies the error |
| **Exclusions** — what A deliberately left out | B "fixes" an omission that was intentional |
| **Open threads** — what A flagged for later | nobody picks them up; they vanish |

Orchestrators (LangChain, CrewAI, LangGraph, AutoGen, OpenAI Agents SDK) route the **task**.
Nobody routes the **reasoning**. That's the gap.

**The new primitive:** a *Context Object* — append-only, travels with the task,
accumulates a structured epistemic record per agent turn. Think **OpenTelemetry for agent
epistemics**, with an **eval/grading layer** on top.

### Non-goals (what keeps this adoptable)
- **We do not replace orchestrators.** Rubric sits *alongside* LangGraph/CrewAI, not under them.
- **We do not require agents to be rewritten.** First-class SDK is best-fidelity, but adapters and passive trace ingestion give value on day one with zero agent changes.
- **We do not dump everything into B's context window.** Storage is easy; *consumption* is the hard part (§6).

---

## 2. The core insight (and the hard part)

Two problems hide inside "route the reasoning":

1. **Capture** — get a faithful epistemic record out of an agent without trusting it to confess perfectly. (Agents confabulate their own reasoning.)
2. **Consumption** — let the next agent *use* that record without blowing the context window or drowning in irrelevance.

Most naive versions solve #1 by asking the agent "explain your reasoning" (unfaithful) and
ignore #2 entirely (just concatenate). **Rubric's defensibility is in solving both:**
grounded capture (§5) and a retrieval/compaction layer that turns the ledger into a
*queryable* surface (§6). The "rubric" scoring engine (§7) is the wedge — it delivers
immediate debugging value before anyone trusts us to route reasoning.

---

## 3. The data model — the Context Object spec

The spec is the product's moat. It must be an **open, versioned JSON Schema** so it can
become a standard, independent of our hosted backend.

### 3.1 `ContextObject` (one per task)
```jsonc
{
  "id": "co_...",
  "spec_version": "0.1",
  "task": {
    "goal": "string",                 // canonical task statement
    "original_prompt": "string",
    "success_criteria": ["..."]
  },
  "lineage": ["frame_a", "frame_b"],   // ordered chain of agent turns
  "current_holder": "agent_c",
  "status": "active | done | failed",
  "created_at": "ts", "updated_at": "ts"
}
```

### 3.2 `Frame` (one per agent turn — the epistemic unit)
Append-only. Each agent that touches the task adds exactly one frame.
```jsonc
{
  "id": "frame_b",
  "context_object_id": "co_...",
  "agent": { "id": "writer", "role": "writer", "model": "claude-opus-4-8" },
  "received": { "from_frame": "frame_a", "inputs_ref": "storage://..." },

  "interpretation": {                 // how B understood the task
    "restated_goal": "string",
    "scope_in":  ["..."],
    "scope_out": ["..."]
  },
  "attempts": [
    { "approach": "string", "outcome": "string",
      "kept": false, "reason_dropped": "string" }
  ],
  "decisions": [
    { "decision": "string", "rationale": "string",
      "alternatives_rejected": [{ "option": "string", "why_not": "string" }] }
  ],
  "assumptions": [
    { "statement": "string", "basis": "string",
      "confidence": 0.0, "validated": false, "grounded": true }   // grounded = traceable to evidence vs inferred
  ],
  "uncertainties": [
    { "question": "string", "impact": "high|med|low",
      "confidence": 0.0, "blocking": false }
  ],
  "evidence": [
    { "claim": "string", "source": "url|tool_call|...", "strength": "strong|weak" }
  ],
  "excluded": [ { "what": "string", "why": "string" } ],

  "output": { "content_ref": "storage://...", "format": "md|json|..." },

  "handoff_note": {                   // the compact, always-read payload for the next agent
    "for_next_agent": "string",
    "watch_out_for": ["..."],
    "open_threads": ["..."],
    "inherited_assumptions": ["assumption_id"]   // explicit chain of inheritance
  },

  "provenance": {                     // how this frame was captured (trust signal)
    "capture_mode": "native|adapter|passive",
    "trace_spans": ["span_id"],       // each epistemic item cites the trace event it came from
    "extractor_model": "string|null"
  },
  "meta": { "tokens": 0, "cost_usd": 0, "latency_ms": 0, "timestamp": "ts" }
}
```

### Key design choices
- **Append-only ledger**, not mutable state → full replay + audit, no lost history.
- **`grounded` flag** on every assumption/claim → distinguishes evidence-backed from inferred, the antidote to confabulation.
- **`inherited_assumptions`** makes the epistemic chain explicit → enables "B built on A's assumption X, which C later invalidated" analysis.
- **Refs, not blobs** (`content_ref`, `inputs_ref`) → big outputs live in storage; the frame stays queryable.

---

## 4. System architecture (layers)

```
┌─────────────────────────────────────────────────────────────────────┐
│  AGENT RUNTIME (user's pipeline — LangGraph / CrewAI / custom)        │
│   ┌────────┐  handoff   ┌────────┐  handoff   ┌────────┐              │
│   │Agent A │──────────▶ │Agent B │──────────▶ │Agent C │              │
│   └───┬────┘            └───┬────┘            └───┬────┘              │
└───────│─────────────────────│────────────────────│──────────────────┘
        │  capture (3 modes)   │                    │
        ▼                      ▼                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  RUBRIC SDK  (@rubric/sdk — TS + Python)                              │
│   • native contract  • framework adapters  • passive trace ingest     │
└───────────────────────────────┬─────────────────────────────────────┘
                                 │ ingest API (signed, async)
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  RUBRIC BACKEND  (InsForge)                                           │
│   Postgres (context_objects, frames JSONB, scores)  ── RLS multi-tenant│
│   Storage   (outputs, raw traces)                                     │
│   Edge fns  (extractor · compaction/query · rubric scorer · ingest)   │
│   AI gateway(OpenRouter: extraction / summarize / score)             │
│   Realtime  (live handoff graph)                                     │
└───────────────┬───────────────────────────────┬─────────────────────┘
                │ query/compaction API           │ realtime
                ▼                                 ▼
┌──────────────────────────┐        ┌────────────────────────────────┐
│ CONSUMPTION (Agent B)     │        │ DASHBOARD (Next.js)             │
│ getHandoffContext(taskId) │        │ handoff graph · frame inspector │
│ ask(co, "did A consider…")│        │ epistemic diff · rubric scores  │
└──────────────────────────┘        └────────────────────────────────┘
```

---

## 5. Capture — three modes, graduated fidelity

The bet: **meet teams where they are.** Adoption friction kills infra products, so we offer
three on-ramps from zero-effort to high-fidelity.

| Mode | Effort | Fidelity | How |
| --- | --- | --- | --- |
| **Passive** | none | low–med | Ingest existing traces (OTel / LangSmith export). An extractor LLM distills frames *from real trace spans only*. |
| **Adapter** | wrap agents | med–high | `wrapAgent()` / callback handlers for LangGraph, CrewAI, AutoGen. Captures I/O + intermediate steps; extractor fills epistemic fields, each item citing a span. |
| **Native** | structured output | highest | Agent emits a frame directly via a tool/output contract. No extraction guesswork. |

**Faithfulness guardrails (this is what makes capture trustworthy):**
- The extractor is only allowed to emit items **grounded in actual trace events** (tool calls, intermediate messages, retrieved docs). Each epistemic item must cite a `trace_span`.
- Items the extractor *infers* without a span get `grounded: false` and a confidence score — surfaced differently in the UI and down-weighted by the scorer.
- Capture is **async and out-of-band** (post-handoff), so it never adds latency to the user's pipeline.

---

## 6. Consumption — the retrieval/compaction layer (the real moat)

Storing reasoning is trivial. The hard, defensible part is letting Agent B *use* A's
reasoning **without** pasting 50KB of ledger into its prompt. Three access patterns:

1. **`handoff_note` (always injected, ~200 tokens).** The compact "for the next agent" payload — open threads, watch-outs, inherited assumptions. Cheap, high-signal, included in every handoff by default.

2. **Relevance-ranked digest.** On `getHandoffContext(taskId)`, a compaction edge function returns a budgeted summary: top-k assumptions/uncertainties/decisions ranked by `impact × (1 − confidence) × relevance-to-B's-subtask`. Budget is a token cap the caller sets.

3. **Query API — `ask(co, question)`.** B (or a human) asks natural-language questions against the ledger: *"Did anyone assume the user is US-based?"* / *"What did research decide NOT to include?"* Backed by structured filters over the frames' JSONB **plus** semantic search over embedded epistemic items. This is what turns a passive log into a *router of reasoning*.

> **Why this matters:** without §6, Rubric is just a logging library. With it, the next agent
> actively pulls the *relevant slice* of prior reasoning on demand — which is the literal
> thing the Problem statement asks for ("routing the reasoning").

---

## 7. The Rubric engine — scoring handoff quality (the wedge)

A configurable rubric scores each handoff. This is the **immediate-value entry point**:
teams adopt it as a *debugging/observability* tool long before they trust it to route reasoning.

| Dimension | What it measures | Signal source |
| --- | --- | --- |
| **Completeness** | Did the frame surface assumptions/uncertainties/exclusions, or hand off a bare output? | frame field density vs task complexity |
| **Faithfulness** | Does the output actually match the stated reasoning/evidence? | output ↔ evidence/decisions cross-check |
| **Continuity** | Did B address A's `open_threads` and `inherited_assumptions`? | frame-to-frame diff |
| **Information loss** | Epistemic entropy across the boundary — what A knew that B never references | A.frame ∩ B.received analysis |
| **Grounding** | Ratio of `grounded:true` to inferred items | provenance flags |

Outputs a **Handoff Health Score** + drill-downs. Powers:
- **Regression tracking** — score handoffs over time / across prompt or model changes.
- **Alerts** — "this handoff dropped 3 high-impact assumptions."
- **Eval harness** — CI gate: fail a PR if handoff quality regresses.

Rubrics are user-configurable (weights, custom dimensions) and run as edge functions calling
the AI gateway with the frame + a scoring prompt, results cached in Postgres.

---

## 8. InsForge mapping (concrete backend plan)

| Capability | InsForge primitive | Notes |
| --- | --- | --- |
| `context_objects`, `frames`, `scores`, `projects`, `api_keys` | **Postgres** | `frames` uses JSONB for the flexible epistemic fields + generated columns / GIN indexes for query. **RLS** scopes every row to an org/project. |
| Large outputs, raw traces, embeddings payloads | **Storage** buckets | frames hold `content_ref` keys; persist both `url` and `key`. |
| Ingest, extractor, compaction/query, rubric scorer | **Edge functions** | stateless, async; ingest is signed + idempotent. |
| Extraction / summarization / scoring LLM calls | **AI gateway (OpenRouter)** | model-agnostic; cost tracked into `meta`. |
| Live handoff graph in dashboard | **Realtime** | subscribe to `frames` inserts per task. |
| Multi-tenant SDK auth, dashboard login | **Auth + API keys** | SDK ingest keys are project-scoped, RLS-enforced. |
| Semantic `ask()` over epistemic items | **Postgres + pgvector** | embed assumptions/decisions/uncertainties; hybrid (filter + vector) search. |

> Backend is provisioned/managed via the **`insforge-cli`** skill (SQL, migrations, RLS,
> buckets, functions, secrets); app/SDK code uses the **`insforge`** skill (`@insforge/sdk`).

---

## 9. Build phases (how we ship a top-notch product)

**Phase 0 — Primitive + proof (weeks 1–3)**
- Freeze **Context Object spec v0.1** (open JSON Schema, public repo).
- `@rubric/sdk` core (TS first): create CO, append frame, `getHandoffContext`.
- InsForge store: `context_objects` + `frames` tables, RLS, ingest edge fn.
- One end-to-end demo on a real 3-agent LangGraph pipeline.

**Phase 1 — Observability wedge (weeks 4–7)**
- **Passive trace ingestion** + **one adapter** (LangGraph) → zero-rewrite onboarding.
- Dashboard: **handoff graph**, frame inspector, epistemic diff between frames.
- This phase alone is shippable/valuable: "see what your agents drop at every handoff."

**Phase 2 — Consumption layer (weeks 8–11)**
- Compaction digest + **`ask(co, question)`** query API (pgvector hybrid search).
- Now the next agent can *pull relevant reasoning* — the core promise is real.

**Phase 3 — Rubric scoring (weeks 12–15)**
- Scoring engine, Handoff Health Score, alerts, CI eval gate.
- Regression tracking across model/prompt changes.

**Phase 4 — Standard + scale**
- More adapters (CrewAI, AutoGen, OpenAI Agents SDK), Python SDK parity.
- Spec governance (push toward an open standard), enterprise (RBAC, audit, self-host).

---

## 10. Why this wins where others haven't

- **Right altitude:** we don't fight orchestrators — we add the missing *epistemic* layer beside them. Complementary, not competitive.
- **Land-and-expand:** observability/scoring (Phase 1–3) is *immediately useful* and low-friction; it earns the right to become the routing standard.
- **Open spec = standard play:** the Context Object spec is open and framework-agnostic; the hosted backend (store + consumption + rubric) is the monetizable layer.
- **The hard part is the moat:** anyone can store a JSON log. The grounded-capture + queryable-consumption + scoring trio is the defensible engineering.

---

## 11. Key risks & mitigations

| Risk | Mitigation |
| --- | --- |
| **Confabulated reasoning** (agents lie about why they did things) | Grounded-only extraction tied to real trace spans; `grounded` flags; scorer down-weights inferred items. |
| **Context-window blowup** on consumption | Never inject the raw ledger — compaction digest + on-demand `ask()` with a token budget. |
| **Adoption friction** | Three capture modes; passive ingestion needs zero agent changes. |
| **"Just use LangSmith/tracing"** | Traces are *raw spans*; Rubric is *structured epistemics + scoring + reasoning routing*. We ingest traces as one input, not a competitor. |
| **Spec churn** | `spec_version` on every object; SDK negotiates; migrations are additive. |
| **Latency** | All capture is async/out-of-band; never on the pipeline's critical path. |
```
