import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { Layout } from '../src/components/Layout';
import { HealthBadge, SeverityPill, GroundedPill, Spinner, ScoreBars } from '../src/components/ui';

import { vi } from 'vitest';
vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 'test@example.com' },
    loading: false,
    signIn: vi.fn(),
    signUp: vi.fn(),
    signOut: vi.fn(),
  }),
}));

describe('Layout', () => {
  it('renders navigation links and user email', () => {
    render(
      <BrowserRouter>
        <Layout><div>content</div></Layout>
      </BrowserRouter>,
    );
    expect(screen.getByText('content')).toBeInTheDocument();
    expect(screen.getByText('Pipelines')).toBeInTheDocument();
    expect(screen.getByText('Ingest keys')).toBeInTheDocument();
    expect(screen.getByText('test@example.com')).toBeInTheDocument();
  });
});

describe('HealthBadge', () => {
  it('renders — for null', () => {
    render(<HealthBadge score={null} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('renders a numeric score', () => {
    render(<HealthBadge score={92} />);
    expect(screen.getByText('92')).toBeInTheDocument();
  });

  it('renders with emerald color for high scores', () => {
    render(<HealthBadge score={90} />);
    expect(screen.getByText('90').className).toContain('emerald');
  });

  it('renders with rose color for low scores', () => {
    render(<HealthBadge score={50} />);
    expect(screen.getByText('50').className).toContain('rose');
  });
});

describe('SeverityPill', () => {
  it('renders high severity', () => {
    render(<SeverityPill severity="high" />);
    const pill = screen.getByText('high');
    expect(pill.className).toContain('rose');
  });

  it('renders medium severity by default', () => {
    render(<SeverityPill />);
    expect(screen.getByText('med')).toBeInTheDocument();
    expect(screen.getByText('med').className).toContain('amber');
  });
});

describe('GroundedPill', () => {
  it('shows grounded for true', () => {
    render(<GroundedPill grounded={true} />);
    expect(screen.getByText('grounded').className).toContain('emerald');
  });

  it('shows inferred for false', () => {
    render(<GroundedPill grounded={false} />);
    expect(screen.getByText('inferred').className).toContain('amber');
  });
});

describe('Spinner', () => {
  it('renders with a label', () => {
    render(<Spinner label="Loading…" />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });
});

describe('ScoreBars', () => {
  const dims = { completeness: 85, faithfulness: 70, continuity: 60, information_loss: 55, grounding: 90 };

  it('renders all five dimension labels', () => {
    render(<ScoreBars dimensions={dims} />);
    expect(screen.getByText('Completeness')).toBeInTheDocument();
    expect(screen.getByText('Faithfulness')).toBeInTheDocument();
    expect(screen.getByText('Continuity')).toBeInTheDocument();
    expect(screen.getByText('Info retention')).toBeInTheDocument();
    expect(screen.getByText('Grounding')).toBeInTheDocument();
  });

  it('renders n/a for null values', () => {
    render(<ScoreBars dimensions={{ completeness: null, faithfulness: 50, continuity: null, information_loss: null, grounding: 80 }} />);
    expect(screen.getAllByText('n/a')).toHaveLength(3);
  });
});
