/**
 * custom-pipeline.ts — Native-mode: highest-fidelity epistemic capture.
 *
 * Your agents emit structured frames directly. No extraction LLM needed —
 * the agent itself fills in assumptions, uncertainties, decisions, etc.
 * This is the most accurate mode because the agent introspects its own reasoning
 * rather than having an extractor infer it from trace spans.
 *
 * Ideal for regulated domains (finance, healthcare, legal) where you need
 * audit-ready provenance.
 */
import { RubricClient } from '@rubric/sdk';

const rubric = new RubricClient({
  baseUrl: process.env.RUBRIC_BASE_URL!,
  apiKey: process.env.RUBRIC_API_KEY!,
});

// ---------------------------------------------------------------------------
// Agent A: Researcher — emits a structured epistemic frame
// ---------------------------------------------------------------------------
async function researchTask(query: string) {
  // ... your real research logic here ...

  // The agent introspects and emits its own epistemic frame.
  // This is what makes native mode high-fidelity — the agent itself declares
  // what it assumed, doubted, decided, and excluded.
  await rubric.ingest({
    pipeline_name: 'financial-analysis',
    task: {
      goal: query,
      original_prompt: query,
      success_criteria: [
        'All data sources verified',
        'No unstated assumptions in output',
        'Uncertainties explicitly flagged',
      ],
    },
    source: 'custom',
    spans: [{
      span: 'researcher_frame',
      role: 'researcher',
      events: [
        {
          type: 'tool_call',
          name: 'pull_financial_data',
          result: { revenue: '$39.3B', growth: '+78% YoY', source: 'SEC 10-Q' },
        },
        {
          type: 'tool_call',
          name: 'fetch_analyst_reports',
          result: { consensus_rating: 'Strong Buy', target: '$175' },
        },
        {
          type: 'assumption',
          text: 'Assumed Q4 growth rate is sustainable through H1 2026',
          confidence: 0.6,
          impact: 'high',
          rationale: 'Based on 4 consecutive quarters of accelerating growth',
        },
        {
          type: 'uncertainty',
          text: 'Data center revenue concentration (87%) is a single-point-of-failure risk if cloud capex slows',
          confidence: 0.4,
          impact: 'high',
          blocking: true,
        },
        {
          type: 'decision',
          text: 'Include Data Center segment breakdown as primary risk factor',
          rationale: '87% revenue concentration warrants explicit call-out',
          alternatives_rejected: [
            { option: 'Treat as standard risk', why_not: 'Concentration is unusual — deserves top billing' },
            { option: 'Omit for brevity', why_not: 'Would violate success criteria: no unstated assumptions' },
          ],
        },
        {
          type: 'exclusion',
          text: 'Excluded gaming segment analysis — flat YoY, no material change to thesis',
          why: 'Gaming revenue grew only 2% — not material to the investment case',
        },
        {
          type: 'output',
          summary: 'NVIDIA Q4 2025: Revenue $39.3B (+78% YoY). Data Center $34.2B (+93% YoY). Key risk: revenue concentration (87% DC). Sustainable growth thesis supported but watch capex cycle.',
          format: 'text',
        },
      ],
    }],
  });

  return 'NVIDIA Q4 analysis complete — see frame for details';
}

// ---------------------------------------------------------------------------
// Agent B: Writer — receives the handoff, carries forward what matters
// ---------------------------------------------------------------------------
async function writingTask(contextObjectId: string) {
  // Pull the compact handoff payload from the prior agent.
  const { handoff, dropped_context } = await rubric.getHandoff(contextObjectId);

  console.log('Writer received compact handoff:');
  console.log('  Open threads:', handoff?.note?.open_threads ?? []);
  console.log('  Watch out for:', handoff?.note?.watch_out_for ?? []);

  if (dropped_context.length > 0) {
    console.warn('⚠ Dropped context detected — writer should address:', dropped_context);
  }

  // ... real writing logic here, informed by the handoff ...

  await rubric.ingest({
    context_object_id: contextObjectId,
    source: 'custom',
    spans: [{
      span: 'writer_frame',
      role: 'writer',
      events: [
        {
          type: 'decision',
          text: 'Lead with Data Center revenue concentration risk — addressed open thread from researcher',
          rationale: 'Researcher flagged this as a blocking uncertainty; writer elevates it to the lead',
        },
        {
          type: 'assumption',
          text: 'Assumed audience is institutional investors with financial literacy',
          confidence: 0.9,
          grounded: true,
        },
        {
          type: 'output',
          summary: 'NVIDIA (NVDA) investment memo. Q4 revenue $39.3B, Data Center 87% of mix. Risk: capex cycle. Rating: Overweight.',
          format: 'text',
        },
        {
          type: 'handoff_note',
          text: 'For reviewer: verify Data Center risk framing is appropriate. Check if gaming segment omission is justified.',
        },
      ],
    }],
  });
}

// ---------------------------------------------------------------------------
// Agent C: Reviewer — audits the chain, queries the ledger
// ---------------------------------------------------------------------------
async function reviewingTask(contextObjectId: string) {
  // Before reviewing, ask the ledger: did anyone miss anything?
  const queries = [
    'Did anyone assume the growth rate is sustainable?',
    'What did the researcher decide NOT to include?',
    'Are there any blocking uncertainties that were not resolved?',
  ];

  for (const q of queries) {
    const { results, mode } = await rubric.ask(contextObjectId, q);
    console.log(`\nQ: "${q}" (${mode})`);
    for (const r of results.slice(0, 3)) {
      console.log(`  [seq ${r.seq}] ${r.item_type}: ${r.text}`);
    }
  }

  // Score the pipeline.
  const { pipeline_health } = await rubric.process(contextObjectId);
  console.log(`\nFinal pipeline health: ${pipeline_health}/100`);

  return { approved: pipeline_health >= 70, health: pipeline_health };
}

// ---------------------------------------------------------------------------
// Run the full native-mode pipeline
// ---------------------------------------------------------------------------
async function main() {
  console.log('=== Native-mode pipeline ===\n');

  // Agent A
  await researchTask('Analyze NVIDIA Q4 2025 earnings for investment memo');

  // Get the context object (created by ingest with pipeline_name)
  const coId = 'co_...'; // In a real pipeline, pass this between agents.

  // Agent B
  await writingTask(coId);

  // Agent C
  const result = await reviewingTask(coId);

  console.log(`\n=== Pipeline complete. Approved: ${result.approved} | Health: ${result.health} ===`);
}

main().catch(console.error);
