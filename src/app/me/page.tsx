'use client';

// The clinician landing page — what a physician sees the moment they sign in.
//
// It renders the SAME overview component back office sees on the provider
// profile, from /api/scheduling/me/overview. That route takes no id: the
// provider comes from the session, which is what stops one physician reading
// another's record (see lib/auth/routeAccess).
//
// This page replaced a placeholder that said the real dashboard "is its own
// piece of work". It is now that work: employment, call owed against call
// taken, hours scheduled, credentialed sites and PTO.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, Banner, Spinner, Button } from '@/components/ui';
import { SignOutButton } from '@/components/SignOutButton';
import { ProviderOverviewView } from '@/components/ProviderOverview';
import type { OverviewProvider, OverviewSite, ProviderOverview } from '@/lib/providerOverview';

interface Me {
  userId: string | null;
  email: string | null;
  role: 'anonymous' | 'provider' | 'admin';
  providerId: string | null;
}

interface OverviewPayload {
  provider: OverviewProvider;
  sites: OverviewSite[];
  overview: ProviderOverview;
  errors: string[];
}

export default function MePage() {
  const [me, setMe] = useState<Me | null>(null);
  const [data, setData] = useState<OverviewPayload | null>(null);
  // Three states, not two: still loading, loaded, and failed. A failure that
  // renders as "loading for ever" is the one thing worse than an error.
  const [overviewError, setOverviewError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.json())
      .then(setMe)
      .catch(() => setMe({ userId: null, email: null, role: 'anonymous', providerId: null }));
  }, []);

  useEffect(() => {
    if (!me?.providerId) return;
    fetch('/api/scheduling/me/overview')
      .then(async r => {
        const body = await r.json();
        if (!r.ok) throw new Error(body?.error || `Request failed (${r.status})`);
        return body as OverviewPayload;
      })
      .then(setData)
      .catch(e => setOverviewError(e instanceof Error ? e.message : 'Overview could not be loaded.'));
  }, [me?.providerId]);

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-base)', padding: 'var(--space-6)' }}>
      <div style={{ maxWidth: 1100, margin: '0 auto', display: 'grid', gap: 'var(--space-4)' }}>
        <div style={{
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          gap: 'var(--space-4)', flexWrap: 'wrap',
        }}>
          <div style={{
            fontSize: 'var(--fs-xl)', fontWeight: 800, color: 'var(--text-strong)',
            letterSpacing: -0.4,
          }}>
            Floor<span style={{ color: 'var(--blue)' }}>Runner</span>
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
            {me?.role === 'admin' && (
              <Link href="/dashboard"><Button variant="ghost" size="sm">Open the scheduler</Button></Link>
            )}
            {me?.userId && <SignOutButton standalone />}
          </div>
        </div>

        {me === null && (
          <Card>
            <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--space-5)' }}>
              <Spinner />
            </div>
          </Card>
        )}

        {me && !me.userId && (
          <Card title="You are not signed in">
            <Banner tone="info">Sign in to see your schedule and call counts.</Banner>
            <div style={{ marginTop: 'var(--space-4)' }}>
              <Link href="/login"><Button variant="primary">Go to sign in</Button></Link>
            </div>
          </Card>
        )}

        {/* An admin login that is not itself a physician has no overview of its
            own. Said plainly rather than showing an empty one. */}
        {me?.userId && !me.providerId && (
          <Card title="No provider record linked">
            <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', lineHeight: 1.7 }}>
              You are signed in as <strong>{me.email}</strong>, but this login is not bound to a
              provider record — so there is no personal schedule to show. An administrator can
              link it from the provider&rsquo;s profile.
            </div>
          </Card>
        )}

        {me?.providerId && overviewError && (
          <Banner tone="error">{overviewError}</Banner>
        )}

        {me?.providerId && !data && !overviewError && (
          <Card>
            <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--space-5)' }}>
              <Spinner />
            </div>
          </Card>
        )}

        {data && (
          <ProviderOverviewView
            provider={data.provider}
            sites={data.sites}
            data={data.overview}
            errors={data.errors}
          />
        )}
      </div>
    </div>
  );
}
