// Pure data decisions for the Block Prep page.
//
// These live BESIDE page.tsx rather than in it because a Next.js App Router
// page may only export a fixed set of fields — `default`, `metadata`,
// `dynamic`, `revalidate` and friends. Any other named export fails
// `next build` with "X is not a valid Page export field", even though
// `tsc --noEmit` and vitest both pass. That is exactly how these two shipped
// to production as a broken build on 2026-09-07: the page exported them so
// its test could reach them, and nothing in the local checks caught it.
//
// So: anything on this page that a test needs to reach goes here.

import type { BlockPrepData } from '@/app/api/scheduling/block-prep/route.helpers';

/**
 * C2 fix (CRITICAL, round 5 review): `data` alone is not enough to render —
 * it may still be the PREVIOUS site/year's payload while a fresh fetch for
 * the current one is in flight (deliberately kept on screen; see the
 * onCommitted/onPatched split below for why). `AnnualTallyCard` already
 * guards its OWN rendering against exactly this with an identical check; this
 * gives `RosterCard` the same guard on the same payload, so the two cards can
 * never disagree about which site is on screen — either both show fresh data
 * for `(siteId, year)`, or both fall back to their loading/pick-a-site state.
 * Uses the stamps the route puts on every shape it returns, INCLUDING every
 * failure panel (`loadFailure` above stamps them too), so a route-level
 * failure for the CURRENT site/year still passes this check and renders its
 * error, while a stale payload for a DIFFERENT site/year does not.
 */
export function freshFor(data: BlockPrepData | null, siteId: string, year: number): BlockPrepData | null {
  return data && data.site_id === siteId && data.year === year ? data : null;
}

/**
 * The exact prop object handed to `AnnualTallyCard` on this page — pulled out
 * so a test can pin that `data` is ALWAYS included (I6, round 5 review):
 * omitting `data` flips `AnnualTallyCard` into its self-fetch branch,
 * reintroducing the duplicate year-wide query this task exists to prevent,
 * and that mutation previously typechecked clean and left every test green.
 * Spread at the JSX call site below (`{...tallyCardProps(...)}`) rather than
 * writing the props out by hand there, so there is one call whose return
 * value a test can inspect directly — same pattern as RosterCard's
 * `buildRosterTableRows` / `resolveDisplayRows`.
 */
export function tallyCardProps(
  fresh: BlockPrepData | null, siteId: string, year: number, siteName: string | undefined,
): { siteId: string | null; year: number; siteName: string | undefined; data: BlockPrepData | null } {
  return { siteId: siteId || null, year, siteName, data: fresh };
}
