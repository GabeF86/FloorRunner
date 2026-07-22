-- supabase_scheduling_patch35_call_splits.sql
-- Call splitting (Gabriel 2026-07-22): "Add the ability to split calls into
-- 2 - 12 hour shifts or even 3 8 hr shifts."
--
-- Three binding decisions:
--   1. PER-DAY split action on the grid — site structure keeps 24h calls;
--      auto-generation keeps placing whole calls (segments are manual_only).
--   2. FRACTIONAL burden — a 12h segment = 0.5 call, an 8h segment = 0.3333;
--      a split call totals exactly ONE call across fairness / obligation /
--      OVER accounting (shift_types.call_burden_weight).
--   3. POST-CALL rest goes to the OVERNIGHT segment holder only (the
--      overnight segment inherits the parent's requires_post_call_rule;
--      day/evening segments are false).
--
-- Contents:
--   A. shift_types.call_burden_weight numeric NOT NULL DEFAULT 1 — fractional
--      call credit. Every existing row keeps weight 1 (unsplit schedules are
--      byte-identical).
--   B. shift_types.parent_call_code text NULL — segment → parent call code
--      (e.g. 'C1'). THIS COLUMN IS THE GROUPING/CAPS/BUCKET MAPPING — code
--      never keys on code-name patterns.
--   C. Segment shift-type rows for Paoli's C1 and C2 (C3 neuro overlay is
--      deliberately EXCLUDED from v1 — the evening overlay already covers its
--      structure). Per parent: a 2x12 pair (day 07:00-19:00 w=0.5; night
--      19:00-07:00 crosses_midnight w=0.5) and a 3x8 trio (07-15, 15-23,
--      23-07 w=0.3333 each). All segments: category 'call', manual_only true,
--      can_auto_assign false, generation_engine 'call', call_rank copied from
--      the parent (callFillOrder='call_rank' warning hygiene), NO
--      shift_templates rows — slot creation keys on templates (the D8/D9
--      lesson), so segment slots exist ONLY via the split action.
--   D. Live Weekend v2 pattern-doc update (site 2ddd2427, Paoli): dayChains
--      for the C2 OVERNIGHT segment codes (C2N12 / C2N8) mirroring C2's
--      +1 D1 on the same dayTypes — manually assigning the overnight C2
--      segment auto-fills next-day D1 via the existing sequenceAutoFill
--      machinery. C1 overnight segments need NO chain data: their post-call
--      rest rides requires_post_call_rule via the rest guards, and C1's +1
--      OFF block is engine-side for auto-gen, which never places segments.
--      Mirrors src/lib/rulesEngine/patterns/weekendV2.ts — keep in sync.
--
-- Apply via the project-scoped supabase-floorrunner MCP (ref
-- qhwdbtixhzdsgwwtcfrm) — verify the ref before applying; the global
-- supabase / supabase-chiefos servers belong to OTHER apps.
--
-- APPLY-TIME VERIFICATION (run BEFORE applying):
--   SELECT code, requires_post_call_rule, call_rank, call_coverage_type, color_hex
--     FROM scheduling.shift_types
--    WHERE site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e'
--      AND code IN ('C1','C2') AND is_active;
--   -- expect: C1 (requires_post_call_rule true, call_rank 0),
--   --         C2 (requires_post_call_rule false, call_rank 1, partial_beeper)
--   SELECT definition->'dayChains' FROM scheduling.call_patterns
--    WHERE site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e' AND status = 'active';
--   -- expect: the Weekend v2 doc with C2 sunday +1 D1 and NO C2N12/C2N8 triggers yet

BEGIN;

-- Idempotence guard: abort when any segment code already exists at Paoli.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM scheduling.shift_types
             WHERE site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e'
               AND code IN ('C1D12','C1N12','C1D8','C1E8','C1N8',
                            'C2D12','C2N12','C2D8','C2E8','C2N8')) THEN
    RAISE EXCEPTION 'patch35 already applied (segment shift types exist)';
  END IF;
END $$;

-- ── A + B. Weight + parent-code columns ─────────────────────────────────────

ALTER TABLE scheduling.shift_types
  ADD COLUMN IF NOT EXISTS call_burden_weight numeric NOT NULL DEFAULT 1;

ALTER TABLE scheduling.shift_types
  ADD COLUMN IF NOT EXISTS parent_call_code text NULL;

COMMENT ON COLUMN scheduling.shift_types.call_burden_weight IS
  'Fractional call credit toward fairness/obligation/caps (12h segment = 0.5, 8h = 0.3333, whole call = 1).';
COMMENT ON COLUMN scheduling.shift_types.parent_call_code IS
  'Segment → parent call code (e.g. C1). The grouping/caps/bucket mapping key — never key logic on code-name patterns.';

-- ── C. Paoli segment shift-type rows ────────────────────────────────────────
-- One INSERT..SELECT per segment, copying the inherited fields from the live
-- parent row (requires_post_call_rule for OVERNIGHT segments only; call_rank,
-- call_coverage_type, counts_toward_call_burden, provider_group always).
-- Colors are dimmer variants of the parent #0ea5e9: day #0b84ba, evening
-- #0a74a3, night #085b80.

INSERT INTO scheduling.shift_types
  (site_id, name, code, category, provider_group, start_time, end_time,
   crosses_midnight, duration_hours, color_hex, display_order,
   counts_toward_hours, counts_toward_call_burden, counts_as_weekend_burden,
   counts_as_holiday_burden, requires_post_call_rule, can_auto_assign,
   manual_only, is_active, call_rank, relief_rank, is_overlay,
   generation_engine, call_coverage_type, call_burden_weight, parent_call_code)
SELECT p.site_id, n.name, seg.code, 'call', p.provider_group,
       seg.start_time::time, seg.end_time::time, seg.crosses_midnight,
       seg.duration_hours, seg.color_hex, seg.display_order,
       p.counts_toward_hours, p.counts_toward_call_burden,
       p.counts_as_weekend_burden, p.counts_as_holiday_burden,
       CASE WHEN seg.overnight THEN p.requires_post_call_rule ELSE false END,
       false,  -- can_auto_assign: the engine never places segments
       true,   -- manual_only: split cells are filled by the scheduler
       true, p.call_rank, NULL, false, 'call', p.call_coverage_type,
       seg.weight, p.code
FROM scheduling.shift_types p
JOIN (VALUES
  -- parent, code,   name suffix,       start,      end,        x-mid, hrs,  weight, overnight, color,     ord
  ('C1', 'C1D12', 'Day (07-19)',       '07:00:00', '19:00:00', false, 12.0, 0.5,    false, '#0b84ba', 20),
  ('C1', 'C1N12', 'Night (19-07)',     '19:00:00', '07:00:00', true,  12.0, 0.5,    true,  '#085b80', 21),
  ('C1', 'C1D8',  'Day (07-15)',       '07:00:00', '15:00:00', false,  8.0, 0.3333, false, '#0b84ba', 22),
  ('C1', 'C1E8',  'Evening (15-23)',   '15:00:00', '23:00:00', false,  8.0, 0.3333, false, '#0a74a3', 23),
  ('C1', 'C1N8',  'Night (23-07)',     '23:00:00', '07:00:00', true,   8.0, 0.3333, true,  '#085b80', 24),
  ('C2', 'C2D12', 'Day (07-19)',       '07:00:00', '19:00:00', false, 12.0, 0.5,    false, '#0b84ba', 25),
  ('C2', 'C2N12', 'Night (19-07)',     '19:00:00', '07:00:00', true,  12.0, 0.5,    true,  '#085b80', 26),
  ('C2', 'C2D8',  'Day (07-15)',       '07:00:00', '15:00:00', false,  8.0, 0.3333, false, '#0b84ba', 27),
  ('C2', 'C2E8',  'Evening (15-23)',   '15:00:00', '23:00:00', false,  8.0, 0.3333, false, '#0a74a3', 28),
  ('C2', 'C2N8',  'Night (23-07)',     '23:00:00', '07:00:00', true,   8.0, 0.3333, true,  '#085b80', 29)
) AS seg(parent, code, suffix, start_time, end_time, crosses_midnight,
         duration_hours, weight, overnight, color_hex, display_order)
  ON seg.parent = p.code
CROSS JOIN LATERAL (SELECT p.name || ' ' || seg.suffix AS name) n(name)
WHERE p.site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e'
  AND p.is_active
  AND p.category = 'call';

-- Sanity: exactly 10 segment rows must have landed (both parents present).
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM scheduling.shift_types
   WHERE site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e'
     AND parent_call_code IS NOT NULL;
  IF n <> 10 THEN
    RAISE EXCEPTION 'patch35: expected 10 segment rows, found % — aborting', n;
  END IF;
END $$;

-- ── D. Weekend v2 dayChains for the C2 overnight segments ───────────────────
-- Structural (jsonb) WHERE guard — never text LIKE: the active doc must still
-- carry C2's sunday +1 D1 chain (the shape being mirrored) and must not
-- already carry the segment triggers. Appends four chains: C2N12 / C2N8 on
-- C2's two day-type scopes, +1 D1 only (no D3 pre-fill — the pre-call fill
-- belongs to the following day's whole-call machinery, not the segment).

UPDATE scheduling.call_patterns
   SET definition = jsonb_set(
         definition, '{dayChains}',
         (definition->'dayChains') || '[
           {"trigger":"C2N12","dayTypes":["weekday","friday","federal_holiday","major_holiday"],"links":[{"offset":1,"code":"D1"}]},
           {"trigger":"C2N12","dayTypes":["sunday"],"links":[{"offset":1,"code":"D1"}]},
           {"trigger":"C2N8","dayTypes":["weekday","friday","federal_holiday","major_holiday"],"links":[{"offset":1,"code":"D1"}]},
           {"trigger":"C2N8","dayTypes":["sunday"],"links":[{"offset":1,"code":"D1"}]}
         ]'::jsonb),
       updated_at = now()
 WHERE site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e'
   AND status = 'active'
   AND definition->'dayChains' @> '[{"trigger":"C2","dayTypes":["sunday"],"links":[{"offset":1,"code":"D1"}]}]'::jsonb
   AND NOT definition->'dayChains' @> '[{"trigger":"C2N12"}]'::jsonb;

-- The doc update must have matched exactly the one active row.
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM scheduling.call_patterns
   WHERE site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e'
     AND status = 'active'
     AND definition->'dayChains' @> '[{"trigger":"C2N12"}]'::jsonb;
  IF n <> 1 THEN
    RAISE EXCEPTION 'patch35: active pattern doc did not take the C2 segment dayChains (structural guard mismatch) — aborting';
  END IF;
END $$;

COMMIT;

-- Verification (run after):
--   SELECT code, parent_call_code, call_burden_weight, start_time, end_time,
--          crosses_midnight, requires_post_call_rule, manual_only, can_auto_assign, call_rank
--     FROM scheduling.shift_types
--    WHERE site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e' AND parent_call_code IS NOT NULL
--    ORDER BY display_order;
--   -- expect 10 rows: C1D12/C1N12/C1D8/C1E8/C1N8 then C2*, weights 0.5/0.3333,
--   --   requires_post_call_rule TRUE only on C1N12/C1N8 (C1 requires it; C2 does not),
--   --   manual_only true + can_auto_assign false everywhere, call_rank 0 (C1*) / 1 (C2*)
--   SELECT count(*) FROM scheduling.shift_templates t
--     JOIN scheduling.shift_types st ON st.id = t.shift_type_id
--    WHERE st.parent_call_code IS NOT NULL;
--   -- expect 0 — segments NEVER materialize from templates
--   SELECT jsonb_array_length(definition->'dayChains') FROM scheduling.call_patterns
--    WHERE site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e' AND status = 'active';
--   -- expect 9 (5 original + 4 segment chains)
--   SELECT count(*) FROM scheduling.shift_types WHERE call_burden_weight <> 1 AND parent_call_code IS NULL;
--   -- expect 0 — every whole shift type keeps weight 1
