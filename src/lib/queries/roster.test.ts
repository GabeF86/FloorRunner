/**
 * The roster queries, which are now read by TWO callers — the API route and
 * the server component that renders the same list. That is exactly why they
 * are tested: a filter that behaves differently in one caller than the other
 * would show a chief one roster on load and a different one after touching a
 * dropdown, with nothing failing.
 */
import { describe, it, expect } from 'vitest';
import { makeFakeSupabase, type TableCfg } from '@/lib/rulesEngine/__fixtures__/fakeSupabase';
import { listProviders, listSites, firstOrgId, providerFiltersFrom } from './roster';

const PROVIDERS = [
  { id: 'p1', last_name: 'Alpha', organization_id: 'org1', status: 'active', provider_type: 'physician' },
  { id: 'p2', last_name: 'Beta', organization_id: 'org1', status: 'active', provider_type: 'crna' },
];
const PROFILES = [
  { provider_id: 'p1', fte_value: 1, home_site_id: 'siteA' },
  { provider_id: 'p2', fte_value: 0.5, home_site_id: 'siteB' },
];

function sbWith(over: Record<string, TableCfg> = {}) {
  return makeFakeSupabase({
    tables: {
      providers: { data: PROVIDERS },
      provider_employment_profiles: { data: PROFILES },
      provider_site_credentials: { data: [] },
      sites: { data: [{ id: 'siteA', name: 'Paoli' }] },
      organizations: { data: [{ id: 'org1' }] },
      ...over,
    },
  });
}

describe('providerFiltersFrom', () => {
  it('reads every filter the module understands', () => {
    const f = providerFiltersFrom(new URLSearchParams(
      'org_id=o&status=active&provider_type=crna&search=vu&home_site_id=h&credentialed_site_id=c',
    ));
    expect(f).toEqual({
      orgId: 'o', status: 'active', providerType: 'crna',
      search: 'vu', homeSiteId: 'h', credentialedSiteId: 'c',
    });
  });

  it('yields nulls for an empty query string, which every branch treats as absent', () => {
    expect(providerFiltersFrom(new URLSearchParams())).toEqual({
      orgId: null, status: null, providerType: null,
      search: null, homeSiteId: null, credentialedSiteId: null,
    });
  });
});

describe('listProviders', () => {
  it('attaches the employment profile as a one-element array', async () => {
    // Shape matters: the client reads provider_employment_profiles[0], and it
    // is fetched separately rather than joined because PostgREST join rows
    // come back empty intermittently right after a write.
    const { sb } = sbWith();
    const r = await listProviders(sb, { orgId: 'org1' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows[0].provider_employment_profiles).toEqual([PROFILES[0]]);
  });

  it('gives a provider with no profile an EMPTY array, not undefined', async () => {
    const { sb } = sbWith({ provider_employment_profiles: { data: [PROFILES[0]] } });
    const r = await listProviders(sb, { orgId: 'org1' });
    if (!r.ok) throw new Error('expected ok');
    expect(r.rows.find(x => x.id === 'p2')!.provider_employment_profiles).toEqual([]);
  });

  it('rejects an unknown status with 400 rather than querying for it', async () => {
    const { sb, calls } = sbWith();
    const r = await listProviders(sb, { status: 'nonsense' });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(calls.filter(c => c.table === 'providers' && c.method === 'eq')).toHaveLength(0);
  });

  it('rejects an unknown provider_type with 400', async () => {
    const { sb } = sbWith();
    expect(await listProviders(sb, { providerType: 'wizard' })).toMatchObject({ ok: false, status: 400 });
  });

  it('strips PostgREST OR-filter metacharacters out of a search term', async () => {
    // A name containing a comma or a paren could otherwise break out of the
    // or() expression and change which rows match.
    const { sb, calls } = sbWith();
    await listProviders(sb, { search: "O'Brien, (Pat) 100%" });
    const or = calls.find(c => c.method === 'or');
    expect(or).toBeTruthy();
    const expr = String(or!.args[0]);
    // The expression legitimately contains `%` (the ilike wildcard) and ONE
    // comma (separating the first_name and last_name clauses). The injection
    // risk is the user's own comma creating a THIRD clause, so that is what
    // is asserted — exactly two clauses, and no parens survived.
    expect(expr.split(',')).toHaveLength(2);
    expect(expr).not.toMatch(/[()]/);
    expect(expr).toContain("O'Brien");
  });

  it('drops a search that is nothing BUT metacharacters, rather than filtering on empty', async () => {
    const { sb, calls } = sbWith();
    await listProviders(sb, { search: '(),%' });
    expect(calls.find(c => c.method === 'or')).toBeUndefined();
  });

  it('short-circuits to no rows when a site filter matches nobody', async () => {
    // Without this an `.in('id', [])` would be issued, which PostgREST treats
    // as "no constraint" and would return the WHOLE roster — the opposite of
    // what the filter asked for.
    const { sb } = sbWith({ provider_site_credentials: { data: [] } });
    const r = await listProviders(sb, { credentialedSiteId: 'siteZ' });
    expect(r).toEqual({ ok: true, rows: [] });
  });

  it('short-circuits the same way for an empty home-site match', async () => {
    const { sb } = sbWith({ provider_employment_profiles: { data: [] } });
    const r = await listProviders(sb, { homeSiteId: 'siteZ' });
    expect(r).toEqual({ ok: true, rows: [] });
  });

  it('surfaces a read failure as 500 instead of an empty roster', async () => {
    // "No providers" and "the database did not answer" must never look alike.
    const { sb } = sbWith({ providers: { data: null, error: { message: 'db down' } } });
    const r = await listProviders(sb, { orgId: 'org1' });
    expect(r).toMatchObject({ ok: false, status: 500, error: 'db down' });
  });

  it('treats a genuinely empty roster as a real answer', async () => {
    const { sb } = sbWith({ providers: { data: [] } });
    expect(await listProviders(sb, { orgId: 'org1' })).toEqual({ ok: true, rows: [] });
  });
});

describe('listSites', () => {
  it('returns rows for an org', async () => {
    const { sb } = sbWith();
    expect(await listSites(sb, 'org1')).toEqual({ ok: true, rows: [{ id: 'siteA', name: 'Paoli' }] });
  });

  it('reports a failure rather than an empty site list', async () => {
    const { sb } = sbWith({ sites: { data: null, error: { message: 'boom' } } });
    expect(await listSites(sb, 'org1')).toMatchObject({ ok: false, status: 500 });
  });
});

describe('firstOrgId', () => {
  it('returns the id the pages used to spend a round trip learning', async () => {
    const { sb } = sbWith();
    expect(await firstOrgId(sb)).toBe('org1');
  });

  it('returns null when there is no organization yet, so the page can onboard', async () => {
    const { sb } = sbWith({ organizations: { data: [] } });
    expect(await firstOrgId(sb)).toBeNull();
  });

  it('returns null on a failed read — the caller renders setup, never a crash', async () => {
    const { sb } = sbWith({ organizations: { data: null, error: { message: 'x' } } });
    expect(await firstOrgId(sb)).toBeNull();
  });
});
