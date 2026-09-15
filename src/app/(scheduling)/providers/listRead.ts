/**
 * Shared interpretation of the list endpoints the providers roster reads.
 *
 * Lives beside page.tsx rather than inside it because a Next page module may
 * only export its default (and the reserved route fields) — an exported helper
 * there fails the typed-routes check, and this decision needs a unit test.
 */

export type ListRead<T> = { ok: true; rows: T[] } | { ok: false; error: string };

/**
 * Interpret a list endpoint's response.
 *
 * Every list read on the providers page used to do `setX(await res.json())`,
 * which conflates three different outcomes into one empty array: a genuine
 * empty list, a non-2xx error body (an OBJECT — assigning it to array state
 * makes the next `.map()` throw and blanks the page), and a malformed 200.
 * They must stay distinguishable, because the page renders them very
 * differently — an empty organizations list offers to CREATE an organization,
 * so a transient read failure that looks empty invites a duplicate org.
 */
export function interpretListRead<T>(
  res: { ok: boolean; status: number },
  body: unknown,
  what: string,
): ListRead<T> {
  if (!res.ok) {
    const err = (body as { error?: unknown } | null)?.error;
    return { ok: false, error: typeof err === 'string' && err ? err : `Could not load ${what} (${res.status})` };
  }
  if (!Array.isArray(body)) return { ok: false, error: `The ${what} response was malformed.` };
  return { ok: true, rows: body as T[] };
}
