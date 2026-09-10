'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, Banner, Spinner } from '@/components/ui';
import { MIN_PASSWORD_LENGTH } from '@/lib/auth/password';

interface InviteInfo {
  valid: boolean;
  message?: string;
  email?: string;
  providerName?: string;
}

export default function JoinPage({ params }: { params: { token: string } }) {
  const router = useRouter();
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/auth/invite/${encodeURIComponent(params.token)}`)
      .then(r => r.json())
      .then(setInfo)
      .catch(() => setInfo({ valid: false, message: 'Could not reach the server.' }));
  }, [params.token]);

  const mismatch = confirm.length > 0 && password !== confirm;
  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
  const canSubmit = password.length >= MIN_PASSWORD_LENGTH && password === confirm && !busy;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/auth/accept-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: params.token, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error || 'Could not create your account.'); return; }

      if (data.signedIn) { router.push('/me'); router.refresh(); }
      else setDone(data.message || 'Your account is ready. Please sign in.');
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={shell}>
      <div style={{ width: '100%', maxWidth: 440 }}>
        <div style={brand}>FloorRunner</div>

        {info === null && (
          <Card><div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--space-5)' }}><Spinner /></div></Card>
        )}

        {info && !info.valid && (
          <Card title="This link will not work">
            <Banner tone="warn">{info.message}</Banner>
            <div style={{ marginTop: 'var(--space-4)' }}>
              <Button onClick={() => router.push('/login')} variant="secondary">Go to sign in</Button>
            </div>
          </Card>
        )}

        {info?.valid && done && (
          <Card title="Account created">
            <Banner tone="success">{done}</Banner>
            <div style={{ marginTop: 'var(--space-4)' }}>
              <Button onClick={() => router.push('/login')} variant="primary">Sign in</Button>
            </div>
          </Card>
        )}

        {info?.valid && !done && (
          <form onSubmit={submit}>
            <Card title="Set your password">
              {/* The name is shown so the invitee can tell immediately that the
                  link is for THEM. It is the only confirmation they get that
                  the chief bound this login to the right record. */}
              <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', marginBottom: 'var(--space-4)', lineHeight: 1.6 }}>
                You are setting up the FloorRunner login for{' '}
                <strong style={{ color: 'var(--text-strong)' }}>{info.providerName || 'your account'}</strong>
                {info.email && <> using <strong style={{ color: 'var(--text-strong)' }}>{info.email}</strong></>}.
                {' '}If that is not you, close this page and tell the scheduler.
              </div>

              {error && <div style={{ marginBottom: 'var(--space-3)' }}><Banner tone="error">{error}</Banner></div>}

              <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
                <label style={{ display: 'grid', gap: 4 }}>
                  <span style={labelStyle}>Password</span>
                  <input
                    type="password" value={password} onChange={e => setPassword(e.target.value)}
                    autoComplete="new-password" required autoFocus
                    className="fr-field" style={inputStyle}
                  />
                  <span style={{ fontSize: 'var(--fs-xs)', color: tooShort ? 'var(--danger)' : 'var(--text-dim)' }}>
                    At least {MIN_PASSWORD_LENGTH} characters.
                  </span>
                </label>
                <label style={{ display: 'grid', gap: 4 }}>
                  <span style={labelStyle}>Confirm password</span>
                  <input
                    type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
                    autoComplete="new-password" required
                    className="fr-field" style={inputStyle}
                  />
                  {mismatch && (
                    <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--danger)' }}>
                      The two passwords do not match.
                    </span>
                  )}
                </label>
                <Button type="submit" variant="primary" disabled={!canSubmit}>
                  {busy ? 'Creating your account…' : 'Create account'}
                </Button>
              </div>
            </Card>
          </form>
        )}
      </div>
    </div>
  );
}

const shell: React.CSSProperties = {
  minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: 'var(--space-6)', background: 'var(--bg-base)',
};
const brand: React.CSSProperties = {
  fontSize: 'var(--fs-xl)', fontWeight: 800, color: 'var(--text-strong)',
  textAlign: 'center', marginBottom: 'var(--space-5)', letterSpacing: -0.4,
};
const labelStyle: React.CSSProperties = {
  fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--text-muted)',
};
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 12px', borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border)', background: 'var(--bg-deep)',
  color: 'var(--text)', fontSize: 'var(--fs-md)', outline: 'none',
};
