// Committed-assignment scope — the ONE place the "what counts as a real
// booking" predicate lives for the rules engine's conflict/validation reads.
//
// Draft isolation (clinical invariant 3): an assignment is a *committed*
// booking iff its version is published — `schedule_versions.version_status =
// 'published'`. Conflict/validation logic sees committed assignments PLUS the
// single version currently being generated/validated; two unpublished drafts
// with overlapping dates are invisible to each other (deliberate — the overlap
// is resolved at publish time, which re-validates and flags).
//
// Why `version_status`, not `schedules.published_version_number` (stale via the
// UI publish path) or `schedules.status` (coarser): see the design doc
// (2026-07-15-draft-isolation-design.md §Semantic). The predicate string
// `version_status = 'published'` appears in exactly one place below
// (`applyPublishedScope`); every call site funnels through this module so the
// definition of "committed" can never drift between them.
//
// Two-query strategy: PostgREST cannot OR across a filter on an embedded
// resource (`schedule_slots.schedule_versions...`), so when a caller also needs
// the rows of the DRAFT version under evaluation (`includeVersionId`) we run a
// second query scoped to that version and merge + dedupe by assignment id.
// Correctness over cleverness — one extra round-trip on those call sites.
//
// Each caller passes its OWN select string (the six sites select different
// column shapes / embeds); the caller's select MUST embed
// `schedule_slots.schedule_versions!inner(...)` so the published predicate can
// filter on it, and MUST select the assignment `id` when it uses
// `includeVersionId` (the merge dedupes on it).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type QueryBuilder = any;
type QueryError = { code?: string; message?: string } | null;

// ── the authoritative committed predicate ───────────────────────────────────
const PUBLISHED = 'published';
const VERSION_STATUS_LEAF = 'version_status';
// The PostgREST embed path from `assignments` to the joined schedule_versions
// row (assignments → schedule_slots → schedule_versions). Callers that go
// through fetchCommittedAssignments select this shape; the exported
// filterPublishedVersions() defaults to it.
const ASSIGNMENTS_VERSIONS_PATH = 'schedule_slots.schedule_versions';
const VERSION_STATUS_PATH = `${ASSIGNMENTS_VERSIONS_PATH}.${VERSION_STATUS_LEAF}`;
// Companion filter paths (the exclusion / current-version scoping the callers
// layer on top of the committed predicate).
const SCHEDULE_ID_PATH = 'schedule_slots.schedule_versions.schedule_id';
const SITE_ID_PATH = 'schedule_slots.site_id';
const VERSION_ID_PATH = 'schedule_slots.schedule_version_id';
const DEFAULT_SLOT_DATE_PATH = 'schedule_slots.slot_date';

/**
 * Apply the committed ("published version") predicate to a query assembled
 * OUTSIDE fetchCommittedAssignments. A few call sites build their own select
 * with a shape/window the option bag cannot express (genContext's legacy
 * fallback scan uses `.lt` with no lower bound and an `.eq` site filter; a
 * reporting surface may query `schedule_slots` directly) — but the string
 * `version_status = 'published'` must still have exactly ONE home. Route those
 * sites through here.
 *
 * `versionsPath` is the PostgREST embed path from the queried table to the
 * joined schedule_versions row — the default matches the `assignments` →
 * `schedule_slots` → `schedule_versions` shape; pass `'schedule_versions'` when
 * querying `schedule_slots` directly. The caller's select MUST embed
 * `schedule_versions!inner(version_status)` at that path.
 */
export function filterPublishedVersions(
  query: QueryBuilder,
  versionsPath: string = ASSIGNMENTS_VERSIONS_PATH,
): QueryBuilder {
  return query.eq(`${versionsPath}.${VERSION_STATUS_LEAF}`, PUBLISHED);
}

export interface CommittedScopeOptions {
  // Provider filter — exactly one of these. `providerIds` → `.in`, `providerId`
  // → `.eq` (matches the mix across the six call sites).
  providerIds?: string[];
  providerId?: string | null;
  // Inclusive date window on the joined slot. Pass start === end for a single
  // day (loadContext's per-slot cross-site read).
  start: string;
  end: string;
  // Override when the slot-date column is addressed differently (default is the
  // embedded `schedule_slots.slot_date`).
  slotDateColumn?: string;
  // Applied to the published variant. Callers use exactly one (or neither):
  //  - excludeScheduleId: drop the parent schedule (its sibling versions are
  //    clones — counting them would self-conflict every regenerate).
  //  - excludeSiteId: the degraded no-parent fallback (schedule unknown) — keep
  //    the legacy other-sites-only scope AND the published-only filter.
  excludeScheduleId?: string | null;
  excludeSiteId?: string | null;
  // When set, ALSO return rows from this (draft) version — the version being
  // generated/validated, whose own rows are legitimately part of the window
  // (eviction, occupied-detection, neighbor scoping, self-inclusion).
  includeVersionId?: string | null;
}

// Provider + assignment_status + date-window filters shared by both variants.
function applyBase(query: QueryBuilder, opts: CommittedScopeOptions): QueryBuilder {
  const dateCol = opts.slotDateColumn ?? DEFAULT_SLOT_DATE_PATH;
  let q = query.eq('assignment_status', 'assigned');
  if (opts.providerIds) q = q.in('provider_id', opts.providerIds);
  else if (opts.providerId != null) q = q.eq('provider_id', opts.providerId);
  return q.gte(dateCol, opts.start).lte(dateCol, opts.end);
}

// Variant A — committed rows. THE published predicate lives here and nowhere
// else. Optional single exclusion (schedule OR site) layered on top.
function applyPublishedScope(query: QueryBuilder, opts: CommittedScopeOptions): QueryBuilder {
  let q = applyBase(query, opts).eq(VERSION_STATUS_PATH, PUBLISHED);
  if (opts.excludeScheduleId) q = q.neq(SCHEDULE_ID_PATH, opts.excludeScheduleId);
  if (opts.excludeSiteId) q = q.neq(SITE_ID_PATH, opts.excludeSiteId);
  return q;
}

// Variant B — the draft version currently under evaluation (regardless of its
// publish status).
function applyCurrentVersionScope(query: QueryBuilder, opts: CommittedScopeOptions): QueryBuilder {
  return applyBase(query, opts).eq(VERSION_ID_PATH, opts.includeVersionId);
}

// Merge two row sets, deduping on assignment `id` (a row can satisfy both
// variants when the current version is itself published). Published rows first,
// then current-version rows not already seen.
function mergeById<T extends { id?: unknown }>(a: T[], b: T[]): T[] {
  const seen = new Set<unknown>();
  const out: T[] = [];
  for (const row of a) {
    if (row?.id != null) seen.add(row.id);
    out.push(row);
  }
  for (const row of b) {
    if (row?.id != null && seen.has(row.id)) continue;
    if (row?.id != null) seen.add(row.id);
    out.push(row);
  }
  return out;
}

/**
 * Fetch assignments in the committed scope (published versions + the optional
 * current draft version), applying the caller's own select string.
 *
 * Returns `{ data, error }` (never throws) so each caller keeps its existing
 * error posture: some bail/return-null on error (fail-closed validation
 * reads), others ignore it (best-effort generation scans). On error `data` is
 * `null` and the FIRST failing sub-query's error is surfaced. When
 * `includeVersionId` is unset only the published variant runs (single query).
 */
export async function fetchCommittedAssignments(
  sb: SupabaseClient,
  select: string,
  opts: CommittedScopeOptions,
): Promise<{ data: Array<Record<string, unknown>> | null; error: QueryError }> {
  const published = await applyPublishedScope(sb.from('assignments').select(select), opts);
  if (published.error) return { data: null, error: published.error };
  const publishedRows = (published.data ?? []) as Array<Record<string, unknown>>;
  if (opts.includeVersionId == null) return { data: publishedRows, error: null };

  const current = await applyCurrentVersionScope(sb.from('assignments').select(select), opts);
  if (current.error) return { data: null, error: current.error };
  const currentRows = (current.data ?? []) as Array<Record<string, unknown>>;
  return { data: mergeById(publishedRows, currentRows), error: null };
}
