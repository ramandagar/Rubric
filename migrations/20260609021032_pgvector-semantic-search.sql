-- Rubric — pgvector semantic search support (ARCHITECTURE.md §6)
-- Enables the ask(co, question) query API via hybrid filter + vector search.
-- Embeddings columns on frames and a materialized items table for performant searching.

-- Enable pgvector extension
create extension if not exists vector;

-- ---------------------------------------------------------------------------
-- frame_embedding: one embedding per frame summarizing its epistemic content
-- for whole-frame similarity queries (compaction digest, relevance ranking).
-- ---------------------------------------------------------------------------
alter table public.frames
  add column embedding vector(1536) null;

-- ---------------------------------------------------------------------------
-- epistemic_items: materialized view for individual-item semantic search.
-- Each row is one assumption, uncertainty, decision, or exclusion extracted
-- from a frame's JSONB fields — flattened so we can do nearest-neighbor lookups
-- with metadata filters in a single scan.
-- ---------------------------------------------------------------------------
create table public.epistemic_items (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  frame_id    uuid not null references public.frames(id) on delete cascade,
  co_id       uuid not null references public.context_objects(id) on delete cascade,
  seq         integer not null,
  item_type   text not null check (item_type in ('assumption','uncertainty','decision','excluded','evidence','attempt')),
  text        text not null,
  metadata    jsonb not null default '{}'::jsonb,
  embedding   vector(1536) not null,
  created_at  timestamptz not null default now()
);

create index epistemic_items_co_idx   on public.epistemic_items (co_id);
create index epistemic_items_type_idx on public.epistemic_items (co_id, item_type);
create index epistemic_items_seq_idx  on public.epistemic_items (co_id, seq);

-- IVFFlat index for approximate nearest neighbor — optional but recommended for scale.
-- Not created automatically because IVFFlat requires a minimum number of rows;
-- migration uses exact search via ORDER BY distance which works at any size.
-- Uncomment after ~1k items per co:
-- create index epistemic_items_embedding_idx on public.epistemic_items
--   using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- ---------------------------------------------------------------------------
-- RLS for the new table.
-- ---------------------------------------------------------------------------
alter table public.epistemic_items enable row level security;

create policy epistemic_items_owner on public.epistemic_items
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Helper: flatten a frame's epistemic arrays into text items.
-- Used by the extract function to populate epistemic_items after frame creation.
-- ---------------------------------------------------------------------------
create or replace function public.flatten_epistemic_items(
  p_owner_id  uuid,
  p_frame_id  uuid,
  p_co_id     uuid,
  p_seq       integer,
  p_assumptions jsonb,
  p_uncertainties jsonb,
  p_decisions jsonb,
  p_excluded jsonb,
  p_evidence jsonb,
  p_attempts jsonb
) returns void language plpgsql as $$
declare
  item jsonb;
begin
  for item in select * from jsonb_array_elements(p_assumptions)
  loop
    insert into public.epistemic_items (owner_id, frame_id, co_id, seq, item_type, text, metadata)
    values (p_owner_id, p_frame_id, p_co_id, p_seq, 'assumption', item->>'statement', item);
  end loop;
  for item in select * from jsonb_array_elements(p_uncertainties)
  loop
    insert into public.epistemic_items (owner_id, frame_id, co_id, seq, item_type, text, metadata)
    values (p_owner_id, p_frame_id, p_co_id, p_seq, 'uncertainty', item->>'question', item);
  end loop;
  for item in select * from jsonb_array_elements(p_decisions)
  loop
    insert into public.epistemic_items (owner_id, frame_id, co_id, seq, item_type, text, metadata)
    values (p_owner_id, p_frame_id, p_co_id, p_seq, 'decision', item->>'decision', item);
  end loop;
  for item in select * from jsonb_array_elements(p_excluded)
  loop
    insert into public.epistemic_items (owner_id, frame_id, co_id, seq, item_type, text, metadata)
    values (p_owner_id, p_frame_id, p_co_id, p_seq, 'excluded', item->>'what', item);
  end loop;
  for item in select * from jsonb_array_elements(p_evidence)
  loop
    insert into public.epistemic_items (owner_id, frame_id, co_id, seq, item_type, text, metadata)
    values (p_owner_id, p_frame_id, p_co_id, p_seq, 'evidence', item->>'claim', item);
  end loop;
  for item in select * from jsonb_array_elements(p_attempts)
  loop
    insert into public.epistemic_items (owner_id, frame_id, co_id, seq, item_type, text, metadata)
    values (p_owner_id, p_frame_id, p_co_id, p_seq, 'attempt', item->>'approach', item);
  end loop;
end;
$$;
