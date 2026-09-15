// A closed vocabulary of changes to a call pattern, and a way to see what one
// would do before doing it.
//
// ── WHY NOT JUST LET SOMETHING WRITE THE DOCUMENT ──────────────────────────
// The obvious design for "change the schedule structure in plain English" is
// to have a model emit a new CallPatternDoc. Rejected, for a reason specific
// to this system: an invalid pattern does NOT fail loudly. The engine parses
// it with a strict schema and silently falls back to CLASSIC_PATTERN when it
// does not match, so a bad write does not break — it quietly schedules
// something nobody asked for, at a site that looks configured.
//
// A whole-document rewrite also has no blast radius. A proposal meant to touch
// the Saturday C1 chain can silently drop the Friday block, and a reviewer
// reading English would never see the omission.
//
// So changes are EDITS: each one names its target explicitly, applies
// deterministically, and fails when the target is not there. A model proposes
// edits; it never writes the document. What reaches the schema is always the
// result of code applying a named operation to a known-good doc.
//
// ── FAIL, DO NOT NO-OP ─────────────────────────────────────────────────────
// Every operation below errors when its target is missing or already present.
// Silently doing nothing is the worst outcome here: the reviewer sees an empty
// diff, reads it as "no change needed", and the misunderstanding survives.

import {
  CallPatternDocSchema,
  type CallPatternDoc,
  type DayType,
} from './rulesEngine/callPattern';
import { describeSchedulingLogic, type ShiftTypeFacts } from './schedulingLogic';

export type PatternEdit =
  /** "Saturday C1 should also put the same provider on C2 on Sunday." */
  | { op: 'add_block_link'; anchorDayType: DayType; trigger: string; code: string; offset: number; minFte?: number }
  | { op: 'remove_block_link'; anchorDayType: DayType; trigger: string; code: string; offset: number }
  /** A trigger that has no chain on this anchor yet. */
  | { op: 'add_block_chain'; anchorDayType: DayType; trigger: string; links: Array<{ code: string; offset: number; minFte?: number }> }
  | { op: 'remove_block_chain'; anchorDayType: DayType; trigger: string }
  /** Raise, lower or clear the FTE floor on one link. */
  | { op: 'set_block_link_min_fte'; anchorDayType: DayType; trigger: string; code: string; offset: number; minFte: number | null };

export type EditResult =
  | { ok: true; doc: CallPatternDoc }
  | { ok: false; error: string };

/** Deep copy so an edit can never mutate the document it was handed. */
function clone(doc: CallPatternDoc): CallPatternDoc {
  return JSON.parse(JSON.stringify(doc)) as CallPatternDoc;
}

function describeTarget(e: { anchorDayType: DayType; trigger: string }): string {
  return `the ${e.anchorDayType} ${e.trigger} chain`;
}

/**
 * Apply edits in order, then validate the whole document.
 *
 * Validation runs ONCE at the end rather than per edit: a sequence can legally
 * pass through an intermediate state the schema would reject (removing the
 * last link before adding a replacement), and rejecting that would make
 * perfectly reasonable pairs of edits impossible.
 */
export function applyPatternEdits(
  original: CallPatternDoc,
  edits: readonly PatternEdit[],
): EditResult {
  if (edits.length === 0) return { ok: false, error: 'No changes were proposed.' };

  let doc = clone(original);

  for (const [i, edit] of edits.entries()) {
    const step = edits.length > 1 ? `Change ${i + 1}: ` : '';
    const block = doc.blocks.find(b => b.anchorDayType === edit.anchorDayType);

    if (edit.op === 'add_block_chain') {
      if (!block) {
        // A brand-new anchor is legitimate — a site that gains a Friday block.
        doc.blocks.push({ anchorDayType: edit.anchorDayType, chains: [{ trigger: edit.trigger, links: edit.links }] });
        continue;
      }
      if (block.chains.some(c => c.trigger === edit.trigger)) {
        return { ok: false, error: `${step}${describeTarget(edit)} already exists. Add a link to it instead of creating it again.` };
      }
      block.chains.push({ trigger: edit.trigger, links: edit.links });
      continue;
    }

    if (!block) {
      return { ok: false, error: `${step}this pattern has no ${edit.anchorDayType} block, so ${describeTarget(edit)} cannot be changed.` };
    }

    if (edit.op === 'remove_block_chain') {
      const before = block.chains.length;
      block.chains = block.chains.filter(c => c.trigger !== edit.trigger);
      if (block.chains.length === before) {
        return { ok: false, error: `${step}there is no ${edit.anchorDayType} ${edit.trigger} chain to remove.` };
      }
      // An anchor with no chains left is not a valid block, and leaving an
      // empty one behind would fail validation with a message about a shape
      // nobody asked for.
      doc.blocks = doc.blocks.filter(b => b.chains.length > 0);
      continue;
    }

    const chain = block.chains.find(c => c.trigger === edit.trigger);
    if (!chain) {
      return { ok: false, error: `${step}there is no ${edit.anchorDayType} ${edit.trigger} chain. Create it first.` };
    }

    const at = chain.links.findIndex(l => l.code === edit.code && l.offset === edit.offset);

    if (edit.op === 'add_block_link') {
      if (at >= 0) {
        return { ok: false, error: `${step}${describeTarget(edit)} already places ${edit.code} at offset ${edit.offset}.` };
      }
      chain.links.push({
        code: edit.code,
        offset: edit.offset,
        ...(edit.minFte !== undefined ? { minFte: edit.minFte } : {}),
      });
      continue;
    }

    if (at < 0) {
      return { ok: false, error: `${step}${describeTarget(edit)} does not place ${edit.code} at offset ${edit.offset}.` };
    }

    if (edit.op === 'remove_block_link') {
      chain.links.splice(at, 1);
      if (chain.links.length === 0) {
        return {
          ok: false,
          error: `${step}removing that link would leave ${describeTarget(edit)} with nothing to place. `
            + 'Remove the whole chain instead if that is the intent.',
        };
      }
      continue;
    }

    // set_block_link_min_fte
    if (edit.minFte === null) delete chain.links[at].minFte;
    else chain.links[at].minFte = edit.minFte;
  }

  // The gate. Nothing reaches the database without satisfying the same schema
  // the engine parses with — which is what stops a change from silently
  // demoting a site to the classic fallback.
  const parsed = CallPatternDocSchema.safeParse(doc);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: `The result would not be a valid call pattern: ${first.message}`
        + (first.path.length ? ` (at ${first.path.join('.')})` : ''),
    };
  }
  return { ok: true, doc: parsed.data };
}

export interface LogicDiff {
  /** Sentences true after the change that were not true before. */
  added: string[];
  /** Sentences true before that no longer hold. */
  removed: string[];
  /** True when the documents describe the same behaviour. */
  identical: boolean;
}

/**
 * What changes, in the same English the page already shows.
 *
 * Diffing the DESCRIPTION rather than the JSON is the point. A chief can check
 * "Saturday C1 also takes C2 on Sunday" against how the group actually runs;
 * nobody can check a JSON patch against that. It also means a change with no
 * behavioural effect shows as no change, however much the document moved.
 */
export function diffSchedulingLogic(
  before: CallPatternDoc,
  after: CallPatternDoc,
  context: { shiftTypes: readonly ShiftTypeFacts[]; parLevel: number | null },
): LogicDiff {
  const flatten = (doc: CallPatternDoc) =>
    describeSchedulingLogic({ doc, shiftTypes: context.shiftTypes, parLevel: context.parLevel })
      // Coverage notes and the hard-coded invariants cannot change with the
      // pattern, so including them would only add noise a reader must skip.
      .filter(s => s.kind === 'enforced' && s.key !== 'invariants')
      .flatMap(s => s.statements.map(st => st.text));

  const a = flatten(before);
  const b = flatten(after);
  const added = b.filter(t => !a.includes(t));
  const removed = a.filter(t => !b.includes(t));
  return { added, removed, identical: added.length === 0 && removed.length === 0 };
}
