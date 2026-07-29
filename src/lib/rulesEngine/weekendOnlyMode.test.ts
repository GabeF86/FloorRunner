import { describe, it, expect } from 'vitest';
import { solve } from './solve';
import { buildFixtureContext, buildCtx, prov, callSlot, dSlot, shiftInfo } from './__fixtures__/buildContext';
import { CLASSIC_PATTERN, type CallPatternDoc } from './callPattern';
import { WEEKEND_V2_PATTERN } from './patterns/weekendV2';
import type { AvailabilityEntry, GenerationContext, SolutionPlan } from './genTypes';

// ── Generation fill mode 'weekend-only' (2026-07-21, staged weekend fill) ────
// Gabriel: "give me an option to just fill in the weekend call schedule and
// then if I want to continue filling in the rest I can press another button."
//
// Semantics under test:
//  - The MAIN LOOP attempts ONLY call slots whose derived_day_type is
//    saturday / sunday / friday. Holiday day types are OUT of scope.
//  - Block/day chains fire normally from weekend placements and land WHEREVER
//    the pattern points (Monday D1, Friday D2/D4, post-call blocks) — chains
//    are never scope-clipped.
//  - Out-of-scope call slots are NOT unfilled failures: they are counted in
//    plan.awaitingContinue (absent entirely outside weekend-only mode).
//  - Skipped passes: pre-PTO Thursday (weekday-targeted), relief, mop-up.
//    Spans still run (structural obligations, like chains). The optimizer and
//    the day-shift engine are skipped upstream (autoGenerate / the route).
//  - Quota/scoring semantics are the SAME as 'all' (relaxation enabled, no
//    obligation caps — modes do not compose in v1).

const byId = (plan: SolutionPlan) =>
  new Map(plan.assignments.map(a => [a.slot_id, a.provider_id]));

// ── main-loop scope ──────────────────────────────────────────────────────────

describe("fillMode 'weekend-only' — main loop attempts only Sat/Sun/Fri call slots", () => {
  // Classic weekend structure + a Monday. Input order mirrors production's
  // weekend-first dayTypeFillOrder (buildCtx preserves input order verbatim).
  const mkSlots = () => [
    callSlot('satC2', '2026-01-10', 'C2', 'saturday'),
    callSlot('satC1', '2026-01-10', 'C1', 'saturday'),
    callSlot('sunC2', '2026-01-11', 'C2', 'sunday'),
    callSlot('sunC1', '2026-01-11', 'C1', 'sunday'),
    callSlot('friC2', '2026-01-09', 'C2', 'friday'),
    callSlot('friC1', '2026-01-09', 'C1', 'friday'),
    dSlot('friD2', '2026-01-09', 'D2', 'friday'),
    callSlot('monC2', '2026-01-12', 'C2', 'weekday'),
    callSlot('monC1', '2026-01-12', 'C1', 'weekday'),
    dSlot('monD1', '2026-01-12', 'D1', 'weekday'),
  ];
  // Four providers: the weekend consumes three (two chain carriers + Fri C1),
  // and the 'all' control needs a fourth with Monday free so both Monday call
  // slots are fillable there.
  const providers = [prov('p1'), prov('p2'), prov('p3'), prov('p4')];

  it('fills every weekend/friday call slot; weekday call slots await Continue', () => {
    const plan = solve(buildCtx(mkSlots(), providers), { fillMode: 'weekend-only' });
    const ids = byId(plan);
    for (const id of ['satC1', 'satC2', 'sunC1', 'sunC2', 'friC1', 'friC2']) {
      expect(ids.has(id), `${id} must be filled`).toBe(true);
    }
    expect(ids.has('monC1')).toBe(false);
    expect(ids.has('monC2')).toBe(false);
    // Out-of-scope call slots are NOT unfilled failures…
    expect(plan.unfilled).toHaveLength(0);
    // …they are counted separately, in slotsToFill order.
    expect(plan.awaitingContinue?.map(s => s.slot_id)).toEqual(['monC2', 'monC1']);
    expect(plan.awaitingContinue?.every(s => s.derived_day_type === 'weekday')).toBe(true);
  });

  it('chains still land on out-of-scope days (Monday D1 from Sunday C2; Friday D2 from Saturday C2)', () => {
    const plan = solve(buildCtx(mkSlots(), providers), { fillMode: 'weekend-only' });
    const ids = byId(plan);
    // Classic Sat C2 chain: +1 Sun C1, −1 Fri D2 — same provider.
    expect(ids.get('friD2')).toBe(ids.get('satC2'));
    expect(ids.get('sunC1')).toBe(ids.get('satC2'));
    // Sunday C2 dayChain: +1 D1 lands on MONDAY (out of scope) — never clipped.
    expect(ids.get('monD1')).toBe(ids.get('sunC2'));
  });

  it("fillMode 'all' on the same ctx fills the Monday call slots (control)", () => {
    const plan = solve(buildCtx(mkSlots(), providers), { fillMode: 'all' });
    const ids = byId(plan);
    expect(ids.has('monC1')).toBe(true);
    expect(ids.has('monC2')).toBe(true);
    expect(plan.awaitingContinue).toBeUndefined();
  });

  it('holiday day types are OUT of weekend scope (Continue handles them)', () => {
    const slots = [
      callSlot('satC1', '2026-01-10', 'C1', 'saturday'),
      callSlot('holC1', '2026-01-01', 'C1', 'federal_holiday'),
      callSlot('majC1', '2026-01-19', 'C1', 'major_holiday'),
    ];
    const plan = solve(buildCtx(slots, providers), { fillMode: 'weekend-only' });
    expect(byId(plan).has('satC1')).toBe(true);
    expect(plan.awaitingContinue?.map(s => s.slot_id)).toEqual(['holC1', 'majC1']);
    expect(plan.awaitingContinue?.map(s => s.derived_day_type))
      .toEqual(['federal_holiday', 'major_holiday']);
    expect(plan.unfilled).toHaveLength(0);
  });

  it('an out-of-scope call slot already filled by a chain is handled, not awaiting', () => {
    // Custom doc: Saturday C1 anchors a +2 link to MONDAY C1 (call). The chain
    // fires from the in-scope anchor, fills the Monday call slot for the same
    // provider, and the slot is NOT double-counted as awaiting-continue.
    const doc: CallPatternDoc = {
      ...CLASSIC_PATTERN,
      blocks: [{ anchorDayType: 'saturday', chains: [
        { trigger: 'C1', links: [{ offset: 2, code: 'C1' }] },
      ] }],
      dayChains: [],
    };
    const slots = [
      callSlot('satC1', '2026-01-10', 'C1', 'saturday'),
      callSlot('monC1', '2026-01-12', 'C1', 'weekday'),
    ];
    const plan = solve(buildCtx(slots, providers, { callPattern: doc }), { fillMode: 'weekend-only' });
    const ids = byId(plan);
    expect(ids.get('monC1')).toBe(ids.get('satC1'));
    expect(plan.awaitingContinue).toEqual([]);
  });

  it('an IN-scope weekend slot nobody can take is still a real unfilled failure', () => {
    const plan = solve(buildCtx(
      [callSlot('satC1', '2026-01-10', 'C1', 'saturday')],
      [prov('p1')],
      { availByPid: new Map([['p1', [{
        availability_type: 'pto', start_date: '2026-01-10', end_date: '2026-01-10',
        approval_status: 'approved',
      }]]]) },
    ), { fillMode: 'weekend-only' });
    expect(plan.assignments).toHaveLength(0);
    expect(plan.unfilled).toHaveLength(1);
    expect(plan.unfilled[0].slot_id).toBe('satC1');
    expect(plan.awaitingContinue).toEqual([]);
  });
});

// ── skipped passes ───────────────────────────────────────────────────────────

describe("fillMode 'weekend-only' — pre-PTO / relief / mop-up passes are skipped", () => {
  it('the pre-PTO Thursday pass does not run (its Thursday slot awaits Continue)', () => {
    const slots = [callSlot('thuC1', '2026-01-08', 'C1')];
    const providers = [prov('p1'), prov('p2')];
    const availByPid = new Map([['p1', [{
      availability_type: 'pto', start_date: '2026-01-12', end_date: '2026-01-16',
      approval_status: 'approved',
    }]]]);

    // Control: 'all' gives PTO-bound p1 the pre-PTO Thursday.
    const all = solve(buildCtx(slots, providers, { availByPid }), { fillMode: 'all' });
    expect(all.assignments.find(a => a.slot_id === 'thuC1')?.source).toBe('pre-pto-thursday');

    const wk = solve(buildCtx(slots, providers, { availByPid }), { fillMode: 'weekend-only' });
    expect(wk.assignments).toHaveLength(0);
    expect(wk.awaitingContinue?.map(s => s.slot_id)).toEqual(['thuC1']);
    expect(wk.unfilled).toHaveLength(0);
  });

  it('the relief pass does not run (open Friday relief slot stays open, unreported)', () => {
    const mk = () => buildCtx(
      [callSlot('friC1', '2026-01-09', 'C1', 'friday'), dSlot('friD4', '2026-01-09', 'D4', 'friday')],
      [prov('p1'), prov('p2')],
    );
    // Control: 'all' fills the D4 via relief ordering.
    const all = solve(mk(), { fillMode: 'all' });
    expect(all.assignments.find(a => a.slot_id === 'friD4')?.source).toBe('relief-order');

    const wk = solve(mk(), { fillMode: 'weekend-only' });
    expect(wk.assignments.some(a => a.slot_id === 'friD4')).toBe(false);
    expect(wk.unfilled).toHaveLength(0); // relief never ran → no relief-unfilled report
  });

  it('the mop-up sweep does not run (orphaned call-engine day slot stays open, unreported)', () => {
    // A weekday D1 whose Monday C2 trigger has no slot at all: under 'all' the
    // mop-up reports the sequence-owned orphan; weekend-only defers it whole
    // to the Continue run.
    const shiftTypes = new Map([
      ['C1', shiftInfo('C1', { category: 'call', generation_engine: 'call' })],
      ['C2', shiftInfo('C2', { category: 'call', generation_engine: 'call' })],
      ['D1', shiftInfo('D1', { generation_engine: 'call' })],
    ]);
    const mk = () => buildCtx(
      [dSlot('tueD1', '2026-01-06', 'D1', 'weekday')], [prov('p1')], { shiftTypes });
    const all = solve(mk(), { fillMode: 'all' });
    expect(all.unfilled.map(u => u.reason)).toEqual(['sequence-orphan: chain source unfilled']);

    const wk = solve(mk(), { fillMode: 'weekend-only' });
    expect(wk.unfilled).toHaveLength(0);
    expect(wk.assignments).toHaveLength(0);
  });
});

// ── weekend-v2 (the live Paoli pattern) ──────────────────────────────────────

describe("fillMode 'weekend-only' — weekend-v2 four-person shape still forms", () => {
  it('produces the full Doc A/B/C/E weekend incl. Monday D1; weekday calls await', () => {
    const slots = [
      callSlot('satC1', '2026-01-10', 'C1', 'saturday'),
      callSlot('satC2', '2026-01-10', 'C2', 'saturday'),
      callSlot('satC3', '2026-01-10', 'C3', 'saturday'),
      callSlot('friC1', '2026-01-09', 'C1', 'friday'),
      callSlot('friC2', '2026-01-09', 'C2', 'friday'),
      dSlot('friD2', '2026-01-09', 'D2', 'friday'),
      dSlot('friD4', '2026-01-09', 'D4', 'friday'),
      callSlot('sunC1', '2026-01-11', 'C1', 'sunday'),
      callSlot('sunC2', '2026-01-11', 'C2', 'sunday'),
      callSlot('sunC3', '2026-01-11', 'C3', 'sunday'),
      dSlot('monD1', '2026-01-12', 'D1', 'weekday'),
      callSlot('monC1', '2026-01-12', 'C1', 'weekday'),
    ];
    const providers = [prov('p1'), prov('p2'), prov('p3'), prov('p4'), prov('p5'), prov('p6')];
    const shiftTypes = new Map([
      ['C1', shiftInfo('C1', { call_rank: 0 })],
      ['C2', shiftInfo('C2', { call_rank: 1 })],
      ['C3', shiftInfo('C3', { category: 'call', call_rank: 2, is_overlay: true })],
      ['D4', shiftInfo('D4', { category: 'regular' })],
    ]);
    const plan = solve(
      buildCtx(slots, providers, { callPattern: WEEKEND_V2_PATTERN, shiftTypes }),
      { fillMode: 'weekend-only' },
    );
    const ids = byId(plan);
    // Doc A: Fri C1 carries Sun C2 and Monday D1 (chain into the weekday).
    expect(ids.get('sunC2')).toBe(ids.get('friC1'));
    expect(ids.get('monD1')).toBe(ids.get('friC1'));
    // Doc B / C / E links. Doc C's neuro is Sat + Sun plus the Friday D4 day
    // shift (2026-07-27): there is no Friday C3 slot to chain any more — the
    // Friday C2 doc cross-covers neuro that day — so this fixture mints none.
    expect(ids.get('friC2')).toBe(ids.get('satC2'));
    expect(ids.get('sunC1')).toBe(ids.get('satC2'));
    expect(ids.get('friD4')).toBe(ids.get('satC3'));
    expect(ids.get('sunC3')).toBe(ids.get('satC3'));
    expect(ids.get('friD2')).toBe(ids.get('satC1'));
    // The Monday call is deferred, not failed.
    expect(ids.has('monC1')).toBe(false);
    expect(plan.awaitingContinue?.map(s => s.slot_id)).toEqual(['monC1']);
    expect(plan.unfilled).toHaveLength(0);
  });
});

// ── staged-equivalence property (the key correctness pin) ────────────────────
// Stage 1 = weekend-only greedy; commit; Stage 2 = 'all' greedy over the
// committed stage-1 placements as seeds. Because dayTypeFillOrder runs weekend
// groups FIRST and seedSolveState reconstructs bucket counts / call dates /
// post-call blocks from seeds, the greedy portion of the staged flow should
// reproduce the one-shot 'all' greedy. Optimizer outcomes legitimately differ
// (staged locks reviewed weekends as seeds) and are deliberately NOT pinned.

// Mirror production stage 2: committed stage-1 assignments become seeds, their
// slots leave slotsToFill AND slotIndex (genContext only indexes OPEN slots).
function continueCtx(base: GenerationContext, stage1: SolutionPlan): GenerationContext {
  const filled = new Set(stage1.assignments.map(a => a.slot_id));
  const slotIndex = new Map<string, Map<string, typeof base.slotsToFill[number]>>();
  for (const [date, codeMap] of base.slotIndex) {
    for (const [code, s] of codeMap) {
      if (filled.has(s.slot_id)) continue;
      if (!slotIndex.has(date)) slotIndex.set(date, new Map());
      slotIndex.get(date)!.set(code, s);
    }
  }
  return {
    ...base,
    slotsToFill: base.slotsToFill.filter(s => !filled.has(s.slot_id)),
    slotIndex,
    seedAssignments: [
      ...base.seedAssignments,
      ...stage1.assignments.map(a => ({
        slot_date: a.slot_date, provider_id: a.provider_id,
        shift_type_code: a.shift_type_code, shift_type_category: a.shift_type_category,
        derived_day_type: a.derived_day_type,
        // PROVENANCE (2026-07-29). genContext stamps all four on every real
        // seed; without them mayEvictPreFill conservatively refuses, so a
        // provenance-free fixture silently models a Continue run that can
        // never evict a stale pre-fill — the opposite of production.
        slot_id: a.slot_id, assignment_id: `a-${a.slot_id}`,
        source_type: 'auto_generated', schedule_version_id: base.scheduleVersionId,
      })),
    ],
  };
}

// The staged union must ACCOUNT FOR EVICTIONS. A Continue run's post-call
// link can evict a stale stage-1 pre-fill (preFillEviction.ts); commitPlan
// executes those evictions against the DB, reverting the row to open. A union
// that only adds assignments therefore models a state production never has —
// it keeps showing a provider in a slot the same run just vacated. Subtracting
// plan.evictions is what makes the union equal the real post-commit schedule.
const assignmentMap = (...plans: SolutionPlan[]) => {
  const m = new Map<string, string>();
  for (const plan of plans) for (const a of plan.assignments) m.set(a.slot_id, a.provider_id);
  // Keyed on the evicted PROVIDER, not just the slot: the row being evicted is
  // by definition one an earlier plan in this union assigned, so "is this slot
  // assigned anywhere?" is always true and would never subtract. If a later
  // pass handed the vacated slot to somebody else, the map already holds THEM
  // and the entry correctly survives.
  for (const plan of plans) for (const e of plan.evictions ?? []) {
    if (m.get(e.slot_id) === e.provider_id) m.delete(e.slot_id);
  }
  return m;
};

describe('staged equivalence — weekend-only then Continue-all vs one-shot all (greedy)', () => {
  // No blocking PTO: the pre-PTO pass is inert in both flows, so the greedy
  // portions must agree exactly.
  const noPto = () => buildFixtureContext({ availByPid: new Map() });

  it('(a) stage-1 weekend placements are byte-identical to the one-shot weekend subset', () => {
    const oneShot = solve(noPto());
    const stage1 = solve(noPto(), { fillMode: 'weekend-only' });
    // Every stage-1 assignment (weekend calls AND their chain fills, wherever
    // they landed) appears in the one-shot plan byte for byte — EXCEPT a day
    // fill the one-shot post-call repair relocated (2026-07-29). Stage 1
    // cannot know about it: the trigger is a WEEKDAY call that stage 1 has not
    // placed yet, so its pre-call day fill is provisional exactly the way
    // relief and mop-up are, and the Continue run corrects it by evicting the
    // same row (proven in (b) — the two paths land on the same schedule).
    const oneShotById = new Map(oneShot.assignments.map(a => [a.slot_id, a]));
    const relocated = new Set((oneShot.postCallRepairs ?? [])
      .map(r => `${r.provider_id}|${r.date}|${r.from_code}`));
    for (const a of stage1.assignments) {
      if (relocated.has(`${a.provider_id}|${a.slot_date}|${a.shift_type_code}`)) {
        // Must be relocated, not merely lost: one-shot has the provider in the
        // post-call slot the repair named.
        const r = oneShot.postCallRepairs!.find(x =>
          x.provider_id === a.provider_id && x.date === a.slot_date);
        expect(oneShot.assignments.some(x =>
          x.provider_id === a.provider_id && x.slot_date === a.slot_date
          && x.shift_type_code === r!.to_code)).toBe(true);
        continue;
      }
      expect(oneShotById.get(a.slot_id), `${a.slot_id} in one-shot`).toEqual(a);
    }
    // …and stage 1 is not MISSING any one-shot weekend-scope call placement.
    const weekendCalls = (p: SolutionPlan) => p.assignments
      .filter(a => a.shift_type_category === 'call'
        && ['saturday', 'sunday', 'friday'].includes(a.derived_day_type))
      .map(a => `${a.slot_id}=${a.provider_id}`).sort();
    expect(weekendCalls(stage1)).toEqual(weekendCalls(oneShot));
  });

  it('(b) the staged-continue union equals the one-shot greedy plan (assignments + unfilled)', () => {
    const oneShot = solve(noPto());
    const stage1 = solve(noPto(), { fillMode: 'weekend-only' });
    const stage2 = solve(continueCtx(noPto(), stage1), { fillMode: 'all' });
    expect(Object.fromEntries(assignmentMap(stage1, stage2)))
      .toEqual(Object.fromEntries(assignmentMap(oneShot)));
    // Same open slots at the end of greedy, too.
    const unfilledIds = (p: SolutionPlan) => p.unfilled.map(u => u.slot_id).sort();
    expect([...unfilledIds(stage1), ...unfilledIds(stage2)].sort())
      .toEqual(unfilledIds(oneShot));
    expect(stage2.awaitingContinue).toBeUndefined();
  });

  it('(b′) holds on the SHIPPED golden fixture too — PTO bookends, adjacent-week exclusions and the pre-PTO pass included', () => {
    // p05's PTO (01-14..16) activates every PTO-adjacent rule AND the pre-PTO
    // Thursday pass. Seed reconstruction (seedSolveState) reproduces bucket
    // counts / call dates / post-call blocks exactly, and on this fixture the
    // pre-PTO placement (p05, 01-08 C1) does not contend with any weekend
    // outcome — so the staged union still equals one-shot, assignment for
    // assignment. (When the pre-PTO provider DOES contend for a weekend/Friday
    // slot the flows can diverge — characterized precisely below.)
    const oneShot = solve(buildFixtureContext());
    const stage1 = solve(buildFixtureContext(), { fillMode: 'weekend-only' });
    const stage2 = solve(continueCtx(buildFixtureContext(), stage1), { fillMode: 'all' });
    expect(oneShot.assignments.find(a => a.source === 'pre-pto-thursday')?.provider_id).toBe('p05'); // the pass is live
    expect(Object.fromEntries(assignmentMap(stage1, stage2)))
      .toEqual(Object.fromEntries(assignmentMap(oneShot)));
  });

  // ── the ONE known greedy divergence, characterized (do not paper over) ────
  // Seeds reconstruct solve state faithfully (proved above); what CAN differ
  // is PASS ORDERING around the pre-PTO Thursday placement. One-shot runs
  // pre-PTO BEFORE the weekend groups; the staged flow by construction runs
  // it AFTER them (stage 1 skips it; stage 2 runs it over the committed
  // weekend). When the PTO-bound provider would win a Friday call that the
  // pre-PTO Thursday placement's post-call block would have denied them, the
  // flows swap providers on the contended slots: staged favors the weekend
  // placement (which is the feature's intent — the reviewed weekend is
  // authoritative), one-shot favors the pre-PTO Thursday. In the MINIMAL
  // case below the swap stays contained (same two slots, swapped providers),
  // but that containment is NOT a general guarantee — the swap can cascade
  // through chain links and unlessCallWithinDays waivers and change WHICH
  // chained day slots fill. The cascade is pinned in the next test.
  it('characterized divergence: a pre-PTO provider contending for a Friday call swaps with the Thursday fill', () => {
    const mk = () => buildCtx(
      [callSlot('friC1', '2026-01-09', 'C1', 'friday'), callSlot('thuC1', '2026-01-08', 'C1')],
      [prov('p1'), prov('p2')],
      { availByPid: new Map([['p1', [{
        availability_type: 'pto', start_date: '2026-01-12', end_date: '2026-01-16',
        approval_status: 'approved',
      }]]]) },
    );
    // One-shot: pre-PTO gives p1 the Thursday C1 first; its post-call block
    // covers Friday, so p2 takes the Friday call.
    const oneShot = solve(mk());
    expect(Object.fromEntries(assignmentMap(oneShot)))
      .toEqual({ thuC1: 'p1', friC1: 'p2' });
    expect(oneShot.assignments.find(a => a.slot_id === 'thuC1')?.source).toBe('pre-pto-thursday');
    // Staged: stage 1 hands p1 the Friday call (score winner, nothing blocks
    // it yet); stage 2's pre-PTO pass then finds p1 busy Friday (post-call
    // guard) and declines — best-effort by design — so Thursday falls to the
    // main loop and p2. Same slots covered, swapped providers.
    const stage1 = solve(mk(), { fillMode: 'weekend-only' });
    const stage2 = solve(continueCtx(mk(), stage1), { fillMode: 'all' });
    expect(Object.fromEntries(assignmentMap(stage1, stage2)))
      .toEqual({ friC1: 'p1', thuC1: 'p2' });
    expect(stage2.assignments.find(a => a.slot_id === 'thuC1')?.source).toBe('main-loop');
    // In THIS minimal two-slot case no coverage is lost — the same two slots
    // fill either way. That is a fact about this fixture, not a guarantee:
    // the cascade test below shows the same swap changing which chained day
    // slots fill at all.
    expect(oneShot.unfilled).toHaveLength(0);
    expect(stage1.unfilled).toHaveLength(0);
    expect(stage2.unfilled).toHaveLength(0);
  });

  // ── the cascade: the swap can change WHICH chained day slots fill ─────────
  // Golden fixture (p05 PTO 01-14..16) plus two live no-call requests (soft
  // scoring tiers — enough to reshuffle greedy winners so the PTO-bound p05
  // contends for a weekend-scope call). One-shot's pre-PTO pass hands p05 the
  // Thursday 01-08 C1, whose post-call block denies p05 the Friday 01-09 C1
  // (p02 takes it despite the no-call penalty); stage 1 has no pre-PTO pass,
  // so p05 wins that Friday. The swap then CASCADES through chain links and
  // unlessCallWithinDays waivers: the staged union covers TWO FEWER day slots
  // than one-shot (loses four chained D fills, gains two different ones).
  // "Coverage never differs" is FALSE for the cascade. What DOES hold is the
  // reporting invariant: every divergent slot is accounted for — chain
  // suppressions land in skippedDerived (invariant 4) and, in production
  // shape (ctx.shiftTypes present), every still-open chain slot is reported
  // by the stage-2 mop-up as a sequence orphan. Run in production shape here
  // so those reports are live and pinned.
  it('characterized cascade: the swap changes WHICH chained day slots fill — fewer covered, all reported', () => {
    const shiftTypes = new Map([
      ['C1', shiftInfo('C1', { category: 'call', generation_engine: 'call', call_rank: 0, requires_post_call_rule: true })],
      ['C2', shiftInfo('C2', { category: 'call', generation_engine: 'call', call_rank: 1, requires_post_call_rule: true })],
      ['C3', shiftInfo('C3', { category: 'call', generation_engine: 'call', call_rank: 2 })],
      ['D1', shiftInfo('D1', { generation_engine: 'call' })],
      ['D2', shiftInfo('D2', { generation_engine: 'call' })],
      ['D3', shiftInfo('D3', { generation_engine: 'call' })],
      ['D4', shiftInfo('D4', { generation_engine: 'call', relief_rank: 1 })],
      ['D5', shiftInfo('D5', { generation_engine: 'call', relief_rank: 2 })],
      ['D6', shiftInfo('D6', { generation_engine: 'call', relief_rank: 3 })],
    ]);
    const mkAvail = (): Map<string, AvailabilityEntry[]> => new Map([
      ['p05', [{ availability_type: 'pto', start_date: '2026-01-14',
                 end_date: '2026-01-16', approval_status: 'approved' }]],
      ['p02', [{ availability_type: 'no_call_request', start_date: '2026-01-09',
                 end_date: '2026-01-12', approval_status: 'pending' }]],
      ['p06', [{ availability_type: 'no_call_request', start_date: '2026-01-17',
                 end_date: '2026-01-18', approval_status: 'approved' }]],
    ]);
    const mk = () => buildFixtureContext({ availByPid: mkAvail(), shiftTypes });

    const oneShot = solve(mk());
    const stage1 = solve(mk(), { fillMode: 'weekend-only' });
    const stage2 = solve(continueCtx(mk(), stage1), { fillMode: 'all' });

    // The contention scenario is realized.
    const prePto = oneShot.assignments.find(a => a.source === 'pre-pto-thursday');
    expect(prePto?.slot_id).toBe('2026-01-08|C1');
    expect(prePto?.provider_id).toBe('p05');
    expect(assignmentMap(oneShot).get('2026-01-09|C1')).toBe('p02');
    expect(assignmentMap(stage1).get('2026-01-09|C1')).toBe('p05');

    // The cascade: the two flows fill DIFFERENT sets of chained day slots.
    const union = assignmentMap(stage1, stage2);
    const one = assignmentMap(oneShot);
    const lost = [...one.keys()].filter(k => !union.has(k)).sort();
    const gained = [...union.keys()].filter(k => !one.has(k)).sort();
    // 2026-07-29: the one-shot's 01-08 loss moved from D1 to D2. The post-call
    // repair pass puts that provider in the D1 their previous day's call
    // declared, so one-shot now COVERS 01-08 D1 and leaves 01-08 D2 open —
    // the slot the staged flow still fills. The cascade's shape is unchanged.
    expect(lost).toEqual(['2026-01-08|D2', '2026-01-18|D2', '2026-01-20|D2', '2026-01-21|D2']);
    expect(gained).toEqual(['2026-01-18|D3', '2026-01-23|D2']);
    expect(union.size).toBe(one.size - 2); // coverage genuinely differs

    // Nothing is silent. Every lost slot is reported open by stage 2…
    const stage2Open = new Map(stage2.unfilled.map(u => [u.slot_id, u.reason]));
    // 01-08 D2 is reported through the OTHER channel: stage 2's post-call link
    // EVICTED p05's stale pre-fill there (commitPlan reverts that row to open),
    // so it is never in stage 2's unfilled list — plan.evictions is its report.
    // Both channels count; what must not exist is a slot in neither.
    expect((stage2.evictions ?? []).some(e => e.slot_id === '2026-01-08|D2')).toBe(true);
    expect(stage2Open.has('2026-01-08|D2')).toBe(false);
    expect(stage2Open.get('2026-01-18|D2')).toBe('sequence-orphan: chain link severed');
    expect(stage2Open.get('2026-01-20|D2')).toBe('sequence-orphan: pre-call fill waived');
    expect(stage2Open.get('2026-01-21|D2')).toBe('sequence-orphan: pre-call fill waived');
    // …with the severed links' suppression events in skippedDerived
    // (invariant 4; the waived pair is a by-design unlessCallWithinDays skip,
    // recorded via the mop-up reason above, not a suppression):
    const skips = new Map((stage2.skippedDerived ?? []).map(s => [`${s.date}|${s.code}`, s.reason]));
    expect(skips.get('2026-01-18|D2')).toBe('pto');
    // …and the gained slots are exactly slots ONE-SHOT itself reported open.
    const oneShotOpen = new Map(oneShot.unfilled.map(u => [u.slot_id, u.reason]));
    expect(oneShotOpen.get('2026-01-18|D3')).toBe('sequence-orphan: chain link severed');
    expect(oneShotOpen.get('2026-01-23|D2')).toBe('sequence-orphan: chain link severed');

    // Source pinned: drop ONLY p05's PTO (both no-call requests stay) and the
    // staged union is byte-identical to one-shot again — the cascade's sole
    // source is the pre-PTO pass ordering the previous test characterizes.
    const mkCtl = () => {
      const avail = mkAvail();
      avail.delete('p05');
      return buildFixtureContext({ availByPid: avail, shiftTypes });
    };
    const ctlOneShot = solve(mkCtl());
    const ctlStage1 = solve(mkCtl(), { fillMode: 'weekend-only' });
    const ctlStage2 = solve(continueCtx(mkCtl(), ctlStage1), { fillMode: 'all' });
    expect(Object.fromEntries(assignmentMap(ctlStage1, ctlStage2)))
      .toEqual(Object.fromEntries(assignmentMap(ctlOneShot)));
  });
});
