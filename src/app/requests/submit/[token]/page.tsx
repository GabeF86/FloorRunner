// PUBLIC intake page — the one shared link Gabriel sends the group while a
// request window is open (/requests/submit/<token>). Lives OUTSIDE the
// (scheduling) route group on purpose: providers clicking the link must not
// land inside the internal AppShell nav. The token is validated server-side
// here (and again in the POST route); a closed or unknown token renders a
// friendly closed page, never a form.
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import IntakeForm from './IntakeForm';

export const dynamic = 'force-dynamic';

interface RosterProvider {
  id: string;
  first_name: string;
  last_name: string;
}

export default async function RequestSubmitPage({ params }: { params: { token: string } }) {
  const sb = sbSchedulingServer();

  const { data: window } = await sb
    .from('request_windows')
    .select('id, site_id, block_start, block_end, max_no_call_requests, status, sites:site_id(name, short_name)')
    .eq('token', params.token)
    .maybeSingle();

  if (!window || window.status !== 'open') {
    return (
      <Frame>
        <div style={{ textAlign: 'center', padding: '32px 8px' }}>
          <div style={{ fontSize: 34, marginBottom: 12 }}>🗓️</div>
          <h1 style={{ fontSize: 19, fontWeight: 800, color: 'var(--text)', marginBottom: 8 }}>
            This request window has closed
          </h1>
          <p style={{ fontSize: 13.5, color: 'var(--text-muted)', lineHeight: 1.6, maxWidth: 380, margin: '0 auto' }}>
            {window
              ? 'Submissions for this scheduling block are no longer being accepted. If you still need time off or a schedule change, contact your scheduler directly.'
              : 'This link isn’t valid. Check that you copied the full link from your scheduler, or ask for a fresh one.'}
          </p>
        </div>
      </Frame>
    );
  }

  // Active roster for the window's site: home-sited, active providers.
  // (Same home-site predicate the engine's pools use.)
  const { data: profileRows } = await sb
    .from('provider_employment_profiles')
    .select('provider_id')
    .eq('home_site_id', window.site_id);
  const rosterIds = (profileRows || []).map((r: { provider_id: string }) => r.provider_id);

  let roster: RosterProvider[] = [];
  if (rosterIds.length > 0) {
    const { data: providers } = await sb
      .from('providers')
      .select('id, first_name, last_name')
      .in('id', rosterIds)
      .eq('status', 'active')
      .order('last_name');
    roster = (providers || []) as RosterProvider[];
  }

  const site = window.sites as unknown as { name: string; short_name: string | null } | null;

  return (
    <Frame>
      <IntakeForm
        token={params.token}
        siteName={site?.name || 'your site'}
        blockStart={window.block_start}
        blockEnd={window.block_end}
        maxNoCall={window.max_no_call_requests}
        roster={roster}
      />
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      minHeight: '100vh', background: 'var(--bg-base)',
      display: 'flex', justifyContent: 'center', padding: '32px 16px',
    }}>
      <div style={{ width: '100%', maxWidth: 620 }}>
        <div style={{
          fontSize: 11, fontWeight: 800, letterSpacing: 1.5, textTransform: 'uppercase',
          color: 'var(--text-dim)', marginBottom: 14,
          fontFamily: 'var(--font-mono), ui-monospace, monospace',
        }}>
          FloorRunner · Schedule Requests
        </div>
        <div style={{
          background: 'var(--bg-surface)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-card)',
          padding: '24px 26px',
        }}>
          {children}
        </div>
      </div>
    </div>
  );
}
