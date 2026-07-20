// sequenceAutoFill — pattern-driven manual-edit companion (scheduling-v2 Task 10).
//
// 1. Manual C2 on Mon at site A triggers D1 fill on Tue (classic pattern link).
// 2. CROSS-SITE FIX: provider already 'assigned' on Tue at site B (different
//    schedule_version) → D1 NOT filled; skip recorded {reason: 'cross-site'}.
// 3. PTO on Tue (pending) → skip {reason: 'pto'}.
// 4. Result shape: { filledSlotIds, skips } — skips use the SkippedDerived vocabulary.
// 5. Precedence: D1 beats D3 via relief/call rank comparison of shift_types rows,
//    not the literal 'D3' (fixture renames D3→'PRE'; the D1 fill still
//    evicts/declines correctly; lower call_rank trigger wins).
// 6. Query budget: one assignments-window query + one availability query + one
//    slots query per invocation (≤5 total DB calls; assert via recording fake).

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  applySequenceAutoFill,
  cleanupSequenceAutoFill,
  loadActiveCallPattern,
} from './sequenceAutoFill';
import { CLASSIC_PATTERN, type CallPatternDoc } from './callPattern';
import { makeFakeSupabase, fromCount, callsFor, type TableCfg } from './__fixtures__/fakeSupabase';

// Dates: Sun 2026-03-01, Mon 03-02, Tue 03-03, Wed 03-04, Thu 03-05,
// Fri 03-06, Sat 03-07.
const SUN = '2026-03-01';
const MON = '2026-03-02';
const TUE = '2026-03-03';
const WED = '2026-03-04';
const THU = '2026-03-05';
const FRI = '2026-03-06';
const SAT = '2026-03-07';

const SKIP_REASONS = ['pto', 'cross-site', 'occupied', 'no-slot', 'ineligible', 'already-handled'];

// ── production-shaped row builders ──────────────────────────────────────────

interface StOpts {
  category?: string;
  call_rank?: number | null;
  relief_rank?: number | null;
  requires_post_call_rule?: boolean;
  is_overlay?: boolean;
}
const st = (code: string, o: StOpts = {}) => ({
  code,
  category: o.category ?? 'derived',
  call_rank: o.call_rank ?? null,
  relief_rank: o.relief_rank ?? null,
  requires_post_call_rule: o.requires_post_call_rule ?? false,
  is_overlay: o.is_overlay ?? false,
});

// Trigger slot as returned by the eq-id schedule_slots fetch.
function triggerSlot(o: {
  date: string; code?: string; dayType?: string; site?: string; version?: string; stOpts?: StOpts;
} = { date: MON }) {
  return {
    id: 'trig',
    site_id: o.site ?? 'siteA',
    slot_date: o.date,
    derived_day_type: o.dayType ?? 'weekday',
    schedule_version_id: o.version ?? 'v1',
    shift_types: st(o.code ?? 'C2', o.stOpts ?? { category: 'call', call_rank: 1 }),
  };
}

type AssignmentRow = { id: string; provider_id: string | null; assignment_status: string; source_type: string };
const openRow = (id: string): AssignmentRow =>
  ({ id, provider_id: null, assignment_status: 'open', source_type: 'manual' });

// Candidate slot as returned by the version-window schedule_slots query.
function slot(o: {
  id: string; date: string; code: string; site?: string; locked?: boolean; stOpts?: StOpts;
  assignments?: AssignmentRow[];
}) {
  return {
    id: o.id,
    site_id: o.site ?? 'siteA',
    slot_date: o.date,
    locked: o.locked ?? false,
    shift_types: st(o.code, o.stOpts),
    assignments: o.assignments ?? [],
  };
}

// Provider-wide assignments-window row (joined shape). `version` defaults to
// the trigger's own version 'v1' and `status` to 'draft' (the version under
// edit — seen via the helper's includeVersionId variant). A row in ANOTHER
// version only surfaces when it is committed (status 'published').
function winAssign(o: {
  id: string; date: string; code: string; site?: string; version?: string;
  status?: string; slotId?: string; source?: string; stOpts?: StOpts;
}) {
  return {
    id: o.id,
    source_type: o.source ?? 'manual',
    schedule_slots: {
      id: o.slotId ?? `slot-of-${o.id}`,
      slot_date: o.date,
      site_id: o.site ?? 'siteA',
      schedule_version_id: o.version ?? 'v1',
      schedule_versions: { version_status: o.status ?? 'draft' },
      shift_types: st(o.code, o.stOpts),
    },
  };
}

interface AvailRow { availability_type: string; approval_status: string; start_date: string; end_date: string }

function tables(o: {
  trigger?: unknown;
  slots?: unknown[];
  assignments?: unknown[];
  availability?: AvailRow[];
  callPatternRow?: unknown;
}): Record<string, TableCfg> {
  return {
    // Two shapes: eq('id', …) = trigger fetch; otherwise the version-window read.
    schedule_slots: (filters) =>
      filters.some(f => f.method === 'eq' && f.args[0] === 'id')
        ? { data: o.trigger ?? null }
        : { data: o.slots ?? [] },
    // Honors the helper's two committed-scope reads: the published variant
    // (version_status = 'published') and the current-version variant
    // (schedule_version_id = trigger's version). Each read resolves against the
    // canned rows; the helper merges + dedupes them.
    assignments: (filters) => {
      if (filters.some(f => ['update', 'insert', 'upsert'].includes(f.method))) {
        return { data: [{}], error: null };
      }
      const rows = (o.assignments ?? []) as Array<{
        schedule_slots: { schedule_version_id: string; schedule_versions?: { version_status?: string } };
      }>;
      const publishedEq = filters.find(f => f.method === 'eq' && f.args[0] === 'schedule_slots.schedule_versions.version_status');
      const versionEq = filters.find(f => f.method === 'eq' && f.args[0] === 'schedule_slots.schedule_version_id');
      let data = rows;
      if (publishedEq) data = data.filter(r => r.schedule_slots.schedule_versions?.version_status === publishedEq.args[1]);
      if (versionEq) data = data.filter(r => r.schedule_slots.schedule_version_id === versionEq.args[1]);
      return { data, error: null };
    },
    provider_availability: { data: o.availability ?? [] },
    call_patterns: { data: o.callPatternRow ?? null },
  };
}

const updates = (calls: ReturnType<typeof makeFakeSupabase>['calls']) =>
  callsFor(calls, 'assignments', 'update').map(c => c.args[0] as Record<string, unknown>);
const inserts = (calls: ReturnType<typeof makeFakeSupabase>['calls']) =>
  callsFor(calls, 'assignments', 'insert').map(c => c.args[0] as Record<string, unknown>);

afterEach(() => vi.restoreAllMocks());

// ── 1. classic pattern link: manual C2 Mon → D1 fill Tue ────────────────────

describe('applySequenceAutoFill — pattern-driven fill', () => {
  it('manual C2 on Mon fills the open D1 slot on Tue (classic C2→D1 link)', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: tables({
        trigger: triggerSlot({ date: MON }),
        slots: [slot({ id: 'slot-d1-tue', date: TUE, code: 'D1', assignments: [openRow('open-1')] })],
      }),
    });
    const result = await applySequenceAutoFill(sb, 'trig', 'p1', CLASSIC_PATTERN);

    expect(result.filledSlotIds).toEqual(['slot-d1-tue']);
    const up = updates(calls);
    expect(up).toHaveLength(1);
    expect(up[0].provider_id).toBe('p1');
    expect(up[0].assignment_status).toBe('assigned');
    expect(up[0].source_type).toBe('auto_generated');
    // Carried Task 8 finding: never persist an unevaluated clean []. The POST
    // route revalidates neighbors right after, so null ("not validated") is right.
    expect(up[0].validation_flags).toBeNull();
    // Classic C2 weekday also links D3 at -1 → Sunday has no D3 slot: recorded,
    // never silently dropped (clinical invariant 4).
    expect(result.skips).toContainEqual({ date: SUN, code: 'D3', provider_id: 'p1', reason: 'no-slot' });
    // Pattern passed in — no call_patterns read.
    expect(fromCount(calls, 'call_patterns')).toBe(0);
  });

  // Live DB: UNIQUE(schedule_slot_id) → PostgREST returns the slot's
  // assignments embed as ONE OBJECT, not an array. The candidate-slot parse
  // seam must normalize (an object here used to throw in the fill pass).
  it('workdays-cap seam: skips a link fill when the threaded predicate reports the provider capped', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: tables({
        trigger: triggerSlot({ date: MON }),
        slots: [slot({ id: 'slot-d1-tue', date: TUE, code: 'D1', assignments: [openRow('open-1')] })],
      }),
    });
    const result = await applySequenceAutoFill(sb, 'trig', 'p1', CLASSIC_PATTERN, {
      capExceeded: (pid, date) => pid === 'p1' && date === TUE,
    });
    expect(result.filledSlotIds).toEqual([]);
    expect(result.skips).toContainEqual({ date: TUE, code: 'D1', provider_id: 'p1', reason: 'ineligible' });
    expect(callsFor(calls, 'assignments', 'update')).toHaveLength(0);
    expect(callsFor(calls, 'assignments', 'insert')).toHaveLength(0);
  });

  it('no cap predicate (default) fills as before — the seam is opt-in', async () => {
    const { sb } = makeFakeSupabase({
      tables: tables({
        trigger: triggerSlot({ date: MON }),
        slots: [slot({ id: 'slot-d1-tue', date: TUE, code: 'D1', assignments: [openRow('open-1')] })],
      }),
    });
    const result = await applySequenceAutoFill(sb, 'trig', 'p1', CLASSIC_PATTERN);
    expect(result.filledSlotIds).toEqual(['slot-d1-tue']);
  });

  it('single-OBJECT assignments embed (live one-to-one shape) still fills via the open row', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: tables({
        trigger: triggerSlot({ date: MON }),
        slots: [{ ...slot({ id: 'slot-d1-tue', date: TUE, code: 'D1' }), assignments: openRow('open-1') }],
      }),
    });
    const result = await applySequenceAutoFill(sb, 'trig', 'p1', CLASSIC_PATTERN);
    expect(result.filledSlotIds).toEqual(['slot-d1-tue']);
    const up = updates(calls);
    expect(up).toHaveLength(1); // updated the existing open row — no duplicate insert
    expect(up[0].provider_id).toBe('p1');
    expect(inserts(calls)).toHaveLength(0);
  });

  it('inserts a fresh row (validation_flags null, not the [] column default) when the slot has no open row', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: tables({
        trigger: triggerSlot({ date: MON }),
        slots: [slot({ id: 'slot-d1-tue', date: TUE, code: 'D1', assignments: [] })],
      }),
    });
    const result = await applySequenceAutoFill(sb, 'trig', 'p1', CLASSIC_PATTERN);
    expect(result.filledSlotIds).toEqual(['slot-d1-tue']);
    const ins = inserts(calls);
    expect(ins).toHaveLength(1);
    expect(ins[0].schedule_slot_id).toBe('slot-d1-tue');
    expect(ins[0].validation_flags).toBeNull();
  });

  it('loads the active call pattern itself (once) when no doc is passed', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: tables({
        trigger: triggerSlot({ date: MON }),
        slots: [slot({ id: 'slot-d1-tue', date: TUE, code: 'D1', assignments: [openRow('open-1')] })],
        callPatternRow: null, // no active row → classic fallback
      }),
    });
    const result = await applySequenceAutoFill(sb, 'trig', 'p1');
    expect(result.filledSlotIds).toEqual(['slot-d1-tue']);
    expect(result.patternWarnings).toEqual([]); // no-row fallback is silent (matches genContext)
    expect(fromCount(calls, 'call_patterns')).toBe(1);
  });

  it('invalid active pattern → warning surfaced in the result, fills still computed from CLASSIC', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sb } = makeFakeSupabase({
      tables: tables({
        trigger: triggerSlot({ date: MON }),
        slots: [slot({ id: 'slot-d1-tue', date: TUE, code: 'D1', assignments: [openRow('open-1')] })],
        callPatternRow: { definition: { nope: true } },
      }),
    });
    const result = await applySequenceAutoFill(sb, 'trig', 'p1');
    expect(result.filledSlotIds).toEqual(['slot-d1-tue']); // classic C2→D1 still applied
    expect(result.patternWarnings).toHaveLength(1);
    expect(result.patternWarnings[0]).toMatch(/failed validation/);
  });

  it('prefers the trigger site when several sites have a matching slot on the linked day', async () => {
    const { sb } = makeFakeSupabase({
      tables: tables({
        trigger: triggerSlot({ date: MON }),
        slots: [
          slot({ id: 'slot-d1-tue-b', date: TUE, code: 'D1', site: 'siteB', assignments: [openRow('open-b')] }),
          slot({ id: 'slot-d1-tue-a', date: TUE, code: 'D1', site: 'siteA', assignments: [openRow('open-a')] }),
        ],
      }),
    });
    const result = await applySequenceAutoFill(sb, 'trig', 'p1', CLASSIC_PATTERN);
    expect(result.filledSlotIds).toEqual(['slot-d1-tue-a']);
  });

  it('ambiguous multi-site candidates (none at the trigger site) skip as ineligible', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: tables({
        trigger: triggerSlot({ date: MON }),
        slots: [
          slot({ id: 'slot-d1-tue-b', date: TUE, code: 'D1', site: 'siteB', assignments: [openRow('open-b')] }),
          slot({ id: 'slot-d1-tue-c', date: TUE, code: 'D1', site: 'siteC', assignments: [openRow('open-c')] }),
        ],
      }),
    });
    const result = await applySequenceAutoFill(sb, 'trig', 'p1', CLASSIC_PATTERN);
    expect(result.filledSlotIds).toEqual([]);
    expect(result.skips).toContainEqual({ date: TUE, code: 'D1', provider_id: 'p1', reason: 'ineligible' });
    expect(updates(calls)).toHaveLength(0);
  });

  it('a locked linked slot skips as ineligible', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: tables({
        trigger: triggerSlot({ date: MON }),
        slots: [slot({ id: 'slot-d1-tue', date: TUE, code: 'D1', locked: true, assignments: [openRow('open-1')] })],
      }),
    });
    const result = await applySequenceAutoFill(sb, 'trig', 'p1', CLASSIC_PATTERN);
    expect(result.filledSlotIds).toEqual([]);
    expect(result.skips).toContainEqual({ date: TUE, code: 'D1', provider_id: 'p1', reason: 'ineligible' });
    expect(updates(calls)).toHaveLength(0);
  });

  it('unlessCallWithinDays suppresses the pre-fill silently (link condition, not a skip — mirrors solve)', async () => {
    // Trigger C2 on Wed; classic D3 link has unlessCallWithinDays: 2 and the
    // provider took call on Mon (gap 2) → the D3 fill is suppressed with NO
    // skip record, exactly like solve(). The D1 link (Thu) still fills.
    const { sb } = makeFakeSupabase({
      tables: tables({
        trigger: triggerSlot({ date: WED }),
        slots: [
          slot({ id: 'slot-d3-tue', date: TUE, code: 'D3', assignments: [openRow('open-3')] }),
          slot({ id: 'slot-d1-thu', date: THU, code: 'D1', assignments: [openRow('open-1')] }),
        ],
        assignments: [winAssign({
          id: 'a-call-mon', date: MON, code: 'C2',
          stOpts: { category: 'call', call_rank: 1, requires_post_call_rule: true },
        })],
      }),
    });
    const result = await applySequenceAutoFill(sb, 'trig', 'p1', CLASSIC_PATTERN);
    expect(result.filledSlotIds).toEqual(['slot-d1-thu']);
    expect(result.skips.every(s => s.code !== 'D3')).toBe(true);
  });

  it('a failed fill write logs loudly and lands in neither filledSlotIds nor skips (documented contract)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { sb } = makeFakeSupabase({
      tables: {
        ...tables({
          trigger: triggerSlot({ date: MON }),
          slots: [slot({ id: 'slot-d1-tue', date: TUE, code: 'D1', assignments: [openRow('open-1')] })],
        }),
        assignments: (filters) =>
          filters.some(f => ['update', 'insert', 'upsert'].includes(f.method))
            ? { data: null, error: { message: 'boom' } }
            : { data: [], error: null },
      },
    });
    const result = await applySequenceAutoFill(sb, 'trig', 'p1', CLASSIC_PATTERN);
    expect(result.filledSlotIds).toEqual([]);
    expect(result.skips.every(s => s.code !== 'D1')).toBe(true);
    expect(err).toHaveBeenCalled();
  });
});

// ── post-call rest guard (clinical invariant 1) ──────────────────────────────

describe('applySequenceAutoFill — post-call rest guard', () => {
  it('declines a fill on the rest day of ANOTHER rest-requiring call (any site, any PUBLISHED version)', async () => {
    // The provider holds a rest-requiring 24h call on Mon at site B in a
    // committed (published) version. Tue is their post-call day off — the D1
    // fill must decline.
    const { sb, calls } = makeFakeSupabase({
      tables: tables({
        trigger: triggerSlot({ date: MON }),
        slots: [slot({ id: 'slot-d1-tue', date: TUE, code: 'D1', assignments: [openRow('open-1')] })],
        assignments: [winAssign({
          id: 'a-callB', date: MON, code: 'CX', site: 'siteB', version: 'v2', status: 'published', slotId: 'slot-callB',
          stOpts: { category: 'call', call_rank: 0, requires_post_call_rule: true },
        })],
      }),
    });
    const result = await applySequenceAutoFill(sb, 'trig', 'p1', CLASSIC_PATTERN);
    expect(result.filledSlotIds).toEqual([]);
    // 'ineligible' — matches solve's skipReasonFrom mapping for the post-call
    // guard; 'already-handled' would mislabel this as slot consumption.
    expect(result.skips).toContainEqual({ date: TUE, code: 'D1', provider_id: 'p1', reason: 'ineligible' });
    expect(updates(calls)).toHaveLength(0);
  });

  it("the trigger's own rest-requiring call does NOT self-block its +1 link (D1 still fills)", async () => {
    // Production reality: the POST route upserts the manual C2 BEFORE the
    // auto-fill runs, so the trigger's own assignment IS in the window. Its
    // +1 link (D1) is the sanctioned post-call assignment.
    const { sb } = makeFakeSupabase({
      tables: tables({
        trigger: triggerSlot({ date: MON }),
        slots: [slot({ id: 'slot-d1-tue', date: TUE, code: 'D1', assignments: [openRow('open-1')] })],
        assignments: [winAssign({
          id: 'a-trig', date: MON, code: 'C2', slotId: 'trig',
          stOpts: { category: 'call', call_rank: 1, requires_post_call_rule: true },
        })],
      }),
    });
    const result = await applySequenceAutoFill(sb, 'trig', 'p1', CLASSIC_PATTERN);
    expect(result.filledSlotIds).toEqual(['slot-d1-tue']);
  });
});

// ── 2. cross-site fix: provider-wide same-day conflict (any site/version) ───

describe('applySequenceAutoFill — cross-site conflict (clinical invariant 3)', () => {
  it('does NOT fill D1 when the provider is assigned that day at another site in a PUBLISHED version', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: tables({
        trigger: triggerSlot({ date: MON }),
        slots: [slot({ id: 'slot-d1-tue', date: TUE, code: 'D1', assignments: [openRow('open-1')] })],
        assignments: [winAssign({
          id: 'x1', date: TUE, code: 'OR1', site: 'siteB', version: 'v2', status: 'published',
          stOpts: { category: 'regular' },
        })],
      }),
    });
    const result = await applySequenceAutoFill(sb, 'trig', 'p1', CLASSIC_PATTERN);

    expect(result.filledSlotIds).toEqual([]);
    expect(result.skips).toContainEqual({ date: TUE, code: 'D1', provider_id: 'p1', reason: 'cross-site' });
    expect(updates(calls)).toHaveLength(0);
    expect(inserts(calls)).toHaveLength(0);
  });

  // Draft isolation (invariant 3): the SAME booking, but in an unpublished
  // DRAFT of another version, is invisible — D1 fills and no skip is recorded.
  it('DOES fill D1 when the other-site booking is an unpublished DRAFT (draft isolation)', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: tables({
        trigger: triggerSlot({ date: MON }),
        slots: [slot({ id: 'slot-d1-tue', date: TUE, code: 'D1', assignments: [openRow('open-1')] })],
        assignments: [winAssign({
          id: 'x1', date: TUE, code: 'OR1', site: 'siteB', version: 'v2', status: 'draft',
          stOpts: { category: 'regular' },
        })],
      }),
    });
    const result = await applySequenceAutoFill(sb, 'trig', 'p1', CLASSIC_PATTERN);

    expect(result.filledSlotIds).toEqual(['slot-d1-tue']);
    expect(result.skips.every(s => s.code !== 'D1')).toBe(true);
    expect(updates(calls)).toHaveLength(1);
  });

  it('same-site same-day conflict (published) is recorded as occupied, not cross-site', async () => {
    const { sb } = makeFakeSupabase({
      tables: tables({
        trigger: triggerSlot({ date: MON }),
        slots: [slot({ id: 'slot-d1-tue', date: TUE, code: 'D1', assignments: [openRow('open-1')] })],
        assignments: [winAssign({
          id: 'x1', date: TUE, code: 'OR1', site: 'siteA', version: 'v2', status: 'published',
          stOpts: { category: 'regular' },
        })],
      }),
    });
    const result = await applySequenceAutoFill(sb, 'trig', 'p1', CLASSIC_PATTERN);
    expect(result.filledSlotIds).toEqual([]);
    expect(result.skips).toContainEqual({ date: TUE, code: 'D1', provider_id: 'p1', reason: 'occupied' });
  });

  it('labels relative to the CHOSEN slot site: conflict at siteB with the only candidate at siteB → occupied', async () => {
    // The fill would land at siteB (sole candidate); the provider's conflicting
    // (published) assignment is also at siteB — same-site relative to where the
    // fill goes, even though it differs from the trigger site.
    const { sb } = makeFakeSupabase({
      tables: tables({
        trigger: triggerSlot({ date: MON }),
        slots: [slot({ id: 'slot-d1-tue-b', date: TUE, code: 'D1', site: 'siteB', assignments: [openRow('open-b')] })],
        assignments: [winAssign({
          id: 'x1', date: TUE, code: 'OR1', site: 'siteB', version: 'v2', status: 'published',
          stOpts: { category: 'regular' },
        })],
      }),
    });
    const result = await applySequenceAutoFill(sb, 'trig', 'p1', CLASSIC_PATTERN);
    expect(result.skips).toContainEqual({ date: TUE, code: 'D1', provider_id: 'p1', reason: 'occupied' });
  });
});

// ── 2b. overlay coexistence: two-sided, same-site, regular↔overlay-call only ─
// The coexists predicate mirrors solve's narrow overlay exemption in BOTH
// directions (review findings 3+4): an existing same-site OVERLAY row lets a
// NON-CALL fill land beside it; an incoming OVERLAY fill lands beside an
// existing same-site REGULAR row (order-independence). Call+call always
// collides, and ANY cross-site row still blocks (conservative).

describe('applySequenceAutoFill — overlay coexistence (same-site vs cross-site)', () => {
  it('fills D1 even though the provider holds a SAME-SITE overlay call (neuro C3) that day', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: tables({
        trigger: triggerSlot({ date: MON }),
        slots: [slot({ id: 'slot-d1-tue', date: TUE, code: 'D1', assignments: [openRow('open-1')] })],
        assignments: [winAssign({
          id: 'ovl', date: TUE, code: 'C3', site: 'siteA', slotId: 'slot-c3-tue',
          stOpts: { category: 'call', call_rank: 2, is_overlay: true },
        })],
      }),
    });
    const result = await applySequenceAutoFill(sb, 'trig', 'p1', CLASSIC_PATTERN);
    expect(result.filledSlotIds).toEqual(['slot-d1-tue']);
    expect(result.skips.every(s => s.code !== 'D1')).toBe(true);
    expect(updates(calls)).toHaveLength(1);
  });

  it('a CROSS-SITE overlay row still blocks the fill (recorded cross-site)', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: tables({
        trigger: triggerSlot({ date: MON }),
        slots: [slot({ id: 'slot-d1-tue', date: TUE, code: 'D1', assignments: [openRow('open-1')] })],
        assignments: [winAssign({
          id: 'ovlB', date: TUE, code: 'C3', site: 'siteB', version: 'v2', status: 'published', slotId: 'slot-c3-tue-b',
          stOpts: { category: 'call', call_rank: 2, is_overlay: true },
        })],
      }),
    });
    const result = await applySequenceAutoFill(sb, 'trig', 'p1', CLASSIC_PATTERN);
    expect(result.filledSlotIds).toEqual([]);
    expect(result.skips).toContainEqual({ date: TUE, code: 'D1', provider_id: 'p1', reason: 'cross-site' });
    expect(updates(calls)).toHaveLength(0);
  });

  it('a CALL link fill still collides with a same-site overlay call (never call-on-call)', async () => {
    // Finding 3: the fill itself is a CALL (C1 link), so the existing same-site
    // overlay C3 does NOT coexist — the C1 must decline as occupied, never
    // stack a second call on the neuro doc.
    const CALL_LINK: CallPatternDoc = {
      version: 1, blocks: [],
      dayChains: [{ trigger: 'C2', dayTypes: ['weekday'], links: [{ offset: 1, code: 'C1' }] }],
      spans: [], placementPasses: [], reliefPass: null, optimizerMovableDayTypes: [],
    };
    const { sb, calls } = makeFakeSupabase({
      tables: tables({
        trigger: triggerSlot({ date: MON }),
        slots: [slot({
          id: 'slot-c1-tue', date: TUE, code: 'C1',
          stOpts: { category: 'call', call_rank: 0 }, assignments: [openRow('open-1')],
        })],
        assignments: [winAssign({
          id: 'ovl', date: TUE, code: 'C3', site: 'siteA', slotId: 'slot-c3-tue',
          stOpts: { category: 'call', call_rank: 2, is_overlay: true },
        })],
      }),
    });
    const result = await applySequenceAutoFill(sb, 'trig', 'p1', CALL_LINK);
    expect(result.filledSlotIds).toEqual([]);
    expect(result.skips).toContainEqual({ date: TUE, code: 'C1', provider_id: 'p1', reason: 'occupied' });
    expect(updates(calls)).toHaveLength(0);
    expect(inserts(calls)).toHaveLength(0);
  });

  it('an OVERLAY call link fills over a pre-existing same-site REGULAR row (reverse order, finding 4)', async () => {
    // Order-independence: Fri D4 (regular) already sits on the provider; the
    // Sat-C3 trigger's −1 C3 link (overlay call) must land beside it — the
    // two-sided predicate exempts incoming-OVERLAY + existing-REGULAR too.
    const C3_PRECALL: CallPatternDoc = {
      version: 1, blocks: [],
      dayChains: [{ trigger: 'C3', dayTypes: ['saturday'], links: [{ offset: -1, code: 'C3' }] }],
      spans: [], placementPasses: [], reliefPass: null, optimizerMovableDayTypes: [],
    };
    const { sb, calls } = makeFakeSupabase({
      tables: tables({
        trigger: triggerSlot({
          date: SAT, code: 'C3', dayType: 'saturday',
          stOpts: { category: 'call', call_rank: 2, is_overlay: true },
        }),
        slots: [slot({
          id: 'slot-c3-fri', date: FRI, code: 'C3',
          stOpts: { category: 'call', call_rank: 2, is_overlay: true },
          assignments: [openRow('open-1')],
        })],
        assignments: [winAssign({
          id: 'a-d4', date: FRI, code: 'D4', site: 'siteA', slotId: 'slot-d4-fri',
          stOpts: { category: 'regular' },
        })],
      }),
    });
    const result = await applySequenceAutoFill(sb, 'trig', 'p1', C3_PRECALL);
    expect(result.filledSlotIds).toEqual(['slot-c3-fri']);
    expect(result.skips.every(s => s.code !== 'C3')).toBe(true);
    expect(updates(calls)).toHaveLength(1);
  });
});

// ── 3. PTO (pending blocks — canonical isBlockingAvailability predicate) ────

describe('applySequenceAutoFill — PTO (clinical invariant 2)', () => {
  it('pending PTO on the linked day blocks the fill and records reason pto', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: tables({
        trigger: triggerSlot({ date: MON }),
        slots: [slot({ id: 'slot-d1-tue', date: TUE, code: 'D1', assignments: [openRow('open-1')] })],
        availability: [{ availability_type: 'pto', approval_status: 'pending', start_date: TUE, end_date: TUE }],
      }),
    });
    const result = await applySequenceAutoFill(sb, 'trig', 'p1', CLASSIC_PATTERN);

    expect(result.filledSlotIds).toEqual([]);
    expect(result.skips).toContainEqual({ date: TUE, code: 'D1', provider_id: 'p1', reason: 'pto' });
    expect(updates(calls)).toHaveLength(0);
  });

  it('denied PTO does not block (predicate polarity)', async () => {
    const { sb } = makeFakeSupabase({
      tables: tables({
        trigger: triggerSlot({ date: MON }),
        slots: [slot({ id: 'slot-d1-tue', date: TUE, code: 'D1', assignments: [openRow('open-1')] })],
        availability: [{ availability_type: 'pto', approval_status: 'denied', start_date: TUE, end_date: TUE }],
      }),
    });
    const result = await applySequenceAutoFill(sb, 'trig', 'p1', CLASSIC_PATTERN);
    expect(result.filledSlotIds).toEqual(['slot-d1-tue']);
  });

  // pto_sellback date-level override (2026-07-20, ALGORITHM.md §6): a live
  // sell-back row covering the linked date means the provider is WORKING —
  // the derived fill may land despite PTO (pending included) covering it.
  it('a live sell-back on the linked day overrides PTO — the D1 fill lands', async () => {
    const { sb } = makeFakeSupabase({
      tables: tables({
        trigger: triggerSlot({ date: MON }),
        slots: [slot({ id: 'slot-d1-tue', date: TUE, code: 'D1', assignments: [openRow('open-1')] })],
        availability: [
          { availability_type: 'pto', approval_status: 'pending', start_date: TUE, end_date: TUE },
          { availability_type: 'pto_sellback', approval_status: 'approved', start_date: TUE, end_date: TUE },
        ],
      }),
    });
    const result = await applySequenceAutoFill(sb, 'trig', 'p1', CLASSIC_PATTERN);
    expect(result.filledSlotIds).toEqual(['slot-d1-tue']);
    // No pto skip for the sold-back linked day (the fixture's absent D3
    // pre-fill slot still records its unrelated 'no-slot' skip).
    expect(result.skips.filter(s => s.reason === 'pto')).toEqual([]);
  });

  it('a canceled sell-back does not override — skip reason stays pto', async () => {
    const { sb } = makeFakeSupabase({
      tables: tables({
        trigger: triggerSlot({ date: MON }),
        slots: [slot({ id: 'slot-d1-tue', date: TUE, code: 'D1', assignments: [openRow('open-1')] })],
        availability: [
          { availability_type: 'pto', approval_status: 'approved', start_date: TUE, end_date: TUE },
          { availability_type: 'pto_sellback', approval_status: 'canceled', start_date: TUE, end_date: TUE },
        ],
      }),
    });
    const result = await applySequenceAutoFill(sb, 'trig', 'p1', CLASSIC_PATTERN);
    expect(result.filledSlotIds).toEqual([]);
    expect(result.skips).toContainEqual({ date: TUE, code: 'D1', provider_id: 'p1', reason: 'pto' });
  });
});

// ── 4. result shape / vocabulary ─────────────────────────────────────────────

describe('applySequenceAutoFill — result shape', () => {
  it('returns { filledSlotIds, evictedSlotIds, skips, patternWarnings } with SkippedDerived-vocabulary reasons', async () => {
    const { sb } = makeFakeSupabase({
      tables: tables({
        trigger: triggerSlot({ date: MON }),
        slots: [],
      }),
    });
    const result = await applySequenceAutoFill(sb, 'trig', 'p1', CLASSIC_PATTERN);
    expect(result).toHaveProperty('filledSlotIds');
    expect(result).toHaveProperty('skips');
    expect(result.evictedSlotIds).toEqual([]);
    expect(result.patternWarnings).toEqual([]); // doc passed in — nothing to warn about
    expect(Array.isArray(result.filledSlotIds)).toBe(true);
    for (const s of result.skips) {
      expect(s.provider_id).toBe('p1');
      expect(SKIP_REASONS).toContain(s.reason);
    }
    // Both classic C2 links (D3 Sun, D1 Tue) had no slot → both recorded.
    expect(result.skips.map(s => s.code).sort()).toEqual(['D1', 'D3']);
  });
});

// ── 5. precedence via ranks, not literal codes ───────────────────────────────
// Same shape as classic C2 chains, but the pre-call code is renamed D3→'PRE'.

const RENAMED: CallPatternDoc = {
  version: 1,
  blocks: [],
  dayChains: [
    {
      trigger: 'C2',
      dayTypes: ['weekday', 'friday'],
      links: [{ offset: -1, code: 'PRE' }, { offset: 1, code: 'D1' }],
    },
  ],
  spans: [],
  placementPasses: [],
  reliefPass: null,
  optimizerMovableDayTypes: [],
};

describe('applySequenceAutoFill — rank precedence (renamed D3→PRE)', () => {
  it('post-call D1 evicts an auto-generated PRE pre-fill on the same day (no literal D3)', async () => {
    const preAssignment: AssignmentRow =
      { id: 'a-pre', provider_id: 'p1', assignment_status: 'assigned', source_type: 'auto_generated' };
    const { sb, calls } = makeFakeSupabase({
      tables: tables({
        trigger: triggerSlot({ date: MON }),
        slots: [
          slot({ id: 'slot-pre-tue', date: TUE, code: 'PRE', assignments: [preAssignment] }),
          slot({ id: 'slot-d1-tue', date: TUE, code: 'D1', assignments: [openRow('open-1')] }),
        ],
        assignments: [winAssign({ id: 'a-pre', date: TUE, code: 'PRE', slotId: 'slot-pre-tue', source: 'auto_generated' })],
      }),
    });
    const result = await applySequenceAutoFill(sb, 'trig', 'p1', RENAMED);

    expect(result.filledSlotIds).toEqual(['slot-d1-tue']);
    expect(result.evictedSlotIds).toEqual(['slot-pre-tue']); // eviction is reported, never silent
    const up = updates(calls);
    expect(up).toHaveLength(2);
    // Eviction first: PRE row reverted to open, flags null (never fake-clean []).
    expect(up[0].provider_id).toBeNull();
    expect(up[0].assignment_status).toBe('open');
    expect(up[0].validation_flags).toBeNull();
    // Then the D1 fill.
    expect(up[1].provider_id).toBe('p1');
    expect(up[1].source_type).toBe('auto_generated');
  });

  it('evicts the stale PRE even when the D1 then declines on PTO (decline recorded, eviction reported)', async () => {
    // Deliberate ordering: provider-level declines (PTO/conflict/rest) run
    // AFTER eviction — the auto-generated PRE was sitting on the provider's
    // post-call day (and here on a PTO day), so removing it is self-justifying
    // even though the incoming fill does not land.
    const preAssignment: AssignmentRow =
      { id: 'a-pre', provider_id: 'p1', assignment_status: 'assigned', source_type: 'auto_generated' };
    const { sb, calls } = makeFakeSupabase({
      tables: tables({
        trigger: triggerSlot({ date: MON }),
        slots: [
          slot({ id: 'slot-pre-tue', date: TUE, code: 'PRE', assignments: [preAssignment] }),
          slot({ id: 'slot-d1-tue', date: TUE, code: 'D1', assignments: [openRow('open-1')] }),
        ],
        assignments: [winAssign({ id: 'a-pre', date: TUE, code: 'PRE', slotId: 'slot-pre-tue', source: 'auto_generated' })],
        availability: [{ availability_type: 'pto', approval_status: 'pending', start_date: TUE, end_date: TUE }],
      }),
    });
    const result = await applySequenceAutoFill(sb, 'trig', 'p1', RENAMED);

    expect(result.filledSlotIds).toEqual([]);
    expect(result.evictedSlotIds).toEqual(['slot-pre-tue']);
    expect(result.skips).toContainEqual({ date: TUE, code: 'D1', provider_id: 'p1', reason: 'pto' });
    expect(updates(calls)).toHaveLength(1); // the eviction only
    expect(updates(calls)[0].provider_id).toBeNull();
  });

  it('does NOT evict when the fill declines structurally (no D1 slot to land on)', async () => {
    const preAssignment: AssignmentRow =
      { id: 'a-pre', provider_id: 'p1', assignment_status: 'assigned', source_type: 'auto_generated' };
    const { sb, calls } = makeFakeSupabase({
      tables: tables({
        trigger: triggerSlot({ date: MON }),
        slots: [slot({ id: 'slot-pre-tue', date: TUE, code: 'PRE', assignments: [preAssignment] })],
        assignments: [winAssign({ id: 'a-pre', date: TUE, code: 'PRE', slotId: 'slot-pre-tue', source: 'auto_generated' })],
      }),
    });
    const result = await applySequenceAutoFill(sb, 'trig', 'p1', RENAMED);

    expect(result.evictedSlotIds).toEqual([]);
    expect(result.skips).toContainEqual({ date: TUE, code: 'D1', provider_id: 'p1', reason: 'no-slot' });
    expect(updates(calls)).toHaveLength(0); // PRE untouched
  });

  it('duplicate links to the same date+code fill once and skip the duplicate as already-handled', async () => {
    const DUP: CallPatternDoc = {
      ...RENAMED,
      dayChains: [{
        trigger: 'C2', dayTypes: ['weekday', 'friday'],
        links: [{ offset: 1, code: 'D1' }, { offset: 1, code: 'D1' }],
      }],
    };
    const { sb, calls } = makeFakeSupabase({
      tables: tables({
        trigger: triggerSlot({ date: MON }),
        slots: [slot({ id: 'slot-d1-tue', date: TUE, code: 'D1', assignments: [openRow('open-1')] })],
      }),
    });
    const result = await applySequenceAutoFill(sb, 'trig', 'p1', DUP);
    expect(result.filledSlotIds).toEqual(['slot-d1-tue']);
    expect(updates(calls)).toHaveLength(1);
    expect(result.skips).toContainEqual({ date: TUE, code: 'D1', provider_id: 'p1', reason: 'already-handled' });
  });

  it('a MANUAL PRE on the linked day is never evicted — D1 declines as occupied', async () => {
    const manualPre: AssignmentRow =
      { id: 'a-pre', provider_id: 'p1', assignment_status: 'assigned', source_type: 'manual' };
    const { sb, calls } = makeFakeSupabase({
      tables: tables({
        trigger: triggerSlot({ date: MON }),
        slots: [
          slot({ id: 'slot-pre-tue', date: TUE, code: 'PRE', assignments: [manualPre] }),
          slot({ id: 'slot-d1-tue', date: TUE, code: 'D1', assignments: [openRow('open-1')] }),
        ],
        assignments: [winAssign({ id: 'a-pre', date: TUE, code: 'PRE', slotId: 'slot-pre-tue', source: 'manual' })],
      }),
    });
    const result = await applySequenceAutoFill(sb, 'trig', 'p1', RENAMED);
    expect(result.filledSlotIds).toEqual([]);
    expect(result.skips).toContainEqual({ date: TUE, code: 'D1', provider_id: 'p1', reason: 'occupied' });
    expect(updates(calls)).toHaveLength(0);
  });

  it('an auto-generated PRE in a DIFFERENT (published) schedule version is not evicted', async () => {
    // The other version is PUBLISHED, so its PRE is visible; the eviction guard
    // is same-version-only, so it survives and blocks the D1 fill as occupied.
    const { sb, calls } = makeFakeSupabase({
      tables: tables({
        trigger: triggerSlot({ date: MON }),
        slots: [slot({ id: 'slot-d1-tue', date: TUE, code: 'D1', assignments: [openRow('open-1')] })],
        assignments: [winAssign({
          id: 'a-pre', date: TUE, code: 'PRE', version: 'v2', status: 'published', source: 'auto_generated',
        })],
      }),
    });
    const result = await applySequenceAutoFill(sb, 'trig', 'p1', RENAMED);
    expect(result.filledSlotIds).toEqual([]);
    expect(updates(calls)).toHaveLength(0);
    expect(result.skips).toContainEqual({ date: TUE, code: 'D1', provider_id: 'p1', reason: 'occupied' });
  });

  it('pre-fill declines when a prior-day call of equal-or-lower call_rank owns the linked day', async () => {
    // Trigger C2 (call_rank 1) on Wed → PRE targets Tue. Provider already has a
    // C2 call (rank 1, tie → post-call wins) on Mon → Tue is a post-call day.
    const { sb, calls } = makeFakeSupabase({
      tables: tables({
        trigger: triggerSlot({ date: WED }),
        slots: [slot({ id: 'slot-pre-tue', date: TUE, code: 'PRE', assignments: [openRow('open-2')] })],
        assignments: [winAssign({
          id: 'a-call-mon', date: MON, code: 'C2', stOpts: { category: 'call', call_rank: 1 },
        })],
      }),
    });
    const result = await applySequenceAutoFill(sb, 'trig', 'p1', RENAMED);
    expect(result.filledSlotIds).toEqual([]);
    expect(result.skips).toContainEqual({ date: TUE, code: 'PRE', provider_id: 'p1', reason: 'already-handled' });
    expect(result.skips).toContainEqual({ date: THU, code: 'D1', provider_id: 'p1', reason: 'no-slot' });
    expect(updates(calls)).toHaveLength(0);
  });

  it('pre-fill proceeds when the prior-day call is OUTRANKED (lower call_rank trigger wins)', async () => {
    // Prior-day call is C3 (call_rank 2) — higher rank than the C2 trigger (1),
    // so the pre-fill wins the day.
    const { sb } = makeFakeSupabase({
      tables: tables({
        trigger: triggerSlot({ date: WED }),
        slots: [slot({ id: 'slot-pre-tue', date: TUE, code: 'PRE', assignments: [openRow('open-2')] })],
        assignments: [winAssign({
          id: 'a-call-mon', date: MON, code: 'C3', stOpts: { category: 'call', call_rank: 2 },
        })],
      }),
    });
    const result = await applySequenceAutoFill(sb, 'trig', 'p1', RENAMED);
    expect(result.filledSlotIds).toEqual(['slot-pre-tue']);
  });
});

// ── 6. query budget ──────────────────────────────────────────────────────────

describe('applySequenceAutoFill — query budget', () => {
  it('a fill costs ≤6 DB calls: trigger + assignments-window (published + current version) + availability + slots + 1 write', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: tables({
        trigger: triggerSlot({ date: MON }),
        slots: [slot({ id: 'slot-d1-tue', date: TUE, code: 'D1', assignments: [openRow('open-1')] })],
      }),
    });
    await applySequenceAutoFill(sb, 'trig', 'p1', CLASSIC_PATTERN);

    expect(fromCount(calls)).toBeLessThanOrEqual(6);
    expect(fromCount(calls, 'schedule_slots')).toBe(2);      // trigger fetch + slots window
    expect(fromCount(calls, 'provider_availability')).toBe(1);
    // Draft isolation: the window is two committed-scope reads (published
    // versions + the trigger's own version), merged in the helper.
    expect(callsFor(calls, 'assignments', 'select')).toHaveLength(2);
  });
});

// ── cleanup mirrors the same pattern-link derivation ─────────────────────────

describe('cleanupSequenceAutoFill', () => {
  it('clears the auto-generated D1 fill when the C2 trigger is removed', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: tables({
        trigger: triggerSlot({ date: MON }),
        slots: [slot({
          id: 'slot-d1-tue', date: TUE, code: 'D1',
          assignments: [{ id: 'a-d1', provider_id: 'p1', assignment_status: 'assigned', source_type: 'auto_generated' }],
        })],
      }),
    });
    const result = await cleanupSequenceAutoFill(sb, 'trig', 'p1', CLASSIC_PATTERN);

    expect(result.clearedSlotIds).toEqual(['slot-d1-tue']);
    const up = updates(calls);
    expect(up).toHaveLength(1);
    expect(up[0].provider_id).toBeNull();
    expect(up[0].assignment_status).toBe('open');
    expect(up[0].validation_flags).toBeNull(); // never a fake-clean []
  });

  it('never touches manual assignments or other providers', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: tables({
        trigger: triggerSlot({ date: MON }),
        slots: [
          slot({
            id: 'slot-d1-tue', date: TUE, code: 'D1',
            assignments: [{ id: 'a-d1', provider_id: 'p1', assignment_status: 'assigned', source_type: 'manual' }],
          }),
          slot({
            id: 'slot-d3-sun', date: SUN, code: 'D3',
            assignments: [{ id: 'a-d3', provider_id: 'p2', assignment_status: 'assigned', source_type: 'auto_generated' }],
          }),
        ],
      }),
    });
    const result = await cleanupSequenceAutoFill(sb, 'trig', 'p1', CLASSIC_PATTERN);
    expect(result.clearedSlotIds).toEqual([]);
    expect(result.patternWarnings).toEqual([]);
    expect(updates(calls)).toHaveLength(0);
  });

  it('duplicate links to the same date+code clear each assignment once (deduped by assignment id)', async () => {
    const DUP: CallPatternDoc = {
      version: 1,
      blocks: [],
      dayChains: [{
        trigger: 'C2', dayTypes: ['weekday', 'friday'],
        links: [{ offset: 1, code: 'D1' }, { offset: 1, code: 'D1' }],
      }],
      spans: [],
      placementPasses: [],
      reliefPass: null,
      optimizerMovableDayTypes: [],
    };
    const { sb, calls } = makeFakeSupabase({
      tables: tables({
        trigger: triggerSlot({ date: MON }),
        slots: [slot({
          id: 'slot-d1-tue', date: TUE, code: 'D1',
          assignments: [{ id: 'a-d1', provider_id: 'p1', assignment_status: 'assigned', source_type: 'auto_generated' }],
        })],
      }),
    });
    const result = await cleanupSequenceAutoFill(sb, 'trig', 'p1', DUP);
    expect(result.clearedSlotIds).toEqual(['slot-d1-tue']);
    expect(updates(calls)).toHaveLength(1);
  });
});

// ── loadActiveCallPattern (route-side per-request loader) ────────────────────

describe('loadActiveCallPattern', () => {
  it('returns { doc, warnings: [] } for a valid active row', async () => {
    const { sb } = makeFakeSupabase({ tables: { call_patterns: { data: { definition: RENAMED } } } });
    const loaded = await loadActiveCallPattern(sb, 'siteA');
    expect(loaded.doc).toEqual(RENAMED);
    expect(loaded.warnings).toEqual([]);
  });

  it('falls back to CLASSIC_PATTERN silently when no active row exists (matches genContext)', async () => {
    const { sb } = makeFakeSupabase({ tables: { call_patterns: { data: null } } });
    const loaded = await loadActiveCallPattern(sb, 'siteA');
    expect(loaded.doc).toBe(CLASSIC_PATTERN);
    expect(loaded.warnings).toEqual([]);
  });

  it('falls back to CLASSIC_PATTERN with a returned warning on an invalid definition', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sb } = makeFakeSupabase({ tables: { call_patterns: { data: { definition: { nope: true } } } } });
    const loaded = await loadActiveCallPattern(sb, 'siteA');
    expect(loaded.doc).toBe(CLASSIC_PATTERN);
    expect(loaded.warnings).toHaveLength(1);
    expect(loaded.warnings[0]).toMatch(/failed validation/);
    expect(warn).toHaveBeenCalled();
  });

  it('falls back to CLASSIC_PATTERN with a returned warning on a query error (missing table)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sb } = makeFakeSupabase({
      tables: { call_patterns: { data: null, error: { message: 'relation "scheduling.call_patterns" does not exist' } } },
    });
    const loaded = await loadActiveCallPattern(sb, 'siteA');
    expect(loaded.doc).toBe(CLASSIC_PATTERN);
    expect(loaded.warnings).toHaveLength(1);
  });

  it('returns CLASSIC_PATTERN without querying when siteId is missing', async () => {
    const { sb, calls } = makeFakeSupabase({});
    const loaded = await loadActiveCallPattern(sb, undefined);
    expect(loaded.doc).toBe(CLASSIC_PATTERN);
    expect(loaded.warnings).toEqual([]);
    expect(fromCount(calls)).toBe(0);
  });
});

// ── pre-patch18 degraded mode: rank columns missing / read errors ────────────
//
// On a live DB without patch18, shift_types.call_rank/relief_rank don't exist
// and every wide select 42703s. The module must NOT silently no-op (dead
// manual C2→D1 fills, dead cleanup, dead skips): it retries with a narrow
// shift-type embed, degrades rank precedence to category ranking, and says so.
// Non-column errors abort LOUDLY — an empty-looking window would silently pass
// the occupancy/rest guards.

describe('sequenceAutoFill — pre-patch18 degraded mode', () => {
  const MISSING_COL = { message: 'column shift_types.call_rank does not exist', code: '42703' };
  const wideSelected = (filters: Array<{ method: string; args: unknown[] }>) =>
    filters.some(f => f.method === 'select' && String(f.args[0]).includes('call_rank'));
  const narrowSt = (code: string, o: { category?: string; requires_post_call_rule?: boolean } = {}) =>
    ({ code, category: o.category ?? 'derived', requires_post_call_rule: o.requires_post_call_rule ?? false });

  function degradedTables(o: { slots?: unknown[]; assignments?: unknown[] }): Record<string, TableCfg> {
    return {
      schedule_slots: (filters) => {
        if (wideSelected(filters)) return { data: null, error: MISSING_COL };
        return filters.some(f => f.method === 'eq' && f.args[0] === 'id')
          ? { data: {
              id: 'trig', site_id: 'siteA', slot_date: MON, derived_day_type: 'weekday',
              schedule_version_id: 'v1', shift_types: narrowSt('C2', { category: 'call' }),
            } }
          : { data: o.slots ?? [] };
      },
      assignments: (filters) => {
        if (filters.some(f => ['update', 'insert', 'upsert'].includes(f.method))) {
          return { data: [{}], error: null };
        }
        if (wideSelected(filters)) return { data: null, error: MISSING_COL };
        return { data: o.assignments ?? [], error: null };
      },
      provider_availability: { data: [] },
      call_patterns: { data: null },
    };
  }

  it('still fills C2→D1 via the narrow retry, with a degradation warning', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: degradedTables({
        slots: [{
          id: 'slot-d1-tue', site_id: 'siteA', slot_date: TUE, locked: false,
          shift_types: narrowSt('D1'), assignments: [openRow('open-1')],
        }],
      }),
    });
    const result = await applySequenceAutoFill(sb, 'trig', 'p1', CLASSIC_PATTERN);
    expect(result.filledSlotIds).toEqual(['slot-d1-tue']);
    expect(updates(calls)).toHaveLength(1);
    // Degradation is surfaced (deduped to one warning), never silent.
    const degraded = result.patternWarnings.filter(w => w.includes('apply patch18'));
    expect(degraded).toHaveLength(1);
    expect(degraded[0]).toMatch(/rank columns missing/);
  });

  it('cleanup still clears the linked auto-fill via the narrow retry', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: degradedTables({
        slots: [{
          id: 'slot-d1-tue', site_id: 'siteA', slot_date: TUE, locked: false,
          shift_types: narrowSt('D1'),
          assignments: [{ id: 'a-fill', provider_id: 'p1', assignment_status: 'assigned', source_type: 'auto_generated' }],
        }],
      }),
    });
    const result = await cleanupSequenceAutoFill(sb, 'trig', 'p1', CLASSIC_PATTERN);
    expect(result.clearedSlotIds).toEqual(['slot-d1-tue']);
    expect(updates(calls)).toHaveLength(1); // the revert-to-open write
    expect(result.patternWarnings.some(w => w.includes('apply patch18'))).toBe(true);
  });

  it('a non-column read error aborts loudly: warning returned, nothing filled, nothing silent', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cfg = degradedTables({
      slots: [{
        id: 'slot-d1-tue', site_id: 'siteA', slot_date: TUE, locked: false,
        shift_types: narrowSt('D1'), assignments: [openRow('open-1')],
      }],
    });
    // Trigger fetch works (narrow), but the assignments-window read fails hard.
    cfg.assignments = () => ({ data: null, error: { message: 'connection reset by peer' } });
    const { sb, calls } = makeFakeSupabase({ tables: cfg });
    const result = await applySequenceAutoFill(sb, 'trig', 'p1', CLASSIC_PATTERN);
    expect(result.filledSlotIds).toEqual([]);
    expect(callsFor(calls, 'assignments', 'update')).toHaveLength(0); // no writes
    expect(result.patternWarnings.some(w => w.includes('connection reset by peer'))).toBe(true);
    expect(err).toHaveBeenCalled();
  });
});
