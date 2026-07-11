'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';

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

const STATUS_COLORS: Record<string, { color: string; bg: string }> = {
  draft:    { color: '#64748b', bg: 'rgba(100,116,139,0.15)' },
  active:   { color: '#10b981', bg: 'rgba(16,185,129,0.15)' },
  archived: { color: 'var(--text-muted)', bg: 'rgba(100,116,139,0.15)' },
};

export default function RulesPage() {
  const [ruleSets, setRuleSets] = useState<RuleSet[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [orgId, setOrgId] = useState('');
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [filterStatus, setFilterStatus] = useState<string>('all');

  useEffect(() => {
    (async () => {
      const orgRes = await fetch('/api/scheduling/organizations');
      const orgs = await orgRes.json();
      if (orgs.length > 0) setOrgId(orgs[0].id);
      setLoading(false);
    })();
  }, []);

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

  useEffect(() => { loadData(); }, [loadData]);

  const filtered = filterStatus === 'all'
    ? ruleSets
    : ruleSets.filter(rs => rs.status === filterStatus);

  if (loading) return <div style={{ padding: 40, color: 'var(--text-muted)' }}>Loading...</div>;

  return (
    <div style={{ padding: '24px 32px' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)' }}>Rules Engine</h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>
            Configure scheduling constraints and automation rules per site
          </p>
        </div>
        <button onClick={() => setShowCreate(true)} style={{
          padding: '10px 20px', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13,
          background: 'linear-gradient(135deg,#0ea5e9,#6366f1)', color: '#fff', border: 'none',
        }}>+ Create Rule Set</button>
      </div>

      {/* Status filter */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 20 }}>
        {['all', 'draft', 'active', 'archived'].map(s => (
          <button key={s} onClick={() => setFilterStatus(s)} style={{
            padding: '6px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 700,
            border: `1px solid ${filterStatus === s ? '#0ea5e9' : 'var(--border)'}`,
            background: filterStatus === s ? 'rgba(14,165,233,0.1)' : 'transparent',
            color: filterStatus === s ? '#0ea5e9' : 'var(--text-muted)',
            textTransform: 'capitalize',
          }}>{s === 'all' ? `All (${ruleSets.length})` : `${s} (${ruleSets.filter(r => r.status === s).length})`}</button>
        ))}
      </div>

      {/* Table */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
        {/* Table header */}
        <div style={{
          display: 'grid', gridTemplateColumns: '2fr 1.5fr 100px 80px 140px',
          padding: '12px 20px', borderBottom: '1px solid var(--border)',
          fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', letterSpacing: 0.5, textTransform: 'uppercase',
        }}>
          <span>Name</span>
          <span>Site</span>
          <span>Status</span>
          <span style={{ textAlign: 'center' }}>Rules</span>
          <span>Created</span>
        </div>

        {/* Rows */}
        {filtered.map(rs => {
          const sc = STATUS_COLORS[rs.status] || STATUS_COLORS.draft;
          const ruleCount = rs.rule_definitions?.length || 0;
          return (
            <Link key={rs.id} href={`/rules/${rs.id}`} style={{ textDecoration: 'none' }}>
              <div style={{
                display: 'grid', gridTemplateColumns: '2fr 1.5fr 100px 80px 140px',
                padding: '14px 20px', borderBottom: '1px solid var(--border)',
                cursor: 'pointer', transition: 'background 0.1s',
                alignItems: 'center',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = 'rgba(14,165,233,0.04)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
              >
                <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{rs.name}</span>
                <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{rs.sites?.name || 'Unknown'}</span>
                <span>
                  <span style={{
                    fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 6,
                    background: sc.bg, color: sc.color, textTransform: 'capitalize',
                  }}>{rs.status}</span>
                </span>
                <span style={{ fontSize: 13, color: 'var(--text-muted)', textAlign: 'center', fontWeight: 600 }}>{ruleCount}</span>
                <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{new Date(rs.created_at).toLocaleDateString()}</span>
              </div>
            </Link>
          );
        })}

        {filtered.length === 0 && (
          <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-dim)', fontStyle: 'italic' }}>
            {filterStatus === 'all' ? 'No rule sets created yet. Click "Create Rule Set" to get started.' : `No ${filterStatus} rule sets.`}
          </div>
        )}
      </div>

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
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }} onClick={onClose}>
      <div className="modal-box" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 16, padding: 28, width: 460, maxHeight: '85vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 17, fontWeight: 800, color: 'var(--text-strong)', marginBottom: 22 }}>Create Rule Set</div>

        <label style={labelStyle}>Rule Set Name *</label>
        <input style={inputStyle} placeholder="e.g. Paoli Hospital Main Rules" value={name} onChange={e => setName(e.target.value)} />

        <label style={labelStyle}>Site *</label>
        <select value={siteId} onChange={e => setSiteId(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
          {sites.length === 0 && <option value="">No sites available</option>}
          {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button onClick={onClose} style={{ padding: '9px 18px', borderRadius: 8, cursor: 'pointer', background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border)', fontWeight: 600, fontSize: 13 }}>Cancel</button>
          <button onClick={submit} disabled={saving || !name.trim() || !siteId} style={{
            padding: '9px 20px', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13,
            background: 'linear-gradient(135deg,#0ea5e9,#6366f1)', color: '#fff', border: 'none', opacity: (saving || !name.trim() || !siteId) ? 0.5 : 1,
          }}>{saving ? 'Creating...' : 'Create'}</button>
        </div>
      </div>
    </div>
  );
}
