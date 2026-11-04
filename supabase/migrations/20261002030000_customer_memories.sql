-- ============================================================================
-- Customer Memories — Persistent conversation memory per customer
-- ============================================================================
-- Each row is a "memory" about a customer: their style preferences, past
-- searches, purchase patterns, interaction notes, etc.  The WhatsApp bot
-- reads these at the start of every conversation to personalise responses.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. customer_memories table
-- ----------------------------------------------------------------------------
create table if not exists customer_memories (
  id            uuid        primary key default gen_random_uuid(),
  customer_id   uuid        not null references customers(id) on delete cascade,

  -- Memory classification
  memory_type   text        not null default 'interaction'
                            check (memory_type in (
                              'preference',        -- e.g. "Loves Banarasi silk, prefers gold zari"
                              'search_history',    -- e.g. "Searched for red Kanjivaram under ₹10k"
                              'style_note',        -- e.g. "Prefers pastel tones for office wear"
                              'interaction',       -- e.g. "Asked about return policy"
                              'purchase',          -- e.g. "Bought SAI-BAN-02 Royal Sapphire Banarasi"
                              'feedback',          -- e.g. "Said the blue saree colour was darker than expected"
                              'address',           -- e.g. "Lives in Banjara Hills, Hyderabad"
                              'general'            -- catch-all
                            )),

  -- Human-readable one-liner (shown to Gemini as context)
  summary       text        not null,

  -- Structured details (flexible JSON for each type)
  details       jsonb       not null default '{}'::jsonb,

  -- Optional embedding for semantic memory retrieval
  embedding     vector(768),

  -- Source: which conversation / message produced this memory
  source_conversation_id  uuid  references conversations(id) on delete set null,
  source_message_id       uuid  references messages(id) on delete set null,

  -- Importance score (higher = more relevant, used for pruning)
  importance    float       not null default 0.5,

  -- Timestamps
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  expires_at    timestamptz           -- NULL = never expires
);

-- Indexes
create index if not exists idx_memories_customer
  on customer_memories(customer_id);

create index if not exists idx_memories_customer_type
  on customer_memories(customer_id, memory_type);

create index if not exists idx_memories_importance
  on customer_memories(customer_id, importance desc);

create index if not exists idx_memories_updated
  on customer_memories(customer_id, updated_at desc);

-- Optional: HNSW vector index for semantic memory search
create index if not exists idx_memories_embedding
  on customer_memories using hnsw (embedding vector_cosine_ops);


-- ----------------------------------------------------------------------------
-- 2. RPC: get_customer_memories
--    Returns the N most recent + most important memories for a customer,
--    formatted as a text block that can be injected into a Gemini prompt.
-- ----------------------------------------------------------------------------
create or replace function get_customer_memories(
  p_customer_id  uuid,
  p_limit        int   default 20,
  p_types        text[] default null   -- NULL = all types
)
returns table (
  id          uuid,
  memory_type text,
  summary     text,
  details     jsonb,
  importance  float,
  created_at  timestamptz,
  updated_at  timestamptz
)
language plpgsql
security definer
as $$
begin
  return query
  select
    m.id,
    m.memory_type,
    m.summary,
    m.details,
    m.importance,
    m.created_at,
    m.updated_at
  from customer_memories m
  where m.customer_id = p_customer_id
    and (m.expires_at is null or m.expires_at > now())
    and (p_types is null or m.memory_type = any(p_types))
  order by m.importance desc, m.updated_at desc
  limit p_limit;
end;
$$;


-- ----------------------------------------------------------------------------
-- 3. RPC: upsert_customer_memory
--    Insert a new memory or update an existing one if a matching
--    (customer_id, memory_type, summary) already exists.
-- ----------------------------------------------------------------------------
create or replace function upsert_customer_memory(
  p_customer_id            uuid,
  p_memory_type            text,
  p_summary                text,
  p_details                jsonb       default '{}'::jsonb,
  p_importance             float       default 0.5,
  p_source_conversation_id uuid        default null,
  p_source_message_id      uuid        default null,
  p_expires_at             timestamptz default null
)
returns uuid
language plpgsql
security definer
as $$
declare
  v_id uuid;
begin
  -- Try to find an existing memory with the same type and summary
  select m.id into v_id
  from customer_memories m
  where m.customer_id = p_customer_id
    and m.memory_type = p_memory_type
    and m.summary = p_summary
  limit 1;

  if v_id is not null then
    -- Update existing
    update customer_memories
    set details                = p_details,
        importance             = greatest(importance, p_importance),
        source_conversation_id = coalesce(p_source_conversation_id, source_conversation_id),
        source_message_id      = coalesce(p_source_message_id, source_message_id),
        expires_at             = p_expires_at,
        updated_at             = now()
    where id = v_id;

    return v_id;
  else
    -- Insert new
    insert into customer_memories (
      customer_id, memory_type, summary, details, importance,
      source_conversation_id, source_message_id, expires_at
    ) values (
      p_customer_id, p_memory_type, p_summary, p_details, p_importance,
      p_source_conversation_id, p_source_message_id, p_expires_at
    )
    returning id into v_id;

    return v_id;
  end if;
end;
$$;


-- ----------------------------------------------------------------------------
-- 4. RPC: cleanup_expired_memories
--    Housekeeping — delete expired memories and cap per-customer count.
-- ----------------------------------------------------------------------------
create or replace function cleanup_expired_memories(
  p_max_per_customer int default 100
)
returns int
language plpgsql
security definer
as $$
declare
  v_deleted int := 0;
  v_cust record;
begin
  -- 1. Delete expired memories
  delete from customer_memories
  where expires_at is not null and expires_at < now();
  get diagnostics v_deleted = row_count;

  -- 2. Cap per-customer: keep top N by importance, delete the rest
  for v_cust in (
    select customer_id, count(*) as cnt
    from customer_memories
    group by customer_id
    having count(*) > p_max_per_customer
  ) loop
    delete from customer_memories
    where id in (
      select m.id
      from customer_memories m
      where m.customer_id = v_cust.customer_id
      order by m.importance desc, m.updated_at desc
      offset p_max_per_customer
    );
    get diagnostics v_deleted = row_count;
  end loop;

  return v_deleted;
end;
$$;
