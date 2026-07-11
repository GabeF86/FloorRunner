// Trims GenerationResult.unfilled payloads for API/tool consumers — shared by
// the generate route and the assistant's regenerate_schedule tool (lives in
// lib so lib code never imports from app/ route helpers).
//
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
