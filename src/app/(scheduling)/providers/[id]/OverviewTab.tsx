'use client';

// The Overview tab — back office reading a clinician's standing.
//
// It renders the SAME component the clinician sees at /me, from the admin
// variant of the route. Identical either way, deliberately: the number a
// physician reads about their own call must be the number the office is
// reading about them, or the two will argue about whose screen is right.

import { useEffect, useState } from 'react';
import { Banner, Spinner, Card } from '@/components/ui';
import { ProviderOverviewView } from '@/components/ProviderOverview';
import type { OverviewProvider, OverviewSite, ProviderOverview } from '@/lib/providerOverview';

interface Payload {
  provider: OverviewProvider;
  sites: OverviewSite[];
  overview: ProviderOverview;
  errors: string[];
}

export function OverviewTab({ providerId }: { providerId: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setData(null); setError(null);
    fetch(`/api/scheduling/providers/${providerId}/overview`)
      .then(async r => {
        const body = await r.json();
        if (!r.ok) throw new Error(body?.error || `Request failed (${r.status})`);
        return body as Payload;
      })
      .then(d => { if (live) setData(d); })
      .catch(e => { if (live) setError(e instanceof Error ? e.message : 'Overview could not be loaded.'); });
    return () => { live = false; };
  }, [providerId]);

  if (error) return <Banner tone="error">{error}</Banner>;
  if (!data) {
    return (
      <Card>
        <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--space-5)' }}>
          <Spinner />
        </div>
      </Card>
    );
  }
  return (
    <ProviderOverviewView
      provider={data.provider}
      sites={data.sites}
      data={data.overview}
      errors={data.errors}
      viewingOther
    />
  );
}
