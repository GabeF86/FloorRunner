// Site-credential writes. Split out from route.ts so the merge semantics are
// testable with an injected client (the convention block-prep/route.helpers.ts
// and dashboard/queries.ts already follow).
//
// ── WHY THIS EXISTS: THE FULL-ROW UPSERT WAS A DATA-LOSS BUG ────────────────
// The original POST built its row as `is_active: body.is_active ?? true`, and
// its arrays as `toStringArray(body.allowed_shift_types)` — which returns []
// for an absent key. So an omitted boolean did not mean "leave it alone", it
// meant TRUE, and an omitted array meant EMPTY. The endpoint could not express
// a partial update at all, which forced every caller to resend the entire row.
//
// That forcing is what caused the bug Gabriel hit. The Sites & Credentials tab
// built each toggle's payload from its `cred` prop, and that prop only
// refreshes after the write completes and the parent refetches. Two toggles
// clicked before the refetch landed both read the SAME stale base, so the
// second silently reverted the first — six toggles per site, one round trip
// each, no control disabled in between.
//
// ── THE FIX: UPDATE NAMES ONLY THE COLUMNS THE CALLER SENT ──────────────────
// An existing row is UPDATEd with exactly the keys present in the body; a
// missing row is INSERTed with the historical `?? true` defaults so the "add a
// site" path is unchanged. Presence is tested with `'key' in body`, which is
// what lets `null` mean "clear this" and absence mean "don't touch it" — the
// route already used that distinction for dates and notes, and this
// generalizes it to every column.
//
// Because UPDATE names only the sent columns, two concurrent writes touching
// DIFFERENT columns now both land. That is a real concurrency property, not
// just a narrower window: Postgres is not writing the untouched columns at all,
// so there is no value to be stale.

/** Loose client type — the same seam the other DB-coupled modules use. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = any;

/** Booleans. Absent on INSERT means `true` (the historical default). */
export const CREDENTIAL_BOOLEAN_COLUMNS = [
  'is_active', 'credentialed', 'can_take_call',
  'can_take_weekend_call', 'can_take_holiday_call', 'can_take_backup_call',
] as const;

/** Text arrays. Absent on INSERT means `[]`. */
export const CREDENTIAL_ARRAY_COLUMNS = [
  'allowed_shift_types', 'excluded_shift_types', 'skill_tags',
] as const;

/** Nullable scalars. Absent on INSERT means the column is simply not written. */
export const CREDENTIAL_NULLABLE_COLUMNS = [
  'effective_start_date', 'effective_end_date', 'notes',
] as const;

const ROW_EMBED = '*, sites:site_id(id, name, short_name)';

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

/** YYYY-MM-DD, and a real calendar date. Mirrors validation/providers.isValidDate. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isDateish(v: unknown): boolean {
  return typeof v === 'string' && DATE_RE.test(v);
}

/**
 * The UPDATE set: exactly the columns named by the body, coerced.
 *
 * Keyed off `'k' in body` rather than truthiness, so `null` (clear the value)
 * and `false` (turn the flag off) are both writes, while an absent key is not.
 * Anything not on the three column lists is dropped — the body is client input
 * and must never widen into arbitrary columns on an upsert.
 */
export function credentialPatch(body: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const k of CREDENTIAL_BOOLEAN_COLUMNS) {
    if (k in body) patch[k] = !!body[k];
  }
  for (const k of CREDENTIAL_ARRAY_COLUMNS) {
    if (k in body) patch[k] = toStringArray(body[k]);
  }
  for (const k of CREDENTIAL_NULLABLE_COLUMNS) {
    if (k in body) patch[k] = body[k] || null;
  }
  return patch;
}

/**
 * The INSERT row: the historical defaults, with the patch laid over them.
 *
 * Absent booleans default TRUE here on purpose — that is what the "add a site"
 * button has always relied on (it posts only `credentialed` and `is_active` and
 * expects the four call flags to come up enabled). The default is correct for a
 * NEW row and only ever wrong as an *update*, which is the bug this file fixes.
 */
export function credentialInsertRow(
  providerId: string,
  siteId: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const row: Record<string, unknown> = { provider_id: providerId, site_id: siteId };
  for (const k of CREDENTIAL_BOOLEAN_COLUMNS) row[k] = k in body ? !!body[k] : true;
  for (const k of CREDENTIAL_ARRAY_COLUMNS) row[k] = toStringArray(body[k]);
  return { ...row, ...credentialPatch(body) };
}

/**
 * Validate the effective range as it will stand AFTER the write.
 *
 * Checking the merged value, not the body, is what keeps partial updates
 * honest: a patch carrying only `effective_end_date` has to be compared against
 * the START ALREADY STORED, or you could set an end date before an existing
 * start simply by not mentioning the start. There is no CHECK constraint on the
 * table to fall back on (verified 2026-09-09), so this is the only guard.
 */
export function effectiveRangeError(
  merged: { effective_start_date?: unknown; effective_end_date?: unknown },
): string | null {
  const start = merged.effective_start_date;
  const end = merged.effective_end_date;
  if (start != null && start !== '' && !isDateish(start)) {
    return 'effective_start_date must be YYYY-MM-DD';
  }
  if (end != null && end !== '' && !isDateish(end)) {
    return 'effective_end_date must be YYYY-MM-DD';
  }
  if (isDateish(start) && isDateish(end) && (start as string) > (end as string)) {
    return 'effective_end_date must be on or after effective_start_date';
  }
  return null;
}

export interface WriteResult {
  status: number;
  body: unknown;
}

function fail(status: number, error: string): WriteResult {
  return { status, body: { error } };
}

/**
 * Create or partially update one provider/site credential.
 *
 * Order of operations, and why:
 *   1. org check — a client could otherwise cross organizations by posting an
 *      arbitrary site_id (pre-existing guard, kept verbatim);
 *   2. read the current row, for the merged date validation above;
 *   3. existing row  -> UPDATE naming only the sent columns;
 *      missing row   -> UPSERT the defaults row. Upsert rather than insert so
 *      two requests racing to create the same credential resolve against the
 *      UNIQUE (provider_id, site_id) index instead of one of them 409-ing.
 */
export async function writeSiteCredential(
  sb: Sb,
  providerId: string,
  body: Record<string, unknown>,
): Promise<WriteResult> {
  const siteId = body.site_id;
  if (!siteId || typeof siteId !== 'string') {
    return fail(400, 'site_id is required');
  }

  const [providerRes, siteRes] = await Promise.all([
    sb.from('providers').select('organization_id').eq('id', providerId).maybeSingle(),
    sb.from('sites').select('organization_id').eq('id', siteId).maybeSingle(),
  ]);
  if (providerRes.error) return fail(500, providerRes.error.message);
  if (siteRes.error) return fail(500, siteRes.error.message);
  if (!providerRes.data) return fail(404, 'Provider not found');
  if (!siteRes.data) return fail(404, 'Site not found');
  if (siteRes.data.organization_id !== providerRes.data.organization_id) {
    return fail(400, 'Site does not belong to this provider’s organization');
  }

  const existingRes = await sb
    .from('provider_site_credentials')
    .select('id, effective_start_date, effective_end_date')
    .eq('provider_id', providerId)
    .eq('site_id', siteId)
    .maybeSingle();
  if (existingRes.error) return fail(500, existingRes.error.message);
  const existing = existingRes.data as
    { effective_start_date?: unknown; effective_end_date?: unknown } | null;

  const patch = credentialPatch(body);

  if (existing) {
    const rangeError = effectiveRangeError({
      effective_start_date: 'effective_start_date' in patch
        ? patch.effective_start_date : existing.effective_start_date,
      effective_end_date: 'effective_end_date' in patch
        ? patch.effective_end_date : existing.effective_end_date,
    });
    if (rangeError) return fail(400, rangeError);

    // A body naming no writable column is a no-op. Returning the row rather
    // than issuing an empty UPDATE keeps `.single()` from erroring on a
    // zero-column statement.
    if (Object.keys(patch).length === 0) {
      const readBack = await sb
        .from('provider_site_credentials')
        .select(ROW_EMBED)
        .eq('provider_id', providerId)
        .eq('site_id', siteId)
        .single();
      if (readBack.error) return fail(500, readBack.error.message);
      return { status: 200, body: readBack.data };
    }

    const updated = await sb
      .from('provider_site_credentials')
      .update(patch)
      .eq('provider_id', providerId)
      .eq('site_id', siteId)
      .select(ROW_EMBED)
      .single();
    if (updated.error) return fail(500, updated.error.message);
    return { status: 200, body: updated.data };
  }

  const insertRow = credentialInsertRow(providerId, siteId, body);
  const rangeError = effectiveRangeError(insertRow);
  if (rangeError) return fail(400, rangeError);

  const inserted = await sb
    .from('provider_site_credentials')
    .upsert(insertRow, { onConflict: 'provider_id,site_id' })
    .select(ROW_EMBED)
    .single();
  if (inserted.error) return fail(500, inserted.error.message);
  return { status: 200, body: inserted.data };
}
