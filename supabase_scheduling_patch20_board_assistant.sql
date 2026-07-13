-- supabase_scheduling_patch20_board_assistant.sql (public schema — the BOARD tables)
-- Board voice assistant (spec docs/superpowers/specs/2026-07-12-board-voice-assistant-design.md).
-- Idempotence guard: aborts if already applied.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='board_assistant_actions') THEN
    RAISE EXCEPTION 'patch20 already applied';
  END IF;
END $$;

CREATE TABLE public.board_assistant_actions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  board_date  date NOT NULL,
  hospital    text,
  summary     text,
  snapshot    jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  reverted_at timestamptz
);
CREATE INDEX board_assistant_actions_date_idx ON public.board_assistant_actions (board_date, created_at DESC);

-- Pre-existing drift fix: the live check constraint (daily_designations_designation_check)
-- lags the TS MDDesignation type — missing D9, C3, 3pm/5pm/7pm. The UI already writes these values.
-- Verified against live DB 2026-07-12: current def is
--   CHECK (designation = ANY (ARRAY['D1','D2','D3','D4','D5','D6','D7','D8','C1','C2','8hr','10hr']))
ALTER TABLE public.daily_designations DROP CONSTRAINT IF EXISTS daily_designations_designation_check;
ALTER TABLE public.daily_designations ADD CONSTRAINT daily_designations_designation_check
  CHECK (designation IN ('D1','D2','D3','D4','D5','D6','D7','D8','D9','C1','C2','C3','3pm','5pm','7pm','8hr','10hr'));
COMMIT;

-- Verification (run after):
--   SELECT count(*) FROM public.board_assistant_actions;
--   -- expect: 0
--   INSERT a 'D9' designation row in a transaction, then ROLLBACK;
--   -- expect: no constraint error

