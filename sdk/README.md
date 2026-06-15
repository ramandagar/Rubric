# @rubric/sdk

**Audit-grade reasoning provenance for multi-agent AI pipelines.**

Rubric captures what your agents *knew, assumed, doubted, and dropped* at every handoff — not just their final output. Integrate with 3 lines of code.

## Install

```bash
npm install @rubric/sdk
```

## Quickstart — 3 lines

```ts
import { RubricClient } from '@rubric/sdk';

const rubric = new RubricClient({
  baseUrl: 'https://<your-project>.functions.insforge.app',
  apiKey: 'rbk_...'   // create in your Rubric dashboard → Ingest keys
});

// 1. Ingest raw traces (passive mode — zero agent changes)
const { context_object_id } = await rubric.ingest({
  pipeline_name: 'research→write→review',
  task: { goal: 'Analyze Q4 earnings and draft a summary' },
  source: 'langgraph',
  spans: [{ span: 'agent_research', role: 'researcher', events: [...] }]
});

// 2. Extract + score in one call
const { pipeline_health } = await rubric.process(context_object_id);

// 3. Query the reasoning ledger
const { results } = await rubric.ask(context_object_id,
  'Did anyone assume the user is US-based?');
```

## How it works

```
your agents → traces → [ingest] → raw_traces
                        │
                  [extract]  ── AI gateway ──▶ frames (grounded epistemics)
                        │
                   [score]  ── AI gateway ──▶ scores (+ dropped-context detection)
                        │
                  [get-handoff]  ──▶ next-agent compact payload
```

Rubric sits **alongside** your orchestrator (LangGraph, CrewAI, etc.). Agents run as normal. After each agent turn, you call `ingest()` with the trace, then `process()` to extract structured epistemic frames and score them.

The output is a **queryable epistemic ledger**: every assumption, uncertainty, decision (+ rejected alternatives), excluded item, and open thread — each tied to its source trace span or flagged `inferred`.

## API Reference

### Constructor

```ts
new RubricClient({
  baseUrl: string;     // Your InsForge functions URL
  apiKey: string;      // Rubric ingest key (rbk_...)
  fetch?: typeof fetch // Optional custom fetch (for Node 18-, testing)
})
```

### `rubric.ingest(params)`

Send raw agent traces for passive extraction. Idempotent — call once per agent turn.

```ts
const { context_object_id, raw_trace_id } = await rubric.ingest({
  context_object_id?: string;  // Reuse an existing CO (omitting creates one)
  pipeline_name?: string;      // Groups runs under a named pipeline
  task?: { goal, original_prompt, success_criteria };
  source?: 'otel' | 'langsmith' | 'langgraph' | 'crewai' | 'custom';
  spans: TraceSpan[];          // The raw agent trace
});

interface TraceSpan {
  span: string;          // Unique span ID
  role: string;          // Agent role (researcher, writer, reviewer)
  events: TraceEvent[];  // Ordered events from this agent
}

interface TraceEvent {
  type: 'tool_call' | 'decision' | 'assumption' | 'uncertainty' | 'exclusion' | 'output';
  name?: string;         // Tool name (for tool_calls)
  result?: any;          // Tool result
  text?: string;         // Natural-language event description
  confidence?: number;   // 0-1
  impact?: 'high' | 'med' | 'low';
  blocking?: boolean;
  rationale?: string;
}
```

Returns: `{ context_object_id, raw_trace_id, status: 'accepted' }` (202)

Rate limit: 60 req/min per key (configurable via `RUBRIC_RATE_LIMIT_MAX`/`RUBRIC_RATE_LIMIT_WINDOW_MS` env vars).

### `rubric.extract(contextObjectId)`

Distills unextracted raw traces into structured epistemic frames via the AI gateway. Each frame captures: interpretation, attempts (incl. rejected paths), decisions (+ rejected alternatives), assumptions, uncertainties, evidence, exclusions, and a compact handoff note for the next agent.

Every epistemic item is ground-truthed (`grounded: true`) against an actual trace span or flagged `grounded: false` with a confidence score.

```ts
const { status, frames_created, frame_ids } = await rubric.extract('co_...');
```

Returns: `{ status, frames_created, frame_ids[] }`

### `rubric.score(contextObjectId)`

Scores every frame across 5 dimensions and computes a Handoff Health Score. The headline feature is **drop-detection**: for each handoff, it lists every assumption/uncertainty/open_thread the prior agent surfaced that the next one silently dropped.

```ts
const { scored, pipeline_health, total_dropped_items, frames } = await rubric.score('co_...');
```

Returns: `{ status, scored, pipeline_health (0-100), total_dropped_items, frames[] }`

Scoring dimensions:

| Dimension | What it measures |
|---|---|
| Completeness | Did the frame surface assumptions/uncertainties/exclusions? |
| Faithfulness | Does the output match stated reasoning/evidence? |
| Continuity | Did the next agent address prior open_threads and inherited_assumptions? |
| Information loss | What the prior agent knew that the next never references |
| Grounding | Ratio of `grounded:true` (trace-tied) to inferred items |

### `rubric.process(contextObjectId)`

Full pipeline in one call: extract → embed → score. Idempotent — reprocessing only handles unextracted traces.

```ts
const { stages, pipeline_health, frames_processed } = await rubric.process('co_...');
```

Returns: `{ stages[], context_object_id, pipeline_health, frames_processed }`

### `rubric.getHandoff(contextObjectId)`

Returns the complete handoff view: compact payload for the next agent + full audit data for the dashboard (all frames, scores, dropped-context warnings).

```ts
const view = await rubric.getHandoff('co_...');
// view.context_object     — task info + status
// view.pipeline_health    — composite score (0-100)
// view.handoff            — compact payload (inject this into the next agent)
// view.dropped_context    — list of all drops across the pipeline
// view.frames[]           — full frames with scores
```

### `rubric.ask(contextObjectId, question, options?)`

Ask a natural-language question against the full epistemic ledger. Uses pgvector semantic search when embeddings are available, falls back to GIN-structured keyword match.

```ts
const { results, mode, total } = await rubric.ask('co_...',
  'Did anyone assume the applicant is US-based?',
  { item_types: ['assumption', 'decision'], limit: 10 }
);

// results: [{ id, frame_id, seq, item_type, text, metadata, similarity }]
```

## Integration patterns

### Pattern 1: Passive (zero agent changes)

Send raw traces after each agent turn. The extractor LLM distills frames from the trace.

```ts
// After agent A finishes:
await rubric.ingest({
  context_object_id: coId,
  source: 'langgraph',
  spans: [{ span: 'agent_a', role: 'researcher', events: agentAEvents }]
});

// Process periodically or at pipeline end:
await rubric.process(coId);
```

### Pattern 2: Adapter (wrap your agent)

Wrap your agent function to auto-capture traces:

```ts
import { wrapAgent } from '@rubric/sdk/adapters/langgraph';

const tracedResearcher = wrapAgent(researcherFn, {
  rubric,
  contextObjectId: coId,
  role: 'researcher'
});

// tracedResearcher behaves identically — traces are captured transparently
const output = await tracedResearcher(input);
```

### Pattern 3: Native (agents emit frames directly)

For highest fidelity, agents call Rubric directly with structured epistemic frames. See [`examples/`](./examples/) for full patterns.

```ts
await rubric.emitFrame(coId, {
  agent: { role: 'researcher', model: 'claude-opus-4-8' },
  interpretation: { restated_goal: '...' },
  assumptions: [{ statement: '...', basis: '...', confidence: 0.8, grounded: true }],
  uncertainties: [{ question: '...', impact: 'high', blocking: true }],
  decisions: [{ decision: '...', rationale: '...', alternatives_rejected: [...] }],
  handoff_note: { for_next_agent: '...', watch_out_for: ['...'], open_threads: ['...'] }
});
```

## The epistemic frame (what gets captured)

Every agent turn produces one frame. Here's what it contains:

| Field | Example |
|---|---|
| `interpretation` | How the agent understood the task |
| `attempts` | Approaches tried, including ones **dropped** with reason |
| `decisions` | Decisions made + **rejected alternatives** + rationale |
| `assumptions` | What was taken for granted, with basis and confidence |
| `uncertainties` | What the agent was unsure about, with impact and blocking flag |
| `evidence` | Claims with source and strength |
| `excluded` | What was deliberately left out and why |
| `handoff_note` | Compact briefing for the next agent |

Every item carries `trace_span` (source span), `grounded` (trace-tied vs inferred), and `confidence`.

## Key management

- Create ingest keys in your Rubric dashboard → **Ingest keys** tab.
- Keys are `rbk_`-prefixed, shown once. Only the SHA-256 hash is stored.
- Revoke keys from the dashboard at any time.
- Scope: each key is tied to your user account via RLS.

## Requirements

- Node.js ≥ 18
- A Rubric backend (InsForge project with `migrations/` applied and `functions/` deployed)

## License

MIT
