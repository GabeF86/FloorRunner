// D-assignment audit — Gabriel 2026-08-02.
import { describe, it, expect } from 'vitest';
import { auditDAssignments, type AuditSlot, type AuditShiftType } from './dAssignmentAudit';
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
