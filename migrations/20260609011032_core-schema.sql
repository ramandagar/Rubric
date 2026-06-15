-- Rubric — Context Handoff Layer: core schema
-- Implements the Context Object spec (see ARCHITECTURE.md §3) as multi-tenant tables.
-- Every row is owned by an auth user; RLS scopes all access to the owner.
-- Server-side ingestion runs with the admin key (bypasses RLS) and sets owner_id explicitly.

-- ---------------------------------------------------------------------------
-- pipelines: a named multi-agent system the user is observing (e.g. "research→write→review")
-- ---------------------------------------------------------------------------
create table public.pipelines (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  description text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index pipelines_owner_idx on public.pipelines (owner_id, created_at desc);

-- ---------------------------------------------------------------------------
-- context_objects: one per task. The append-only ledger header.
-- ---------------------------------------------------------------------------
create table public.context_objects (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users(id) on delete cascade,
  pipeline_id  uuid references public.pipelines(id) on delete set null,
  spec_version text not null default '0.1',
  -- task: { goal, original_prompt, success_criteria[] }
  task         jsonb not null default '{}'::jsonb,
  lineage      uuid[] not null default '{}',          -- ordered frame ids
  current_holder text,                                -- agent id currently holding the task
  status       text not null default 'active'
                 check (status in ('active','done','failed')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index context_objects_owner_idx   on public.context_objects (owner_id, created_at desc);
create index context_objects_pipeline_idx on public.context_objects (pipeline_id);
create index context_objects_status_idx   on public.context_objects (owner_id, status);

-- ---------------------------------------------------------------------------
-- frames: one per agent turn. The epistemic unit. Append-only.
-- Epistemic fields are separate JSONB columns so each is independently queryable.
-- ---------------------------------------------------------------------------
create table public.frames (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null references auth.users(id) on delete cascade,
  context_object_id uuid not null references public.context_objects(id) on delete cascade,
  seq               integer not null,                 -- position in the lineage chain (0-based)
  -- agent: { id, role, model }
  agent             jsonb not null default '{}'::jsonb,
  -- received: { from_frame, inputs_ref }
  received          jsonb not null default '{}'::jsonb,
  -- interpretation: { restated_goal, scope_in[], scope_out[] }
  interpretation    jsonb not null default '{}'::jsonb,
  -- the epistemic arrays (see ARCHITECTURE.md §3.2)
  attempts          jsonb not null default '[]'::jsonb,
  decisions         jsonb not null default '[]'::jsonb,
  assumptions       jsonb not null default '[]'::jsonb,
  uncertainties     jsonb not null default '[]'::jsonb,
  evidence          jsonb not null default '[]'::jsonb,
  excluded          jsonb not null default '[]'::jsonb,
  -- output: { content_ref, format }
  output            jsonb not null default '{}'::jsonb,
  -- handoff_note: { for_next_agent, watch_out_for[], open_threads[], inherited_assumptions[] }
  handoff_note      jsonb not null default '{}'::jsonb,
  -- provenance: { capture_mode, trace_spans[], extractor_model }
  provenance        jsonb not null default '{}'::jsonb,
  -- meta: { tokens, cost_usd, latency_ms, timestamp }
  meta              jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  unique (context_object_id, seq)
);
create index frames_co_idx            on public.frames (context_object_id, seq);
create index frames_owner_idx         on public.frames (owner_id, created_at desc);
-- GIN indexes for querying inside the epistemic arrays (the ask() API, §6)
create index frames_assumptions_gin   on public.frames using gin (assumptions jsonb_path_ops);
create index frames_uncertainties_gin on public.frames using gin (uncertainties jsonb_path_ops);
create index frames_decisions_gin     on public.frames using gin (decisions jsonb_path_ops);

-- ---------------------------------------------------------------------------
-- raw_traces: passive-mode input. Raw OTel/LangSmith spans before extraction.
-- An extractor edge function reads these and produces frames.
-- ---------------------------------------------------------------------------
create table public.raw_traces (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null references auth.users(id) on delete cascade,
  context_object_id uuid references public.context_objects(id) on delete cascade,
  source            text not null default 'otel'
                      check (source in ('otel','langsmith','langgraph','crewai','custom')),
  payload           jsonb not null,                   -- raw spans
  extracted         boolean not null default false,   -- has the extractor processed this?
  ingested_at       timestamptz not null default now()
);
create index raw_traces_co_idx      on public.raw_traces (context_object_id);
create index raw_traces_pending_idx on public.raw_traces (owner_id, extracted) where extracted = false;

-- ---------------------------------------------------------------------------
-- scores: rubric scores per frame (the Handoff Health Score, §7).
-- ---------------------------------------------------------------------------
create table public.scores (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references auth.users(id) on delete cascade,
  frame_id       uuid not null references public.frames(id) on delete cascade,
  rubric_version text not null default '0.1',
  -- dimensions: { completeness, faithfulness, continuity, information_loss, grounding }
  dimensions     jsonb not null default '{}'::jsonb,
  health_score   numeric(5,2),                        -- 0..100 composite
  details        jsonb not null default '{}'::jsonb,  -- per-dimension explanations
  created_at     timestamptz not null default now()
);
create index scores_frame_idx on public.scores (frame_id);
create index scores_owner_idx on public.scores (owner_id, created_at desc);

-- ---------------------------------------------------------------------------
-- api_keys: project-scoped SDK ingestion tokens. Only the hash is stored.
-- ---------------------------------------------------------------------------
create table public.api_keys (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users(id) on delete cascade,
  name         text not null,
  key_prefix   text not null,                         -- first chars, shown in UI (e.g. "rbk_a1b2")
  key_hash     text not null,                         -- sha-256 of the full key
  last_used_at timestamptz,
  revoked      boolean not null default false,
  created_at   timestamptz not null default now()
);
create unique index api_keys_hash_idx on public.api_keys (key_hash);
create index api_keys_owner_idx on public.api_keys (owner_id, created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger pipelines_set_updated_at
  before update on public.pipelines
  for each row execute function public.set_updated_at();
create trigger context_objects_set_updated_at
  before update on public.context_objects
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security: owner-only access on every table.
-- ---------------------------------------------------------------------------
alter table public.pipelines       enable row level security;
alter table public.context_objects enable row level security;
alter table public.frames          enable row level security;
alter table public.raw_traces      enable row level security;
alter table public.scores          enable row level security;
alter table public.api_keys        enable row level security;

create policy pipelines_owner       on public.pipelines
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy context_objects_owner on public.context_objects
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy frames_owner          on public.frames
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy raw_traces_owner      on public.raw_traces
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy scores_owner          on public.scores
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy api_keys_owner        on public.api_keys
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
