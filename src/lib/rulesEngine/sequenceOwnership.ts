// Sequence-owned slots (2026-07-17). SINGLE HOME for the "could the ACTIVE
// pattern doc target this slot as a chain link?" predicate.
//
// A sequence-owned slot belongs to its chain's provider and nobody else:
// D1 (Post 2nd Call) belongs to yesterday's C2 person, D2/D3 pre-call fills
// belong to tomorrow's C1/C2 person, Doc C's Friday D4 belongs to the Sat-C3
// block-chain provider. When the chain breaks (source call unfilled, holder
// blocked on the target day) the slot stays UNASSIGNED and the orphan is
// REPORTED (solve's mop-up sweep) — never given to another provider. The
// legitimate writers are the chain fills themselves (applyDayChains /
// applyBlockChains), sequenceAutoFill (manual-edit companion) and seeds;
// generic fill paths (mop-up sweep, relief pass) must exclude this set.
//
// Definition — a slot (date, code) is sequence-owned iff for SOME dayChains
// link or block-chain link:
//   anchorDate + link.offset === slot date
//   AND link.code === slot code
//   AND anchorDate's day type matches the chain's trigger dayTypes
//       (dayChains) / the block's anchorDayType (blocks).
//
// Two deliberate breadth decisions (over-exclusion leaves a slot open and
// reported; under-exclusion hands it to the wrong provider — clinically worse):
//   1. Anchor-slot existence is NOT required: a version with no C2 slot on the
//      anchor date still owns the D1 (the chain can simply never fire there,
//      so the slot is a permanent, reported orphan — not free inventory).
//   2. OUT-OF-BLOCK anchors still own in-block targets: a D1 on the first
//      block day belongs to the PREVIOUS block's C2 person. Day types for
//      dates with no slots in this version are derived from the day of week
//      (saturday/sunday/friday/weekday) — holiday typing is unknowable there,
//      which is acceptable: every shipped pattern scopes holiday day types
//      together with weekday, and Sat/Sun (the types that gate block chains)
//      derive exactly. In-block anchor dates use the version's REAL
//      derived_day_type (any slot on the date carries it).
//
// Spans are deliberately NOT ownership: the span pass places and reports its
// own slots atomically, and unfilled span slots fall to the main loop (call)
// — they were never mop-up/relief inventory in the first place.
import { addDays, dayOfWeekUTC, dayTypeFromDow } from './shared';
import type { CallPatternDoc } from './callPattern';
import type { SlotToFill } from './genTypes';

interface OwnershipRule {
  offset: number;                 // anchorDate + offset === target date
  anchorDayTypes: readonly string[];
}

export function computeSequenceOwnedSlotIds(
  doc: CallPatternDoc,
  slotIndex: Map<string, Map<string, SlotToFill>>,
): Set<string> {
  // target code -> every (offset, anchor day types) rule that could reach it.
  const rulesByCode = new Map<string, OwnershipRule[]>();
  const addRule = (code: string, offset: number, anchorDayTypes: readonly string[]) => {
    let list = rulesByCode.get(code);
    if (!list) { list = []; rulesByCode.set(code, list); }
    list.push({ offset, anchorDayTypes });
  };
  for (const chain of doc.dayChains) {
    for (const link of chain.links ?? []) addRule(link.code, link.offset, chain.dayTypes);
  }
  for (const block of doc.blocks) {
    for (const chain of block.chains) {
      for (const link of chain.links) addRule(link.code, link.offset, [block.anchorDayType]);
    }
  }

  // Anchor-date day type: the version's real derived_day_type when the date
  // has any slot; day-of-week fallback otherwise (out-of-block dates).
  const dayTypeOf = (date: string): string => {
    for (const s of slotIndex.get(date)?.values() ?? []) return s.derived_day_type;
    return dayTypeFromDow(dayOfWeekUTC(date));
  };

  const owned = new Set<string>();
  for (const codeMap of slotIndex.values()) {
    for (const [code, slot] of codeMap) {
      const rules = rulesByCode.get(code);
      if (!rules) continue;
      for (const r of rules) {
        const anchorDate = addDays(slot.slot_date, -r.offset);
        if (r.anchorDayTypes.includes(dayTypeOf(anchorDate))) {
          owned.add(slot.slot_id);
          break;
        }
      }
    }
  }
  return owned;
}
