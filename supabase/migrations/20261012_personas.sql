-- Personal personas, independent of AI characters and chat history.
create table if not exists public.personas (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  description text not null default '' check (char_length(description) <= 6000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists personas_user_id_idx on public.personas(user_id);
alter table public.personas enable row level security;
create policy "Users manage their own personas" on public.personas
for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
