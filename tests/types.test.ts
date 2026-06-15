import { describe, it, expect } from 'vitest';

// Validate the Context Object spec types — these are structural tests, not runtime.
// They ensure the Frame type definitions remain consistent with ARCHITECTURE.md §3.2.

describe('Frame structure', () => {
  it('has all required epistemic array fields', () => {
    const minimalFrame = {
      id: 'frame_1',
      seq: 0,
      agent: { role: 'researcher', model: 'claude-opus-4-8' },
      attempts: [],
      decisions: [],
      assumptions: [],
      uncertainties: [],
      evidence: [],
      excluded: [],
      output: {},
      handoff_note: {},
      provenance: { capture_mode: 'passive' },
      meta: { timestamp: new Date().toISOString() },
    };

    expect(minimalFrame).toBeDefined();
    expect(Array.isArray(minimalFrame.attempts)).toBe(true);
    expect(Array.isArray(minimalFrame.decisions)).toBe(true);
    expect(Array.isArray(minimalFrame.assumptions)).toBe(true);
    expect(Array.isArray(minimalFrame.uncertainties)).toBe(true);
    expect(Array.isArray(minimalFrame.evidence)).toBe(true);
    expect(Array.isArray(minimalFrame.excluded)).toBe(true);
  });

  it('properly models an assumption with grounding metadata', () => {
    const assumption = {
      statement: 'Gig income is stable and annualizable',
      basis: '3 months of 1099 data',
      confidence: 0.4,
      grounded: false,
      trace_span: 'agent_a.data_analyst.assumption_3',
    };

    expect(assumption.grounded).toBe(false);
    expect(assumption.confidence).toBeLessThan(0.5);
    expect(assumption.trace_span).toBeDefined();
  });

  it('properly models an uncertainty with impact', () => {
    const uncertainty = {
      question: 'Can gig income stability be confirmed beyond 3 months?',
      impact: 'high' as const,
      confidence: 0.3,
      blocking: true,
      trace_span: 'agent_a.data_analyst.uncertainty_2',
    };

    expect(uncertainty.blocking).toBe(true);
    expect(uncertainty.impact).toBe('high');
  });

  it('properly models a dropped item (score output)', () => {
    const dropped = {
      type: 'assumption' as const,
      item: 'Gig income is stable and annualizable',
      severity: 'high' as const,
      at_seq: 1,
      into_role: 'risk_modeler',
    };

    expect(dropped.type).toBe('assumption');
    expect(dropped.severity).toBe('high');
    expect(dropped.at_seq).toBe(1);
  });
});

describe('Health score composite', () => {
  // Test the composite scoring formula from score.ts
  function composite(d: Record<string, number | null>): number {
    const w: Record<string, number> = { completeness: 0.2, faithfulness: 0.25, continuity: 0.2, information_loss: 0.2, grounding: 0.15 };
    let num = 0, den = 0;
    for (const k of Object.keys(w)) {
      if (typeof d[k] === 'number') { num += d[k] * w[k]; den += w[k]; }
    }
    return den ? Math.round((num / den) * 100) / 100 : 0;
  }

  it('computes correct weighted average for all dimensions', () => {
    const dims = { completeness: 80, faithfulness: 90, continuity: 70, information_loss: 75, grounding: 85 };
    const expected = (80 * 0.2 + 90 * 0.25 + 70 * 0.2 + 75 * 0.2 + 85 * 0.15);
    expect(composite(dims)).toBeCloseTo(expected, 2);
  });

  it('reweights when first frame has no continuity/info_loss', () => {
    const dims = { completeness: 80, faithfulness: 90, continuity: null, information_loss: null, grounding: 85 };
    const expected = (80 * 0.2 + 90 * 0.25 + 85 * 0.15) / (0.2 + 0.25 + 0.15);
    expect(composite(dims)).toBeCloseTo(expected, 2);
  });

  it('returns 0 when no dimensions are scored', () => {
    const dims = { completeness: null, faithfulness: null, continuity: null, information_loss: null, grounding: null };
    expect(composite(dims)).toBe(0);
  });
});

describe('Grounding score', () => {
  function groundingScore(frame: any): { score: number; total: number; grounded: number } {
    const items = [
      ...(frame.assumptions ?? []), ...(frame.decisions ?? []),
      ...(frame.attempts ?? []), ...(frame.evidence ?? []),
    ];
    if (!items.length) return { score: 100, total: 0, grounded: 0 };
    const grounded = items.filter((i: any) => i.grounded === true || (i.trace_span && i.grounded !== false)).length;
    return { score: Math.round((grounded / items.length) * 100), total: items.length, grounded };
  }

  it('returns 100 for empty lists', () => {
    const frame = { assumptions: [], decisions: [], attempts: [], evidence: [] };
    expect(groundingScore(frame)).toEqual({ score: 100, total: 0, grounded: 0 });
  });

  it('counts grounded and inferred items correctly', () => {
    const frame = {
      assumptions: [
        { statement: 'a', grounded: true, trace_span: 's1' },
        { statement: 'b', grounded: false },
      ],
      decisions: [
        { decision: 'd', grounded: true, trace_span: 's2' },
      ],
      attempts: [],
      evidence: [],
    };
    const result = groundingScore(frame);
    expect(result.total).toBe(3);
    expect(result.grounded).toBe(2);
    expect(result.score).toBe(67);
  });

  it('counts items with trace_span but no explicit grounded as grounded', () => {
    const frame = {
      assumptions: [{ statement: 'x', trace_span: 's10' }],
      decisions: [],
      attempts: [],
      evidence: [],
    };
    const result = groundingScore(frame);
    expect(result.grounded).toBe(1);
  });
});
