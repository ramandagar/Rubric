// @rubric/sdk — Types for the Context Object spec (ARCHITECTURE.md §3).

export interface Agent {
  id?: string;
  role?: string;
  model?: string | null;
}

export interface EpistemicItem {
  trace_span?: string;
  grounded?: boolean;
  confidence?: number;
}

export interface Assumption extends EpistemicItem {
  statement: string;
  basis?: string;
}

export interface Uncertainty extends EpistemicItem {
  question: string;
  impact?: 'high' | 'med' | 'low';
  blocking?: boolean;
}

export interface Decision extends EpistemicItem {
  decision: string;
  rationale?: string;
  alternatives_rejected?: { option: string; why_not: string }[];
}

export interface Attempt extends EpistemicItem {
  approach: string;
  outcome?: string;
  kept?: boolean;
  reason_dropped?: string | null;
}

export interface EvidenceItem extends EpistemicItem {
  claim: string;
  source?: string;
  strength?: 'strong' | 'weak';
}

export interface Excluded {
  what: string;
  why: string;
  trace_span?: string;
}

export interface HandoffNote {
  for_next_agent?: string;
  watch_out_for?: string[];
  open_threads?: string[];
  inherited_assumptions?: string[];
}

export interface FrameInput {
  agent: Agent;
  interpretation?: { restated_goal?: string; scope_in?: string[]; scope_out?: string[] };
  attempts?: Attempt[];
  decisions?: Decision[];
  assumptions?: Assumption[];
  uncertainties?: Uncertainty[];
  evidence?: EvidenceItem[];
  excluded?: Excluded[];
  output?: { summary?: string; format?: string; content_ref?: string };
  handoff_note?: HandoffNote;
  provenance?: { capture_mode?: 'native' | 'adapter' | 'passive'; source?: string; trace_spans?: string[] };
  meta?: { tokens?: number; cost_usd?: number; latency_ms?: number };
}

export interface Frame extends FrameInput {
  id: string;
  seq: number;
  context_object_id: string;
  received?: { from_frame?: string; inputs_ref?: string };
  created_at: string;
}

export interface Task {
  goal?: string;
  original_prompt?: string;
  success_criteria?: string[];
}

export interface ContextObject {
  id: string;
  spec_version: string;
  task: Task;
  lineage: string[];
  current_holder?: string;
  status: 'active' | 'done' | 'failed';
  created_at: string;
  updated_at: string;
}

export interface FrameScore {
  id: string;
  frame_id: string;
  rubric_version: string;
  dimensions: Record<string, number | null>;
  health_score: number;
  details: Record<string, any>;
}

export interface AskResultItem {
  id: string;
  frame_id: string;
  seq: number;
  item_type: 'assumption' | 'uncertainty' | 'decision' | 'excluded' | 'evidence' | 'attempt';
  text: string;
  metadata: Record<string, any>;
  similarity: number | null;
}

export interface AskResult {
  question: string;
  mode: 'semantic' | 'structured';
  total: number;
  results: AskResultItem[];
}

export interface DroppedItem {
  type: 'assumption' | 'uncertainty' | 'open_thread';
  item: string;
  severity?: 'high' | 'med' | 'low';
  at_seq?: number;
  into_role?: string;
}

export interface HandoffView {
  context_object: Pick<ContextObject, 'id' | 'task' | 'status' | 'spec_version' | 'created_at'>;
  pipeline_health: number | null;
  handoff: { from_role?: string; note?: HandoffNote; open_questions: Uncertainty[]; key_assumptions: Assumption[] } | null;
  dropped_context: DroppedItem[];
  frames: (Frame & { score: FrameScore | null })[];
}
