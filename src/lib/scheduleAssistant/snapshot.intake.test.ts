// Snapshot / undo round-trips for the intake writers (assistant-intake).
// Exercised against the STATEFUL in-memory fake so "mutate via the real
// executors → revert → deep-equals the seed" is a genuine check (the
// call-recording fake never applies writes). versionId is null throughout —
// these tools touch availability / profiles / credentials, not assignments, so
// the assignment-restore + batch-validation legs are out of scope here and
// skipping them keeps the seed minimal.
import { describe, it, expect } from 'vitest';
import { takeSnapshot, revertAction } from './snapshot';
import { createToolExecutors, type ScheduleCtx } from './tools';
import { makeStatefulSupabase } from './__fixtures__/statefulScheduling';

const ctx: ScheduleCtx = {
  scheduleId: 'sched-1', siteId: 'site-1', versionId: 'ver-1',
  scheduleName: 'S', dateStart: '2026-01-01', dateEnd: '2026-01-31',
};

function seed() {
  return {
    schedules: [{ id: 'sched-1', site_id: 'site-1', date_start: '2026-01-01', date_end: '2026-01-31' }],
    sites: [{ id: 'site-1', organization_id: 'org-1' }],
    providers: [
      { id: 'p1', organization_id: 'org-1', last_name: 'One', short_display_name: 'A. One' },
      { id: 'p2', organization_id: 'org-1', last_name: 'Two', short_display_name: 'B. Two' },
    ],
    provider_employment_profiles: [
      { id: 'prof-1', provider_id: 'p1', home_site_id: 'site-1', fte_value: 1, call_taker: true, partial_call_taker: false, is_day_doc: false },
      // Org provider whose HOME is another site — engines still read this
      // profile, so the snapshot must capture it (org-wide scope) for undo.
      { id: 'prof-2', provider_id: 'p2', home_site_id: 'site-2', fte_value: 0.9, call_taker: true, partial_call_taker: false, is_day_doc: true },
    ],
    provider_site_credentials: [
      { id: 'cred-1', provider_id: 'p1', site_id: 'site-1', can_take_call: true, can_take_weekend_call: true, can_take_holiday_call: true, can_take_backup_call: true },
    ],
    provider_availability: [
      { id: 'av-old', provider_id: 'p1', site_id: 'site-1', availability_type: 'pto', start_date: '2026-01-10', end_date: '2026-01-12', all_day: true, approval_status: 'approved', source: 'manual', notes: null },
    ],
    call_patterns: [] as Array<Record<string, unknown>>,
    shift_types: [] as Array<Record<string, unknown>>,
    rule_sets: [] as Array<Record<string, unknown>>,
    assistant_actions: [] as Array<Record<string, unknown>>,
  };
}

const avIds = (dump: (t: string) => Array<Record<string, unknown>>) =>
  dump('provider_availability').map(r => r.id);
const fteOf = (dump: (t: string) => Array<Record<string, unknown>>) =>
  dump('provider_employment_profiles').find(r => r.id === 'prof-1')!.fte_value;

describe('intake snapshot round-trip', () => {
  it('take → record_availability + profile change → revert: new row DELETED, profile RESTORED', async () => {
    const { sb, dump } = makeStatefulSupabase(seed());
    const execs = createToolExecutors();

    const actionId = await takeSnapshot(sb as never, 'sched-1', null, 'Assistant: intake', 'record PTO + FTE');

    await execs.record_availability(sb as never, ctx, {
      provider_id: 'p1', availability_type: 'unavailable', start_date: '2026-01-20', end_date: '2026-01-20',
    });
    await execs.update_provider_profile(sb as never, ctx, { provider_id: 'p1', fte_value: 0.8 });

    // Sanity: the state genuinely changed.
    expect(dump('provider_availability')).toHaveLength(2);
    expect(fteOf(dump)).toBe(0.8);

    const revert = await revertAction(sb as never, actionId);
    expect(revert.errors).toEqual([]);
    expect(revert.ok).toBe(true);

    // The recorded row is gone (delete-new pass); the pre-existing one survives.
    expect(avIds(dump)).toEqual(['av-old']);
    // The profile is back to its captured value (upsert-by-id restore).
    expect(fteOf(dump)).toBe(1);
    // reverted_at stamped.
    expect(dump('assistant_actions').find(r => r.id === actionId)!.reverted_at).toBeTruthy();
  });

  it('take → cancel_availability → revert: canceled entry restored to approved (upsert path)', async () => {
    const { sb, dump } = makeStatefulSupabase(seed());
    const execs = createToolExecutors();

    const actionId = await takeSnapshot(sb as never, 'sched-1', null, 'Assistant: cancel PTO', 'oops');
    await execs.cancel_availability(sb as never, ctx, { id: 'av-old' });
    expect(dump('provider_availability').find(r => r.id === 'av-old')!.approval_status).toBe('canceled');

    const revert = await revertAction(sb as never, actionId);
    expect(revert.ok).toBe(true);
    expect(dump('provider_availability').find(r => r.id === 'av-old')!.approval_status).toBe('approved');
    expect(avIds(dump)).toEqual(['av-old']); // nothing deleted (row existed at snapshot)
  });

  it('an org provider whose home is ANOTHER site still round-trips (org-wide profile snapshot)', async () => {
    const { sb, dump } = makeStatefulSupabase(seed());
    const execs = createToolExecutors();

    const actionId = await takeSnapshot(sb as never, 'sched-1', null, 'Assistant: FTE change', 'p2 to 0.5');
    await execs.update_provider_profile(sb as never, ctx, { provider_id: 'p2', fte_value: 0.5 });
    expect(dump('provider_employment_profiles').find(r => r.id === 'prof-2')!.fte_value).toBe(0.5);

    const revert = await revertAction(sb as never, actionId);
    expect(revert.errors).toEqual([]);
    expect(revert.ok).toBe(true);
    // A home-site-only capture would have missed prof-2 and left 0.5 in place.
    expect(dump('provider_employment_profiles').find(r => r.id === 'prof-2')!.fte_value).toBe(0.9);
  });

  it('a pre-intake action (no new config_before keys) still reverts, leaving intake tables untouched', async () => {
    const base = seed();
    const withLegacy = {
      ...base,
      assistant_actions: [{
        id: 'legacy-1', schedule_id: 'sched-1', schedule_version_id: null,
        summary: 'legacy edit', request_text: null,
        config_before: { call_pattern: null, shift_types: [] }, // no availability/profiles/credentials keys
        assignments_before: [],
      }],
    };
    const { sb, dump } = makeStatefulSupabase(withLegacy);

    const revert = await revertAction(sb as never, 'legacy-1');
    expect(revert.ok).toBe(true);
    // The intake blocks were skipped entirely — no deletes, no profile changes.
    expect(avIds(dump)).toEqual(['av-old']);
    expect(fteOf(dump)).toBe(1);
    expect(dump('assistant_actions').find(r => r.id === 'legacy-1')!.reverted_at).toBeTruthy();
  });
});
