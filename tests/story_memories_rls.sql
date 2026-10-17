-- Run against the database with a privileged connection. All fixtures are rolled back.
BEGIN;
SELECT set_config('request.jwt.claim.sub', 'd040ffb6-70d1-47b8-bffd-7cdc47d872bf', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  test_character uuid;
  denied boolean := false;
BEGIN
  SELECT id INTO test_character FROM public.characters WHERE user_id IS NULL LIMIT 1;
  IF test_character IS NULL THEN RAISE EXCEPTION 'A preset character is required for this test'; END IF;
  IF EXISTS (SELECT 1 FROM public.story_memories WHERE user_id <> auth.uid()) THEN
    RAISE EXCEPTION 'RLS exposed another user memory';
  END IF;
  BEGIN
    INSERT INTO public.story_memories (user_id, character_id)
    VALUES ('c61b9f4c-8525-460a-8eb3-e3e326f65a16', test_character);
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'RLS permitted an insert for another user'; END IF;
  INSERT INTO public.story_memories (user_id, character_id) VALUES (auth.uid(), test_character);
  IF NOT EXISTS (SELECT 1 FROM public.story_memories WHERE user_id = auth.uid() AND character_id = test_character AND summary = '' AND scene = '' AND known_facts = '' AND last_processed_message_id IS NULL AND updated_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Own insert/read or required defaults failed';
  END IF;
  UPDATE public.story_memories SET scene = 'rls-test' WHERE user_id = auth.uid() AND character_id = test_character;
  IF NOT FOUND THEN RAISE EXCEPTION 'Own update was denied'; END IF;
  denied := false;
  BEGIN
    UPDATE public.story_memories SET user_id = 'c61b9f4c-8525-460a-8eb3-e3e326f65a16' WHERE user_id = auth.uid() AND character_id = test_character;
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'RLS permitted changing ownership'; END IF;
END $$;
SELECT set_config('request.jwt.claim.sub', 'c61b9f4c-8525-460a-8eb3-e3e326f65a16', true);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.story_memories WHERE user_id = 'd040ffb6-70d1-47b8-bffd-7cdc47d872bf') THEN RAISE EXCEPTION 'Cross-user read permitted'; END IF;
  UPDATE public.story_memories SET scene = 'forbidden' WHERE user_id = 'd040ffb6-70d1-47b8-bffd-7cdc47d872bf';
  IF FOUND THEN RAISE EXCEPTION 'Cross-user update permitted'; END IF;
  DELETE FROM public.story_memories WHERE user_id = 'd040ffb6-70d1-47b8-bffd-7cdc47d872bf';
  IF FOUND THEN RAISE EXCEPTION 'Cross-user delete permitted'; END IF;
END $$;
SELECT set_config('request.jwt.claim.sub', 'd040ffb6-70d1-47b8-bffd-7cdc47d872bf', true);
DO $$
BEGIN
  DELETE FROM public.story_memories WHERE user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Own fixture delete denied'; END IF;
END $$;
ROLLBACK;