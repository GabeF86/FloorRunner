// The generation contract, in English.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// The Rules screen used to be a CRUD editor over `rule_definitions`, which is
// a VALIDATOR — it checks a finished schedule and has never been consulted
// during generation. So the one page called "Rules" showed you everything the
// engine does NOT read, and nothing it does. Gabriel asked for the opposite: a
// view of the structure the engine actually obeys.
//
// Everything below is DERIVED from live data. There is no second copy of the
// truth here to drift — if the pattern doc changes, this description changes
// with it, and if it says the engine does something, the engine does it.
//
// ── WHAT ACTUALLY GOVERNS GENERATION ───────────────────────────────────────
// Three sources, none of them rule_definitions:
//   1. call_patterns.definition — the CallPatternDoc: chains, spans, fill
//      order, placement passes, relief, obligation bands.
//   2. shift_types — which codes exist, which force a post-call day off,
//      their call rank and burden weight.
//   3. Invariants compiled into the engine itself — PTO always blocks, no
//      cross-site double-booking, burden distributes per FTE. These are not
//      configurable ON PURPOSE, and saying so out loud is the point of the
//      last section.

import type { CallPatternDoc, DayType } from './rulesEngine/callPattern';

export interface LogicStatement {
  /** One sentence a chief can check against how the group actually runs. */
  text: string;
  /** Where this comes from, so a wrong statement can be traced to its source. */
  source?: string;
}

export interface LogicSection {
  key: string;
  title: string;
  /** Shown when the section has nothing in it — never a bare "none". */
  emptyNote: string;
  statements: LogicStatement[];
}

const DAY_LABEL: Record<DayType, string> = {
  weekday: 'Mon–Thu',
  friday: 'Friday',
  saturday: 'Saturday',
  sunday: 'Sunday',
  federal_holiday: 'a federal holiday',
  major_holiday: 'a major holiday',
};

/** Weekday anchors resolve to real day names; the rest stay relative. */
const WEEK_ORDER = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const ANCHOR_INDEX: Partial<Record<DayType, number>> = { friday: 5, saturday: 6, sunday: 0 };

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * "Sunday", or "2 days later" when the anchor is not a specific weekday.
 *
 * An offset is only nameable when the anchor is one — `weekday` covers four
 * days, so "+1 from a weekday" has no single name and saying one would be a
 * lie dressed as helpfulness.
 */
export function offsetLabel(anchor: DayType, offset: number): string {
  if (offset === 0) return 'the same day';
  const base = ANCHOR_INDEX[anchor];
  if (base !== undefined) {
    const idx = (((base + offset) % 7) + 7) % 7;
    return cap(WEEK_ORDER[idx]);
  }
  const n = Math.abs(offset);
  const unit = n === 1 ? 'day' : 'days';
  return offset > 0 ? `${n} ${unit} later` : `${n} ${unit} earlier`;
}

function fteNote(minFte?: number): string {
  // minFte: 0 is behaviourally identical to omitting it, so it is not worth
  // a clause that implies a condition exists where none does.
  if (minFte === undefined || minFte <= 0) return '';
  return ` — but only for providers at ${minFte} FTE or above`;
}

/** Blocks: the weekend/holiday chains, the backbone of the call schedule. */
function blockSection(doc: CallPatternDoc): LogicSection {
  const statements: LogicStatement[] = [];
  for (const block of doc.blocks) {
    const anchor = block.anchorDayType;
    for (const chain of block.chains) {
      const parts = chain.links.map(l =>
        `${l.code} on ${offsetLabel(anchor, l.offset)}${fteNote(l.minFte)}`);
      statements.push({
        text: `${DAY_LABEL[anchor]} ${chain.trigger} — the same provider also takes ${listOf(parts)}.`,
        source: `pattern block, ${anchor} anchor`,
      });
    }
  }
  return {
    key: 'chains',
    title: 'Call chains',
    emptyNote:
      'No chains are defined, so each call slot is filled independently — '
      + 'nothing pulls a neighbouring day along with it.',
    statements,
  };
}

/** Day chains: the D-shifts that hang off a call, and the days they block. */
function dayChainSection(doc: CallPatternDoc): LogicSection {
  const statements: LogicStatement[] = [];
  for (const chain of doc.dayChains) {
    const days = listOf(chain.dayTypes.map(d => DAY_LABEL[d]));
    for (const l of chain.links ?? []) {
      statements.push({
        text: `A ${chain.trigger} on ${days} puts the same provider on ${l.code} `
          + `${relative(l.offset)}${l.unlessCallWithinDays
            ? ` — unless they have another call within ${l.unlessCallWithinDays} days`
            : ''}.`,
        source: 'pattern dayChain',
      });
    }
    for (const b of chain.blocks ?? []) {
      statements.push({
        text: `A ${chain.trigger} on ${days} leaves that provider unavailable ${relative(b.offset)}.`,
        source: 'pattern dayChain block',
      });
    }
  }
  return {
    key: 'daychains',
    title: 'Pre-call and post-call days',
    emptyNote: 'No pre- or post-call day shifts are attached to call assignments.',
    statements,
  };
}

function relative(offset: number): string {
  if (offset === 0) return 'the same day';
  const n = Math.abs(offset);
  if (n === 1) return offset > 0 ? 'the day after' : 'the day before';
  return offset > 0 ? `${n} days after` : `${n} days before`;
}

/** Post-call rest — a column on the shift type, not a rule. */
export interface ShiftTypeFacts {
  code: string;
  category: string;
  requires_post_call_rule?: boolean | null;
  call_rank?: number | null;
  is_overlay?: boolean | null;
  /** Free text: what the shift actually covers. NOT read by the engine. */
  coverage_notes?: string | null;
}

export interface LogicSectionWithKind extends LogicSection {
  /**
   * 'enforced' — derived from data the engine reads, so it cannot be wrong
   * without the schedule also being wrong.
   * 'described' — written by a human. True, load-bearing, and invisible to
   * the engine. The distinction is shown on the page, because a reader who
   * cannot tell them apart will assume the engine acts on prose it never sees.
   */
  kind: 'enforced' | 'described';
}

function restSection(shiftTypes: readonly ShiftTypeFacts[]): LogicSection {
  const forcing = shiftTypes.filter(t => t.requires_post_call_rule).map(t => t.code).sort();
  const callCodes = shiftTypes.filter(t => t.category === 'call').map(t => t.code).sort();
  const notForcing = callCodes.filter(c => !forcing.includes(c));

  const statements: LogicStatement[] = [];
  if (forcing.length > 0) {
    statements.push({
      text: `Working ${listOf(forcing)} forces the next day off. The engine will not place `
        + 'any assignment on that day, and it holds for manual and seeded assignments too.',
      source: 'shift_types.requires_post_call_rule',
    });
  }
  if (notForcing.length > 0) {
    statements.push({
      text: `${listOf(notForcing)} do not force a day off — they are not overnight in-house call.`,
      source: 'shift_types.requires_post_call_rule',
    });
  }
  return {
    key: 'rest',
    title: 'Post-call rest',
    emptyNote: 'No shift type at this site forces a post-call day off.',
    statements,
  };
}

/**
 * What each call actually covers, in the words of whoever runs the service.
 *
 * This is the only section NOT derived from what the engine reads, and it
 * exists because the most load-bearing facts about a call are often in nobody's
 * schema. Paoli's C2 cross-covers neuro on Friday nights — which is WHY that
 * site has no Friday C3 template. A reader can see the absence in the slate but
 * not the reason, and could reasonably "fix" it by adding one.
 */
function coverageSection(shiftTypes: readonly ShiftTypeFacts[]): LogicSection {
  const statements: LogicStatement[] = shiftTypes
    .filter(t => t.coverage_notes?.trim())
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }))
    .map(t => ({ text: `${t.code} — ${t.coverage_notes!.trim()}`, source: 'coverage note' }));

  return {
    key: 'coverage',
    title: 'What each call covers',
    emptyNote:
      'No coverage notes recorded for this site. These describe what a shift actually '
      + 'involves — beeper versus in-house, home call, cross-coverage of another service — '
      + 'and are worth writing down: the engine cannot infer them, and a slate that looks '
      + 'like a gap is sometimes deliberate cross-coverage.',
    statements,
  };
}

/** Fill order, relief, placement passes — how the engine works through a block. */
function orderSection(doc: CallPatternDoc): LogicSection {
  const statements: LogicStatement[] = [];

  if (doc.dayTypeFillOrder?.length) {
    statements.push({
      text: `Days are filled in this order: ${doc.dayTypeFillOrder.join(' → ')}. `
        + 'The hardest days to staff go first, while the pool is widest.',
      source: 'pattern dayTypeFillOrder',
    });
  }
  if (doc.callFillOrder === 'call_rank') {
    statements.push({
      text: 'Within a day, call codes are filled in call-rank order rather than alphabetically.',
      source: 'pattern callFillOrder',
    });
  }
  for (const pass of doc.placementPasses) {
    if (pass.kind !== 'pre_pto') continue;
    statements.push({
      text: pass.enabled
        ? `Before the main fill, up to ${pass.maxProviders} `
          + `${pass.maxProviders === 1 ? 'provider' : 'providers'} heading into leave are placed `
          + `on ${listOf(pass.codes)} the Thursday of the prior week, so their call lands before `
          + 'they go rather than stranding it.'
        : 'The pre-leave placement pass is switched off.',
      source: 'pattern placementPass',
    });
  }
  if (doc.reliefPass) {
    statements.push({
      text: doc.reliefPass.enabled
        ? `A relief pass runs on ${listOf(doc.reliefPass.dayTypes.map(d => DAY_LABEL[d]))}.`
        : 'The relief pass is switched off.',
      source: 'pattern reliefPass',
    });
  }
  if (doc.optimizerMovableDayTypes.length > 0) {
    statements.push({
      text: `After the first pass, the optimizer may move assignments on `
        + `${listOf(doc.optimizerMovableDayTypes.map(d => DAY_LABEL[d]))} to improve fairness. `
        + 'Everything else it treats as fixed.',
      source: 'pattern optimizerMovableDayTypes',
    });
  }
  return {
    key: 'order',
    title: 'How the engine works through a block',
    emptyNote: 'The engine fills in its default order with no extra passes.',
    statements,
  };
}

/** Obligations — what a provider owes, and where the number comes from. */
function obligationSection(doc: CallPatternDoc, parLevel: number | null): LogicSection {
  const statements: LogicStatement[] = [];

  if (doc.obligations?.bands?.length) {
    // Stated bands OVERRIDE the par formula — see the obligation-tiers work.
    const bands = [...doc.obligations.bands].sort((a, b) => b.minFte - a.minFte);
    bands.forEach((band, i) => {
      const calls = band.calls.map(c => `${c.count} × ${c.code} on ${DAY_LABEL[c.dayType as DayType] ?? c.dayType}`);
      // The lowest band is a catch-all. Printing it as "at 0 FTE or above"
      // states a threshold that is not really a threshold, and reads as a
      // data entry error rather than as the bottom tier it is.
      const who = i === bands.length - 1 && band.minFte <= 0
        ? 'Every other provider'
        : `A provider at ${band.minFte} FTE or above`;
      statements.push({
        text: `${who} owes ${listOf(calls)} per block.`,
        source: 'pattern obligations band',
      });
    });
    statements.push({
      text: 'These stated tiers are the obligation. They are not derived from the par level, '
        + 'and they take precedence over it.',
      source: 'pattern obligations',
    });
  } else if (parLevel) {
    statements.push({
      text: `Obligation is the par level: each call type's yearly slots divided by ${parLevel}, `
        + 'scaled by the provider’s FTE.',
      source: 'sites.call_par_level',
    });
    statements.push({
      text: 'When the pool’s total FTE is below par, obligations deliberately under-cover the '
        + 'year — the remainder is the paid-pickup layer, not a gap to be filled by quota.',
      source: 'par-authoritative, 2026-07-24',
    });
  }
  return {
    key: 'obligations',
    title: 'What a provider owes',
    emptyNote: 'No par level is set for this site, so obligations cannot be computed.',
    statements,
  };
}

/**
 * The invariants compiled into the engine.
 *
 * Hard-coded on purpose and listed here because a page claiming to show what
 * the engine obeys would be misleading if it only showed the CONFIGURABLE
 * part. These hold at every site regardless of any setting.
 */
function invariantSection(): LogicSection {
  return {
    key: 'invariants',
    title: 'Always true, at every site',
    emptyNote: '',
    statements: [
      { text: 'Approved and PENDING time off always blocks an assignment. A pending request is '
          + 'treated as real until it is denied.', source: 'clinical invariant 2' },
      { text: 'Nobody is booked at two sites on the same day, checked against every published '
          + 'schedule across the group.', source: 'clinical invariant 3' },
      { text: 'A post-call day off is honoured even when the call was entered by hand rather '
          + 'than generated.', source: 'clinical invariant 1' },
      { text: 'When a chained shift cannot be placed — leave, a cross-site booking — it is left '
          + 'unassigned AND recorded, never quietly dropped.', source: 'clinical invariant 4' },
      { text: 'Call burden is distributed per FTE, not per head.', source: 'clinical invariant 5' },
      { text: 'Validation never reports a schedule clean because it failed to run.',
        source: 'clinical invariant 6' },
    ],
  };
}

/** "A, B and C" — an Oxford-free list that reads as a sentence. */
export function listOf(items: readonly string[]): string {
  if (items.length === 0) return 'nothing';
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export interface SchedulingLogicInput {
  doc: CallPatternDoc;
  shiftTypes: readonly ShiftTypeFacts[];
  parLevel: number | null;
}

/**
 * Every section, in reading order, each labelled with whether the engine acts
 * on it.
 *
 * Coverage notes come LAST on purpose. They are the only descriptive section,
 * and putting prose among the derived sections would blur the one distinction
 * this page has to keep sharp.
 */
export function describeSchedulingLogic(input: SchedulingLogicInput): LogicSectionWithKind[] {
  const enforced = (s: LogicSection): LogicSectionWithKind => ({ ...s, kind: 'enforced' });
  return [
    enforced(blockSection(input.doc)),
    enforced(dayChainSection(input.doc)),
    enforced(restSection(input.shiftTypes)),
    enforced(orderSection(input.doc)),
    enforced(obligationSection(input.doc, input.parLevel)),
    enforced(invariantSection()),
    { ...coverageSection(input.shiftTypes), kind: 'described' },
  ];
}
