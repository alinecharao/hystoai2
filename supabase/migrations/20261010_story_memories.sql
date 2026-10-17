-- Hysto: memória evolutiva isolada por usuário e personagem.
-- Executar no editor SQL do Supabase antes de ativar a gravação automática.
create table if not exists public.story_memories (
  user_id uuid not null references auth.users(id) on delete cascade,
  character_id uuid not null references public.characters(id) on delete cascade,
  summary text not null default '',
  scene text not null default '',
  known_facts text not null default '',
  last_processed_message_id uuid null,
  updated_at timestamptz not null default now(),
  primary key (user_id, character_id)
);

alter table public.story_memories enable row level security;

drop policy if exists "Users read own story memory" on public.story_memories;
create policy "Users read own story memory" on public.story_memories
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists "Users insert own story memory" on public.story_memories;
create policy "Users insert own story memory" on public.story_memories
  for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "Users update own story memory" on public.story_memories;
create policy "Users update own story memory" on public.story_memories
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "Users delete own story memory" on public.story_memories;
create policy "Users delete own story memory" on public.story_memories
  for delete to authenticated using (auth.uid() = user_id);
