'use client';

// Sign out. Sits in the app-shell footer beside the theme toggle, and on /me.
//
// It renders NOTHING when nobody is signed in, which is the state the whole
// app was in until today and will be again for anyone who has not been
// invited. A dead "Sign out" control on a page you reached without signing in
// is worse than no control.

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui';

interface Props {
  /** Collapsed rail in the sidebar: icon only. */
  compact?: boolean;
  /** Render as a plain full-width button (used on /me). */
  standalone?: boolean;
}

export function SignOutButton({ compact = false, standalone = false }: Props) {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch('/api/auth/me')
      .then(r => r.json())
      .then(d => { if (alive) setEmail(d?.email ?? null); })
      .catch(() => { /* not signed in, or offline — render nothing */ });
    return () => { alive = false; };
  }, []);

  const signOut = useCallback(async () => {
    setBusy(true);
    try {
      await fetch('/api/auth/signout', { method: 'POST' });
      // Full reload rather than router.push: the session lives in cookies the
      // middleware reads, and a client-side navigation can keep serving a
      // cached tree rendered for the signed-in user.
      window.location.href = '/login';
    } catch {
      setBusy(false);
    }
  }, []);

  if (!email) return null;

  if (compact) {
    return (
      <button
        onClick={signOut}
        title={`Sign out (${email})`}
        aria-label={`Sign out (${email})`}
        className="fr-focus"
        style={{
          width: 34, height: 34, borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
          background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer',
        }}
      >
        ⏻
      </button>
    );
  }

  return (
    <div style={standalone ? undefined : { width: '100%' }}>
      {!standalone && (
        <div style={{
          fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', padding: '0 var(--space-2) 4px',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {email}
        </div>
      )}
      <Button
        variant="ghost"
        size="sm"
        onClick={signOut}
        disabled={busy}
        style={{ width: '100%', justifyContent: 'flex-start', gap: 10 }}
      >
        <span style={{ fontSize: 14, width: 20, textAlign: 'center' }}>⏻</span>
        {busy ? 'Signing out…' : 'Sign out'}
      </Button>
    </div>
  );
}
