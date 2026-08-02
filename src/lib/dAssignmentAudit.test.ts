// D-assignment audit — Gabriel 2026-08-02.
import { describe, it, expect } from 'vitest';
import { auditDAssignments, placementsFor, type AuditSlot, type AuditShiftType } from './dAssignmentAudit';
import { WEEKEND_V2_PATTERN } from './rulesEngine/patterns/weekendV2';
import { CallPatternDocSchema } from './rulesEngine/callPattern';

const ST: Record<string, AuditShiftType> = {
  C1: { code: 'C1', category: 'call', display_order: 1, generation_engine: 'call' },
  C2: { code: 'C2', category: 'call', display_order: 2, generation_engine: 'call' },
  C3: { code: 'C3', category: 'call', display_order: 2, generation_engine: 'call' },
  D1: { code: 'D1', category: 'regular', display_order: 3, relief_rank: null, generation_engine: 'call' },
  D2: { code: 'D2', category: 'regular', display_order: 4, relief_rank: null, generation_engine: 'call' },
  D3: { code: 'D3', category: 'regular', display_order: 5, relief_rank: null, generation_engine: 'call' },
  D4: { code: 'D4', category: 'regular', display_order: 6, relief_rank: 1, generation_engine: 'call' },
  D5: { code: 'D5', category: 'regular', display_order: 7, relief_rank: 2, generation_engine: 'call' },
  D6: { code: 'D6', category: 'regular', display_order: 8, relief_rank: 3, generation_engine: 'call' },
  '7-5': { code: '7-5', category: 'regular', display_order: 13, relief_rank: null, generation_engine: 'day_pool' },
};

const slot = (date: string, code: string, pid: string | null, dayType = 'weekday'): AuditSlot => ({
  id: `${date}|${code}`, slot_date: date, derived_day_type: dayType,
  shift_types: ST[code],
  assignments: [{ id: `a-${date}-${code}`, provider_id: pid }],
});

const audit = (slots: AuditSlot[]) => auditDAssignments(slots, WEEKEND_V2_PATTERN);
const MON = '2026-08-10', TUE = '2026-08-11', WED = '2026-08-12';

describe('sequence claims (D1–D3)', () => {
  it('places the post-call D1 the pattern owes after a C2', () => {
    // weekendV2: weekday C2 → +1 D1.
    const r = audit([slot(MON, 'C2', 'p1'), slot(TUE, 'D1', null)]);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].kind).toBe('missing-sequence-code');
    expect(r.placements).toEqual([{ slotId: `${TUE}|D1`, providerId: 'p1' }]);
  });

  it('moves a provider out of the wrong D and into the owed one', () => {
    const r = audit([slot(MON, 'C2', 'p1'), slot(TUE, 'D1', null), slot(TUE, 'D3', 'p1')]);
    expect(r.findings[0].kind).toBe('wrong-sequence-code');
    expect(r.placements).toEqual([
      { slotId: `${TUE}|D3`, providerId: null },
      { slotId: `${TUE}|D1`, providerId: 'p1' },
    ]);
  });

  it('THE LOWER CLAIM WINS when a provider is owed two', () => {
    // p1 is post-call from Mon C2 (→ Tue D1) AND pre-call for Wed C1 (→ Tue D2).
    // D1 sorts lower, so D1 wins — Gabriel's rule, and the standing post-call-
    // beats-pre-call rule, agreeing.
    const r = audit([
      slot(MON, 'C2', 'p1'), slot(WED, 'C1', 'p1'),
      slot(TUE, 'D1', null), slot(TUE, 'D2', null),
    ]);
    expect(r.placements).toEqual([{ slotId: `${TUE}|D1`, providerId: 'p1' }]);
    expect(r.findings[0].detail).toContain('D1 and D2 both claimed');
  });

  it('says nothing when the placement is already right', () => {
    expect(audit([slot(MON, 'C2', 'p1'), slot(TUE, 'D1', 'p1')]).findings).toEqual([]);
  });

  it('never moves someone who is ON CALL that day', () => {
    // p1's Mon C2 owes them Tue D1, but they also hold Tue C1 — that is the
    // pattern's own doing (a call outranks a day slot), not a D error.
    const r = audit([slot(MON, 'C2', 'p1'), slot(TUE, 'C1', 'p1'), slot(TUE, 'D1', null)]);
    expect(r.findings).toEqual([]);
  });

  it('does not evict someone else to satisfy a claim', () => {
    // Reportable elsewhere, but this pass never takes a slot off its holder.
    const r = audit([slot(MON, 'C2', 'p1'), slot(TUE, 'D1', 'p2')]);
    expect(r.findings).toEqual([]);
  });

  it('leaves day-pool codes alone — another engine owns them', () => {
    const r = audit([slot(MON, 'C2', 'p1'), slot(TUE, '7-5', 'p1'), slot(TUE, 'D1', null)]);
    expect(r.placements).toEqual([{ slotId: `${TUE}|D1`, providerId: 'p1' }]);
    expect(r.placements.some(p => p.slotId.includes('7-5'))).toBe(false);
  });

  it('honours the WEEKEND day-type scoping rather than assuming rest', () => {
    // Gabriel: "on weekends, it is possible for a C2 shift to occur the day
    // after a C1". Sat C1 → Sun C2 → Mon D1 is exactly what weekendV2 states
    // (sunday C2 carries a +1 D1), so the Monday D1 is a real claim.
    const r = audit([
      slot('2026-08-15', 'C1', 'p1', 'saturday'),
      slot('2026-08-16', 'C2', 'p1', 'sunday'),
      slot('2026-08-17', 'D1', null),
    ]);
    expect(r.placements).toEqual([{ slotId: '2026-08-17|D1', providerId: 'p1' }]);
  });
});

describe('ladder order (D4+)', () => {
  // p1's next call is Wed (1 day out), p2's is much later.
  const ladderBoard = (d4: string, d5: string) => [
    slot(TUE, 'D4', d4), slot(TUE, 'D5', d5),
    slot(WED, 'C1', 'p1'), slot('2026-08-24', 'C1', 'p2'),
  ];

  it('flags a ladder ordered against nearest-call and proposes the swap', () => {
    const r = audit(ladderBoard('p2', 'p1'));
    const ladder = r.findings.filter(f => f.kind === 'ladder-order');
    expect(ladder).toHaveLength(1);
    expect(ladder[0].placements).toEqual([
      { slotId: `${TUE}|D4`, providerId: 'p1' },   // soonest next call leaves first
      { slotId: `${TUE}|D5`, providerId: 'p2' },
    ]);
  });

  it('says nothing when already in nearest-call order', () => {
    expect(audit(ladderBoard('p1', 'p2')).findings.filter(f => f.kind === 'ladder-order'))
      .toEqual([]);
  });

  it('a gap in the middle is not itself a finding — only relative order', () => {
    const r = audit([
      slot(TUE, 'D4', 'p1'), slot(TUE, 'D5', null), slot(TUE, 'D6', 'p2'),
      slot(WED, 'C1', 'p1'), slot('2026-08-24', 'C1', 'p2'),
    ]);
    expect(r.findings.filter(f => f.kind === 'ladder-order')).toEqual([]);
  });

  it('a provider with NO upcoming call sorts last', () => {
    const r = audit([
      slot(TUE, 'D4', 'p2'), slot(TUE, 'D5', 'p1'), slot(WED, 'C1', 'p1'),
    ]);
    expect(r.findings[0].placements[0]).toEqual({ slotId: `${TUE}|D4`, providerId: 'p1' });
  });

  it('never touches a locked slot', () => {
    const board = ladderBoard('p2', 'p1');
    board[0] = { ...board[0], locked: true };
    expect(audit(board).findings.filter(f => f.kind === 'ladder-order')).toEqual([]);
  });

  it('a reorder is a PERMUTATION — the same people work that day', () => {
    const r = audit(ladderBoard('p2', 'p1'));
    const before = ['p2', 'p1'].sort();
    const after = r.findings[0].placements.map(p => p.providerId).filter(Boolean).sort();
    expect(after).toEqual(before);
  });
});

describe('result shape', () => {
  it('de-duplicates placements by slot so "fix all" is one write per slot', () => {
    const r = audit([
      slot(MON, 'C2', 'p1'), slot(TUE, 'D1', null), slot(TUE, 'D3', 'p1'),
      slot(TUE, 'D4', 'p2'), slot(TUE, 'D5', 'p3'),
      slot(WED, 'C1', 'p3'), slot('2026-08-24', 'C1', 'p2'),
    ]);
    expect(new Set(r.placements.map(p => p.slotId)).size).toBe(r.placements.length);
  });

  it('a clean board yields nothing to do', () => {
    expect(audit([slot(MON, 'C2', 'p1'), slot(TUE, 'D1', 'p1')]).placements).toEqual([]);
  });
});

describe('a dayChain link to a CALL code is never a D claim', () => {
  // No shipped pattern does this — weekendV2 and CLASSIC only link D codes
  // from dayChains — so it needs a synthetic doc. It is guarded anyway because
  // the consequence is the worst this module could have: treating "C2" as a
  // claim would make the repair write a provider into a CALL slot, and this
  // pass must never touch call assignments.
  const doc = CallPatternDocSchema.parse({
    version: 1, spans: [], blocks: [],
    dayChains: [
      { trigger: 'C1', dayTypes: ['weekday'], links: [{ offset: 1, code: 'C2' }] },
    ],
    placementPasses: [],
    reliefPass: { enabled: false, dayTypes: ['weekday'] },
    optimizerMovableDayTypes: [],
  });

  it('produces no finding, and never proposes writing into the call slot', () => {
    const r = auditDAssignments(
      [slot(MON, 'C1', 'p1'), slot(TUE, 'C2', null)], doc);
    expect(r.findings).toEqual([]);
    expect(r.placements).toEqual([]);
  });
});

describe('finding keys and subset payloads (dismissal support)', () => {
  const board = () => [
    slot(MON, 'C2', 'p1'), slot(TUE, 'D1', null), slot(TUE, 'D3', 'p1'),
    slot(TUE, 'D4', 'p2'), slot(TUE, 'D5', 'p3'),
    slot(WED, 'C1', 'p3'), slot('2026-08-24', 'C1', 'p2'),
  ];

  it('every finding carries a distinct, stable key', () => {
    const a = audit(board()).findings.map(f => f.key);
    const b = audit(board()).findings.map(f => f.key);
    expect(a).toEqual(b);                       // stable across runs
    expect(new Set(a).size).toBe(a.length);     // distinct
  });

  it('the key changes when the PROPOSED CHANGE changes', () => {
    // A dismissal must not outlive the situation it was about. This case is
    // deliberately constructed so date, KIND and provider are all IDENTICAL and
    // only the target slot moves — an earlier version of this test also changed
    // the kind, so it passed even with the change omitted from the key.
    //
    // A: Mon C2 ⇒ owed Tue D1 (weekday C2 → +1 D1)
    // B: Wed C2 ⇒ owed Tue D3 (weekday C2 → −1 D3)
    const common = [slot(TUE, 'D1', null), slot(TUE, 'D3', null)];
    const a = audit([slot(MON, 'C2', 'p1'), ...common]).findings
      .find(f => f.date === TUE && f.providerIds[0] === 'p1')!;
    const b = audit([slot(WED, 'C2', 'p1'), ...common]).findings
      .find(f => f.date === TUE && f.providerIds[0] === 'p1')!;

    expect(a.kind).toBe(b.kind);                       // same kind…
    expect(a.providerIds).toEqual(b.providerIds);      // …same provider, same date
    expect(a.placements).not.toEqual(b.placements);    // …different fix
    expect(a.key).not.toBe(b.key);                     // ⇒ different key
  });

  it('placementsFor(subset) omits a dismissed finding entirely', () => {
    const { findings } = audit(board());
    const kept = findings.filter(f => f.kind !== 'ladder-order');
    const dropped = findings.filter(f => f.kind === 'ladder-order');
    const slots = new Set(placementsFor(kept).map(p => p.slotId));
    for (const f of dropped) {
      for (const p of f.placements) expect(slots.has(p.slotId)).toBe(false);
    }
  });

  it('placementsFor(all) equals the audit’s own payload — one dedupe, not two', () => {
    const r = audit(board());
    expect(placementsFor(r.findings)).toEqual(r.placements);
  });

  it('dismissing everything leaves nothing to write', () => {
    expect(placementsFor([])).toEqual([]);
  });
});

describe('post-call suppresses D claims', () => {
  // Gabriel 2026-08-02: "if someone is post call, they dont get a D spot, so if
  // someone was on call sunday, but C1 on Tuesday, that shouldnt be picked up
  // as missing D spot."
  const SUN = '2026-08-16', MONDAY = '2026-08-17', TUESDAY = '2026-08-18';

  it('HIS CASE: Sunday C1 then Tuesday C1 — Monday is rest, not a missing D2', () => {
    // weekendV2: sunday C1 blocks +1 (Monday). The Tuesday C1's −1 D2 claim
    // lands on that rest day and must be dropped.
    const r = audit([
      slot(SUN, 'C1', 'p1', 'sunday'),
      slot(TUESDAY, 'C1', 'p1'),
      slot(MONDAY, 'D2', null),
    ]);
    expect(r.findings).toEqual([]);
    expect(r.placements).toEqual([]);
  });

  it('a Sunday C2 still earns its Monday D1 — a FILL is not a block', () => {
    // The distinction is the pattern's: sunday C2 carries a +1 D1 link and no
    // blocks, so its holder is not resting.
    const r = audit([slot(SUN, 'C2', 'p1', 'sunday'), slot(MONDAY, 'D1', null)]);
    expect(r.placements).toEqual([{ slotId: `${MONDAY}|D1`, providerId: 'p1' }]);
  });

  it('a weekday C1 rests the next day too', () => {
    // Mon C1 blocks Tue; a Wed C1 would otherwise claim Tue D2.
    const r = audit([
      slot(MON, 'C1', 'p1'), slot(WED, 'C1', 'p1'), slot(TUE, 'D2', null),
    ]);
    expect(r.findings).toEqual([]);
  });

  it('rest only suppresses the RESTING provider', () => {
    const r = audit([
      slot(SUN, 'C1', 'p1', 'sunday'),
      slot(TUESDAY, 'C1', 'p2'),          // p2 is not post-call
      slot(MONDAY, 'D2', null),
    ]);
    expect(r.placements).toEqual([{ slotId: `${MONDAY}|D2`, providerId: 'p2' }]);
  });
});
