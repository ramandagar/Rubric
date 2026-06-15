/**
 * langgraph-adapter.ts — One-line agent wrapping.
 *
 * Uses the `wrapAgent()` adapter to auto-capture traces without modifying
 * your agent code. Each wrapped node automatically sends its inputs, outputs,
 * tool calls, and intermediate messages as trace spans.
 */
import { RubricClient } from '@rubric/sdk';
import { wrapAgent } from '@rubric/sdk/adapters/langgraph';

// ---------------------------------------------------------------------------
// 1. Setup
// ---------------------------------------------------------------------------
const rubric = new RubricClient({
  baseUrl: process.env.RUBRIC_BASE_URL!,
  apiKey: process.env.RUBRIC_API_KEY!,
});

// Create the context object once.
let contextObjectId: string | undefined;

async function ensureContext(task: { goal: string }) {
  if (!contextObjectId) {
    const { context_object_id } = await rubric.ingest({
      pipeline_name: 'research→write→review',
      task,
      source: 'langgraph',
      spans: [],
    });
    contextObjectId = context_object_id;
  }
  return contextObjectId;
}

// ---------------------------------------------------------------------------
// 2. Your agent nodes (unchanged — no Rubric code in them)
// ---------------------------------------------------------------------------
async function researcherNode(state: { query: string; messages: any[] }) {
  // Real agent logic goes here. The wrapper captures everything.
  const result = { role: 'assistant', content: `Research results for: ${state.query}` };
  return { messages: [...state.messages, result] };
}

async function writerNode(state: { query: string; messages: any[] }) {
  const result = { role: 'assistant', content: `Written content based on research` };
  return { messages: [...state.messages, result] };
}

async function reviewerNode(state: { query: string; messages: any[] }) {
  const result = { role: 'assistant', content: `Review complete. Approved.` };
  return { messages: [...state.messages, result] };
}

// ---------------------------------------------------------------------------
// 3. Wrap and run
// ---------------------------------------------------------------------------
async function main() {
  const coId = await ensureContext({ goal: 'Analyze Q4 2025 earnings for NVIDIA' });

  // Wrap each node — one line per agent.
  const tracedResearcher = wrapAgent(researcherNode, { rubric, contextObjectId: coId, role: 'researcher' });
  const tracedWriter = wrapAgent(writerNode, { rubric, contextObjectId: coId, role: 'writer' });
  const tracedReviewer = wrapAgent(reviewerNode, { rubric, contextObjectId: coId, role: 'reviewer' });

  // Run the pipeline as normal.
  let state = { query: 'Analyze Q4 2025 earnings for NVIDIA', messages: [] as any[] };

  console.log('Running instrumented pipeline...');
  state = await tracedResearcher(state);
  state = await tracedWriter(state);
  state = await tracedReviewer(state);

  // Process once at the end.
  console.log('Processing traces...');
  const { pipeline_health } = await rubric.process(coId);
  console.log(`Pipeline health: ${pipeline_health}/100`);

  // Query the ledger.
  const { results } = await rubric.ask(coId, 'Did anyone flag uncertainties?');
  console.log(`\nUncertainties found: ${results.length}`);
  for (const r of results) {
    console.log(`  [seq ${r.seq}] ${r.item_type}: ${r.text}`);
  }
}

main().catch(console.error);
