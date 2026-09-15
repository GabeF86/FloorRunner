'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { PageHeader, Card, Badge, Button, Table, EmptyState, Banner, Modal, type BadgeTone } from '@/components/ui';

interface RuleSet {
  id: string;
  organization_id: string;
  site_id: string;
  name: string;
  status: 'draft' | 'active' | 'archived';
  effective_start_date: string | null;
  effective_end_date: string | null;
  original_plain_text: string | null;
  ai_summary: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
  sites: { name: string } | null;
  rule_definitions?: { id: string }[];
}

interface Site {
  id: string;
  name: string;
  short_name: string | null;
}

const STATUS_TONES: Record<string, BadgeTone> = {
  draft:    'neutral',
  active:   'ok',
  archived: 'neutral',
};

const TABLE_HEADERS = ['Name', 'Site', 'Status', 'Rules', 'Created'];

export interface RulesClientProps {
  /** Read by the server in the same request as the page shell, rule counts
   *  already folded in. */
  initialRuleSets: RuleSet[];
  initialSites: Site[];
  orgId: string;
  /** Set when the server's organizations or rule-set read failed — shown
   *  INSTEAD of the list, because an empty list here invites the user to create
   *  a rule set that may already exist. */
  loadError: string | null;
}

export default function RulesClient(
  { initialRuleSets, initialSites, orgId, loadError }: RulesClientProps,
) {
  const [ruleSets, setRuleSets] = useState<RuleSet[]>(initialRuleSets);
  const [sites, setSites] = useState<Site[]>(initialSites);
  // `loading` starts FALSE: the rows arrived with the HTML. Starting true would
  // paint a skeleton over data the user can already see, which is the exact
  // flash this refactor removes.
  const [loading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  // 'all' is the default the SERVER renders too — it passes no status filter —
  // so the first click on a status chip cannot appear to change the list back
  // to something it was already showing.
  const [filterStatus, setFilterStatus] = useState<string>('all');

  // The reload effect below also fires on mount, which would immediately
  // refetch the list the server just sent and reinstate the very waterfall this
  // page was converted to avoid. The first run is skipped; later runs are real
  // reloads (a rule set was created, or orgId changed under a server
  // re-render).
  const seeded = useRef(true);

  // The organization used to be fetched here and every other query gated behind
  // it — a round trip to learn an id that never changes. The server component
  // resolves it now and passes it in, and reports its own failure through
  // `loadError`.

  const loadData = useCallback(async () => {
    if (!orgId) return;
    const [rsRes, sitesRes] = await Promise.all([
      fetch('/api/scheduling/rule-sets?org_id=' + orgId),
      fetch('/api/scheduling/sites?org_id=' + orgId),
    ]);
    const rsData = await rsRes.json();
    const sitesData = await sitesRes.json();
    // Load rule counts per rule set
    const defRes = await fetch('/api/scheduling/rule-definitions');
    const allDefs = await defRes.json();
    const enriched = (Array.isArray(rsData) ? rsData : []).map((rs: RuleSet) => ({
      ...rs,
      rule_definitions: Array.isArray(allDefs) ? allDefs.filter((d: { rule_set_id: string }) => d.rule_set_id === rs.id) : [],
    }));
    setRuleSets(enriched);
    setSites(Array.isArray(sitesData) ? sitesData : []);
  }, [orgId]);

  useEffect(() => {
    if (seeded.current) { seeded.current = false; return; }
    loadData();
  }, [loadData]);

  const filtered = filterStatus === 'all'
    ? ruleSets
    : ruleSets.filter(rs => rs.status === filterStatus);

  if (loading) {
    return (
      <div>
        <PageHeader title="Rules Engine" />
        <Card pad={false}>
          <Table headers={TABLE_HEADERS} rows={undefined} minWidth={560} />
        </Card>
      </div>
    );
  }

  // Only reached when a server read genuinely FAILED — never when it succeeded
  // and came back empty, which is the onboarding case the table renders.
  if (loadError) {
    return (
      <div>
        <PageHeader title="Rules Engine" />
        <Banner tone="error">{loadError} Reload the page to try again.</Banner>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Rules Engine"
        subtitle="Configure scheduling constraints and automation rules per site"
        actions={<Button onClick={() => setShowCreate(true)}>+ Create Rule Set</Button>}
      />

      {/* Status filter */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 20 }}>
        {['all', 'draft', 'active', 'archived'].map(s => (
          <Button
            key={s}
            variant="secondary"
            size="sm"
            onClick={() => setFilterStatus(s)}
            style={{
              textTransform: 'capitalize',
              ...(filterStatus === s
                ? { borderColor: 'var(--blue)', background: 'var(--info-bg)', color: 'var(--blue)' }
                : { color: 'var(--text-muted)' }),
            }}
          >
            {s === 'all' ? `All (${ruleSets.length})` : `${s} (${ruleSets.filter(r => r.status === s).length})`}
          </Button>
        ))}
      </div>

      {/* Table */}
      <Card pad={false}>
        <Table
          headers={TABLE_HEADERS}
          minWidth={560}
          rows={filtered.map(rs => {
            const ruleCount = rs.rule_definitions?.length || 0;
            return [
              <Link key="name" href={`/rules/${rs.id}`} style={{ textDecoration: 'none', color: 'var(--text-strong)', fontWeight: 700 }}>
                {rs.name}
              </Link>,
              rs.sites?.name || 'Unknown',
              <Badge key="status" tone={STATUS_TONES[rs.status] || 'neutral'}>{rs.status}</Badge>,
              String(ruleCount),
              new Date(rs.created_at).toLocaleDateString(),
            ];
          })}
          empty={
            <EmptyState
              icon="⚖"
              title={filterStatus === 'all' ? 'No rule sets created yet' : `No ${filterStatus} rule sets`}
              hint={filterStatus === 'all'
                ? "Create a rule set to encode a site's scheduling constraints — the engine validates every schedule against them."
                : 'Switch the status filter to see rule sets in other states.'}
              action={filterStatus === 'all'
                ? <Button size="sm" onClick={() => setShowCreate(true)}>+ Create Rule Set</Button>
                : undefined}
            />
          }
        />
      </Card>

      {showCreate && (
        <CreateRuleSetModal
          orgId={orgId}
          sites={sites}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); loadData(); }}
        />
      )}
    </div>
  );
}

// ── Create Rule Set Modal ─────────────────────────────────────────────────────
function CreateRuleSetModal({ orgId, sites, onClose, onCreated }: {
  orgId: string;
  sites: Site[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [siteId, setSiteId] = useState(sites[0]?.id || '');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!name.trim() || !siteId) return;
    setSaving(true);
    await fetch('/api/scheduling/rule-sets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organization_id: orgId, site_id: siteId, name: name.trim() }),
    });
    onCreated();
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '10px 12px', borderRadius: 8,
    border: '1px solid var(--border)', background: 'var(--bg-deep)',
    color: 'var(--text)', fontSize: 14, marginBottom: 12,
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 11, color: 'var(--text-muted)', display: 'block',
    marginBottom: 5, fontWeight: 600, letterSpacing: 0.5,
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Create Rule Set"
      width={460}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={saving || !name.trim() || !siteId}>
            {saving ? 'Creating...' : 'Create'}
          </Button>
        </>
      }
    >
      <label style={labelStyle}>Rule Set Name *</label>
      <input style={inputStyle} placeholder="e.g. Paoli Hospital Main Rules" value={name} onChange={e => setName(e.target.value)} />

      <label style={labelStyle}>Site *</label>
      <select value={siteId} onChange={e => setSiteId(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
        {sites.length === 0 && <option value="">No sites available</option>}
        {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </Modal>
  );
}
