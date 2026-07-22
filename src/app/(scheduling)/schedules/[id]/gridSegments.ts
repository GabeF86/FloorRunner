// Call-split grid helpers (2026-07-22) — pure functions behind the stacked
// segment cell: a split call's segment slots render INSIDE the parent call's
// existing row cell (parent_call_code lookup — no new grid rows), each
// mini-cell independently fillable with the normal picker. Kept out of the
// page monolith so vitest covers them (the gridZoom.ts convention).
//
// Everything keys on shift_types.parent_call_code — the patch35 mapping
// column — NEVER on code-name patterns. segmentTag is the one cosmetic
// exception: it derives a compact display label from the code, with the full
// code as fallback, and drives no logic.

export interface SegmentShiftTypeish {
  code: string;
  parent_call_code?: string | null;
  display_order?: number | null;
}

export interface SegmentSlotish {
  slot_date: string;
  shift_types: SegmentShiftTypeish | null;
}

/** A shift type is a call SEGMENT exactly when it stores a parent code. */
export function isSegmentType(st: SegmentShiftTypeish | null | undefined): boolean {
  return typeof st?.parent_call_code === 'string' && st.parent_call_code.length > 0;
}

/** Grouping key for the stacked cell: parent code + date. */
export function segmentKey(parentCode: string, date: string): string {
  return `${parentCode}|${date}`;
}

/**
 * Group segment slots by segmentKey(parent, date), each group sorted by
 * display_order (day → evening → night per patch35 ordering) with a code
 * tiebreak. Whole-call slots and slots without a shift type never enter.
 */
export function groupSegmentSlots<T extends SegmentSlotish>(slots: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const slot of slots) {
    const st = slot.shift_types;
    if (!isSegmentType(st)) continue;
    const key = segmentKey(st!.parent_call_code!, slot.slot_date);
    const list = out.get(key);
    if (list) list.push(slot); else out.set(key, [slot]);
  }
  for (const list of out.values()) {
    list.sort((a, b) =>
      ((a.shift_types?.display_order ?? 999) - (b.shift_types?.display_order ?? 999))
      || (a.shift_types?.code ?? '').localeCompare(b.shift_types?.code ?? ''));
  }
  return out;
}

/** Compact mini-cell label: the code minus the parent prefix ('C1N12' → 'N12'),
 * full code when it doesn't share the prefix (or would go empty). Display only. */
export function segmentTag(code: string, parentCode: string): string {
  if (code.length > parentCode.length && code.startsWith(parentCode)) {
    return code.slice(parentCode.length);
  }
  return code;
}
