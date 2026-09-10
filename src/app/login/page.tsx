'use client';

import { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, Card, Banner } from '@/components/ui';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/auth/signin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error || 'Could not sign in.'); return; }

      // `next` is where the middleware bounced them from. Only relative paths
      // are honoured: an absolute URL here would make this an open redirect,
      // which is exactly the shape a phishing link wants from a login page.
      const next = params.get('next');
      const to = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
      router.push(to);
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <Card title="Sign in" style={{ maxWidth: 400, width: '100%' }}>
        {error && <div style={{ marginBottom: 'var(--space-3)' }}><Banner tone="error">{error}</Banner></div>}
        <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={labelStyle}>Email</span>
            <input
              type="email" value={email} onChange={e => setEmail(e.target.value)}
              autoComplete="username" required autoFocus
              className="fr-field" style={inputStyle}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={labelStyle}>Password</span>
            <input
              type="password" value={password} onChange={e => setPassword(e.target.value)}
              autoComplete="current-password" required
              className="fr-field" style={inputStyle}
            />
          </label>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </div>
      </Card>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 'var(--space-6)', background: 'var(--bg-base)',
    }}>
      <div style={{ width: '100%', maxWidth: 400 }}>
        <div style={{
          fontSize: 'var(--fs-xl)', fontWeight: 800, color: 'var(--text-strong)',
          textAlign: 'center', marginBottom: 'var(--space-5)', letterSpacing: -0.4,
        }}>
          FloorRunner
        </div>
        {/* useSearchParams needs a Suspense boundary or `next build` fails the
            page with a prerender error. */}
        <Suspense fallback={null}>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--text-muted)',
};
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 12px', borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border)', background: 'var(--bg-deep)',
  color: 'var(--text)', fontSize: 'var(--fs-md)', outline: 'none',
};
