import { insforge } from './insforge';
import type { ContextObjectSummary, HandoffView, PipelineRow, ContextObjectRow, AskResult } from './types';

// Edge-function invoke wrapper.
async function invoke<T = any>(slug: string, body: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await insforge.functions.invoke(slug, { body });
  if (error) throw new Error(typeof error === 'string' ? error : JSON.stringify(error));
  return data as T;
}

export const api = {
  // --- list page: combine context_objects + pipelines + frames + scores (all RLS-scoped) ---
  async listContextObjects(): Promise<ContextObjectSummary[]> {
    const [cos, pls, frames, scores] = await Promise.all([
      insforge.database.from('context_objects').select('id, task, status, pipeline_id, created_at'),
      insforge.database.from('pipelines').select('id, name'),
      insforge.database.from('frames').select('id, context_object_id, seq, agent'),
      insforge.database.from('scores').select('frame_id, health_score, details'),
    ]);
    const coRows = (cos.data ?? []) as ContextObjectRow[];
    const plMap = new Map((((pls.data ?? []) as PipelineRow[])).map((p) => [p.id, p.name]));
    const frameRows = (frames.data ?? []) as { id: string; context_object_id: string; seq: number; agent: any }[];
    const scoreRows = (scores.data ?? []) as { frame_id: string; health_score: number; details: any }[];
    const scoreByFrame = new Map(scoreRows.map((s) => [s.frame_id, s]));

    return coRows
      .map((co) => {
        const fs = frameRows.filter((f) => f.context_object_id === co.id).sort((a, b) => a.seq - b.seq);
        const healths: number[] = [];
        let dropped = 0;
        for (const f of fs) {
          const s = scoreByFrame.get(f.id);
          if (s) { healths.push(Number(s.health_score)); dropped += (s.details?.dropped?.length ?? 0); }
        }
        return {
          ...co,
          pipeline_name: co.pipeline_id ? plMap.get(co.pipeline_id) ?? null : null,
          frame_count: fs.length,
          health: healths.length ? Math.round((healths.reduce((a, b) => a + b, 0) / healths.length) * 10) / 10 : null,
          dropped_count: dropped,
          roles: fs.map((f) => f.agent?.role ?? '?'),
        } as ContextObjectSummary;
      })
      .sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at));
  },

  getHandoff(contextObjectId: string): Promise<HandoffView> {
    return invoke<HandoffView>('get-handoff', { context_object_id: contextObjectId });
  },

  // demo flow
  async seedDemo(): Promise<{ context_object_id: string }> {
    return invoke('demo-seed', {});
  },
  extract(contextObjectId: string) {
    return invoke('extract', { context_object_id: contextObjectId });
  },
  score(contextObjectId: string) {
    return invoke('score', { context_object_id: contextObjectId });
  },
  async processFull(contextObjectId: string) {
    await this.extract(contextObjectId);
    await this.score(contextObjectId);
  },

  // API keys
  async listKeys() {
    const { data } = await insforge.database
      .from('api_keys').select('id, name, key_prefix, last_used_at, revoked, created_at').order('created_at', { ascending: false });
    return (data ?? []) as { id: string; name: string; key_prefix: string; last_used_at: string | null; revoked: boolean; created_at: string }[];
  },
  createKey(name: string): Promise<{ key: string; record: any }> {
    return invoke('keys-create', { name });
  },
  async revokeKey(id: string) {
    await insforge.database.from('api_keys').update({ revoked: true }).eq('id', id);
  },

  async ask(contextObjectId: string, question: string, itemTypes?: string[], limit?: number): Promise<AskResult> {
    return invoke<AskResult>('ask', { context_object_id: contextObjectId, question, item_types: itemTypes, limit });
  },
};
