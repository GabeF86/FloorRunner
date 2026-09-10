'use client';

// The chief's invite control. Lives on the Profile tab because the thing it
// creates — a login bound to THIS provider record — is a fact about this
// person, not a scheduling setting.
//
// Delivery is copy-a-link. Supabase's built-in SMTP is rate-limited to a few
// messages an hour and is not meant for production, so 83 invitations would
// not get through it; a real sender is a follow-up. The link shown here is the
// same token an email would carry, so this is a manual path rather than a
// lesser one, and it stays as the fallback for a bounced address.

import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Banner, Badge } from '@/components/ui';

interface InviteState {
  hasLogin: boolean;
  suggestedEmail: string | null;
  latestInvitation: {
    email: string;
    status: 'pending' | 'accepted' | 'revoked';
    expires_at: string;
    created_at: string;
  } | null;
}

interface Created { url: string; email: string; expiresAt: string; providerName: string }

export function AccountCard({ providerId }: { providerId: string }) {
  const [state, setState] = useState<InviteState | null>(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/scheduling/providers/${providerId}/invite`);
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Could not load account status.'); return; }
      setState(data);
      setEmail(prev => prev || data.suggestedEmail || data.latestInvitation?.email || '');
    } catch {
      setError('Could not load account status.');
    }
  }, [providerId]);

  useEffect(() => { void load(); }, [load]);

  const invite = async () => {
    setBusy(true); setError(null); setCopied(false);
    try {
      const res = await fetch(`/api/scheduling/providers/${providerId}/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Could not create the invitation.'); return; }
      setCreated(data);
      await load();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard is blocked in some browsers without a user-gesture context;
      // the link is on screen and selectable either way, so this is not fatal.
      setError('Could not copy automatically — select the link and copy it.');
    }
  };

  if (!state) return null;

  const inv = state.latestInvitation;
  const pending = inv?.status === 'pending' && Date.parse(inv.expires_at) > Date.now();

  return (
    <Card
      title="Account"
      actions={
        state.hasLogin ? <Badge tone="ok">Has login</Badge>
          : pending ? <Badge tone="info">Invited</Badge>
            : <Badge tone="neutral">No login</Badge>
      }
    >
      {error && <div style={{ marginBottom: 'var(--space-3)' }}><Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner></div>}

      {state.hasLogin ? (
        <div style={hint}>
          This provider has signed in and their login is bound to this record.
        </div>
      ) : (
        <>
          <div style={{ ...hint, marginBottom: 'var(--space-3)' }}>
            Invite them to create a password. The link binds their login to{' '}
            <strong style={{ color: 'var(--text-strong)' }}>this</strong> provider record — they
            never choose who they are.
            {pending && inv && (
              <> An invitation sent {new Date(inv.created_at).toLocaleDateString()} to{' '}
                <strong style={{ color: 'var(--text-strong)' }}>{inv.email}</strong> is still open;
                inviting again replaces it and the old link stops working.
              </>
            )}
          </div>

          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'stretch', flexWrap: 'wrap' }}>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="their@email.com"
              aria-label="Email address for the invitation"
              className="fr-field"
              style={{
                flex: '1 1 220px', minWidth: 0, padding: '8px 11px',
                borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
                background: 'var(--bg-deep)', color: 'var(--text)', fontSize: 'var(--fs-md)',
                outline: 'none',
              }}
            />
            <Button onClick={invite} variant="primary" size="sm" disabled={busy || !email.trim()}>
              {busy ? 'Creating…' : pending ? 'Re-invite' : 'Invite'}
            </Button>
          </div>

          {created && (
            <div style={{ marginTop: 'var(--space-4)' }}>
              <Banner tone="success">
                Invitation created for {created.providerName}. Send them this link — it expires{' '}
                {new Date(created.expiresAt).toLocaleDateString()}.
              </Banner>
              <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
                <code style={{
                  flex: '1 1 260px', minWidth: 0, padding: '8px 11px', fontSize: 'var(--fs-xs)',
                  borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
                  background: 'var(--bg-deep)', color: 'var(--text)',
                  overflowX: 'auto', whiteSpace: 'nowrap',
                }}>
                  {created.url}
                </code>
                <Button onClick={copy} variant="secondary" size="sm">
                  {copied ? 'Copied' : 'Copy link'}
                </Button>
              </div>
              <div style={{ ...hint, marginTop: 'var(--space-2)' }}>
                This link is shown once. It is the only copy — the database stores
                a hash, so it cannot be recovered. Re-invite to issue a new one.
              </div>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

const hint: React.CSSProperties = {
  fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', lineHeight: 1.6,
};
