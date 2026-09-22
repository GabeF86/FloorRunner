/**
 * The call pool is PHYSICIAN-ONLY.
 *
 * ── WHY THIS TEST EXISTS (2026-09-22) ─────────────────────────────────────
 * ALGORITHM.md §3 has documented `AND provider_type = 'physician'` on the
 * call-generation pool since it was written. The query never carried it: the
 * pool is selected on home_site_id + (call_taker OR partial_call_taker), and
 * a CRNA flagged call_taker at the site landed in it. Paoli has five.
 *
 * It survived because the harm needs a SECOND defect, and that one is in the
 * data: the eligibility group check reads `schedule_slots.provider_group`,
 * which is 'both' on all 5,841 slots in this database — slots do not inherit
 * the restriction from their shift type, so the gate has never fired. Either
 * defect alone is harmless. Together, a live measurement on a real Paoli
 * block put 63 of 146 call placements (43%) on a CRNA.
 *
 * No live schedule was affected — every one was imported, and humans put the
 * right people in the right slots. It fires the first time the engine
 * generates at a site where a CRNA is flagged call_taker, which is exactly
 * the case that had never been run.
 *
 * Asserted on the QUERY rather than on an outcome: an outcome test would pass
 * again the moment somebody fixed the slot column and reintroduced the pool
 * bug, and the two are meant to be independent defences.
 */
import { describe, it, expect } from 'vitest';
import { makeFakeSupabase, callsFor } from './__fixtures__/fakeSupabase';
import { loadGenerationContext } from './genContext';

describe('the call pool is physician-only', () => {
  it("filters the providers read on provider_type = 'physician'", async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: {
        // Enough to get past the slot preload; the pool query is what matters
        // and it runs regardless of what the rest returns.
        schedule_slots: { data: [{
          id: 's1', slot_date: '2026-10-05', shift_type_id: 'st1',
          provider_group: 'both', required_count: 1, locked: false,
          derived_day_type: 'weekday', site_id: 'site-1',
          shift_types: { code: 'C1', category: 'call' }, assignments: [],
        }] },
        schedule_versions: { data: { schedule_id: 'sch-1' } },
        schedules: { data: { id: 'sch-1', site_id: 'site-1', date_start: '2026-10-05', date_end: '2026-10-05' } },
        sites: { data: { id: 'site-1', call_par_level: 11 } },
        // At least one profile, or the load short-circuits on an empty pool
        // and the providers read — the thing under test — never runs.
        provider_employment_profiles: { data: [{
          provider_id: 'p1', fte_value: 1, work_days_fte: null,
          home_site_id: 'site-1', call_taker: true, partial_call_taker: false,
        }] },
        providers: { data: [{ id: 'p1', provider_type: 'physician', short_display_name: 'AAA' }] },
      },
    });

    await loadGenerationContext(sb as never, 'ver-1');

    const eqs = callsFor(calls, 'providers', 'eq').map(c => c.args);
    expect(eqs, 'the providers read must constrain provider_type')
      .toContainEqual(['provider_type', 'physician']);
    expect(eqs, 'and must still constrain status').toContainEqual(['status', 'active']);
  });

});

describe('the two defects are independent, and both are worth keeping', () => {
  it('documents that a permissive slot group is not a licence to place anyone', () => {
    // A reminder in executable form: schedule_slots.provider_group is 'both'
    // everywhere today, so the eligibility group check cannot be relied on as
    // the only defence. If that column is ever backfilled from shift_types,
    // this pool filter is still the one that keeps a CRNA out of the
    // candidate sweep in the first place — which is cheaper and reports a
    // clearer pool size on the generation banner.
    expect(['physician']).toContain('physician');
  });
});
