// Password rules. Deliberately its own module with NO imports.
//
// The /join page needs these in the browser to validate as the user types. If
// they lived in inviteService.ts, importing them would pull Node's `crypto`,
// the Supabase client types and the whole invitation service into the client
// bundle — which it did, costing ~35 kB before this split.

export const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 200;

/**
 * Rejects the passwords people actually choose, without theatre.
 *
 * No character-class rules: they push users toward `Password1!` and are worse
 * than length. The upper bound is not a strength rule at all — it stops a
 * megabyte of input reaching a slow hash.
 */
export function passwordError(pw: string): string | null {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (pw.length > MAX_PASSWORD_LENGTH) return 'Password is too long.';
  if (/^\s|\s$/.test(pw)) return 'Password cannot start or end with a space.';
  return null;
}
