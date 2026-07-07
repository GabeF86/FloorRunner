import { describe, it, expect } from 'vitest';
import { solve } from './solve';
import { patternWarnings } from './callPattern';
import {
  buildCtx, prov, callSlot, dSlot, cred, shiftInfo,
} from './__fixtures__/buildContext';
import type { CallPatternDoc } from './callPattern';
import type { SeedAssignment, ShiftTypeInfo } from './genTypes';

// The proposed weekend structure from spec §5.3 — proof of expressiveness.
const PROPOSED: CallPatternDoc = {
  version: 1,
  blocks: [{ anchorDayType: 'friday', chains: [
    { trigger: 'C1', links: [{ offset: 2, code: 'C2' }] },
    { trigger: 'C2', links: [{ offset: 1, code: 'C2' }] },
  ] }],
  dayChains: [
    { trigger: 'C1', dayTypes: ['friday', 'saturday', 'sunday'], blocks: [{ offset: 1 }] },
    { trigger: 'C2', dayTypes: ['sunday'], links: [{ offset: 1, code: 'D1' }] },
  ],
  spans: [{ code: 'NB', anchorDayType: 'friday', offsets: [0, 1, 2] }],
  placementPasses: [],
  reliefPass: { enabled: true, dayTypes: ['weekday'] },
  optimizerMovableDayTypes: ['weekday'],
};

// ── 1. IF-1: a seeded C1 blocks its post-call day before solve runs ──────────
describe('patternEngine — IF-1 seed post-call block', () => {
  it('does not give the seeded-C1 provider the next-day call they would win by score', () => {
    const seed: SeedAssignment = {
      slot_date: '2026-01-12', provider_id: 'p01', shift_type_code: 'C1',
      shift_type_category: 'call', derived_day_type: 'weekday',
    };
    const tueC2 = callSlot('tueC2', '2026-01-13', 'C2', 'weekday');
    const plan = solve(buildCtx([tueC2], [prov('p01'), prov('p02')], { seedAssignments: [seed] }));
    // p01 (lower id, 0 in weekday|C2) would win by score, but is blocked Tuesday.
    expect(plan.assignments.find(a => a.slot_id === 'tueC2')?.provider_id).toBe('p02');
    expect(plan.assignments.some(a => a.provider_id === 'p01' && a.slot_date === '2026-01-13')).toBe(false);
  });
});

// ── 2. IF-4: suppressed derived placements are recorded, never dropped ───────
describe('patternEngine — IF-4 skippedDerived', () => {
  it('records a D1 that a PTO conflict suppressed and leaves the slot unassigned', () => {
    const monC2 = callSlot('monC2', '2026-01-05', 'C2', 'weekday'); // Mon
    const tueD1 = dSlot('tueD1', '2026-01-06', 'D1', 'weekday');     // Tue
    const ctx = buildCtx([monC2, tueD1], [prov('p1')], {
      availByPid: new Map([['p1', [{
        availability_type: 'pto', start_date: '2026-01-06', end_date: '2026-01-06',
        approval_status: 'approved',
      }]]]),
    });
    const plan = solve(ctx);
    expect(plan.skippedDerived).toContainEqual({
      date: '2026-01-06', code: 'D1', provider_id: 'p1', reason: 'pto',
    });
    expect(plan.assignments.some(a => a.slot_id === 'tueD1')).toBe(false);
  });
});

// ── 3. IF-2: relief pass fixes (D6+ reachability, per-code rescan) ───────────
describe('patternEngine — IF-2 relief fixes', () => {
  it('fills relief on a date whose only open relief slots are D6/D7 (no D4/D5)', () => {
    const d6 = dSlot('d6', '2026-01-07', 'D6', 'weekday');
    const d7 = dSlot('d7', '2026-01-07', 'D7', 'weekday');
    const plan = solve(buildCtx([d6, d7], [prov('pA'), prov('pB')]));
    expect(plan.assignments.find(a => a.slot_id === 'd6')?.source).toBe('relief-order');
    expect(plan.assignments.find(a => a.slot_id === 'd7')?.source).toBe('relief-order');
  });

  it('reconsiders (rescans) a provider excluded from D5 for the later D6 slot', () => {
    // Legacy forward-cursor skips pB permanently after D5; v2 rescans from rank 0.
    const d4 = dSlot('d4', '2026-01-07', 'D4', 'weekday');
    const d5 = dSlot('d5', '2026-01-07', 'D5', 'weekday');
    const d6 = dSlot('d6', '2026-01-07', 'D6', 'weekday');
    const ctx = buildCtx([d4, d5, d6], [prov('pA'), prov('pB'), prov('pC')], {
      credByPid: new Map([['pB', cred({ excluded_shift_types: ['D5'] })]]),
    });
    const plan = solve(ctx);
    // pA→D4, pC→D5 (pB skipped), pB→D6 (reconsidered). D6 must NOT be dropped.
    expect(plan.assignments.find(a => a.slot_id === 'd6')?.provider_id).toBe('pB');
    expect(plan.assignments.find(a => a.slot_id === 'd5')?.provider_id).toBe('pC');
  });
});

// ── 4. IF-3: quota relaxation rather than stranding a call slot ──────────────
describe('patternEngine — IF-3 quota relaxation', () => {
  it('assigns a call slot when every candidate fails only on bucket-quota', () => {
    const c1 = callSlot('c1', '2026-01-07', 'C1', 'weekday');
    const ctx = buildCtx([c1], [prov('pA'), prov('pB')], {
      bucketTarget: new Map([['pA|weekday|C1', 0.5], ['pB|weekday|C1', 0.5]]),
    });
    const plan = solve(ctx);
    const a = plan.assignments.find(x => x.slot_id === 'c1');
    expect(a?.provider_id).toBe('pA');            // lowest lifetime ratio (tie → id)
    expect(a?.source).toBe('quota-relaxed');
    expect(a?.explanation).toBeDefined();
    expect(plan.unfilled.some(u => u.slot_id === 'c1')).toBe(false);
  });
});

// ── 5. NEW STRUCTURE (spec §5.3): the proposed weekend doc ───────────────────
describe('patternEngine — new weekend structure (block chains + spans + dayChains)', () => {
  it('interprets the proposed friday-anchored pattern end to end', () => {
    const slots = [
      callSlot('friC1', '2026-01-02', 'C1', 'friday'),
      callSlot('friC2', '2026-01-02', 'C2', 'friday'),
      callSlot('satC1', '2026-01-03', 'C1', 'saturday'),
      callSlot('satC2', '2026-01-03', 'C2', 'saturday'),
      callSlot('sunC1', '2026-01-04', 'C1', 'sunday'),
      callSlot('sunC2', '2026-01-04', 'C2', 'sunday'),
      callSlot('nbFri', '2026-01-02', 'NB', 'friday'),
      callSlot('nbSat', '2026-01-03', 'NB', 'saturday'),
      callSlot('nbSun', '2026-01-04', 'NB', 'sunday'),
      dSlot('monD1', '2026-01-05', 'D1', 'weekday'),
    ];
    const providers = ['p01', 'p02', 'p03', 'p04', 'p05', 'p06'].map(id => prov(id));
    const plan = solve(buildCtx(slots, providers, { callPattern: PROPOSED }));

    // NB span: fri/sat/sun all one provider, source 'span'.
    const nb = plan.assignments.filter(a => a.shift_type_code === 'NB');
    expect(nb).toHaveLength(3);
    expect(new Set(nb.map(a => a.provider_id)).size).toBe(1);
    expect(nb.every(a => a.source === 'span')).toBe(true);
    const nbProvider = nb[0].provider_id;

    // Fri-C1 winner also takes Sun-C2 (offset-2 block chain).
    const friC1 = plan.assignments.find(a => a.slot_id === 'friC1')!;
    const sunC2 = plan.assignments.find(a => a.slot_id === 'sunC2')!;
    expect(sunC2.provider_id).toBe(friC1.provider_id);
    expect(sunC2.source).toBe('weekend-chain');

    // Sun-C2 winner gets Mon-D1 (dayChain link off the chained C2).
    const monD1 = plan.assignments.find(a => a.slot_id === 'monD1')!;
    expect(monD1.provider_id).toBe(sunC2.provider_id);
    expect(monD1.source).toBe('d-chain');

    // Every C1 night is followed by a blocked day for that provider.
    const addDay = (d: string) => new Date(new Date(d + 'T00:00:00Z').getTime() + 86400000).toISOString().slice(0, 10);
    for (const a of plan.assignments.filter(x => x.shift_type_code === 'C1')) {
      const next = addDay(a.slot_date);
      expect(plan.assignments.some(x => x.provider_id === a.provider_id && x.slot_date === next)).toBe(false);
    }

    // NB provider holds nothing else those days (non-overlay same-date budget).
    const nbDates = new Set(nb.map(a => a.slot_date));
    const nbOther = plan.assignments.filter(
      a => a.provider_id === nbProvider && a.shift_type_code !== 'NB' && nbDates.has(a.slot_date));
    expect(nbOther).toHaveLength(0);
  });
});

// ── 6. Overlay: is_overlay skips the one-per-day budget in both directions ───
describe('patternEngine — overlay shift type', () => {
  it('lets the overlay-NB provider also hold a non-overlay slot the same day', () => {
    const pattern: CallPatternDoc = {
      version: 1, blocks: [],
      dayChains: [{ trigger: 'NB', dayTypes: ['friday'], links: [{ offset: 1, code: 'D2' }] }],
      spans: [{ code: 'NB', anchorDayType: 'friday', offsets: [0, 1, 2] }],
      placementPasses: [], reliefPass: null, optimizerMovableDayTypes: [],
    };
    const shiftTypes = new Map<string, ShiftTypeInfo>([
      ['NB', shiftInfo('NB', { category: 'call', call_rank: 0, is_overlay: true })],
      ['D2', shiftInfo('D2', { category: 'regular' })],
    ]);
    const slots = [
      callSlot('nbFri', '2026-01-02', 'NB', 'friday'),
      callSlot('nbSat', '2026-01-03', 'NB', 'saturday'),
      callSlot('nbSun', '2026-01-04', 'NB', 'sunday'),
      dSlot('satD2', '2026-01-03', 'D2', 'saturday'),
    ];
    const plan = solve(buildCtx(slots, [prov('p01'), prov('p02')], { callPattern: pattern, shiftTypes }));

    const nb = plan.assignments.filter(a => a.shift_type_code === 'NB');
    expect(nb).toHaveLength(3);
    expect(new Set(nb.map(a => a.provider_id)).size).toBe(1);
    const v = nb[0].provider_id;
    const d2 = plan.assignments.find(a => a.slot_id === 'satD2');
    expect(d2?.provider_id).toBe(v);
    expect(d2?.source).toBe('d-chain');
    // The crux: the same provider holds BOTH the overlay NB and the non-overlay
    // D2 on Saturday — impossible without the overlay same-date exemption.
    expect(plan.assignments.filter(a => a.provider_id === v && a.slot_date === '2026-01-03')).toHaveLength(2);
  });
});

// ── 7. Custom call code fairness plumbing (category-driven, not C1/C2/C3) ────
describe('patternEngine — custom call code call-date tracking', () => {
  it('tracks a custom NC call for recency so a later NC prefers the other provider', () => {
    const pattern: CallPatternDoc = {
      version: 1, blocks: [],
      dayChains: [{ trigger: 'NC', dayTypes: ['weekday'] }],
      spans: [], placementPasses: [], reliefPass: null, optimizerMovableDayTypes: [],
    };
    const shiftTypes = new Map<string, ShiftTypeInfo>([
      ['NC', shiftInfo('NC', { category: 'call', call_rank: 0 })],
    ]);
    const nc1 = callSlot('nc1', '2026-01-05', 'NC', 'weekday'); // Mon
    const nc2 = callSlot('nc2', '2026-01-08', 'NC', 'weekday'); // Thu (+3)
    // pB carries one historical NC so the two tie on lifetime ratio after nc1 →
    // recency (which only sees nc1 if NC is tracked as a call) decides nc2.
    const ctx = buildCtx([nc1, nc2], [prov('pA'), prov('pB')], {
      callPattern: pattern, shiftTypes,
      historicalAssignedByPid: new Map([['pB', new Map([['weekday|NC', 1]])]]),
    });
    const plan = solve(ctx);
    expect(plan.assignments.find(a => a.slot_id === 'nc1')?.provider_id).toBe('pA');
    // If NC weren't tracked (legacy C1/C2/C3 literal), recency would tie and pA
    // would win nc2 too. Category-driven tracking gives it to pB.
    expect(plan.assignments.find(a => a.slot_id === 'nc2')?.provider_id).toBe('pB');
  });
});

// ── 8. Warnings for unknown pattern codes (asserted directly for this task) ──
describe('patternEngine — unknown-code warnings', () => {
  it('solve tolerates a pattern referencing an undefined code; patternWarnings flags it', () => {
    const pattern: CallPatternDoc = {
      version: 1, blocks: [],
      dayChains: [{ trigger: 'C1', dayTypes: ['weekday'], links: [{ offset: 1, code: 'ZZ' }] }],
      spans: [], placementPasses: [], reliefPass: null, optimizerMovableDayTypes: [],
    };
    const c1 = callSlot('c1', '2026-01-05', 'C1', 'weekday');
    // solve() must not throw even though ZZ has no slot/shift type.
    expect(() => solve(buildCtx([c1], [prov('pA')], { callPattern: pattern }))).not.toThrow();
    const warnings = patternWarnings(pattern, new Set(['C1']));
    expect(warnings.some(w => w.includes('ZZ'))).toBe(true);
  });
});

// ── 9. IF-4: a suppressed NON-call block-chain fill is recorded, not dropped ──
describe('patternEngine — IF-4 block-chain skip recording', () => {
  it('records a classic Saturday-C2 → Friday-D2 fill suppressed by cross-site', () => {
    // Classic Saturday block chain: C2 → {+1 C1, -1 D2}. p1 wins Saturday C2, but
    // is cross-site on the Friday, so the -1 D2 fill must be recorded + skipped.
    const satC2 = callSlot('satC2', '2026-01-03', 'C2', 'saturday'); // Sat
    const friD2 = dSlot('friD2', '2026-01-02', 'D2', 'friday');      // Fri (offset -1)
    const ctx = buildCtx([satC2, friD2], [prov('p1'), prov('p2')], {
      // p2 cannot take weekend call → p1 is the deterministic Saturday-C2 winner.
      credByPid: new Map([['p2', cred({ can_take_weekend_call: false })]]),
      // p1 is cross-site on the Friday → the -1 D2 chain fill is suppressed.
      crossSiteByDate: new Map([['p1', new Set(['2026-01-02'])]]),
    });
    const plan = solve(ctx);
    expect(plan.assignments.find(a => a.slot_id === 'satC2')?.provider_id).toBe('p1');
    expect(plan.skippedDerived).toContainEqual({
      date: '2026-01-02', code: 'D2', provider_id: 'p1', reason: 'cross-site',
    });
    // The Friday D2 must NOT be assigned to p1 (it stays unfilled).
    expect(plan.assignments.some(a => a.slot_id === 'friD2')).toBe(false);
  });
});

// ── 10. IF-2 seed budget: an overlay seed does not block the same-day call ────
describe('patternEngine — overlay seed budget', () => {
  it('lets a provider with a seeded overlay assignment win an open call slot that day', () => {
    // Overlay seeds must NOT consume the one-per-day budget (mirrors record()).
    const seed: SeedAssignment = {
      slot_date: '2026-01-05', provider_id: 'p1', shift_type_code: 'NB',
      shift_type_category: 'call', derived_day_type: 'weekday',
    };
    const monC1 = callSlot('monC1', '2026-01-05', 'C1', 'weekday');
    const shiftTypes = new Map<string, ShiftTypeInfo>([
      ['NB', shiftInfo('NB', { category: 'call', call_rank: 0, is_overlay: true })],
      ['C1', shiftInfo('C1', { category: 'call', call_rank: 0 })],
    ]);
    const plan = solve(buildCtx([monC1], [prov('p1')], { shiftTypes, seedAssignments: [seed] }));
    // Without the fix the overlay seed marks p1 busy on 01-05 → C1 goes unfilled.
    expect(plan.assignments.find(a => a.slot_id === 'monC1')?.provider_id).toBe('p1');
    expect(plan.unfilled.some(u => u.slot_id === 'monC1')).toBe(false);
  });
});
