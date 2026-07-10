// Pure helper extracted from route.ts so it can be unit-tested without
// triggering Next.js's route-export type constraint (only GET/POST/… and a
// small set of Next.js-specific names are allowed as named exports from a
// route file).

// Pure: hard failure (ok=false) -> 422 so the UI shows the error message; a
// successful generation (including a partial fill with unfilled slots) -> 200.
export function statusForResult(r: { ok: boolean; filled: number; skipped: number }): number {
  return r.ok ? 200 : 422;
}

// A month-long generation can leave dozens of unfilled slots, each carrying a
// per-provider rejection for the whole pool (~85 providers) — that's a
// megabyte-scale payload the UI only ever shows a few lines of. Cap the
// rejections per slot and report how many were dropped so the UI can say
// "… and N more".
export const MAX_CANDIDATE_REASONS = 3;

// Pure: cap each unfilled entry's candidate rejections at `max` and stamp the
// omitted count. Entries without candidates pass through with omitted 0.
export function trimUnfilled<T extends { candidates?: unknown[] }>(
  unfilled: T[],
  max: number = MAX_CANDIDATE_REASONS,
): Array<T & { omittedCandidates: number }> {
  return unfilled.map(u => ({
    ...u,
    candidates: u.candidates?.slice(0, max),
    omittedCandidates: Math.max(0, (u.candidates?.length ?? 0) - max),
  }));
}
