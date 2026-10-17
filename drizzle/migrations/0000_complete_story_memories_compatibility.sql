CREATE TABLE public.characters (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID,
  name TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT '🙂',
  tagline TEXT NOT NULL DEFAULT '',
  personality TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  greeting TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.characters TO authenticated;
GRANT ALL ON public.characters TO service_role;
ALTER TABLE public.characters ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read presets and own" ON public.characters FOR SELECT TO authenticated USING (user_id IS NULL OR user_id = auth.uid());
CREATE POLICY "insert own" ON public.characters FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "update own" ON public.characters FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "delete own" ON public.characters FOR DELETE TO authenticated USING (user_id = auth.uid());

CREATE TABLE public.messages (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL DEFAULT auth.uid(),
  character_id UUID NOT NULL REFERENCES public.characters(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX messages_user_char_idx ON public.messages(user_id, character_id, created_at);
GRANT SELECT, INSERT, DELETE ON public.messages TO authenticated;
GRANT ALL ON public.messages TO service_role;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read own msgs" ON public.messages FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "insert own msgs" ON public.messages FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "delete own msgs" ON public.messages FOR DELETE TO authenticated USING (user_id = auth.uid());

INSERT INTO public.characters (name, avatar, tagline, personality, instructions, greeting) VALUES
('Luna', '🌙', 'Poeta noturna e sonhadora', 'Gentil, poética, melancólica e curiosa sobre sentimentos.', 'Responda em português com linguagem lírica, use metáforas sobre a noite e as estrelas. Seja acolhedora.', 'Olá, viajante da noite... o que traz seu coração até aqui?'),
('Capitão Rex', '🏴‍☠️', 'Pirata aventureiro e bem-humorado', 'Exagerado, corajoso, engraçado, adora contar histórias do mar.', 'Fale como um pirata carismático em português, com expressões marítimas. Conduza aventuras interativas.', 'Arrr! Bem-vindo a bordo do Tempestade, marujo! Pronto pra zarpar?'),
('Dra. Helena', '🧠', 'Psicóloga calma e empática', 'Paciente, empática, reflexiva, faz boas perguntas.', 'Ouça com atenção, valide sentimentos e faça perguntas abertas. Não dê diagnósticos médicos.', 'Oi, que bom ter você aqui. Como você está se sentindo hoje?'),
('Sherlock', '🔍', 'Detetive brilhante e dedutivo', 'Lógico, arrogante de forma charmosa, observador.', 'Faça deduções a partir de pequenos detalhes do que o usuário diz. Proponha mistérios para resolver juntos.', 'Hmm. Pelo seu jeito de digitar, deduzo que você tem um mistério para mim.'),
('Kai', '🎮', 'Amigo gamer descontraído', 'Animado, informal, usa gírias, fã de jogos e animes.', 'Converse como um amigo próximo, de forma leve e informal em português brasileiro.', 'E aí! Bora trocar ideia? Tá jogando o quê ultimamente?'),
('Mestre Sábio', '🧙', 'Mago ancião e mestre de RPG', 'Sábio, misterioso, narrador envolvente.', 'Atue como mestre de RPG de fantasia: descreva cenas ricas e sempre termine oferecendo escolhas ao usuário.', 'Ah, um novo aventureiro chega à Torre de Eldmoor. Diga-me seu nome e sua classe.');;

ALTER TABLE public.characters
  ADD COLUMN IF NOT EXISTS gender text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS opening_scene text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS background text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS image_url text NOT NULL DEFAULT '';

UPDATE public.characters
SET description = CASE WHEN description = '' THEN tagline ELSE description END,
    opening_scene = CASE WHEN opening_scene = '' THEN greeting ELSE opening_scene END,
    background = CASE
      WHEN background = '' THEN trim(both E'\n' from concat_ws(E'\n\n',
        NULLIF(personality, ''),
        NULLIF(instructions, '')))
      ELSE background END;;

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
;

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
;

-- Expand personas while retaining legacy description data.
alter table public.personas add column if not exists photo_url text not null default '';
alter table public.personas add column if not exists gender text not null default '';
alter table public.personas add column if not exists age integer;
alter table public.personas add column if not exists role_description text not null default '';
alter table public.personas add column if not exists likes text not null default '';
alter table public.personas add column if not exists dislikes text not null default '';
alter table public.personas add column if not exists boundaries text not null default '';
alter table public.personas add column if not exists is_default boolean not null default false;
update public.personas set role_description = description where role_description = '' and description <> '';
alter table public.personas add constraint personas_age_valid check (age is null or (age between 1 and 120));
create unique index if not exists personas_one_default_per_user on public.personas (user_id) where is_default = true;
;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.personas TO authenticated;
GRANT ALL ON public.personas TO service_role;

insert into storage.buckets (id, name, public) values ('character-photos', 'character-photos', false)
on conflict (id) do nothing;
CREATE POLICY "character photos readable by signed in"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'character-photos');

CREATE POLICY "character photos insert own folder"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'character-photos' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "character photos update own folder"
ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'character-photos' AND (storage.foldername(name))[1] = auth.uid()::text)
WITH CHECK (bucket_id = 'character-photos' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "character photos delete own folder"
ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'character-photos' AND (storage.foldername(name))[1] = auth.uid()::text);;
-- Public persona portraits, writable only inside the authenticated user's folder.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('persona-photos', 'persona-photos', true, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = true, file_size_limit = 5242880, allowed_mime_types = excluded.allowed_mime_types;

create policy "Read persona portraits" on storage.objects
for select to public using (bucket_id = 'persona-photos');

create policy "Upload own persona portraits" on storage.objects
for insert to authenticated
with check (bucket_id = 'persona-photos' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Update own persona portraits" on storage.objects
for update to authenticated
using (bucket_id = 'persona-photos' and (storage.foldername(name))[1] = auth.uid()::text)
with check (bucket_id = 'persona-photos' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Delete own persona portraits" on storage.objects
for delete to authenticated
using (bucket_id = 'persona-photos' and (storage.foldername(name))[1] = auth.uid()::text);

ALTER TABLE public.story_memories
  ADD COLUMN IF NOT EXISTS scene TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS known_facts TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS last_processed_message_id UUID;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.story_memories TO authenticated;
GRANT ALL ON public.story_memories TO service_role;

ALTER TABLE public.story_memories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "delete own story memory"
ON public.story_memories
FOR DELETE TO authenticated
USING (user_id = auth.uid());;
