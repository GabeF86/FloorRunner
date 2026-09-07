'use client';

// Shared org→sites bootstrap sequence for /block-prep and /dashboard's
// DashboardTallyCard (round 7 review, Fix 2) — extracted after a fix landed
// in ONE of two hand-duplicated copies: page.tsx got a `noOrg` guard in round
// 6 (without it, an empty organizations list leaves the site select reading
// "Loading sites…" forever, since the sites fetch never runs without an org
// id), while DashboardTallyCard kept its own copy of the same sequence
// without it, and its own header claimed this class of bug was fixed when it
// wasn't. This is now the ONE place either host reads from, so a future fix
// can't land in only one copy again.
//
// Exposes three booleans rather than a single string, so each caller decides
// its OWN wording for the same facts (a `<option>` placeholder needs a
// different sentence than a card's collapsed hint) — `blockPrepView.ts`'s
// `siteBootstrapText` is the shared decision for the SHORT form both callers
// actually use today.

import { useEffect, useState } from 'react';

export interface Site { id: string; name: string; short_name: string | null }

export interface OrgAndSites {
  sites: Site[];
  siteId: string;
  setSiteId: (id: string) => void;
  /** The org OR sites fetch failed outright, or returned a malformed
   *  (non-array) body. Kept distinct from a genuinely empty `sites` array —
   *  a failure must never render as a confirmed "no sites". */
  error: string | null;
  /** The org fetch succeeded but returned zero organizations. Without this,
   *  the sites effect (gated on having an org id) never runs, and a caller
   *  with no other signal would read "loading" forever. */
  noOrg: boolean;
  /** True only once the sites fetch has genuinely completed successfully.
   *  Distinguishes "hasn't looked yet" from "looked and found zero" — both
   *  start from the same empty `sites` array. */
  sitesLoaded: boolean;
}

export function useOrgAndSites(): OrgAndSites {
  const [orgId, setOrgId] = useState('');
  const [sites, setSites] = useState<Site[]>([]);
  const [siteId, setSiteId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [noOrg, setNoOrg] = useState(false);
  const [sitesLoaded, setSitesLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/scheduling/organizations');
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body.error || `Could not load organizations (${res.status})`);
          return;
        }
        const orgs = await res.json();
        // A malformed (non-array) 200 must not silently fall through as
        // though it were a confirmed empty list — that reads identically to
        // "no organizations exist" downstream.
        if (!Array.isArray(orgs)) { setError('Organizations response was malformed.'); return; }
        if (orgs.length > 0) setOrgId(orgs[0].id);
        else setNoOrg(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error loading organizations');
      }
    })();
  }, []);

  useEffect(() => {
    if (!orgId) return;
    (async () => {
      try {
        const res = await fetch(`/api/scheduling/sites?org_id=${orgId}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body.error || `Could not load sites (${res.status})`);
          return;
        }
        const list = await res.json();
        // Same malformed-response guard as the org fetch — `sitesLoaded`
        // must only ever mean "genuinely looked and this is what came back",
        // never "got something, didn't check its shape".
        if (!Array.isArray(list)) { setError('Sites response was malformed.'); return; }
        setSites(list);
        if (list.length > 0) setSiteId(prev => prev || list[0].id);
        setSitesLoaded(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error loading sites');
      }
    })();
  }, [orgId]);

  return { sites, siteId, setSiteId, error, noOrg, sitesLoaded };
}
