/**
 * Provider-name normalization and roster matching — PURE. The caller
 * supplies the roster (JSON file or a read-only DB query); this module
 * never touches the database.
 *
 * Matching is deterministic, never fuzzy: a workbook name matches a roster
 * entry only when its normalized form equals one of the entry's candidate
 * keys (full name, aliases, or the last-name token of a multi-word name).
 * Zero candidates → unmatched HARD error. More than one roster entry
 * matching → ambiguous HARD error (per the prompt: "Do not use fuzzy
 * matching when more than one provider could match").
 */

export interface RosterEntry {
  id: string;
  name: string;
  aliases?: string[];
}

export interface NameMatch {
  sourceName: string;
  normalized: string;
  /** null when the match failed (a corresponding hard error is emitted). */
  providerId: string | null;
  matchedName?: string;
}

export interface MatchResult {
  matches: NameMatch[];
  /** Hard import errors: unmatched, ambiguous, or duplicate source names. */
  errors: string[];
}

/** Trim, collapse internal whitespace, lowercase. */
export function normalizeName(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

function candidateKeys(entry: RosterEntry): Set<string> {
  const keys = new Set<string>();
  const full = normalizeName(entry.name);
  if (full) keys.add(full);
  const tokens = full.split(' ');
  if (tokens.length > 1) keys.add(tokens[tokens.length - 1]); // last-name token
  for (const a of entry.aliases ?? []) {
    const n = normalizeName(a);
    if (n) keys.add(n);
  }
  return keys;
}

export function matchRoster(sourceNames: string[], roster: RosterEntry[]): MatchResult {
  const keyed = roster.map((entry) => ({ entry, keys: candidateKeys(entry) }));
  const matches: NameMatch[] = [];
  const errors: string[] = [];
  const seen = new Map<string, string>(); // normalized → first raw source name

  for (const sourceName of sourceNames) {
    const normalized = normalizeName(sourceName);

    const prior = seen.get(normalized);
    if (prior !== undefined) {
      errors.push(
        `duplicate provider row: "${sourceName}" normalizes to the same provider as "${prior}"`,
      );
      matches.push({ sourceName, normalized, providerId: null });
      continue;
    }
    seen.set(normalized, sourceName);

    const hits = keyed.filter(({ keys }) => keys.has(normalized));
    if (hits.length === 1) {
      matches.push({
        sourceName,
        normalized,
        providerId: hits[0].entry.id,
        matchedName: hits[0].entry.name,
      });
    } else if (hits.length === 0) {
      errors.push(
        `unmatched provider name: "${sourceName}" has no roster match (never fuzzy-matched; fix the roster or the workbook)`,
      );
      matches.push({ sourceName, normalized, providerId: null });
    } else {
      errors.push(
        `ambiguous provider name: "${sourceName}" matches ${hits.length} roster entries (${hits
          .map((h) => `${h.entry.name} [${h.entry.id}]`)
          .join(', ')})`,
      );
      matches.push({ sourceName, normalized, providerId: null });
    }
  }
  return { matches, errors };
}
