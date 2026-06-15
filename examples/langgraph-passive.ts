/**
 * langgraph-passive.ts — Zero-change integration.
 *
 * Run this alongside your existing LangGraph pipeline. After each node finishes,
 * call rubric.ingest() with the raw trace. Extract + score afterward.
 *
 * This is the lowest-friction on-ramp: agents don't change at all.
 */
import { RubricClient } from '@rubric/sdk';

// ---------------------------------------------------------------------------
// 1. Setup
// ---------------------------------------------------------------------------
const rubric = new RubricClient({
  baseUrl: process.env.RUBRIC_BASE_URL!,
  apiKey: process.env.RUBRIC_API_KEY!,
});

// ---------------------------------------------------------------------------
// 2. Your existing LangGraph nodes (unchanged)
// ---------------------------------------------------------------------------
async function researcherNode(state: { query: string; messages: any[] }): Promise<{ messages: any[] }> {
  // ... your real agent logic here ...
  const result = await callLLM('claude-opus-4-8', state.query);
  return { messages: [result] };
}

async function writerNode(state: { messages: any[] }): Promise<{ messages: any[] }> {
  const result = await callLLM('claude-sonnet-4-6', `Write based on: ${JSON.stringify(state.messages)}`);
  return { messages: [result] };
}

async function reviewerNode(state: { messages: any[] }): Promise<{ messages: any[] }> {
  const result = await callLLM('gpt-4o', `Review: ${JSON.stringify(state.messages)}`);
  return { messages: [result] };
}

// ---------------------------------------------------------------------------
// 3. Instrumented graph runner (the Rubric glue)
// ---------------------------------------------------------------------------
interface TraceEvent {
  type: string;
  name?: string;
  text?: string;
  result?: any;
  [key: string]: any;
}

interface AgentNode {
  name: string;
  role: string;
  fn: (state: any) => Promise<any>;
}

async function runInstrumentedGraph(
  nodes: AgentNode[],
  initialState: { query: string },
) {
  // Create a new context object for this pipeline run.
  const { context_object_id } = await rubric.ingest({
    pipeline_name: 'research→write→review',
    task: {
      goal: initialState.query,
      original_prompt: initialState.query,
      success_criteria: ['Accurate', 'Well-written', 'Reviewed'],
    },
    source: 'langgraph',
    spans: [], // Empty — traces come per-node below.
  });

  console.log(`Pipeline started: ${context_object_id}`);

  let state = { ...initialState, messages: [] as any[] };
  const allEvents: Record<string, TraceEvent[]> = {};

  for (const node of nodes) {
    console.log(`  → ${node.name} (${node.role})`);

    const startTime = Date.now();
    let events: TraceEvent[] = [];

    try {
      state = { ...state, ...(await node.fn(state)) };
    } catch (err: any) {
      events.push({ type: 'error', text: err.message });
    }

    events.push({
      type: 'output',
      summary: JSON.stringify(state.messages?.slice(-1)?.[0]?.content ?? '').slice(0, 1000),
    });
    events.push({ type: 'meta', latency_ms: Date.now() - startTime });

    allEvents[node.name] = events;

    // Ingest this agent's trace.
    await rubric.ingest({
      context_object_id,
      source: 'langgraph',
      spans: [{ span: node.name, role: node.role, events }],
    });
  }

  // Extract + score the full pipeline.
  console.log('  → Processing (extract + score)...');
  const { pipeline_health, stages } = await rubric.process(context_object_id);

  console.log(`\nPipeline complete. Health: ${pipeline_health}/100`);
  for (const s of stages) {
    console.log(`  ${s.stage}: ${s.status}${s.detail ? ` (${s.detail})` : ''}`);
  }

  // Query the ledger.
  const { results } = await rubric.ask(context_object_id,
    'Did anyone make assumptions about the target audience?');
  console.log(`\nEpistemic query results: ${results.length} matches`);
  for (const r of results.slice(0, 3)) {
    console.log(`  [seq ${r.seq}] ${r.item_type}: ${r.text}`);
  }

  return { context_object_id, pipeline_health, state };
}

// ---------------------------------------------------------------------------
// 4. Run
// ---------------------------------------------------------------------------
const nodes: AgentNode[] = [
  { name: 'researcher', role: 'researcher', fn: researcherNode },
  { name: 'writer', role: 'writer', fn: writerNode },
  { name: 'reviewer', role: 'reviewer', fn: reviewerNode },
];

runInstrumentedGraph(nodes, { query: 'Analyze Q4 2025 earnings for NVIDIA' })
  .then(({ context_object_id, pipeline_health }) => {
    console.log(`\nView in dashboard: /co/${context_object_id}`);
    console.log(`Pipeline health: ${pipeline_health}/100`);
  })
  .catch(console.error);

// ---------------------------------------------------------------------------
// Placeholder — replace with your actual LLM call.
// ---------------------------------------------------------------------------
async function callLLM(model: string, prompt: string): Promise<any> {
  return { role: 'assistant', content: `[${model} response to: ${prompt.slice(0, 100)}...]` };
}
