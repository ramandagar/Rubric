// @rubric/sdk — Client for the Rubric Context Handoff Layer.
// Provides native frame emission, passive trace ingestion, and the ask() query API.
// Works with any orchestration framework (LangGraph, CrewAI, custom).

export type {
  Agent, Assumption, Uncertainty, Decision, Attempt, EvidenceItem, Excluded,
  HandoffNote, FrameInput, Frame, Task, ContextObject, FrameScore,
  AskResultItem, AskResult, DroppedItem, HandoffView,
} from './types.js';

export interface RubricClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
}

export class RubricClient {
  private baseUrl: string;
  private apiKey: string;
  private fetchFn: typeof fetch;

  constructor(options: RubricClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async request<T = any>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-rubric-key': this.apiKey,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error((data as any)?.error ?? `HTTP ${res.status}`);
    return data as T;
  }

  /**
   * Ingest raw traces for passive-mode extraction.
   * The extractor will distill frames from these asynchronously.
   */
  async ingest(params: {
    context_object_id?: string;
    pipeline_name?: string;
    task?: Record<string, unknown>;
    source?: string;
    spans: unknown[];
  }): Promise<{ context_object_id: string; raw_trace_id: string; status: string }> {
    return this.request('/ingest', {
      context_object_id: params.context_object_id,
      pipeline_name: params.pipeline_name,
      task: params.task,
      source: params.source ?? 'custom',
      spans: params.spans,
    });
  }

  /**
   * Extract structured epistemic frames from ingested traces.
   */
  async extract(contextObjectId: string): Promise<{ status: string; frames_created: number; frame_ids: string[] }> {
    return this.request('/extract', { context_object_id: contextObjectId });
  }

  /**
   * Score all frames in a context object — produces Handoff Health Scores + drop-detection.
   */
  async score(contextObjectId: string): Promise<{
    status: string;
    scored: number;
    pipeline_health: number;
    total_dropped_items: number;
    frames: unknown[];
  }> {
    return this.request('/score', { context_object_id: contextObjectId });
  }

  /**
   * Full pipeline: extract + score in one call (idempotent).
   */
  async process(contextObjectId: string): Promise<{
    stages: unknown[];
    context_object_id: string;
    pipeline_health: number | null;
    frames_processed: number;
  }> {
    return this.request('/process', { context_object_id: contextObjectId });
  }

  /**
   * Get the handoff view for a context object — compact payload + audit view.
   */
  async getHandoff(contextObjectId: string): Promise<import('./types.js').HandoffView> {
    return this.request('/get-handoff', { context_object_id: contextObjectId });
  }

  /**
   * Ask a natural-language question against the epistemic ledger.
   * Uses semantic search when embeddings are available, falls back to structured keyword match.
   */
  async ask(
    contextObjectId: string,
    question: string,
    options?: { item_types?: string[]; limit?: number },
  ): Promise<import('./types.js').AskResult> {
    return this.request('/ask', {
      context_object_id: contextObjectId,
      question,
      item_types: options?.item_types,
      limit: options?.limit ?? 10,
    });
  }
}
