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
USING (user_id = auth.uid());