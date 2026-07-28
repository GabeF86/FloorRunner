// slotCandidates — the manual-assignment picker's candidate classification.
//
// The picker component is not unit-testable (vitest runs environment:'node',
// no jsdom), so EVERY decision lives here and the component only renders what
// these functions return. Each blocker is tested independently, then together
// for precedence.
//
// Calendar anchors used throughout (UTC):
//   2026-01-05 Mon   2026-01-06 Tue   2026-01-09 Fri
//   2026-01-10 Sat   2026-01-11 Sun   2026-01-12 Mon
import { describe, it, expect } from 'vitest';
import {
  buildCandidateIndex, candidatesForSlot, filterCandidateGroups, overrideConfirmMessage,
  sequenceOwnedDayCodes,
  type CandidateAvailabilityRow, type CandidateCredentialRow, type CandidateProviderRow,
  type CandidateSlotRow, type CrossSiteBookingRow, type SlotCandidateGroups,
} from './slotCandidates';
import { CLASSIC_PATTERN, type CallPatternDoc } from './rulesEngine/callPattern';
import { WEEKEND_V2_PATTERN } from './rulesEngine/patterns/weekendV2';

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

function provider(id: string, over: Partial<CandidateProviderRow> = {}): CandidateProviderRow {
  return {
    id,
    short_display_name: id.toUpperCase(),
    initials: id.slice(0, 2).toUpperCase(),
    provider_type: 'physician',
    status: 'active',
    first_name: id,
    last_name: id,
    ...over,
  };
}

// The slot under test: a weekday C1 on Mon 2026-01-05.
function targetSlot(over: Partial<CandidateSlotRow> = {}): CandidateSlotRow {
  return {
    id: 'target',
    slot_date: '2026-01-05',
    derived_day_type: 'weekday',
    provider_group: 'both',
    shift_types: { code: 'C1', category: 'call', requires_post_call_rule: true },
    assignments: [],
    ...over,
  };
}

interface BuildOpts {
  providers?: CandidateProviderRow[];
  slots?: CandidateSlotRow[];
  availability?: CandidateAvailabilityRow[];
  profiles?: Array<{ provider_id: string; available_weekdays?: unknown }>;
  credentials?: CandidateCredentialRow[] | null;
  crossSite?: CrossSiteBookingRow[] | null;
  callPattern?: CallPatternDoc | null;
}

function classify(opts: BuildOpts = {}, slotId = 'target'): SlotCandidateGroups {
  const index = buildCandidateIndex({
    providers: opts.providers ?? [provider('p1')],
    profiles: opts.profiles ?? [],
    availability: opts.availability ?? [],
    slots: opts.slots ?? [targetSlot()],
    credentials: opts.credentials === undefined ? [] : opts.credentials,
    crossSite: opts.crossSite === undefined ? [] : opts.crossSite,
    // `in`, not `??` — an EXPLICIT null means "this site has no parsed pattern"
    // and must reach the index as null (it disables the day-shift release).
    callPattern: 'callPattern' in opts ? opts.callPattern : CLASSIC_PATTERN,
  });
  return candidatesForSlot(index, slotId);
}

const names = (list: SlotCandidateGroups[keyof SlotCandidateGroups]) =>
  (list as Array<{ provider: { id: string } }>).map(c => c.provider.id);

function pto(
  provider_id: string, start: string, end: string, approval_status = 'approved',
  availability_type = 'pto',
): CandidateAvailabilityRow {
  return { provider_id, availability_type, start_date: start, end_date: end, approval_status };
}

/* ── Baseline ─────────────────────────────────────────────────────────────── */

describe('baseline', () => {
  it('a clean provider lands in available with no reasons', () => {
    const g = classify();
    expect(names(g.available)).toEqual(['p1']);
    expect(g.soft).toEqual([]);
    expect(g.blocked).toEqual([]);
    expect(g.available[0].reasonText).toBe('');
    expect(g.available[0].hard).toEqual([]);
  });

  it('inactive providers are omitted entirely — not listed as blocked', () => {
    const g = classify({ providers: [provider('p1'), provider('gone', { status: 'inactive' })] });
    expect(names(g.available)).toEqual(['p1']);
    expect(names(g.blocked)).toEqual([]);
  });

  it('each group is sorted by display name', () => {
    const g = classify({
      providers: [
        provider('c', { short_display_name: 'Zylstra' }),
        provider('a', { short_display_name: 'Abbott' }),
        provider('b', { short_display_name: 'Mercier' }),
      ],
    });
    expect(g.available.map(c => c.provider.short_display_name)).toEqual(['Abbott', 'Mercier', 'Zylstra']);
  });

  it('an unknown slot id yields empty groups rather than throwing', () => {
    expect(classify({}, 'nope')).toEqual({ available: [], soft: [], blocked: [], unchecked: [] });
  });
});

/* ── Blocking availability — clinical invariant 2 ─────────────────────────── */

describe('blocking availability (invariant 2)', () => {
  it('APPROVED PTO covering the date hard-blocks', () => {
    const g = classify({ availability: [pto('p1', '2026-01-05', '2026-01-05')] });
    expect(names(g.blocked)).toEqual(['p1']);
    expect(g.blocked[0].hard).toEqual(['availability-blocked']);
    expect(g.blocked[0].reasonText).toContain('PTO');
  });

  // The invariant-2 nuance, stated three ways.
  it('PENDING PTO hard-blocks — a request awaiting approval is treated exactly like an approved one', () => {
    const g = classify({ availability: [pto('p1', '2026-01-05', '2026-01-05', 'pending')] });
    expect(names(g.blocked)).toEqual(['p1']);
    expect(g.blocked[0].hard).toContain('availability-blocked');
    expect(g.blocked[0].reasonText).toContain('(pending)');
  });

  it('DENIED PTO does not block', () => {
    const g = classify({ availability: [pto('p1', '2026-01-05', '2026-01-05', 'denied')] });
    expect(names(g.available)).toEqual(['p1']);
  });

  it('CANCELED PTO does not block', () => {
    const g = classify({ availability: [pto('p1', '2026-01-05', '2026-01-05', 'canceled')] });
    expect(names(g.available)).toEqual(['p1']);
  });

  it('a LIVE pto_sellback overrides an otherwise-blocking PTO row — the provider IS working', () => {
    const g = classify({
      availability: [
        pto('p1', '2026-01-05', '2026-01-09'),
        pto('p1', '2026-01-05', '2026-01-05', 'approved', 'pto_sellback'),
      ],
    });
    expect(names(g.available)).toEqual(['p1']);
    expect(g.blocked).toEqual([]);
  });

  it('a sell-back overrides even a PENDING PTO row (the override is date-level, not status-level)', () => {
    const g = classify({
      availability: [
        pto('p1', '2026-01-05', '2026-01-05', 'pending'),
        pto('p1', '2026-01-05', '2026-01-05', 'approved', 'pto_sellback'),
      ],
    });
    expect(names(g.available)).toEqual(['p1']);
  });

  it('a DENIED sell-back does not resurrect availability', () => {
    const g = classify({
      availability: [
        pto('p1', '2026-01-05', '2026-01-05'),
        pto('p1', '2026-01-05', '2026-01-05', 'denied', 'pto_sellback'),
      ],
    });
    expect(names(g.blocked)).toEqual(['p1']);
  });

  it('the PTO weekend bookend applies: PTO Mon 1/12–Fri 1/16 blocks the Sat 1/10 before it', () => {
    // effectivePtoRange extends a Monday start back 2 days.
    const g = classify({
      slots: [targetSlot({ slot_date: '2026-01-10', derived_day_type: 'saturday' })],
      availability: [pto('p1', '2026-01-12', '2026-01-16')],
    });
    expect(g.blocked[0].hard).toContain('availability-blocked');
  });

  it('every blocking type blocks (sick, fmla, jury_duty, unavailable, blocked, …)', () => {
    for (const type of ['sick', 'fmla', 'parental_leave', 'military_leave', 'jury_duty', 'unavailable', 'blocked']) {
      const g = classify({ availability: [pto('p1', '2026-01-05', '2026-01-05', 'approved', type)] });
      expect(names(g.blocked), type).toEqual(['p1']);
    }
  });
});

/* ── No-call requests — the SOFT one ──────────────────────────────────────── */

describe('no-call request softness', () => {
  it('a live no-call request lands in SOFT, never in blocked, and stays selectable', () => {
    const g = classify({
      availability: [pto('p1', '2026-01-05', '2026-01-07', 'approved', 'no_call_request')],
    });
    expect(names(g.soft)).toEqual(['p1']);
    expect(g.blocked).toEqual([]);
    expect(g.available).toEqual([]);
    expect(g.soft[0].hard).toEqual([]);          // no hard reason ⇒ freely selectable
    expect(g.soft[0].soft).toEqual(['no-call-request']);
    expect(g.soft[0].reasonText).toBe('Requested no call 1/5–1/7');
  });

  it('a PENDING no-call request is live and still only SOFT', () => {
    const g = classify({
      availability: [pto('p1', '2026-01-05', '2026-01-05', 'pending', 'no_call_request')],
    });
    expect(names(g.soft)).toEqual(['p1']);
    expect(g.blocked).toEqual([]);
  });

  it('a DENIED no-call request is ignored entirely', () => {
    const g = classify({
      availability: [pto('p1', '2026-01-05', '2026-01-05', 'denied', 'no_call_request')],
    });
    expect(names(g.available)).toEqual(['p1']);
  });

  // Validation scopes the soft flag to call-category slots; so does the picker.
  it('a no-call request does not flag a NON-call slot', () => {
    const g = classify({
      slots: [targetSlot({ shift_types: { code: 'D1', category: 'regular' } })],
      availability: [pto('p1', '2026-01-05', '2026-01-05', 'approved', 'no_call_request')],
    });
    expect(names(g.available)).toEqual(['p1']);
  });

  it('a contradictory live call_request cancels the no-call flag (solve treats the date as neither)', () => {
    const g = classify({
      availability: [
        pto('p1', '2026-01-05', '2026-01-05', 'approved', 'no_call_request'),
        pto('p1', '2026-01-05', '2026-01-05', 'approved', 'call_request'),
      ],
    });
    expect(names(g.available)).toEqual(['p1']);
    expect(g.soft).toEqual([]);
  });

  it('a no-call requester who is ALSO on PTO is hard-blocked, and both reasons are reported', () => {
    const g = classify({
      availability: [
        pto('p1', '2026-01-05', '2026-01-05'),
        pto('p1', '2026-01-05', '2026-01-05', 'approved', 'no_call_request'),
      ],
    });
    expect(names(g.blocked)).toEqual(['p1']);
    expect(g.blocked[0].soft).toEqual(['no-call-request']);
    expect(g.blocked[0].reasonTexts).toHaveLength(2);
  });
});

/* ── Post-call rest — clinical invariant 1 ────────────────────────────────── */

describe('post-call', () => {
  // CLASSIC_PATTERN: dayChain C1 on weekday/friday/holidays blocks offset +1.
  const c1Slot = (date: string, dayType = 'weekday'): CandidateSlotRow => ({
    id: 'call-' + date,
    slot_date: date,
    derived_day_type: dayType,
    provider_group: 'both',
    shift_types: { code: 'C1', category: 'call', requires_post_call_rule: true },
    assignments: [{ provider_id: 'p1' }],
  });

  it('a C1 the day before blocks the slot (pattern dayChain block offset +1)', () => {
    const g = classify({
      slots: [targetSlot({ slot_date: '2026-01-06' }), c1Slot('2026-01-05')],
    });
    expect(names(g.blocked)).toEqual(['p1']);
    expect(g.blocked[0].hard).toContain('post-call');
    expect(g.blocked[0].reasonText).toBe('Post-call after C1 on 1/5');
  });

  it('a C1 two days before does not block', () => {
    const g = classify({
      slots: [targetSlot({ slot_date: '2026-01-06' }), c1Slot('2026-01-04')],
    });
    expect(names(g.available)).toEqual(['p1']);
  });

  // THE pattern-driven proof: the block offset comes from the doc, not a
  // hardcoded −1. This doc blocks +2 and nothing else.
  it('the CALL PATTERN drives the offset — a doc blocking +2 blocks +2 and leaves +1 open', () => {
    const plusTwo: CallPatternDoc = {
      ...CLASSIC_PATTERN,
      dayChains: [{ trigger: 'CX', dayTypes: ['weekday'], blocks: [{ offset: 2 }] }],
    };
    const anchor: CandidateSlotRow = {
      id: 'anchor', slot_date: '2026-01-05', derived_day_type: 'weekday', provider_group: 'both',
      // requires_post_call_rule false so ONLY the pattern can produce a block.
      shift_types: { code: 'CX', category: 'call', requires_post_call_rule: false },
      assignments: [{ provider_id: 'p1' }],
    };
    const dayAfter = classify({
      callPattern: plusTwo, slots: [targetSlot({ slot_date: '2026-01-06' }), anchor],
    });
    expect(names(dayAfter.available)).toEqual(['p1']);   // +1 is NOT blocked

    const twoAfter = classify({
      callPattern: plusTwo, slots: [targetSlot({ slot_date: '2026-01-07' }), anchor],
    });
    expect(twoAfter.blocked[0].hard).toContain('post-call');
  });

  it('a code the pattern gives no block still blocks +1 when requires_post_call_rule is set', () => {
    // CLASSIC gives C2 a D1 FILL link on +1, not a block — but if the site
    // flags C2 as rest-requiring, the flag wins (dayShiftAutoGen's rule).
    const c2: CandidateSlotRow = {
      id: 'c2', slot_date: '2026-01-05', derived_day_type: 'weekday', provider_group: 'both',
      shift_types: { code: 'C2', category: 'call', requires_post_call_rule: true },
      assignments: [{ provider_id: 'p1' }],
    };
    const g = classify({ slots: [targetSlot({ slot_date: '2026-01-06' }), c2] });
    expect(g.blocked[0].hard).toContain('post-call');
  });

  it('a code with neither a pattern block nor the flag blocks nothing', () => {
    const c2: CandidateSlotRow = {
      id: 'c2', slot_date: '2026-01-05', derived_day_type: 'weekday', provider_group: 'both',
      shift_types: { code: 'C2', category: 'call', requires_post_call_rule: false },
      assignments: [{ provider_id: 'p1' }],
    };
    const g = classify({ slots: [targetSlot({ slot_date: '2026-01-06' }), c2] });
    expect(names(g.available)).toEqual(['p1']);
  });

  // Call splits (patch35 decision 3): rest belongs to the OVERNIGHT segment.
  it('an overnight SEGMENT inherits its parent code’s post-call block; a day segment confers none', () => {
    const seg = (code: string, rest: boolean): CandidateSlotRow => ({
      id: 'seg-' + code, slot_date: '2026-01-05', derived_day_type: 'weekday', provider_group: 'both',
      shift_types: { code, category: 'call', parent_call_code: 'C1', requires_post_call_rule: rest },
      assignments: [{ provider_id: 'p1' }],
    });
    const overnight = classify({ slots: [targetSlot({ slot_date: '2026-01-06' }), seg('C1N12', true)] });
    expect(overnight.blocked[0].hard).toContain('post-call');
    expect(overnight.blocked[0].reasonText).toBe('Post-call after C1N12 on 1/5');

    const daySeg = classify({ slots: [targetSlot({ slot_date: '2026-01-06' }), seg('C1D12', false)] });
    expect(names(daySeg.available)).toEqual(['p1']);
  });

  it('a rest-requiring call at ANOTHER site blocks the next day here (invariant 1 is provider-wide)', () => {
    const g = classify({
      slots: [targetSlot({ slot_date: '2026-01-06' })],
      crossSite: [{ provider_id: 'p1', slot_date: '2026-01-05', requires_post_call_rule: true }],
    });
    expect(g.blocked[0].hard).toContain('post-call');
    expect(g.blocked[0].reasonText).toBe('Post-call after call at another site on 1/5');
  });

  it('a NON-rest-requiring cross-site booking blocks its own date only', () => {
    const g = classify({
      slots: [targetSlot({ slot_date: '2026-01-06' })],
      crossSite: [{ provider_id: 'p1', slot_date: '2026-01-05', requires_post_call_rule: false }],
    });
    expect(names(g.available)).toEqual(['p1']);
  });
});

/* ── Same-date occupancy ──────────────────────────────────────────────────── */

describe('same-date', () => {
  const other = (over: Partial<CandidateSlotRow> = {}): CandidateSlotRow => ({
    id: 'other', slot_date: '2026-01-05', derived_day_type: 'weekday', provider_group: 'both',
    shift_types: { code: 'D1', category: 'regular' },
    assignments: [{ provider_id: 'p1' }],
    ...over,
  });

  it('an assignment in another slot the same date hard-blocks', () => {
    const g = classify({ slots: [targetSlot(), other()] });
    expect(names(g.blocked)).toEqual(['p1']);
    expect(g.blocked[0].hard).toContain('same-date');
    expect(g.blocked[0].reasonText).toBe('Already assigned 1/5');
  });

  it('the TARGET slot’s own occupant is not treated as a conflict with itself', () => {
    const g = classify({ slots: [targetSlot({ assignments: [{ provider_id: 'p1' }] })] });
    expect(names(g.available)).toEqual(['p1']);
  });

  it('an assignment on a different date does not block', () => {
    const g = classify({ slots: [targetSlot(), other({ slot_date: '2026-01-06' })] });
    expect(names(g.available)).toEqual(['p1']);
  });

  // overlayMayCoexist, consumed literally.
  it('an existing OVERLAY call coexists with an incoming regular day shift', () => {
    const g = classify({
      slots: [
        targetSlot({ shift_types: { code: 'D4', category: 'regular' } }),
        other({ shift_types: { code: 'C3', category: 'call', is_overlay: true } }),
      ],
    });
    expect(names(g.available)).toEqual(['p1']);
  });

  it('an incoming OVERLAY call coexists with an existing regular day shift', () => {
    const g = classify({
      slots: [
        targetSlot({ shift_types: { code: 'C3', category: 'call', is_overlay: true } }),
        other({ shift_types: { code: 'D4', category: 'regular' } }),
      ],
    });
    expect(names(g.available)).toEqual(['p1']);
  });

  it('two calls never stack, even when one is an overlay', () => {
    const g = classify({
      slots: [
        targetSlot(), // C1, call
        other({ shift_types: { code: 'C3', category: 'call', is_overlay: true } }),
      ],
    });
    expect(g.blocked[0].hard).toContain('same-date');
  });

  it('a missing is_overlay reads as non-overlay (the conservative pre-patch reading)', () => {
    const g = classify({
      slots: [
        targetSlot({ shift_types: { code: 'D4', category: 'regular' } }),
        other({ shift_types: { code: 'C3', category: 'call' } }),
      ],
    });
    expect(g.blocked[0].hard).toContain('same-date');
  });
});

/* ── Day-shift release (2026-07-28) ───────────────────────────────────────── */
//
// "anyone in a D4 and up slot on a day that has an empty call slot, they should
// not be placed in the unavailable list, they are technically available to be
// placed on call that day and taken out of the D spot" — Gabriel.
//
// The "D4 and up" boundary is DERIVED from the pattern, never named.

describe('sequenceOwnedDayCodes', () => {
  it('resolves Paoli (weekendV2) to exactly D1, D2, D3', () => {
    expect([...sequenceOwnedDayCodes(WEEKEND_V2_PATTERN)].sort()).toEqual(['D1', 'D2', 'D3']);
  });

  it('resolves CLASSIC to the same three', () => {
    expect([...sequenceOwnedDayCodes(CLASSIC_PATTERN)].sort()).toEqual(['D1', 'D2', 'D3']);
  });

  // THE TRAP. weekendV2's saturday C3 block chain links '−1 D4' and its
  // saturday C1 block chain links '−1 D2'. Block chains are the weekend's
  // designed shape, not the call sequence's derived fills — reading doc.blocks
  // would make D4 sequence-owned and re-block exactly the code Gabriel named.
  it('IGNORES block-chain links — D4 appears in doc.blocks and is still FREE', () => {
    const blockLinkCodes = WEEKEND_V2_PATTERN.blocks
      .flatMap(b => b.chains).flatMap(c => c.links).map(l => l.code);
    expect(blockLinkCodes).toContain('D4');          // it really is in there
    expect(sequenceOwnedDayCodes(WEEKEND_V2_PATTERN).has('D4')).toBe(false);
  });

  it('a pattern with no dayChain links owns nothing', () => {
    expect(sequenceOwnedDayCodes({ ...CLASSIC_PATTERN, dayChains: [] }).size).toBe(0);
  });
});

describe('day-shift release', () => {
  // An ordinary day shift held by p1 on the target date, with a persisted id.
  const dayShift = (code: string, over: Partial<CandidateSlotRow> = {}): CandidateSlotRow => ({
    id: 'day-' + code,
    slot_date: '2026-01-05',
    derived_day_type: 'weekday',
    provider_group: 'both',
    shift_types: { code, category: 'regular' },
    assignments: [{ id: 'a-' + code, provider_id: 'p1' }],
    ...over,
  });

  it('a doc on D6 is AVAILABLE for that day’s call and carries the day-shift detail', () => {
    const g = classify({ slots: [targetSlot(), dayShift('D6')] });
    expect(names(g.available)).toEqual(['p1']);
    expect(g.blocked).toEqual([]);
    expect(g.available[0].hard).toEqual([]);
    expect(g.available[0].release).toEqual({
      shifts: [{ assignmentId: 'a-D6', slotId: 'day-D6', code: 'D6' }],
      text: 'Currently on D6 — will be moved to C1',
    });
  });

  it('names the TARGET call code in the sentence, not a generic word', () => {
    const g = classify({
      slots: [
        targetSlot({ shift_types: { code: 'C2', category: 'call', requires_post_call_rule: true } }),
        dayShift('D9'),
      ],
    });
    expect(g.available[0].release?.text).toBe('Currently on D9 — will be moved to C2');
  });

  it.each(['D1', 'D2', 'D3'])('a doc on %s stays hard-blocked — the call sequence owns it', code => {
    const g = classify({ slots: [targetSlot(), dayShift(code)] });
    expect(names(g.blocked)).toEqual(['p1']);
    expect(g.blocked[0].hard).toEqual(['same-date']);
    expect(g.blocked[0].reasonText).toBe('Already assigned 1/5');
    expect(g.blocked[0].release).toBeNull();
  });

  it('a doc on another CALL that day stays hard-blocked', () => {
    const g = classify({
      slots: [targetSlot(), dayShift('C2', {
        shift_types: { code: 'C2', category: 'call', requires_post_call_rule: false },
      })],
    });
    expect(names(g.blocked)).toEqual(['p1']);
    expect(g.blocked[0].hard).toEqual(['same-date']);
    expect(g.blocked[0].release).toBeNull();
  });

  // Relaxing same-date must not relax anything else.
  it('a doc on D6 who is ALSO on PTO stays hard-blocked', () => {
    const g = classify({
      slots: [targetSlot(), dayShift('D6')],
      availability: [pto('p1', '2026-01-05', '2026-01-05')],
    });
    expect(names(g.blocked)).toEqual(['p1']);
    expect(g.blocked[0].hard).toEqual(['availability-blocked']);   // same-date is gone…
    expect(g.blocked[0].release).not.toBeNull();                   // …but the move still applies
  });

  const otherBlockers: Array<[string, BuildOpts, string]> = [
    ['post-call', { crossSite: [{ provider_id: 'p1', slot_date: '2026-01-04', requires_post_call_rule: true }] }, 'post-call'],
    ['cross-site', { crossSite: [{ provider_id: 'p1', slot_date: '2026-01-05' }] }, 'cross-site'],
    ['credential', { credentials: [{ provider_id: 'p1', is_active: true, credentialed: true, can_take_call: false }] }, 'credential'],
    ['weekday', { profiles: [{ provider_id: 'p1', available_weekdays: [true, false, true, true, true, true, true] }] }, 'weekday-unavailable'],
  ];
  it.each(otherBlockers)('a doc on D6 blocked by %s is still blocked', (_label, extra, reason) => {
    const g = classify({ slots: [targetSlot(), dayShift('D6')], ...extra });
    expect(names(g.blocked)).toEqual(['p1']);
    expect(g.blocked[0].hard).toContain(reason);
    expect(g.blocked[0].hard).not.toContain('same-date');
  });

  // No pattern ⇒ no way to tell sequence-owned from free ⇒ do not guess.
  it('a NULL call pattern hard-blocks D6 exactly as before', () => {
    const g = classify({ callPattern: null, slots: [targetSlot(), dayShift('D6')] });
    expect(names(g.blocked)).toEqual(['p1']);
    expect(g.blocked[0].hard).toEqual(['same-date']);
    expect(g.blocked[0].release).toBeNull();
  });

  // Call slots only: pulling someone off one day shift to put them in another
  // is not what was asked for, and has no call-coverage justification.
  it('the relaxation does NOT apply when the TARGET is a day shift', () => {
    const g = classify({
      slots: [
        targetSlot({ shift_types: { code: 'D7', category: 'regular' } }),
        dayShift('D6'),
      ],
    });
    expect(names(g.blocked)).toEqual(['p1']);
    expect(g.blocked[0].hard).toEqual(['same-date']);
    expect(g.blocked[0].release).toBeNull();
  });

  // All-or-nothing: one un-releasable collision and the whole block stands.
  it('a doc on D6 AND another call is hard-blocked — the release is all-or-nothing', () => {
    const g = classify({
      slots: [
        targetSlot(),
        dayShift('D6'),
        dayShift('C2', {
          id: 'other-call',
          shift_types: { code: 'C2', category: 'call', requires_post_call_rule: false },
        }),
      ],
    });
    expect(names(g.blocked)).toEqual(['p1']);
    expect(g.blocked[0].hard).toEqual(['same-date']);
    expect(g.blocked[0].release).toBeNull();
  });

  it('two ordinary day shifts are both released and both named', () => {
    const g = classify({ slots: [targetSlot(), dayShift('D6'), dayShift('D7')] });
    expect(names(g.available)).toEqual(['p1']);
    expect(g.available[0].release?.shifts.map(s => s.code)).toEqual(['D6', 'D7']);
    expect(g.available[0].release?.text).toBe('Currently on D6, D7 — will be moved to C1');
  });

  // An unsaved optimistic row cannot be cleared by id: the DELETE would match
  // nothing and no-op, leaving the double-booking the release exists to avoid.
  it('an UNSAVED (temp-) day-shift row is not releasable', () => {
    const g = classify({
      slots: [targetSlot(), dayShift('D6', { assignments: [{ id: 'temp-1769000000000', provider_id: 'p1' }] })],
    });
    expect(g.blocked[0].hard).toEqual(['same-date']);
    expect(g.blocked[0].release).toBeNull();
  });

  it('a day-shift row with NO id is not releasable', () => {
    const g = classify({
      slots: [targetSlot(), dayShift('D6', { assignments: [{ provider_id: 'p1' }] })],
    });
    expect(g.blocked[0].hard).toEqual(['same-date']);
    expect(g.blocked[0].release).toBeNull();
  });

  it('an occupied slot with NO shift type is not releasable (its code is unknowable)', () => {
    const g = classify({
      slots: [targetSlot(), dayShift('D6', { shift_types: null })],
    });
    expect(g.blocked[0].hard).toEqual(['same-date']);
    expect(g.blocked[0].release).toBeNull();
  });

  it('a doc with no same-date assignment at all carries a NULL release', () => {
    expect(classify().available[0].release).toBeNull();
  });

  it('a released doc who also requested no call is SOFT, and both lines survive', () => {
    const g = classify({
      slots: [targetSlot(), dayShift('D6')],
      availability: [pto('p1', '2026-01-05', '2026-01-05', 'approved', 'no_call_request')],
    });
    expect(names(g.soft)).toEqual(['p1']);
    expect(g.soft[0].reasonText).toBe('Requested no call 1/5');
    expect(g.soft[0].release?.text).toBe('Currently on D6 — will be moved to C1');
  });

  // End-to-end on the pattern actually live at Paoli.
  describe('against the live Paoli pattern', () => {
    const paoli = (slots: CandidateSlotRow[]) =>
      classify({ callPattern: WEEKEND_V2_PATTERN, slots });

    it('D4 — a block-chain link, but not sequence-owned — is released', () => {
      const g = paoli([targetSlot(), dayShift('D4')]);
      expect(names(g.available)).toEqual(['p1']);
      expect(g.available[0].release?.shifts[0].code).toBe('D4');
    });

    it('D2 — created by the C1 dayChain — is not', () => {
      const g = paoli([targetSlot(), dayShift('D2')]);
      expect(names(g.blocked)).toEqual(['p1']);
      expect(g.blocked[0].hard).toEqual(['same-date']);
    });
  });
});

/* ── Cross-site — clinical invariant 3 ────────────────────────────────────── */

describe('cross-site', () => {
  it('a published booking at another site on the slot date hard-blocks', () => {
    const g = classify({ crossSite: [{ provider_id: 'p1', slot_date: '2026-01-05' }] });
    expect(names(g.blocked)).toEqual(['p1']);
    expect(g.blocked[0].hard).toContain('cross-site');
    expect(g.blocked[0].reasonText).toBe('Booked at another site');
  });

  it('a booking on a neighbouring date does not block the slot date', () => {
    const g = classify({ crossSite: [{ provider_id: 'p1', slot_date: '2026-01-07' }] });
    expect(names(g.available)).toEqual(['p1']);
  });

  it('crossSite null means UNCHECKED — the caller is told, not silently reassured', () => {
    const g = classify({ crossSite: null });
    expect(names(g.available)).toEqual(['p1']);
    expect(g.unchecked.join(' ')).toContain('Cross-site');
  });
});

/* ── Site credentials ─────────────────────────────────────────────────────── */

describe('credentials', () => {
  const cred = (over: Partial<CandidateCredentialRow> = {}): CandidateCredentialRow => ({
    provider_id: 'p1',
    is_active: true, credentialed: true,
    can_take_call: true, can_take_weekend_call: true, can_take_holiday_call: true,
    allowed_shift_types: [], excluded_shift_types: [],
    ...over,
  });

  it('a fully credentialed provider passes', () => {
    expect(names(classify({ credentials: [cred()] }).available)).toEqual(['p1']);
  });

  it('NO credential row = not yet configured = passes', () => {
    expect(names(classify({ credentials: [] }).available)).toEqual(['p1']);
  });

  it.each([
    ['is_active false', { is_active: false }, 'Not active at this site'],
    ['credentialed false', { credentialed: false }, 'Not credentialed at this site'],
    ['code excluded', { excluded_shift_types: ['C1'] }, 'Not credentialed for C1'],
    ['code not in a non-empty allow-list', { allowed_shift_types: ['C2'] }, 'Not credentialed for C1'],
    ['cannot take call', { can_take_call: false }, 'Not cleared to take call'],
  ])('%s hard-blocks', (_label, over, message) => {
    const g = classify({ credentials: [cred(over)] });
    expect(g.blocked[0].hard).toContain('credential');
    expect(g.blocked[0].reasonText).toBe(message);
  });

  it('an allow-list containing the code passes', () => {
    expect(names(classify({ credentials: [cred({ allowed_shift_types: ['C1', 'C2'] })] }).available)).toEqual(['p1']);
  });

  it('weekend-call clearance only binds on saturday/sunday call slots', () => {
    const weekday = classify({ credentials: [cred({ can_take_weekend_call: false })] });
    expect(names(weekday.available)).toEqual(['p1']);
    const saturday = classify({
      slots: [targetSlot({ slot_date: '2026-01-10', derived_day_type: 'saturday' })],
      credentials: [cred({ can_take_weekend_call: false })],
    });
    expect(saturday.blocked[0].reasonText).toBe('Not cleared for weekend call');
  });

  it('holiday-call clearance binds on the holiday day types', () => {
    const g = classify({
      slots: [targetSlot({ derived_day_type: 'federal_holiday' })],
      credentials: [cred({ can_take_holiday_call: false })],
    });
    expect(g.blocked[0].reasonText).toBe('Not cleared for holiday call');
  });

  it('call-only clearances are ignored for a non-call slot', () => {
    const g = classify({
      slots: [targetSlot({ shift_types: { code: 'D1', category: 'regular' } })],
      credentials: [cred({ can_take_call: false })],
    });
    expect(names(g.available)).toEqual(['p1']);
  });

  it('credentials null means UNCHECKED and says so', () => {
    const g = classify({ credentials: null });
    expect(names(g.available)).toEqual(['p1']);
    expect(g.unchecked.join(' ')).toContain('credentials');
  });
});

/* ── Weekday availability ─────────────────────────────────────────────────── */

describe('weekday availability', () => {
  // Index is Sun..Sat; 2026-01-05 is a Monday (index 1).
  it('a provider who does not work Mondays is blocked on a Monday slot', () => {
    const g = classify({
      profiles: [{ provider_id: 'p1', available_weekdays: [true, false, true, true, true, true, true] }],
    });
    expect(g.blocked[0].hard).toContain('weekday-unavailable');
    expect(g.blocked[0].reasonText).toBe('Does not work Mondays');
  });

  it('the same provider is fine on a Tuesday slot', () => {
    const g = classify({
      slots: [targetSlot({ slot_date: '2026-01-06' })],
      profiles: [{ provider_id: 'p1', available_weekdays: [true, false, true, true, true, true, true] }],
    });
    expect(names(g.available)).toEqual(['p1']);
  });

  it('a null/malformed available_weekdays coerces to all-true (no profile ⇒ no restriction)', () => {
    expect(names(classify({ profiles: [{ provider_id: 'p1', available_weekdays: null }] }).available)).toEqual(['p1']);
    expect(names(classify({ profiles: [{ provider_id: 'p1' }] }).available)).toEqual(['p1']);
    expect(names(classify({ profiles: [] }).available)).toEqual(['p1']);
  });
});

/* ── Provider group ───────────────────────────────────────────────────────── */

describe('provider group', () => {
  it('a physician slot blocks a CRNA', () => {
    const g = classify({
      slots: [targetSlot({ provider_group: 'physician' })],
      providers: [provider('p1', { provider_type: 'crna' })],
    });
    expect(g.blocked[0].hard).toContain('group-mismatch');
    expect(g.blocked[0].reasonText).toBe('CRNA — this slot is for physicians');
  });

  it('a crna slot admits crna and aa, blocks a physician', () => {
    const g = classify({
      slots: [targetSlot({ provider_group: 'crna' })],
      providers: [
        provider('c', { provider_type: 'crna' }),
        provider('a', { provider_type: 'aa' }),
        provider('d', { provider_type: 'physician' }),
      ],
    });
    expect(names(g.available).sort()).toEqual(['a', 'c']);
    expect(names(g.blocked)).toEqual(['d']);
  });

  it("provider_group 'both' (or absent) admits everyone", () => {
    const providers = [provider('c', { provider_type: 'crna' }), provider('d')];
    expect(names(classify({ providers, slots: [targetSlot({ provider_group: 'both' })] }).available).sort())
      .toEqual(['c', 'd']);
    expect(names(classify({ providers, slots: [targetSlot({ provider_group: null })] }).available).sort())
      .toEqual(['c', 'd']);
  });
});

/* ── Weekend adjacent-week PTO (advisory) ─────────────────────────────────── */

describe('weekend adjacent-week PTO', () => {
  it('planned leave the week after a Saturday slot is SOFT, not hard', () => {
    const g = classify({
      slots: [targetSlot({ slot_date: '2026-01-10', derived_day_type: 'saturday' })],
      // Mon 1/12 – Wed 1/14, the week AFTER Sat 1/10. Bookended back to Sat 1/10
      // by effectivePtoRange, so this is ALSO an availability block — use a
      // Tuesday start so only the adjacency rule fires.
      availability: [pto('p1', '2026-01-13', '2026-01-14')],
    });
    expect(names(g.soft)).toEqual(['p1']);
    expect(g.blocked).toEqual([]);
    expect(g.soft[0].soft).toEqual(['weekend-adjacent-pto']);
  });

  it('the adjacency flag never fires on a weekday slot', () => {
    const g = classify({ availability: [pto('p1', '2026-01-13', '2026-01-14')] });
    expect(names(g.available)).toEqual(['p1']);
  });

  it('a single sick day in the adjacent week does not extend (bookend-extending types only)', () => {
    const g = classify({
      slots: [targetSlot({ slot_date: '2026-01-10', derived_day_type: 'saturday' })],
      availability: [pto('p1', '2026-01-13', '2026-01-13', 'approved', 'sick')],
    });
    expect(names(g.available)).toEqual(['p1']);
  });
});

/* ── Precedence when several blockers apply ───────────────────────────────── */

describe('precedence', () => {
  it('reports every applicable reason, PTO leading', () => {
    const g = classify({
      slots: [
        targetSlot({ provider_group: 'physician' }),
        {
          id: 'other', slot_date: '2026-01-05', derived_day_type: 'weekday', provider_group: 'both',
          shift_types: { code: 'D1', category: 'regular' }, assignments: [{ provider_id: 'p1' }],
        },
      ],
      providers: [provider('p1', { provider_type: 'crna' })],
      availability: [pto('p1', '2026-01-05', '2026-01-05', 'pending')],
      credentials: [{ provider_id: 'p1', is_active: false }],
      crossSite: [{ provider_id: 'p1', slot_date: '2026-01-05' }],
      profiles: [{ provider_id: 'p1', available_weekdays: [true, false, true, true, true, true, true] }],
    });
    expect(g.blocked[0].hard).toEqual([
      'availability-blocked', 'same-date', 'cross-site',
      'credential', 'weekday-unavailable', 'group-mismatch',
    ]);
    expect(g.blocked[0].reasonText).toContain('PTO');
    expect(g.blocked[0].reasonTexts).toHaveLength(6);
  });

  it('post-call leads when there is no PTO', () => {
    const g = classify({
      slots: [
        targetSlot({ slot_date: '2026-01-06' }),
        {
          id: 'c1', slot_date: '2026-01-05', derived_day_type: 'weekday', provider_group: 'both',
          shift_types: { code: 'C1', category: 'call', requires_post_call_rule: true },
          assignments: [{ provider_id: 'p1' }],
        },
      ],
      crossSite: [{ provider_id: 'p1', slot_date: '2026-01-06' }],
    });
    expect(g.blocked[0].hard).toEqual(['post-call', 'cross-site']);
    expect(g.blocked[0].reasonText).toContain('Post-call');
  });

  it('any hard reason outranks a soft one — the candidate is blocked, not soft', () => {
    const g = classify({
      availability: [
        pto('p1', '2026-01-05', '2026-01-05', 'approved', 'no_call_request'),
      ],
      crossSite: [{ provider_id: 'p1', slot_date: '2026-01-05' }],
    });
    expect(g.blocked[0].group).toBe('blocked');
    expect(g.blocked[0].soft).toEqual(['no-call-request']);
  });
});

/* ── Search + override message ────────────────────────────────────────────── */

describe('filterCandidateGroups', () => {
  const groups = () => classify({
    providers: [
      provider('a', { short_display_name: 'Okonkwo', first_name: 'Sade', last_name: 'Okonkwo', initials: 'SO' }),
      provider('b', { short_display_name: 'Mercier', first_name: 'Luc', last_name: 'Mercier', initials: 'LM' }),
    ],
  });

  it('an empty query returns the groups unchanged (identity)', () => {
    const g = groups();
    expect(filterCandidateGroups(g, '')).toBe(g);
    expect(filterCandidateGroups(g, '   ')).toBe(g);
  });

  it('matches display name, first, last and initials, case-insensitively', () => {
    expect(names(filterCandidateGroups(groups(), 'okon').available)).toEqual(['a']);
    expect(names(filterCandidateGroups(groups(), 'LUC').available)).toEqual(['b']);
    expect(names(filterCandidateGroups(groups(), 'lm').available)).toEqual(['b']);
  });

  it('filters the blocked group too, and preserves the unchecked notices', () => {
    const g = classify({
      providers: [provider('a', { short_display_name: 'Okonkwo' }), provider('b', { short_display_name: 'Mercier' })],
      availability: [pto('a', '2026-01-05', '2026-01-05')],
      crossSite: null,
    });
    const f = filterCandidateGroups(g, 'okon');
    expect(names(f.blocked)).toEqual(['a']);
    expect(names(f.available)).toEqual([]);
    expect(f.unchecked).toEqual(g.unchecked);
  });
});

describe('overrideConfirmMessage', () => {
  it('names the provider and every reason', () => {
    const g = classify({
      providers: [provider('p1', { short_display_name: 'G. Amusa' })],
      availability: [pto('p1', '2026-01-05', '2026-01-09')],
      crossSite: [{ provider_id: 'p1', slot_date: '2026-01-05' }],
    });
    const msg = overrideConfirmMessage(g.blocked[0]);
    expect(msg).toContain('G. Amusa');
    expect(msg).toContain('On PTO 1/5–1/9');
    expect(msg).toContain('Booked at another site');
    expect(msg).toContain('Assign anyway?');
  });

  it('a release survives the override and is stated in the confirm', () => {
    const g = classify({
      providers: [provider('p1', { short_display_name: 'G. Amusa' })],
      slots: [
        targetSlot(),
        {
          id: 'day-D6', slot_date: '2026-01-05', derived_day_type: 'weekday', provider_group: 'both',
          shift_types: { code: 'D6', category: 'regular' },
          assignments: [{ id: 'a-D6', provider_id: 'p1' }],
        },
      ],
      availability: [pto('p1', '2026-01-05', '2026-01-05')],
    });
    const msg = overrideConfirmMessage(g.blocked[0]);
    expect(msg).toContain('On PTO 1/5');
    expect(msg).toContain('Currently on D6 — will be moved to C1.');
  });

  it('says nothing about a move when there is none', () => {
    const g = classify({ availability: [pto('p1', '2026-01-05', '2026-01-05')] });
    expect(overrideConfirmMessage(g.blocked[0])).not.toContain('will be moved');
  });
});
