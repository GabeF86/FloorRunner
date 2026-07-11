// Pure helper extracted from route.ts so it can be unit-tested without
// triggering Next.js's route-export type constraint (only GET/POST/… and a
// small set of Next.js-specific names are allowed as named exports from a
// route file). The unfilled-payload trimming that used to live here moved to
// src/lib/rulesEngine/trimUnfilled.ts (shared with the assistant's
// regenerate tool).

// Pure: hard failure (ok=false) -> 422 so the UI shows the error message; a
// successful generation (including a partial fill with unfilled slots) -> 200.
export function statusForResult(r: { ok: boolean; filled: number; skipped: number }): number {
  return r.ok ? 200 : 422;
}
