/**
 * Response-interpretation tests for the providers roster page.
 *
 * Node environment, no jsdom (repo convention) — the component itself isn't
 * mounted here. What IS tested is the pure decision the page's three list
 * reads share, because that decision is where the page previously conflated
 * "the read failed" with "the list is genuinely empty". On the organizations
 * read that conflation is user-visible and harmful: an empty list renders the
 * create-your-organization onboarding, so a transient 500 invited a duplicate
 * organization.
 */
import { describe, it, expect } from 'vitest';
import { interpretListRead } from './listRead';

describe('interpretListRead', () => {
  it('returns the rows of a genuine list', () => {
    const read = interpretListRead<{ id: string }>({ ok: true, status: 200 }, [{ id: 'a' }], 'organizations');
    expect(read).toEqual({ ok: true, rows: [{ id: 'a' }] });
  });

  it('reports a genuinely empty list as a SUCCESS with zero rows', () => {
    // The only path allowed to reach the create-org onboarding.
    const read = interpretListRead({ ok: true, status: 200 }, [], 'organizations');
    expect(read).toEqual({ ok: true, rows: [] });
  });

  it('never reports a non-2xx response as an empty list', () => {
    const read = interpretListRead({ ok: false, status: 500 }, { error: 'connection refused' }, 'organizations');
    expect(read.ok).toBe(false);
    expect(read).not.toHaveProperty('rows');
    if (!read.ok) expect(read.error).toBe('connection refused');
  });

  it('falls back to a status-bearing message when the error body has no usable error field', () => {
    for (const body of [null, {}, { error: '' }, { error: 42 }, 'Internal Server Error']) {
      const read = interpretListRead({ ok: false, status: 503 }, body, 'providers');
      expect(read).toEqual({ ok: false, error: 'Could not load providers (503)' });
    }
  });

  it('rejects a malformed 200 rather than treating it as empty', () => {
    // An object body assigned to array-typed state makes the next .map() throw.
    for (const body of [null, {}, { error: 'nope' }, 'oops', 7]) {
      const read = interpretListRead({ ok: true, status: 200 }, body, 'sites');
      expect(read).toEqual({ ok: false, error: 'The sites response was malformed.' });
    }
  });
});
