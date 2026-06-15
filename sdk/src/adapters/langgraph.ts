// @rubric/sdk/adapters/langgraph — wrap a LangGraph node function to auto-capture
// traces for passive extraction. Zero changes to agent logic — the wrapper intercepts
// inputs, outputs, tool calls, and intermediate messages and sends them as trace spans.

import type { RubricClient } from '../index.js';

interface WrapOptions {
  rubric: RubricClient;
  contextObjectId?: string;
  role: string;
  pipelineName?: string;
}

interface LangGraphState {
  messages?: Array<{ role: string; content: string; tool_calls?: Array<{ name: string; args: unknown; id: string }> }>;
  [key: string]: unknown;
}

/**
 * Wraps a LangGraph node function to automatically capture traces.
 * The wrapped function behaves identically to the original — tracing is transparent.
 *
 * @example
 * ```ts
 * import { wrapAgent } from '@rubric/sdk/adapters/langgraph';
 *
 * const tracedNode = wrapAgent(myNodeFunction, {
 *   rubric: client,
 *   role: 'researcher',
 *   pipelineName: 'research→write→review',
 * });
 *
 * const graph = new StateGraph(channels)
 *   .addNode('researcher', tracedNode)
 *   .compile();
 * ```
 */
export function wrapAgent<T extends LangGraphState, R extends Partial<T>>(
  fn: (state: T) => Promise<R> | R,
  options: WrapOptions,
): (state: T) => Promise<R> {
  const { rubric, role, pipelineName } = options;
  let coId: string | undefined = options.contextObjectId;

  return async (state: T): Promise<R> => {
    const events: Array<Record<string, unknown>> = [];
    const startTime = Date.now();

    // Capture input state as the task context for this agent turn.
    const inputSummary = summarizeState(state);
    if (inputSummary) {
      events.push({
        type: 'input',
        text: `Received state: ${inputSummary}`,
        timestamp: new Date().toISOString(),
      });
    }

    // If the state has messages, capture the last user message as context.
    const msgs = state.messages ?? [];
    const lastUserMsg = [...msgs].reverse().find((m) => m.role === 'user');
    if (lastUserMsg) {
      events.push({
        type: 'context',
        text: `User instruction: ${truncate(lastUserMsg.content, 500)}`,
        timestamp: new Date().toISOString(),
      });
    }

    // Execute the original node function.
    let result: R;
    try {
      result = await Promise.resolve(fn(state));
    } catch (err) {
      events.push({
        type: 'error',
        text: `Node failed: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: new Date().toISOString(),
      });
      throw err;
    }

    // Capture output.
    if (result.messages?.length) {
      const lastMsg = result.messages[result.messages.length - 1];
      if (lastMsg.content) {
        events.push({
          type: 'output',
          summary: truncate(lastMsg.content, 1000),
          format: 'text',
        });
      }
      // Capture tool calls.
      for (const msg of result.messages) {
        if (msg.tool_calls?.length) {
          for (const tc of msg.tool_calls) {
            events.push({
              type: 'tool_call',
              name: tc.name,
              args: tc.args,
              timestamp: new Date().toISOString(),
            });
          }
        }
        if (msg.role === 'tool') {
          events.push({
            type: 'tool_result',
            text: truncate(msg.content, 500),
            timestamp: new Date().toISOString(),
          });
        }
      }
    }

    const latencyMs = Date.now() - startTime;

    // Ingest trace asynchronously — don't block the pipeline.
    ingestTrace(rubric, coId, role, pipelineName, events, latencyMs)
      .then((id) => { if (id) coId = id; })
      .catch(() => { /* best-effort — never fail the pipeline */ });

    return result;
  };
}

function summarizeState(state: LangGraphState): string {
  const keys = Object.keys(state).filter((k) => k !== 'messages');
  if (!keys.length) return '';
  return keys
    .map((k) => {
      const v = state[k];
      if (typeof v === 'string') return `${k}: ${truncate(v, 200)}`;
      if (typeof v === 'object' && v !== null) return `${k}: ${truncate(JSON.stringify(v), 200)}`;
      return `${k}: ${String(v)}`;
    })
    .join('; ');
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '…';
}

async function ingestTrace(
  rubric: RubricClient,
  coId: string | undefined,
  role: string,
  pipelineName: string | undefined,
  events: Array<Record<string, unknown>>,
  latencyMs: number,
): Promise<string | undefined> {
  try {
    const { context_object_id } = await rubric.ingest({
      context_object_id: coId,
      pipeline_name: pipelineName,
      source: 'langgraph',
      spans: [{
        span: `${role}_${Date.now()}`,
        role,
        events: [...events, { type: 'meta', latency_ms: latencyMs }],
      }],
    });
    return context_object_id;
  } catch {
    return undefined;
  }
}
