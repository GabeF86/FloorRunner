// pre-PTO Thursday: maxProviders caps PLACEMENTS, not ATTEMPTS.
//
// Gabriel 2026-08: "the engine is giving thursday calls to people that arent on
// pto the following week, that should not happen."
//
// THE DEFECT. runPrePtoPass sliced its candidate list to maxProviders BEFORE
// testing anything, and tryPlacePrePto is best-effort — it silently declines on
// the obligation cap, a stated provider cap, or any eligibility gate
// (post-call rest being the common one). So when a sliced candidate could not
// take the slot, the pass gave up and the Thursday fell through to the main
// loop, where ANY provider could take it — while other PTO-bound docs that week
// sat untried.
//
// On the live Paoli block three Thursdays leaked this way (Jones 8/13 C2,
// Kalawadia 8/20 C2, Mojica 10/8 C2) and EVERY leaking week had 2–5 pre-PTO
// docs to choose from. It was never a supply problem.
//
// Calendar: Thu 2026-08-13 is the Thursday before the week of Mon 2026-08-17
// (thursdayBeforeWeekOf → mondayOfWeek − 4).
import { describe, it, expect } from 'vitest';
import { solve } from './solve';
import { buildCtx, prov, callSlot } from './__fixtures__/buildContext';
import { CallPatternDocSchema } from './callPattern';
import type { AvailabilityEntry, GenerationContext, SeedAssignment } from './genTypes';

const WED = '2026-08-12';
const THU = '2026-08-13';
const PTO_WEEK_START = '2026-08-17';   // the Monday after THU

// PTO starting the following Monday ⇒ this provider is pre-PTO for THU.
const goingOnPto = (): AvailabilityEntry[] => [{
  availability_type: 'pto', start_date: PTO_WEEK_START, end_date: '2026-08-21',
  approval_status: 'approved',
}];

// A seeded Wednesday C1 blocks Thursday (classic pattern C1 → blocks +1), so
// this provider is post-call on THU and tryPlacePrePto must decline them.
const wednesdayCall = (pid: string): SeedAssignment => ({
  slot_date: WED, provider_id: pid, shift_type_code: 'C1',
  shift_type_category: 'call', derived_day_type: 'weekday',
});

/** Four pre-PTO docs; the first TWO in id order are post-call on Thursday.
 *  `filler` is a doc with no PTO at all — the one who used to poach the leak. */
function ctx(): GenerationContext {
  return buildCtx(
    [callSlot('thu-c1', THU, 'C1'), callSlot('thu-c2', THU, 'C2')],
    [prov('p1'), prov('p2'), prov('p3'), prov('p4'), prov('zfiller')],
    {
      parLevel: 5,
      availByPid: new Map([
        ['p1', goingOnPto()], ['p2', goingOnPto()],
        ['p3', goingOnPto()], ['p4', goingOnPto()],
      ]),
      seedAssignments: [wednesdayCall('p1'), wednesdayCall('p2')],
    },
  );
}

const bySlot = (plan: ReturnType<typeof solve>) =>
  new Map(plan.assignments.map(a => [a.slot_id, a]));

describe('pre-PTO Thursday exhausts its candidates', () => {
  it('keeps trying PTO-bound docs past the ones that decline', () => {
    const m = bySlot(solve(ctx()));
    // p1/p2 are post-call and must not be here at all.
    expect(['p1', 'p2']).not.toContain(m.get('thu-c1')?.provider_id);
    expect(['p1', 'p2']).not.toContain(m.get('thu-c2')?.provider_id);
    // Both Thursday calls went to PTO-bound docs — p3 and p4, in id order.
    expect(m.get('thu-c1')?.provider_id).toBe('p3');
    expect(m.get('thu-c2')?.provider_id).toBe('p4');
    expect(m.get('thu-c1')?.source).toBe('pre-pto-thursday');
    expect(m.get('thu-c2')?.source).toBe('pre-pto-thursday');
  });

  it('the doc with NO PTO does not get a Thursday call', () => {
    // The symptom Gabriel reported. Before the fix `zfiller` took one of these
    // via the main loop, because the pass had discarded p3/p4 unasked.
    const placed = solve(ctx()).assignments
      .filter(a => a.slot_date === THU && a.shift_type_category === 'call')
      .map(a => a.provider_id);
    expect(placed).not.toContain('zfiller');
  });

  it('still honours maxProviders — it caps placements, not attempts', () => {
    // Needs MORE pass codes than maxProviders to be discriminating: the classic
    // pass states codes ['C1','C2'] with maxProviders 2, so with only two codes
    // the cap can never bind and the test would pass with the cap deleted. This
    // synthetic doc lists three codes against a cap of two.
    const doc = CallPatternDocSchema.parse({
      version: 1, spans: [], blocks: [],
      dayChains: [],
      placementPasses: [{ kind: 'pre_pto', relativeDay: 'thursday_prior_week',
                          codes: ['C1', 'C2', 'C3'], maxProviders: 2, enabled: true }],
      reliefPass: { enabled: false, dayTypes: ['weekday'] },
      optimizerMovableDayTypes: [],
    });
    const plan = solve(buildCtx(
      [callSlot('thu-c1', THU, 'C1'), callSlot('thu-c2', THU, 'C2'),
       callSlot('thu-c3', THU, 'C3')],
      [prov('p1'), prov('p2'), prov('p3'), prov('p4')],
      {
        parLevel: 4,
        callPattern: doc,
        availByPid: new Map([
          ['p1', goingOnPto()], ['p2', goingOnPto()],
          ['p3', goingOnPto()], ['p4', goingOnPto()],
        ]),
      },
    ));
    const prePto = plan.assignments.filter(a => a.source === 'pre-pto-thursday');
    expect(prePto).toHaveLength(2);
  });

  it('leaves the Thursday to the main loop when NO pre-PTO doc can take it', () => {
    // Exhaustion is not coercion: with every PTO-bound doc post-call, the slot
    // legitimately falls through rather than being forced onto someone unfit.
    const plan = solve(buildCtx(
      [callSlot('thu-c1', THU, 'C1')],
      [prov('p1'), prov('p2'), prov('zfiller')],
      {
        parLevel: 3,
        availByPid: new Map([['p1', goingOnPto()], ['p2', goingOnPto()]]),
        seedAssignments: [wednesdayCall('p1'), wednesdayCall('p2')],
      },
    ));
    const c1 = plan.assignments.find(a => a.slot_id === 'thu-c1');
    expect(c1?.provider_id).toBe('zfiller');
    expect(c1?.source).not.toBe('pre-pto-thursday');
  });
});
