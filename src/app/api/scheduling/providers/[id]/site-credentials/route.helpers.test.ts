// Site-credential write semantics, exercised with an injected fake supabase
// client — no network, no DB (the house convention for DB-coupled modules).
import { describe, it, expect } from 'vitest';
import {
  credentialPatch,
  credentialInsertRow,
  effectiveRangeError,
  writeSiteCredential,
  CREDENTIAL_BOOLEAN_COLUMNS,
} from './route.helpers';

const PROVIDER = 'prov-1';
const SITE = 'site-1';
const ORG = 'org-1';

interface Canned { data?: unknown; error?: { message: string } | null }

/**
 * Minimal PostgREST-shaped fake. Every builder method returns `this`, so any
 * chain resolves to the table's canned envelope; `then` makes it awaitable.
 * Calls are recorded so a test can assert WHICH statement was issued and with
 * what payload — the whole point here is that UPDATE names only the sent
 * columns.
 */
function makeSb(tables: Record<string, Canned | Canned[]>) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
  const pending: Record<string, number> = {};

  function resolve(table: string) {
    const cfg = tables[table];
    // `pending[table]` is seeded in `from()`, so the counter is always a
    // number here; the last canned response repeats once the list runs out.
    const canned = Array.isArray(cfg)
      ? (cfg[Math.min(pending[table]++, cfg.length - 1)] ?? { data: null })
      : (cfg ?? { data: null });
    return { data: canned.data ?? null, error: canned.error ?? null };
  }

  function builder(table: string) {
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is', 'in', 'order', 'limit', 'update', 'upsert', 'insert', 'delete']) {
      b[m] = (...args: unknown[]) => { calls.push({ table, method: m, args }); return b; };
    }
    b.single = () => Promise.resolve(resolve(table));
    b.maybeSingle = () => Promise.resolve(resolve(table));
    b.then = (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) =>
      Promise.resolve(resolve(table)).then(ok, err);
    return b;
  }

  const sb = {
    from: (table: string) => {
      if (!(table in pending)) pending[table] = 0;
      return builder(table);
    },
  };
  return { sb, calls };
}

/** The standard happy-path client: org matches, and a credential row exists. */
function sbWithExisting(existing: Record<string, unknown> | null, written: unknown = { id: 'c1' }) {
  return makeSb({
    providers: { data: { organization_id: ORG } },
    sites: { data: { organization_id: ORG } },
    // First read is the existence probe; every later read/write returns `written`.
    provider_site_credentials: [{ data: existing }, { data: written }, { data: written }],
  });
}

const body = (over: Record<string, unknown> = {}) => ({ site_id: SITE, ...over });

// ── the pure halves ────────────────────────────────────────────────────────

describe('credentialPatch — presence, not truthiness', () => {
  it('names only the keys the body carried', () => {
    expect(credentialPatch(body({ can_take_call: true }))).toEqual({ can_take_call: true });
  });

  it('treats false as a write, not an absence', () => {
    // The whole bug: `?? true` turned an omitted false into true.
    expect(credentialPatch(body({ is_active: false }))).toEqual({ is_active: false });
  });

  it('treats an explicit null as a write (clearing a date)', () => {
    expect(credentialPatch(body({ effective_end_date: null })))
      .toEqual({ effective_end_date: null });
  });

  it('omits an absent array rather than emptying it', () => {
    // toStringArray(undefined) used to return [], silently wiping the column.
    expect(credentialPatch(body({ can_take_call: true })))
      .not.toHaveProperty('allowed_shift_types');
  });

  it('empties an array that was explicitly sent empty', () => {
    expect(credentialPatch(body({ skill_tags: [] }))).toEqual({ skill_tags: [] });
  });

  it('drops non-string members of an array', () => {
    expect(credentialPatch(body({ skill_tags: ['a', 3, null, 'b'] })))
      .toEqual({ skill_tags: ['a', 'b'] });
  });

  it('drops columns that are not on the allow-lists', () => {
    // Client input must never widen into arbitrary columns.
    const patch = credentialPatch(body({ provider_id: 'someone-else', id: 'x', notes: 'ok' }));
    expect(patch).toEqual({ notes: 'ok' });
  });

  it('is empty for a body that names nothing writable', () => {
    expect(credentialPatch(body())).toEqual({});
  });

  it('coerces a truthy non-boolean to a real boolean', () => {
    expect(credentialPatch(body({ credentialed: 'yes' }))).toEqual({ credentialed: true });
  });
});

describe('credentialInsertRow — defaults survive for a NEW row', () => {
  it('defaults every unsent boolean to true', () => {
    const row = credentialInsertRow(PROVIDER, SITE, body({ credentialed: true, is_active: true }));
    for (const k of CREDENTIAL_BOOLEAN_COLUMNS) {
      expect(row[k], `${k} should default true on insert`).toBe(true);
    }
  });

  it('still honours a boolean the caller sent as false', () => {
    const row = credentialInsertRow(PROVIDER, SITE, body({ can_take_call: false }));
    expect(row.can_take_call).toBe(false);
    expect(row.can_take_weekend_call).toBe(true);
  });

  it('carries the identity columns', () => {
    const row = credentialInsertRow(PROVIDER, SITE, body());
    expect(row.provider_id).toBe(PROVIDER);
    expect(row.site_id).toBe(SITE);
  });

  it('defaults arrays to empty', () => {
    const row = credentialInsertRow(PROVIDER, SITE, body());
    expect(row.allowed_shift_types).toEqual([]);
  });
});

describe('effectiveRangeError', () => {
  it('accepts a well-ordered range', () => {
    expect(effectiveRangeError({
      effective_start_date: '2026-01-01', effective_end_date: '2026-12-31',
    })).toBeNull();
  });

  it('accepts equal dates', () => {
    expect(effectiveRangeError({
      effective_start_date: '2026-05-01', effective_end_date: '2026-05-01',
    })).toBeNull();
  });

  it('rejects an end before its start', () => {
    expect(effectiveRangeError({
      effective_start_date: '2026-12-31', effective_end_date: '2026-01-01',
    })).toMatch(/on or after/);
  });

  it('rejects a malformed date', () => {
    expect(effectiveRangeError({ effective_start_date: '31/12/2026' })).toMatch(/YYYY-MM-DD/);
  });

  it('accepts either side being null', () => {
    expect(effectiveRangeError({ effective_start_date: null, effective_end_date: '2026-01-01' }))
      .toBeNull();
  });

  it('accepts an empty object', () => {
    expect(effectiveRangeError({})).toBeNull();
  });
});

// ── the write path ─────────────────────────────────────────────────────────

describe('writeSiteCredential — an existing row is PARTIALLY updated', () => {
  it('issues UPDATE, not upsert, and names only the sent column', async () => {
    const { sb, calls } = sbWithExisting({ effective_start_date: null, effective_end_date: null });
    const res = await writeSiteCredential(sb, PROVIDER, body({ can_take_call: true }));

    expect(res.status).toBe(200);
    const update = calls.find(c => c.method === 'update');
    const upsert = calls.find(c => c.method === 'upsert');
    expect(upsert, 'must not upsert a whole row over an existing credential').toBeUndefined();
    expect(update?.args[0]).toEqual({ can_take_call: true });
  });

  it('does not resend the five booleans it was not given', async () => {
    // This is the regression. The old payload carried all six every time, so a
    // stale base silently reverted whichever flag had just been changed.
    const { sb, calls } = sbWithExisting({});
    await writeSiteCredential(sb, PROVIDER, body({ can_take_weekend_call: false }));

    const written = calls.find(c => c.method === 'update')?.args[0] as Record<string, unknown>;
    expect(Object.keys(written)).toEqual(['can_take_weekend_call']);
    expect(written).not.toHaveProperty('can_take_call');
    expect(written).not.toHaveProperty('is_active');
  });

  it('two disjoint patches never carry each other’s columns', async () => {
    // Concurrency property: Postgres is not writing the untouched columns at
    // all, so there is no value for a stale client copy to clobber.
    const a = sbWithExisting({});
    const b = sbWithExisting({});
    await writeSiteCredential(a.sb, PROVIDER, body({ can_take_call: true }));
    await writeSiteCredential(b.sb, PROVIDER, body({ can_take_holiday_call: false }));

    const wa = a.calls.find(c => c.method === 'update')?.args[0] as Record<string, unknown>;
    const wb = b.calls.find(c => c.method === 'update')?.args[0] as Record<string, unknown>;
    expect(Object.keys(wa)).not.toContain('can_take_holiday_call');
    expect(Object.keys(wb)).not.toContain('can_take_call');
  });

  it('does not wipe arrays that were not mentioned', async () => {
    const { sb, calls } = sbWithExisting({});
    await writeSiteCredential(sb, PROVIDER, body({ is_active: false }));
    const written = calls.find(c => c.method === 'update')?.args[0] as Record<string, unknown>;
    expect(written).not.toHaveProperty('allowed_shift_types');
    expect(written).not.toHaveProperty('skill_tags');
  });

  it('validates a one-sided date patch against the STORED other side', async () => {
    // Sending only an end date must not let you slip it before a start date
    // that is already on the row and simply was not mentioned.
    const { sb } = sbWithExisting({ effective_start_date: '2026-06-01', effective_end_date: null });
    const res = await writeSiteCredential(sb, PROVIDER, body({ effective_end_date: '2026-01-01' }));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'effective_end_date must be on or after effective_start_date' });
  });

  it('allows a one-sided date patch that is consistent with the stored side', async () => {
    const { sb } = sbWithExisting({ effective_start_date: '2026-01-01', effective_end_date: null });
    const res = await writeSiteCredential(sb, PROVIDER, body({ effective_end_date: '2026-12-31' }));
    expect(res.status).toBe(200);
  });

  it('lets a cleared start date release a previously blocked end date', async () => {
    const { sb } = sbWithExisting({ effective_start_date: '2026-12-31', effective_end_date: null });
    const res = await writeSiteCredential(sb, PROVIDER, body({
      effective_start_date: null, effective_end_date: '2026-01-01',
    }));
    expect(res.status).toBe(200);
  });

  it('treats a body naming nothing writable as a no-op read', async () => {
    const { sb, calls } = sbWithExisting({}, { id: 'c1' });
    const res = await writeSiteCredential(sb, PROVIDER, body());
    expect(res.status).toBe(200);
    expect(calls.find(c => c.method === 'update')).toBeUndefined();
  });
});

describe('writeSiteCredential — a missing row is INSERTED with defaults', () => {
  it('upserts the full defaults row when no credential exists', async () => {
    const { sb, calls } = sbWithExisting(null);
    const res = await writeSiteCredential(sb, PROVIDER, body({ credentialed: true, is_active: true }));

    expect(res.status).toBe(200);
    const upsert = calls.find(c => c.method === 'upsert');
    expect(upsert, 'a missing row must be created').toBeDefined();
    const row = upsert!.args[0] as Record<string, unknown>;
    // The "add a site" button posts only these two and expects call flags on.
    expect(row.can_take_call).toBe(true);
    expect(row.can_take_backup_call).toBe(true);
    expect(row.provider_id).toBe(PROVIDER);
  });

  it('upserts rather than inserts, so a create race resolves on the unique index', async () => {
    const { sb, calls } = sbWithExisting(null);
    await writeSiteCredential(sb, PROVIDER, body());
    const upsert = calls.find(c => c.method === 'upsert');
    expect(upsert!.args[1]).toEqual({ onConflict: 'provider_id,site_id' });
    expect(calls.find(c => c.method === 'insert')).toBeUndefined();
  });

  it('rejects a bad range on the insert path too', async () => {
    const { sb } = sbWithExisting(null);
    const res = await writeSiteCredential(sb, PROVIDER, body({
      effective_start_date: '2026-12-31', effective_end_date: '2026-01-01',
    }));
    expect(res.status).toBe(400);
  });
});

describe('writeSiteCredential — guards', () => {
  it('requires a site_id', async () => {
    const { sb } = sbWithExisting(null);
    const res = await writeSiteCredential(sb, PROVIDER, {});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'site_id is required' });
  });

  it('404s an unknown provider', async () => {
    const { sb } = makeSb({
      providers: { data: null },
      sites: { data: { organization_id: ORG } },
    });
    expect((await writeSiteCredential(sb, PROVIDER, body())).status).toBe(404);
  });

  it('404s an unknown site', async () => {
    const { sb } = makeSb({
      providers: { data: { organization_id: ORG } },
      sites: { data: null },
    });
    expect((await writeSiteCredential(sb, PROVIDER, body())).status).toBe(404);
  });

  it('refuses a site from another organization', async () => {
    const { sb } = makeSb({
      providers: { data: { organization_id: ORG } },
      sites: { data: { organization_id: 'org-2' } },
    });
    const res = await writeSiteCredential(sb, PROVIDER, body());
    expect(res.status).toBe(400);
    expect(String((res.body as { error: string }).error)).toMatch(/organization/);
  });

  it('surfaces a read failure as a 500 rather than writing anyway', async () => {
    const { sb, calls } = makeSb({
      providers: { data: { organization_id: ORG } },
      sites: { data: { organization_id: ORG } },
      provider_site_credentials: { error: { message: 'connection reset' } },
    });
    const res = await writeSiteCredential(sb, PROVIDER, body({ is_active: false }));
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'connection reset' });
    expect(calls.find(c => c.method === 'update')).toBeUndefined();
    expect(calls.find(c => c.method === 'upsert')).toBeUndefined();
  });
});
