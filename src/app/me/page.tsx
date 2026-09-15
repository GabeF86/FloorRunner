'use client';

// The provider landing page.
//
// Deliberately minimal. The real dashboard — schedule snapshot and call
// metrics — is its own piece of work, and most of its data layer already
// exists (the burden route, annualTally, callCodeBreakdown, blockTargets). What
// this page exists to do TODAY is stop invitation acceptance dead-ending on a
// 404, which is exactly what it did for the first person who used it, and give
// a signed-in person somewhere to confirm who they are and sign out.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, Banner, Spinner, Button } from '@/components/ui';
import { SignOutButton } from '@/components/SignOutButton';

interface Me {
  userId: string | null;
  email: string | null;
  role: 'anonymous' | 'provider' | 'admin';
  providerId: string | null;
}

export default function MePage() {
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.json())
      .then(setMe)
      .catch(() => setMe({ userId: null, email: null, role: 'anonymous', providerId: null }));
  }, []);

  return (
    <div style={{
      minHeight: '100vh', background: 'var(--bg-base)', padding: 'var(--space-6)',
    }}>
      <div style={{ maxWidth: 640, margin: '0 auto', display: 'grid', gap: 'var(--space-4)' }}>
        <div style={{
          fontSize: 'var(--fs-xl)', fontWeight: 800, color: 'var(--text-strong)',
          letterSpacing: -0.4, marginBottom: 'var(--space-2)',
        }}>
          FloorRunner
        </div>

        {me === null && (
          <Card><div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--space-5)' }}><Spinner /></div></Card>
        )}

        {me && !me.userId && (
          <Card title="You are not signed in">
            <Banner tone="info">Sign in to see your schedule and call counts.</Banner>
            <div style={{ marginTop: 'var(--space-4)' }}>
              <Link href="/login"><Button variant="primary">Go to sign in</Button></Link>
            </div>
          </Card>
        )}

        {me?.userId && (
          <>
            <Card title="You are signed in">
              <div style={{ display: 'grid', gap: 'var(--space-2)', fontSize: 'var(--fs-md)' }}>
                <Row label="Email" value={me.email ?? '—'} />
                <Row label="Role" value={me.role === 'admin' ? 'Administrator' : 'Provider'} />
                <Row
                  label="Linked record"
                  value={me.providerId ? 'Yes — your login is bound to your provider record' : 'Not linked'}
                />
              </div>
              <div style={{ marginTop: 'var(--space-4)', display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                {me.role === 'admin' && (
                  <Link href="/"><Button variant="primary">Open the scheduler</Button></Link>
                )}
                <SignOutButton standalone />
              </div>
            </Card>

            <Card title="Coming next">
              <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', lineHeight: 1.7 }}>
                Your call schedule, your call counts against what you owe, your PTO
                and days-off balances, and the onboarding questionnaire will appear
                here. Nothing is missing from your account — these screens are
                simply not built yet.
              </div>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'baseline' }}>
      <span style={{
        fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--text-muted)',
        minWidth: 120, flexShrink: 0,
      }}>
        {label}
      </span>
      <span style={{ color: 'var(--text)', minWidth: 0, wordBreak: 'break-word' }}>{value}</span>
    </div>
  );
}
