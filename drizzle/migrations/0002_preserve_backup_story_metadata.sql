ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS client_message_id text;
ALTER TABLE public.story_memories ADD COLUMN IF NOT EXISTS source_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];
ALTER TABLE public.story_memories ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 0;