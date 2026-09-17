/* ───────────────────────────────────────────────────────────────────────────
 * What the master sheet's codes mean.
 *
 * Every entry below was derived from the September–November 2026 export by
 * measuring the sheet, not by reading the code names: adjacency (what follows
 * what), weekday distribution, how many people hold a code concurrently, and
 * whose rows carry it. Where the measurement was decisive the entry is marked
 * `sure`; where a time or a target had to be assumed it is marked `assumed`
 * and the assumption is stated. Nothing here is a guess dressed as a fact.
 *
 * ── DECIDED BY GABRIEL (2026-09-15) ────────────────────────────────────────
 * • The trailing asterisk is a NOTE attached to an assignment. It carries no
 *   scheduling meaning, so the parser strips it and this table ignores it.
 * • `Vac` is PTO.
 * • `1. Vac` is a WAITLIST — requested, not approved. It imports as PTO with
 *   approval_status 'pending', which under clinical invariant 2 still blocks
 *   scheduling. That is the correct behaviour: an un-adjudicated request must
 *   not be scheduled over.
 * • `pOff` is the contracted non-working days of sub-1.0-FTE physicians. It is
 *   work-pattern structure, NOT leave, and must never draw down a PTO balance.
 * • `BAD1`/`BAD2` are the 3-for-2 split across the three 0.67 FTE physicians —
 *   confirmed exactly by the data: `LankBADOff` is held by AROB, BANS and DOHJ
 *   and by nobody else, and all three are stored at 0.67 FTE. Two positions,
 *   three people, one off at a time.
 * • `JD` is jury duty.
 *
 * ── THE CODE OWNS THE SITE ─────────────────────────────────────────────────
 * `site` below is where the WORK happens, which is often not the section the
 * row sits in: 0 of 23 `pRoth1` cells are worked by a Rothman-homed physician,
 * and `OrthoMD2`/`OrthoMDLate` are staffed almost entirely off the Bryn Mawr
 * roster. See plan.ts.
 * ─────────────────────────────────────────────────────────────────────────── */

import type { CodeMapping } from './plan';

/** How well-founded a mapping is. `assumed` entries are the review list. */
export type Certainty = 'sure' | 'assumed';

export interface DictionaryEntry extends CodeMapping {
  certainty: Certainty;
  /** Stated for every `assumed` entry: what was assumed, and why. */
  assumption?: string;
}

/** A shift type the import must create, keyed by site + code. */
export interface ShiftTypeSpec {
  site: string;
  code: string;
  name: string;
  category: 'call' | 'regular';
  startTime: string;
  endTime: string;
  callRank: number | null;
  requiresPostCall: boolean;
  countsTowardCallBurden: boolean;
  /** True where the times are an assumption rather than read off the sheet. */
  timesAssumed: boolean;
}

// ── House conventions, taken from the two sites already configured ─────────
// Paoli and Lankenau both store first call as 15:00→07:00 with a post-call
// day, and a 07:00→07:00 or 07:00→19:00 second call without one. Where the
// sheet proves a ROLE but states no HOURS, these are the hours used, and the
// entry is marked assumed.
const CALL_1 = { start: '15:00', end: '07:00' };
const CALL_2 = { start: '07:00', end: '19:00' };
const WEEKEND_24 = { start: '07:00', end: '07:00' };
const DAY_8 = { start: '07:00', end: '15:00' };
const DAY_10 = { start: '07:00', end: '17:00' };

/** Clock codes that state their own hours — `07_15`, `pLank2p-8p`. Parsed
 *  rather than tabulated, so a new one in next month's sheet needs no edit. */
export function parseClockCode(code: string): { start: string; end: string } | null {
  // 07_15, 11_19  →  07:00-15:00, 11:00-19:00
  const underscore = /^(\d{1,2})_(\d{1,2})$/.exec(code);
  if (underscore) {
    return {
      start: `${underscore[1].padStart(2, '0')}:00`,
      end: `${underscore[2].padStart(2, '0')}:00`,
    };
  }
  // pLank7a-3p, pLank9a-4p, pLank2p-8p, pLank10a-8p
  const ampm = /^pLank(\d{1,2})([ap])-(\d{1,2})([ap])$/.exec(code);
  if (ampm) {
    const to24 = (h: string, mer: string) => {
      let n = Number(h);
      if (mer === 'p' && n !== 12) n += 12;
      if (mer === 'a' && n === 12) n = 0;
      return `${String(n).padStart(2, '0')}:00`;
    };
    return { start: to24(ampm[1], ampm[2]), end: to24(ampm[3], ampm[4]) };
  }
  return null;
}

// ── Leave and non-working codes (whole group) ──────────────────────────────

const LEAVE: DictionaryEntry[] = [
  { code: 'Vac', kind: 'unavailable', availabilityType: 'pto',
    certainty: 'sure', note: 'Approved vacation' },
  // Stored as PTO with approval_status 'waitlisted'. The engine dismisses only
  // 'denied' and 'canceled', so a waitlisted row still BLOCKS — which is the
  // behaviour a pending request needs, and it keeps the request's real status
  // rather than flattening it to approved.
  { code: '1. Vac', kind: 'unavailable', availabilityType: 'pto',
    certainty: 'sure', note: 'WAITLISTED vacation — requested, not approved' },
  { code: 'Sick', kind: 'unavailable', availabilityType: 'sick',
    certainty: 'sure', note: 'Sick' },
  { code: 'JD', kind: 'unavailable', availabilityType: 'jury_duty',
    certainty: 'sure', note: 'Jury duty' },
  { code: 'Boards', kind: 'unavailable', availabilityType: 'unavailable',
    certainty: 'sure', note: 'Board examination — no dedicated type, and it blocks' },
  // 'admin' is deliberately NOT in BLOCKING_AVAIL: an administrative day is a
  // working day, the physician is simply not in an OR. Recording it as leave
  // would both block them wrongly and overstate time off.
  { code: 'Admin', kind: 'unavailable', availabilityType: 'admin',
    certainty: 'sure', note: 'Administrative day — working, but not in a room' },
  // Work-pattern days off. Recorded so the board can show them, with a type
  // that is NOT pto — these are contracted days, not leave.
  { code: 'pOff', kind: 'off', availabilityType: 'unavailable',
    certainty: 'sure', note: 'Contracted day off (sub-1.0 FTE work pattern)' },
  { code: 'LankBADOff', kind: 'off', availabilityType: 'unavailable',
    certainty: 'sure', note: 'Lankenau BAD rotation off week — the 3-for-2 split '
      + 'across the three 0.67 FTE physicians' },
  { code: 'bmhARMoff', kind: 'off', availabilityType: 'unavailable',
    certainty: 'assumed', note: 'Bryn Mawr ARM block off',
    assumption: 'Held by one physician (PEKA) in multi-day blocks that run through '
      + 'weekends, and distinct from his own separate Vac rows. Treated as a '
      + 'scheduled non-working block. The expansion of "ARM" is unknown.' },
];

// ── Post-call days ─────────────────────────────────────────────────────────
// These create NOTHING. A post-call day is derived from the call shift's
// requires_post_call_rule; the absence of an assignment is the day off, and
// inventing a zero-hour shift would put a phantom row on every grid.
// The one exception is Paoli's pPaoli1, which is the WORKING 07:00–12:00 D1
// shift and is listed with the day codes below.
const POST_CALL: DictionaryEntry[] = [
  'PostC1', 'PostC2', 'pPaoliPC', 'pRiddPC', 'pLankP1st', 'pLankP2nd',
  'pLankP3rd', 'pLankPostICU',
].map(code => ({
  code, kind: 'post_call' as const, shiftCode: null, certainty: 'sure' as const,
  note: 'Post-call day off — derived from the call shift, not stored as one',
}));

// ── Per-site work codes ────────────────────────────────────────────────────

const PAOLI: DictionaryEntry[] = [
  // Onto Paoli's 24 EXISTING shift types — no new types at this site.
  { code: 'pPaoliCall', kind: 'call', site: 'PH', shiftCode: 'C1', certainty: 'sure',
    note: '1/date on 54 of 62 dates, flat across all weekdays, →pPaoliPC 37/51' },
  { code: 'pPaoliLate', kind: 'call', site: 'PH', shiftCode: 'C2', certainty: 'sure',
    note: '1/date on 55 of 62 dates; pPaoli1 follows it 33/35, and D1 is literally '
      + '"Post 2nd Call". Weekends carry exactly Call+Late+Neuro = C1+C2+C3' },
  { code: 'pPaoliNeuro', kind: 'call', site: 'PH', shiftCode: 'C3', certainty: 'sure',
    note: 'Sat 8 / Sun 8, zero weekdays; 8 providers × exactly 2 dates each' },
  { code: 'pPaoli1', kind: 'day', site: 'PH', shiftCode: 'D1', certainty: 'sure',
    note: 'Preceded by pPaoliLate 33/35 — D1 "Post 2nd Call", a WORKING 07:00–12:00' },
  { code: 'pPaoli2', kind: 'day', site: 'PH', shiftCode: 'D2', certainty: 'sure',
    note: 'Followed by pPaoliCall 24/33 — D2 "Pre-1st Call"' },
  { code: 'pPaoli3', kind: 'day', site: 'PH', shiftCode: 'D3', certainty: 'assumed',
    assumption: 'Followed by pPaoliLate only 40% of the time, against 94% and 73% '
      + 'for D1 and D2. The slot is clearly also used as a plain day.' },
  { code: 'pPaoli4', kind: 'day', site: 'PH', shiftCode: 'D4', certainty: 'assumed',
    assumption: 'Ordinal alignment only. Fill depth declines 35/33/30/27/21/12/6/1 '
      + 'across pPaoli1–8, the shape of a ranked ladder matching D1–D8.' },
  { code: 'pPaoli5', kind: 'day', site: 'PH', shiftCode: 'D5', certainty: 'assumed',
    assumption: 'Ordinal alignment only.' },
  { code: 'pPaoli6', kind: 'day', site: 'PH', shiftCode: 'D6', certainty: 'assumed',
    assumption: 'Ordinal alignment only.' },
  { code: 'pPaoli7', kind: 'day', site: 'PH', shiftCode: 'D7', certainty: 'assumed',
    assumption: 'Ordinal alignment only.' },
  { code: 'pPaoli8', kind: 'day', site: 'PH', shiftCode: 'D8', certainty: 'assumed',
    assumption: 'Used once (09/15). D8 is is_active=false and the import reactivates it.' },
  { code: 'pPaoliDay', kind: 'day', site: 'PH', shiftCode: '7-3', certainty: 'assumed',
    assumption: 'Held by a group disjoint from the call rotation, running alongside '
      + 'pPaoli1–8. No hours in the sheet; pointed at the existing generic 7-3.' },
  { code: 'pPaoli_LDay', kind: 'day', site: 'PH', shiftCode: '7-5', certainty: 'assumed',
    assumption: 'Same day-only group, never a Monday, clusters Wed/Thu. The "L" is '
      + 'unexplained; pointed at the existing generic 7-5 on the reading that it is '
      + 'the longer day.' },
];

const BMH: DictionaryEntry[] = [
  { code: 'C1', kind: 'call', site: 'BMH', shiftCode: 'C1', certainty: 'sure',
    note: 'Filled on 62/62 dates; PostC1 count equals C1 minus its Fri+Sat instances exactly' },
  { code: 'C2', kind: 'call', site: 'BMH', shiftCode: 'C2', certainty: 'sure',
    note: 'Filled on 62/62 dates; same exact arithmetic against PostC2' },
  { code: 'C3', kind: 'call', site: 'BMH', shiftCode: 'C3', certainty: 'sure',
    note: '1 on each of the 44 weekdays, 0 on all 18 weekend days' },
  { code: 'Neuro', kind: 'call', site: 'BMH', shiftCode: 'NEURO', certainty: 'sure',
    note: 'Sat 9 / Sun 9 only; C3 ∪ Neuro is exactly one person every day — the same '
      + 'position under two labels' },
  { code: 'dayBMH', kind: 'day', site: 'BMH', shiftCode: 'DAY', certainty: 'assumed',
    assumption: 'Held only by the physicians who also take call, 3–5 concurrent on a '
      + 'weekday. The sheet states no hours; imported as a 07:00–15:00 day.' },
];

const LANKENAU: DictionaryEntry[] = [
  { code: 'pLank1st', kind: 'call', site: 'LMC', shiftCode: 'C1', certainty: 'sure',
    note: '→pLankP1st 39/40. Onto the existing LMC C1 (15:00–07:00, post-call)' },
  // CORRECTED 2026-09-17 (Gabriel): this is C2, the weekend beeper call. The
  // import sent it to CC1 because its taker pool is exactly the six who also
  // hold the weekend cardiac backup — a wrong inference from a right
  // observation. The pool really is that narrow; it just does not make the
  // tier "cardiac first call". The sheet's post-call evidence stands and C2's
  // stored requires_post_call_rule=false was corrected to true.
  { code: 'pLank2nd', kind: 'call', site: 'LMC', shiftCode: 'C2', certainty: 'sure',
    note: '→pLankP2nd 41/43. Lankenau\'s 2nd call, the beeper' },
  { code: 'pLank3rd', kind: 'call', site: 'LMC', shiftCode: 'C3', certainty: 'sure',
    note: '→pLankP3rd 32/33. No existing LMC code; created.' },
  // UNRESOLVED 2026-09-17. Gabriel: "LMC doesn't have a C4 on the weekends" —
  // the weekend is C1, C2, CC2 and C3. But the sheet writes pLank4th on ten
  // weekend days, and every single holder is C1 the day before (10/10) and 7 of
  // 10 are C1 the day after. That reads as a HANDOFF LABEL on the partner of a
  // multi-day first-call stretch rather than a fifth position — in which case
  // it should create no assignment at all, because the person's C1 on the
  // adjacent days already records the call.
  //
  // Left mapping to C4 until that is confirmed. Dropping ten assignments on my
  // reading of an adjacency is not a thing to do quietly.
  { code: 'pLank4th', kind: 'call', site: 'LMC', shiftCode: 'C4', certainty: 'assumed',
    assumption: 'Gabriel says there is no C4 at Lankenau. Every pLank4th holder is '
      + 'C1 the day before, so this is probably a handoff label on the first-call '
      + 'partner rather than a position — but confirm before deleting ten '
      + 'assignments.' },
  { code: 'pLankCardBUp', kind: 'call', site: 'LMC', shiftCode: 'CC2', certainty: 'sure',
    note: 'Sat 8 / Sun 8 only, same six-physician pool, no post-call — the existing '
      + 'LMC "Cardiac Backup Call" exactly' },
  { code: 'pLankDay', kind: 'day', site: 'LMC', shiftCode: 'DAY', certainty: 'assumed',
    assumption: 'The call core\'s non-call weekday room. No hours in the sheet; '
      + 'imported as 07:00–15:00.' },
  { code: 'pLankICU', kind: 'day', site: 'LMC', shiftCode: 'ICU', certainty: 'assumed',
    assumption: 'Mon–Fri blocks followed by the next Monday off. Hours not stated; '
      + 'imported as a 07:00–17:00 day.' },
  { code: 'pLankOB', kind: 'day', site: 'LMC', shiftCode: 'OB', certainty: 'assumed',
    assumption: 'Three cells in two months, all covered by a Paoli physician. Hours '
      + 'not stated; imported as 07:00–15:00.' },
];

const RIDDLE: DictionaryEntry[] = [
  { code: 'pRiddCall', kind: 'call', site: 'RH', shiftCode: 'C1', certainty: 'sure',
    note: 'Exactly 1 holder on every populated date including weekends; →pRiddPC' },
  { code: 'pRiddLate', kind: 'call', site: 'RH', shiftCode: 'C2', certainty: 'assumed',
    assumption: 'Weekday-only, and pRiddDay1 follows it 11/13 — structurally Paoli\'s '
      + 'C2→D1. But unlike a true second call it does not run weekends, so it may be a '
      + 'late-stay room rather than call.' },
  { code: 'pRiddDay1', kind: 'day', site: 'RH', shiftCode: 'D1', certainty: 'assumed',
    assumption: 'Riddle\'s analogue of D1. Whether it is a shortened day like Paoli\'s '
      + '07:00–12:00 is unknown; imported as a full 07:00–15:00.' },
  { code: 'pRiddDay', kind: 'day', site: 'RH', shiftCode: 'DAY', certainty: 'assumed',
    assumption: 'The call rotation\'s generic non-call day. Hours not stated.' },
  { code: 'pRidd8', kind: 'day', site: 'RH', shiftCode: 'D8H', certainty: 'assumed',
    assumption: 'Up to five hold it at once, so it is NOT a room; holder sets are '
      + 'disjoint from pRidd10, so it reads as a contracted day LENGTH. Imported as '
      + 'eight hours, 07:00–15:00.' },
  { code: 'pRidd10', kind: 'day', site: 'RH', shiftCode: 'D10H', certainty: 'assumed',
    assumption: 'Same reasoning; imported as ten hours, 07:00–17:00.' },
];

const OTHER_SITES: DictionaryEntry[] = [
  { code: 'pRoth1', kind: 'day', site: 'RSH', shiftCode: 'R1', certainty: 'assumed',
    assumption: 'A Rothman position — 0 of 23 cells are worked by a Rothman-homed '
      + 'physician. Hours not stated.' },
  { code: 'pRoth2', kind: 'day', site: 'RSH', shiftCode: 'R2', certainty: 'assumed',
    assumption: 'Runs alongside pRoth1 on 13 dates, so a second parallel position. '
      + 'Hours not stated.' },
  { code: 'pJSCLate', kind: 'day', site: 'JSCNY', shiftCode: 'LATE', certainty: 'assumed',
    assumption: 'The only Jefferson Navy Yard code in the sheet; weekday-only, one '
      + 'position, no call. "Late" implies an evening finish but no hours are given; '
      + 'imported as 07:00–17:00.' },
  { code: 'OrthoMD2', kind: 'day', site: 'OSC', shiftCode: 'MD2', certainty: 'assumed',
    assumption: 'Staffed 17/18 off the Bryn Mawr roster and co-occurring with '
      + 'OrthoMDLate on every one of its dates, so two concurrent positions. The SITE '
      + 'is inferred from the code name — nothing in the sheet names it.' },
  { code: 'OrthoMDLate', kind: 'day', site: 'OSC', shiftCode: 'MDLATE', certainty: 'assumed',
    assumption: 'Same; one physician holds 17 of 21 and works nothing else all period.' },
];

/** Clock-time day codes — hours read straight off the code. */
function clockEntries(): DictionaryEntry[] {
  const out: DictionaryEntry[] = [];
  for (const code of ['07_13', '07_15', '07_16', '07_17', '07_19', '07_20', '11_19']) {
    out.push({
      code, kind: 'day', site: 'BMH', shiftCode: code.replace('_', '-'),
      certainty: 'sure', note: 'Hours read from the code',
    });
  }
  for (const code of ['pLank7a-3p', 'pLank7a-4p', 'pLank7a-5p', 'pLank7a-7p',
                      'pLank9a-4p', 'pLank9a-7p', 'pLank10a-8p', 'pLank2p-8p']) {
    out.push({
      code, kind: 'day', site: 'LMC', shiftCode: code.replace('pLank', ''),
      certainty: 'sure', note: 'Hours read from the code',
    });
  }
  return out;
}

export const DICTIONARY: DictionaryEntry[] = [
  ...LEAVE, ...POST_CALL, ...PAOLI, ...BMH, ...LANKENAU, ...RIDDLE,
  ...OTHER_SITES, ...clockEntries(),
];

/** Provider rows that are unfilled POSITIONS, not people. Their cells still
 *  create the slot — the position existed and nobody stood it — but no
 *  assignment. */
export const PLACEHOLDER_ROWS = new Set([
  'pBMOpen1', 'pLankOpen1', 'pPaoliOpen1', 'pPaoliOpen2', 'pPaoliOpen3',
  // BAD1/BAD2 are the two POSITIONS in the 3-for-2 split, not two physicians.
  'BAD1', 'BAD2',
]);

/** The shift types the import must create, derived from the dictionary so the
 *  two can never disagree about a code. Paoli is absent by design: every Paoli
 *  code maps onto a type that already exists. */
export function requiredShiftTypes(): ShiftTypeSpec[] {
  const NAMES: Record<string, string> = {
    'BMH|C1': 'First Call', 'BMH|C2': 'Second Call', 'BMH|C3': 'Third / Neuro Call',
    'BMH|NEURO': 'Neuro Call (weekend)', 'BMH|DAY': 'BMH OR Day',
    'LMC|C2': '2nd Call (beeper)', 'LMC|C3': '3rd Call',
    'LMC|C4': '4th Call (weekend)', 'LMC|DAY': 'Lankenau OR Day',
    'LMC|ICU': 'ICU Week', 'LMC|OB': 'OB Anesthesia',
    'RH|C1': 'Riddle First Call', 'RH|C2': 'Riddle Late / Second Call',
    'RH|D1': 'Post-Late Day', 'RH|DAY': 'Riddle Day',
    'RH|D8H': 'Riddle 8-Hour Day', 'RH|D10H': 'Riddle 10-Hour Day',
    'RSH|R1': 'Rothman Position 1', 'RSH|R2': 'Rothman Position 2',
    'JSCNY|LATE': 'Navy Yard Late', 'OSC|MD2': 'Ortho MD 2', 'OSC|MDLATE': 'Ortho MD Late',
  };
  const CALL_SPECS: Record<string, { rank: number; post: boolean; hours: { start: string; end: string } }> = {
    'BMH|C1': { rank: 0, post: true, hours: CALL_1 },
    'BMH|C2': { rank: 1, post: true, hours: CALL_2 },
    'BMH|C3': { rank: 2, post: false, hours: CALL_2 },
    'BMH|NEURO': { rank: 2, post: false, hours: WEEKEND_24 },
    // Lankenau's real structure, stated by Gabriel 2026-09-17 — no longer
    // inferred, so these are facts rather than house defaults:
    //   C1, C2  weekdays 15:00-07:00, and the pair takes the post-call day off
    //   C3      07:00-19:00 in house, then beeper to 07:00. NOT a day off —
    //           first out the next day but still working it (early_out).
    //   CC2     the weekend cardiac backup beeper
    'LMC|C1': { rank: 0, post: true, hours: CALL_1 },
    'LMC|C2': { rank: 1, post: true, hours: CALL_1 },
    'LMC|C3': { rank: 2, post: false, hours: { start: '07:00', end: '19:00' } },
    'LMC|CC2': { rank: 3, post: false, hours: WEEKEND_24 },
    'LMC|C4': { rank: 4, post: false, hours: WEEKEND_24 },
    'RH|C1': { rank: 0, post: true, hours: CALL_1 },
    'RH|C2': { rank: 1, post: false, hours: CALL_2 },
  };
  const TEN_HOUR = new Set(['RH|D10H', 'LMC|ICU', 'JSCNY|LATE']);

  const specs = new Map<string, ShiftTypeSpec>();
  for (const e of DICTIONARY) {
    if (!e.site || !e.shiftCode) continue;
    if (e.site === 'PH') continue;                    // already configured
    const key = `${e.site}|${e.shiftCode}`;
    if (specs.has(key)) continue;

    const clock = parseClockCode(e.code);
    const call = CALL_SPECS[key];
    const hours = clock ?? call?.hours ?? (TEN_HOUR.has(key) ? DAY_10 : DAY_8);

    specs.set(key, {
      site: e.site,
      code: e.shiftCode,
      name: NAMES[key] ?? (clock ? `${hours.start}–${hours.end}` : e.shiftCode),
      category: e.kind === 'call' ? 'call' : 'regular',
      startTime: hours.start,
      endTime: hours.end,
      callRank: call?.rank ?? null,
      requiresPostCall: call?.post ?? false,
      countsTowardCallBurden: e.kind === 'call',
      timesAssumed: !clock,
    });
  }
  return [...specs.values()].sort((a, b) =>
    a.site.localeCompare(b.site) || a.code.localeCompare(b.code));
}

/** Everything the reviewer should check before trusting the import. */
export function assumptions(): Array<{ code: string; assumption: string }> {
  return DICTIONARY
    .filter(e => e.certainty === 'assumed' && e.assumption)
    .map(e => ({ code: e.code, assumption: e.assumption! }));
}
