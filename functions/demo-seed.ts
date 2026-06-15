// demo-seed — loads a realistic regulated-finance (credit underwriting) 3-agent pipeline.
// The traces deliberately contain DROPPED epistemic context: Agent A flags uncertainty about
// gig-income stability and makes an assumption about an employment gap; Agent B treats them as
// settled facts; Agent C writes the adverse-action rationale on top — a real compliance exposure.
// Run extract + score afterward to see Rubric catch the drops.
import { createClient, createAdminClient } from 'npm:@insforge/sdk';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const TASK = {
  goal: 'Adjudicate a consumer credit application and produce a compliant decision rationale',
  original_prompt: 'Review application #A-4471 for a $28,000 auto loan and decide approve/decline with a documented rationale.',
  success_criteria: ['ECOA/fair-lending compliant', 'every decision factor traceable to evidence', 'no unstated assumptions in the adverse-action notice'],
};

const TRACES = [
  {
    source: 'langgraph',
    spans: [
      { span: 'agent_a.data_analyst', role: 'data_analyst', events: [
        { type: 'tool_call', name: 'pull_credit_bureau', result: 'FICO 662, 1 derogatory 26mo ago' },
        { type: 'tool_call', name: 'parse_income_docs', result: 'W2 $41k + 1099 gig income ~$13k (3 months of statements only)' },
        { type: 'assumption', text: 'Assumed the 1099 gig income (~$13k/yr) is stable and annualizable from only 3 months of data', confidence: 0.4 },
        { type: 'uncertainty', text: 'Only 3 months of gig income visible — cannot confirm 12-month stability; debt-to-income could swing 8 points', impact: 'high', blocking: true },
        { type: 'exclusion', text: 'Excluded a 2-month employment gap from the risk narrative — treated as likely parental leave, not verified' },
        { type: 'decision', text: 'Compute DTI using full annualized gig income', rationale: 'keeps applicant eligible under 43% DTI threshold' },
        { type: 'output', summary: 'DTI 39% (using annualized gig income), FICO 662, one aged derogatory. Borderline-approvable.' },
      ] },
    ],
  },
  {
    source: 'langgraph',
    spans: [
      { span: 'agent_b.risk_modeler', role: 'risk_modeler', events: [
        { type: 'tool_call', name: 'score_risk_model_v3', result: 'PD 6.8%, risk grade B-' },
        { type: 'decision', text: 'Use DTI 39% and full income as provided by data analyst', rationale: 'inputs accepted from upstream agent' },
        { type: 'assumption', text: 'Treated annual income of $54k as verified and stable', confidence: 0.9 },
        { type: 'output', summary: 'Risk grade B-, PD 6.8%, within approvable band. Recommend approve at 11.9% APR.' },
      ] },
    ],
  },
  {
    source: 'langgraph',
    spans: [
      { span: 'agent_c.decision_writer', role: 'decision_writer', events: [
        { type: 'decision', text: 'Approve at 11.9% APR and draft the approval rationale', rationale: 'risk grade B- is within policy' },
        { type: 'output', summary: 'APPROVED. Rationale cites verified $54k annual income and 39% DTI as primary qualifying factors.' },
      ] },
    ],
  },
];

async function ownerFromJwt(req: Request): Promise<string | null> {
  const token = req.headers.get('Authorization')?.replace('Bearer ', '') ?? null;
  if (!token) return null;
  const c = createClient({ baseUrl: Deno.env.get('RUBRIC_BASE_URL'), edgeFunctionToken: token });
  const { data } = await c.auth.getCurrentUser();
  return data?.user?.id ?? null;
}

export default async function (req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const owner = await ownerFromJwt(req);
  if (!owner) return json({ error: 'unauthorized' }, 401);

  const admin = createAdminClient({ baseUrl: Deno.env.get('RUBRIC_BASE_URL'), apiKey: Deno.env.get('RUBRIC_ADMIN_KEY') });

  const { data: pls } = await admin.database
    .from('pipelines').insert([{ owner_id: owner, name: 'Credit Underwriting (demo)', description: 'Data → Risk → Decision. Regulated adjudication with intentional context drops.' }]).select('id');
  const pipelineId = pls?.[0]?.id;

  const { data: co } = await admin.database
    .from('context_objects').insert([{ owner_id: owner, pipeline_id: pipelineId, task: TASK, status: 'active' }]).select('id');
  const coId = co?.[0]?.id;
  if (!coId) return json({ error: 'seed_failed' }, 500);

  for (const t of TRACES) {
    await admin.database.from('raw_traces').insert([{ owner_id: owner, context_object_id: coId, source: t.source, payload: t.spans }]);
  }

  return json({ status: 'seeded', context_object_id: coId, pipeline_id: pipelineId, traces: TRACES.length, next: 'call extract then score with this context_object_id' }, 201);
}
