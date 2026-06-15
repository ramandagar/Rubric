// Shared types mirroring the Context Object spec (ARCHITECTURE.md §3).

export interface Agent { id?: string; role?: string; model?: string | null }

export interface Assumption { statement: string; basis?: string; confidence?: number; grounded?: boolean; trace_span?: string }
export interface Uncertainty { question: string; impact?: 'high' | 'med' | 'low'; confidence?: number; blocking?: boolean; trace_span?: string }
export interface Decision { decision: string; rationale?: string; alternatives_rejected?: { option: string; why_not: string }[]; grounded?: boolean; trace_span?: string }
export interface Attempt { approach: string; outcome?: string; kept?: boolean; reason_dropped?: string | null; grounded?: boolean; trace_span?: string }
export interface Evidence { claim: string; source?: string; strength?: 'strong' | 'weak'; trace_span?: string }
export interface Excluded { what: string; why: string; trace_span?: string }

export interface HandoffNote { for_next_agent?: string; watch_out_for?: string[]; open_threads?: string[]; inherited_assumptions?: string[] }

export interface DroppedItem { type: 'assumption' | 'uncertainty' | 'open_thread'; item: string; severity?: string; at_seq?: number; into_role?: string }

export interface FrameScore {
  health_score: number;
  dimensions: Record<string, number | null>;
  details: {
    grounding?: { score: number; total: number; grounded: number };
    dropped?: DroppedItem[];
    reasons?: Record<string, string>;
  };
}

export interface Frame {
  id: string;
  seq: number;
  agent: Agent;
  interpretation?: { restated_goal?: string; scope_in?: string[]; scope_out?: string[] };
  attempts: Attempt[];
  decisions: Decision[];
  assumptions: Assumption[];
  uncertainties: Uncertainty[];
  evidence: Evidence[];
  excluded: Excluded[];
  output?: { summary?: string; format?: string; content_ref?: string };
  handoff_note?: HandoffNote;
  provenance?: { capture_mode?: string; source?: string; extractor_model?: string };
  score?: FrameScore | null;
}

export interface Task { goal?: string; original_prompt?: string; success_criteria?: string[] }

export interface HandoffView {
  context_object: { id: string; task: Task; status: string; spec_version: string; created_at: string };
  pipeline_health: number | null;
  handoff: {
    from_role?: string;
    note?: HandoffNote;
    open_questions: Uncertainty[];
    key_assumptions: Assumption[];
  } | null;
  dropped_context: DroppedItem[];
  frames: Frame[];
}

export interface ContextObjectRow {
  id: string;
  task: Task;
  status: string;
  pipeline_id: string | null;
  created_at: string;
}
export interface PipelineRow { id: string; name: string; description?: string }

export interface AskResultItem {
  id: string;
  frame_id: string;
  seq: number;
  item_type: string;
  text: string;
  metadata: Record<string, any>;
  similarity: number | null;
}
export interface AskResult {
  question: string;
  mode: 'semantic' | 'structured';
  context_object_id: string;
  total: number;
  results: AskResultItem[];
  tip: string | null;
}

export interface ContextObjectSummary extends ContextObjectRow {
  pipeline_name: string | null;
  frame_count: number;
  health: number | null;
  dropped_count: number;
  roles: string[];
}
