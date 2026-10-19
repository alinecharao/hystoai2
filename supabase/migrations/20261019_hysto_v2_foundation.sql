-- Hysto V2: execute only in a NEW Supabase test project.
-- All records are scoped to the authenticated owner.
create extension if not exists pgcrypto;

create table if not exists public.v2_characters (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 120),
  description text not null default '',
  background text not null default '',
  opening_scene text not null default '',
  avatar_url text,
  created_at timestamptz not null default now(),
  unique (id, user_id)
);
create index if not exists v2_characters_owner_idx on public.v2_characters(user_id);

create table if not exists public.v2_personas (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 120),
  gender text not null default '',
  age integer check (age between 1 and 120),
  role_description text not null default '',
  likes text not null default '',
  dislikes text not null default '',
  boundaries text not null default '',
  photo_url text,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  unique (id, user_id)
);
create unique index if not exists v2_personas_one_default_idx
  on public.v2_personas(user_id) where is_default;

create table if not exists public.v2_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  character_id uuid not null,
  persona_id uuid,
  title text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  foreign key (character_id, user_id) references public.v2_characters(id, user_id),
  foreign key (persona_id, user_id) references public.v2_personas(id, user_id) on delete set null (persona_id)
);
create index if not exists v2_conversations_owner_idx on public.v2_conversations(user_id, updated_at desc);

create table if not exists public.v2_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  conversation_id uuid not null,
  role text not null check (role in ('user','assistant')),
  content text not null,
  created_at timestamptz not null default now(),
  unique (id, user_id),
  foreign key (conversation_id, user_id) references public.v2_conversations(id, user_id) on delete cascade
);
create index if not exists v2_messages_order_idx on public.v2_messages(conversation_id, created_at, id);

-- Regeneration creates an immutable alternative. It never deletes or
-- overwrites the original message. The active version is selected separately.
create table if not exists public.v2_message_versions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  message_id uuid not null,
  content text not null,
  created_at timestamptz not null default now(),
  foreign key (message_id, user_id) references public.v2_messages(id, user_id) on delete cascade,
  unique (id, message_id, user_id)
);
create index if not exists v2_message_versions_order_idx on public.v2_message_versions(message_id, created_at, id);

create table if not exists public.v2_message_selections (
  user_id uuid not null,
  message_id uuid primary key,
  version_id uuid not null,
  foreign key (message_id, user_id) references public.v2_messages(id, user_id) on delete cascade,
  foreign key (version_id, message_id, user_id) references public.v2_message_versions(id, message_id, user_id)
);

create table if not exists public.v2_story_memories (
  conversation_id uuid primary key,
  user_id uuid not null,
  summary text not null default '',
  known_facts jsonb not null default '[]'::jsonb,
  scene text not null default '',
  updated_at timestamptz not null default now(),
  foreign key (conversation_id, user_id) references public.v2_conversations(id, user_id) on delete cascade,
  check (jsonb_typeof(known_facts) = 'array')
);

-- Policies use user_id AND ownership-constrained foreign keys.
do $$
declare table_name text;
begin
  foreach table_name in array array[
    'v2_characters','v2_personas','v2_conversations','v2_messages',
    'v2_message_versions','v2_message_selections','v2_story_memories'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format(
      'create policy %I on public.%I for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))',
      table_name || '_owner', table_name
    );
  end loop;
end $$;
