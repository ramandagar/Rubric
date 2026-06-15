// @rubric/sdk unit tests — validates the client contract without a running backend.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RubricClient } from '../sdk/src/index';

function createFetch<T>(response: T, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => response,
  });
}

describe('RubricClient', () => {
  const baseUrl = 'https://2gakxc8u.ap-southeast.insforge.app';
  const apiKey = 'rbk_test1234567890abcdef';

  let client: RubricClient;

  beforeEach(() => {
    client = new RubricClient({ baseUrl, apiKey });
  });

  describe('ingest', () => {
    it('sends traces to the ingest endpoint', async () => {
      const fetchFn = createFetch({ context_object_id: 'co_1', raw_trace_id: 'rt_1', status: 'accepted' }, 202);
      client = new RubricClient({ baseUrl, apiKey, fetch: fetchFn });

      const result = await client.ingest({
        pipeline_name: 'test-pipeline',
        task: { goal: 'test' },
        spans: [{ span: 'agent', role: 'tester', events: [] }],
      });

      expect(result.context_object_id).toBe('co_1');
      expect(result.status).toBe('accepted');

      const [url, init] = fetchFn.mock.calls[0];
      expect(url).toBe(`${baseUrl}/ingest`);
      expect(init.headers['x-rubric-key']).toBe(apiKey);
      const body = JSON.parse(init.body);
      expect(body.pipeline_name).toBe('test-pipeline');
      expect(body.spans).toBeDefined();
    });

    it('reuses an existing context_object_id when provided', async () => {
      const fetchFn = createFetch({ context_object_id: 'co_existing', raw_trace_id: 'rt_2', status: 'accepted' }, 202);
      client = new RubricClient({ baseUrl, apiKey, fetch: fetchFn });

      const result = await client.ingest({
        context_object_id: 'co_existing',
        spans: [{ span: 'agent', role: 'tester', events: [] }],
      });

      expect(result.context_object_id).toBe('co_existing');
    });
  });

  describe('extract', () => {
    it('calls the extract endpoint', async () => {
      const fetchFn = createFetch({ status: 'extracted', frames_created: 3, frame_ids: ['f1', 'f2', 'f3'] });
      client = new RubricClient({ baseUrl, apiKey, fetch: fetchFn });

      const result = await client.extract('co_1');
      expect(result.frames_created).toBe(3);
      expect(fetchFn.mock.calls[0][0]).toBe(`${baseUrl}/extract`);
    });
  });

  describe('score', () => {
    it('calls the score endpoint and returns health data', async () => {
      const fetchFn = createFetch({
        status: 'scored',
        scored: 3,
        pipeline_health: 76.5,
        total_dropped_items: 4,
        frames: [],
      });
      client = new RubricClient({ baseUrl, apiKey, fetch: fetchFn });

      const result = await client.score('co_1');
      expect(result.pipeline_health).toBe(76.5);
      expect(result.total_dropped_items).toBe(4);
    });
  });

  describe('process', () => {
    it('calls the process endpoint for full pipeline', async () => {
      const fetchFn = createFetch({
        stages: [{ stage: 'extract', status: 'ok', detail: '3 frames' }, { stage: 'score', status: 'ok', detail: '3 frames scored' }],
        context_object_id: 'co_1',
        pipeline_health: 76.5,
        frames_processed: 3,
      });
      client = new RubricClient({ baseUrl, apiKey, fetch: fetchFn });

      const result = await client.process('co_1');
      expect(result.pipeline_health).toBe(76.5);
      expect(result.frames_processed).toBe(3);
    });
  });

  describe('getHandoff', () => {
    it('returns the handoff view with frames and dropped context', async () => {
      const fetchFn = createFetch({
        context_object: { id: 'co_1', task: { goal: 'test' }, status: 'done', spec_version: '0.1', created_at: '2026-01-01' },
        pipeline_health: 85,
        handoff: null,
        dropped_context: [{ type: 'assumption', item: 'Income is stable', severity: 'high', at_seq: 0, into_role: 'risk_modeler' }],
        frames: [],
      });
      client = new RubricClient({ baseUrl, apiKey, fetch: fetchFn });

      const result = await client.getHandoff('co_1');
      expect(result.pipeline_health).toBe(85);
      expect(result.dropped_context).toHaveLength(1);
      expect(result.dropped_context[0].type).toBe('assumption');
    });
  });

  describe('ask', () => {
    it('queries the ledger with a natural-language question', async () => {
      const fetchFn = createFetch({
        question: 'Did anyone assume the user is US-based?',
        mode: 'structured',
        context_object_id: 'co_1',
        total: 2,
        results: [
          { id: 'ei_1', frame_id: 'f1', seq: 0, item_type: 'assumption', text: 'User is likely US-based', metadata: {}, similarity: null },
          { id: 'ei_2', frame_id: 'f2', seq: 1, item_type: 'decision', text: 'Applied US tax brackets', metadata: {}, similarity: null },
        ],
        tip: null,
      });
      client = new RubricClient({ baseUrl, apiKey, fetch: fetchFn });

      const result = await client.ask('co_1', 'Did anyone assume the user is US-based?', { item_types: ['assumption', 'decision'] });
      expect(result.total).toBe(2);
      expect(result.results).toHaveLength(2);
      expect(result.results[0].item_type).toBe('assumption');
    });
  });

  describe('error handling', () => {
    it('throws on non-ok responses', async () => {
      const fetchFn = createFetch({ error: 'invalid_key' }, 401);
      client = new RubricClient({ baseUrl, apiKey, fetch: fetchFn });

      await expect(client.extract('co_1')).rejects.toThrow('invalid_key');
    });
  });
});
