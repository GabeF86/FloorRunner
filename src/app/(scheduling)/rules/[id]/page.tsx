'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Badge, Button, Modal, Banner, EmptyState } from '@/components/ui';

// ── Types ─────────────────────────────────────────────────────────────────────

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
  rule_definitions: RuleDefinition[];
}

interface RuleDefinition {
  id: string;
  rule_set_id: string;
  rule_name: string;
  rule_category: RuleCategory;
  hard_constraint: boolean;
  priority_rank: number;
  applies_to_provider_group: 'physician' | 'crna' | 'both';
  applies_to_shift_types: string[] | null;
  applies_to_day_types: string[] | null;
  condition: Record<string, unknown> | null;
  action: Record<string, unknown> | null;
  explanation_text: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface ShiftType {
  id: string;
  site_id: string;
  code: string;
  name: string;
}

type RuleCategory =
  | 'coverage' | 'sequence' | 'eligibility' | 'frequency'
  | 'rest' | 'pairing' | 'fairness' | 'open_slot' | 'time_off' | 'cross_site';

interface PerRuleActivity {
  rule_id: string | null;
  rule_name: string;
  hard_count: number;
  soft_count: number;
  total: number;
}

interface RuleSetActivity {
  rule_set_id: string;
  site_id: string;
  assignments_checked: number;
  assignments_with_violations: number;
  total_violations: number;
  hard_count: number;
  soft_count: number;
  per_rule: PerRuleActivity[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CATEGORIES: { value: RuleCategory; label: string; color: string }[] = [
  { value: 'coverage',    label: 'Coverage',    color: '#0ea5e9' },
  { value: 'sequence',    label: 'Sequence',    color: '#f59e0b' },
  { value: 'eligibility', label: 'Eligibility', color: '#a78bfa' },
  { value: 'frequency',   label: 'Frequency',   color: '#10b981' },
  { value: 'rest',        label: 'Rest',        color: '#fb923c' },
  { value: 'pairing',     label: 'Pairing',     color: '#f87171' },
  { value: 'fairness',    label: 'Fairness',    color: '#8b5cf6' },
  { value: 'open_slot',   label: 'Open Slot',   color: '#64748b' },
  { value: 'time_off',    label: 'Time Off',    color: '#34d399' },
  { value: 'cross_site',  label: 'Cross-Site',  color: '#fbbf24' },
];

const CAT_COLOR_MAP: Record<string, string> = {};
CATEGORIES.forEach(c => { CAT_COLOR_MAP[c.value] = c.color; });

const DAY_TYPES = ['weekday', 'friday', 'saturday', 'sunday', 'federal_holiday', 'major_holiday'];

// ── Shared Styles ─────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px', borderRadius: 8,
  border: '1px solid var(--border)', background: 'var(--bg-deep)',
  color: 'var(--text)', fontSize: 14, marginBottom: 12,
  boxSizing: 'border-box',
};

const labelStyle: React.CSSProperties = {
  fontSize: 11, color: 'var(--text-muted)', display: 'block',
  marginBottom: 5, fontWeight: 600, letterSpacing: 0.5,
};

// ── InfoTip ───────────────────────────────────────────────────────────────────

function RuleActivityBadge({ activity, ruleId, isActive }: {
  activity: RuleSetActivity | null;
  ruleId: string;
  isActive: boolean;
}) {
  if (!isActive) return null;
  if (!activity) return null;
  const row = activity.per_rule.find(r => r.rule_id === ruleId);
  if (!row) {
    // Active rule that hasn't fired in any validated assignment.
    return (
      <span title="No violations recorded across this site's assignments." style={{
        fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 4,
        background: 'rgba(16,185,129,0.10)', color: '#16a34a',
        fontFamily: 'var(--font-mono), ui-monospace, monospace',
      }}>0 fires</span>
    );
  }
  const isHard = row.hard_count > 0;
  return (
    <span title={`${row.hard_count} hard · ${row.soft_count} soft across ${activity.assignments_checked} validated assignments`} style={{
      fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 4,
      background: isHard ? 'rgba(239,68,68,0.12)' : 'rgba(245,158,11,0.12)',
      color: isHard ? '#dc2626' : '#b45309',
      fontFamily: 'var(--font-mono), ui-monospace, monospace',
    }}>
      {row.total} fire{row.total === 1 ? '' : 's'}
    </span>
  );
}

function ActivitySummary({ activity, ruleSetStatus }: {
  activity: RuleSetActivity | null;
  ruleSetStatus: 'draft' | 'active' | 'archived';
}) {
  if (!activity) {
    return (
      <Card style={{ marginBottom: 24 }}>
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>Loading activity…</span>
      </Card>
    );
  }
  const isInactive = ruleSetStatus !== 'active';
  const hasFires = activity.total_violations > 0;

  return (
    <Card
      title="Rule activity"
      actions={
        <span style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--font-mono), ui-monospace, monospace' }}>
          across all schedules at this site
        </span>
      }
      style={{ marginBottom: 24 }}
    >
      {isInactive && (
        <div style={{ marginBottom: 8 }}>
          <Banner tone="warn">
            This rule set is <strong>{ruleSetStatus}</strong> — the algorithm is not consulting these rules. Activate the set to start enforcing.
          </Banner>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: hasFires ? 12 : 0 }}>
        <Stat label="Assignments checked" value={activity.assignments_checked} fontMono />
        <Stat label="Clean" value={activity.assignments_checked - activity.assignments_with_violations} color="var(--ok)" fontMono />
        <Stat label="Hard violations" value={activity.hard_count} color={activity.hard_count > 0 ? 'var(--danger)' : 'var(--text-dim)'} fontMono />
        <Stat label="Soft violations" value={activity.soft_count} color={activity.soft_count > 0 ? 'var(--warn)' : 'var(--text-dim)'} fontMono />
      </div>

      {!isInactive && activity.assignments_checked === 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-dim)', fontStyle: 'italic' }}>
          No assignments at this site have been validated yet. Run auto-generate on a schedule for this site to populate the counts.
        </div>
      )}
    </Card>
  );
}

function Stat({ label, value, color, fontMono }: { label: string; value: number; color?: string; fontMono?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 600, marginBottom: 2 }}>
        {label}
      </div>
      <div style={{
        fontSize: 18, fontWeight: 800, color: color ?? 'var(--text)',
        fontFamily: fontMono ? 'var(--font-mono), ui-monospace, monospace' : 'inherit',
      }}>
        {value.toLocaleString()}
      </div>
    </div>
  );
}

function InfoTip({ text }: { text: string }) {
  const [show, setShow] = useState(false);
  return (
    <span style={{ position: 'relative', display: 'inline-block', marginLeft: 6 }}>
      <span
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
        style={{
          width: 16, height: 16, borderRadius: '50%', display: 'inline-flex',
          alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 800,
          background: 'rgba(14,165,233,0.15)', color: '#0ea5e9', cursor: 'help',
        }}
      >i</span>
      {show && (
        <div style={{
          position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)',
          background: 'var(--bg-deep)', border: '1px solid var(--border)', borderRadius: 8,
          padding: '8px 12px', fontSize: 12, color: 'var(--text-muted)', width: 240,
          zIndex: 100, marginBottom: 6, lineHeight: 1.5,
          boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
        }}>{text}</div>
      )}
    </span>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function RuleSetDetailPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const { id } = params;

  const [ruleSet, setRuleSet] = useState<RuleSet | null>(null);
  const [shiftTypes, setShiftTypes] = useState<ShiftType[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState('');
  const [plainText, setPlainText] = useState('');
  const [savingText, setSavingText] = useState(false);
  const [collapsedCats, setCollapsedCats] = useState<Record<string, boolean>>({});
  const [showAddRule, setShowAddRule] = useState(false);
  const [editingRule, setEditingRule] = useState<RuleDefinition | null>(null);
  const [activity, setActivity] = useState<RuleSetActivity | null>(null);

  const loadData = useCallback(async () => {
    const res = await fetch(`/api/scheduling/rule-sets/${id}`);
    if (!res.ok) { setLoading(false); return; }
    const data: RuleSet = await res.json();
    setRuleSet(data);
    setNameValue(data.name);
    setPlainText(data.original_plain_text || '');

    // Load shift types for the site
    const stRes = await fetch(`/api/scheduling/shift-types?site_id=${data.site_id}`);
    const stData = await stRes.json();
    setShiftTypes(Array.isArray(stData) ? stData : []);
    setLoading(false);

    // Activity load is fire-and-forget — failures shouldn't block rendering.
    fetch(`/api/scheduling/rule-sets/${id}/activity`)
      .then((r) => r.ok ? r.json() : null)
      .then((act: RuleSetActivity | null) => { if (act) setActivity(act); })
      .catch(() => { /* swallow — activity is informational */ });
  }, [id]);

  useEffect(() => { loadData(); }, [loadData]);

  const saveName = async () => {
    if (!nameValue.trim() || !ruleSet) return;
    await fetch(`/api/scheduling/rule-sets/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: nameValue.trim() }),
    });
    setEditingName(false);
    loadData();
  };

  const savePlainText = async () => {
    if (!ruleSet) return;
    setSavingText(true);
    await fetch(`/api/scheduling/rule-sets/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ original_plain_text: plainText }),
    });
    setSavingText(false);
    loadData();
  };

  const updateStatus = async (newStatus: string) => {
    await fetch(`/api/scheduling/rule-sets/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    });
    loadData();
  };

  const archiveSet = async () => {
    await fetch(`/api/scheduling/rule-sets/${id}`, { method: 'DELETE' });
    router.push('/rules');
  };

  const toggleRuleActive = async (rule: RuleDefinition) => {
    await fetch(`/api/scheduling/rule-definitions/${rule.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: !rule.is_active }),
    });
    loadData();
  };

  const deleteRule = async (ruleId: string) => {
    await fetch(`/api/scheduling/rule-definitions/${ruleId}`, { method: 'DELETE' });
    loadData();
  };

  const toggleCat = (cat: string) => {
    setCollapsedCats(prev => ({ ...prev, [cat]: !prev[cat] }));
  };

  if (loading) return <div style={{ padding: 40, color: 'var(--text-muted)' }}>Loading...</div>;
  if (!ruleSet) return <div style={{ padding: 40, color: 'var(--text-muted)' }}>Rule set not found.</div>;

  const rules = ruleSet.rule_definitions || [];
  const groupedRules: Record<string, RuleDefinition[]> = {};
  rules.forEach(r => {
    if (!groupedRules[r.rule_category]) groupedRules[r.rule_category] = [];
    groupedRules[r.rule_category].push(r);
  });

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1100 }}>
      {/* Back link */}
      <div style={{ marginBottom: 16 }}>
        <Button variant="ghost" size="sm" onClick={() => router.push('/rules')}>
          <span style={{ fontSize: 16 }}>&larr;</span> Back to Rules
        </Button>
      </div>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 28, flexWrap: 'wrap', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 300 }}>
          {editingName ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
              <input
                autoFocus
                value={nameValue}
                onChange={e => setNameValue(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') { setEditingName(false); setNameValue(ruleSet.name); } }}
                style={{ ...inputStyle, fontSize: 20, fontWeight: 800, marginBottom: 0, flex: 1 }}
              />
              <Button size="sm" onClick={saveName}>Save</Button>
            </div>
          ) : (
            <h1
              onClick={() => setEditingName(true)}
              style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)', cursor: 'pointer', marginBottom: 6 }}
              title="Click to rename"
            >{ruleSet.name}</h1>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Badge tone="info">{ruleSet.sites?.name || 'Unknown Site'}</Badge>
            <Badge tone={ruleSet.status === 'active' ? 'ok' : 'neutral'}>{ruleSet.status}</Badge>
            <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{rules.length} rule{rules.length !== 1 ? 's' : ''}</span>
          </div>
        </div>

        {/* Status actions */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {ruleSet.status === 'draft' && (
            <Button onClick={() => updateStatus('active')}>Activate</Button>
          )}
          {ruleSet.status === 'active' && (
            <Button variant="secondary" onClick={() => updateStatus('draft')}>Deactivate</Button>
          )}
          {ruleSet.status !== 'archived' && (
            <Button variant="ghost" onClick={archiveSet}>Archive</Button>
          )}
        </div>
      </div>

      {/* Plain text rules input */}
      <Card
        title={
          <span style={{ display: 'inline-flex', alignItems: 'center' }}>
            Plain-Language Rules
            <InfoTip text="Paste your scheduling rules in plain language here. In the future, AI will parse these into structured rules automatically." />
          </span>
        }
        actions={
          <Button size="sm" onClick={savePlainText} disabled={savingText}>
            {savingText ? 'Saving...' : 'Save Text'}
          </Button>
        }
        style={{ marginBottom: 28 }}
      >
        <textarea
          value={plainText}
          onChange={e => setPlainText(e.target.value)}
          placeholder="Paste scheduling rules here in plain language...&#10;&#10;Example:&#10;- C1 always has post-call day off&#10;- Only call takers can take call shifts&#10;- Max 6 calls per month per provider"
          style={{
            ...inputStyle, minHeight: 120, resize: 'vertical', marginBottom: 0,
            fontFamily: 'inherit', lineHeight: 1.6,
          }}
        />
      </Card>

      {/* Activity summary across all schedules at this site */}
      <ActivitySummary activity={activity} ruleSetStatus={ruleSet.status} />


      {/* Add Rule button */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <span style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)' }}>Rule Definitions</span>
        <Button onClick={() => { setEditingRule(null); setShowAddRule(true); }}>+ Add Rule</Button>
      </div>

      {/* Rules grouped by category */}
      {rules.length === 0 && (
        <Card>
          <EmptyState
            icon="§"
            title="No rules defined yet"
            hint='Click "Add Rule" to create your first scheduling rule.'
            action={<Button size="sm" onClick={() => { setEditingRule(null); setShowAddRule(true); }}>+ Add Rule</Button>}
          />
        </Card>
      )}

      {CATEGORIES.filter(c => groupedRules[c.value]).map(cat => {
        const catRules = groupedRules[cat.value];
        const collapsed = collapsedCats[cat.value] || false;
        return (
          <div key={cat.value} style={{ marginBottom: 16 }}>
            {/* Category header */}
            <button
              onClick={() => toggleCat(cat.value)}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 16px', borderRadius: collapsed ? 10 : '10px 10px 0 0',
                background: 'var(--bg-surface)', border: '1px solid var(--border)',
                borderBottom: collapsed ? '1px solid var(--border)' : 'none',
                cursor: 'pointer', textAlign: 'left',
              }}
            >
              <span style={{ fontSize: 14, color: 'var(--text-dim)', transition: 'transform 0.15s', transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>&#9660;</span>
              <span style={{
                fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 6,
                background: cat.color + '20', color: cat.color,
              }}>{cat.label}</span>
              <span style={{ fontSize: 12, color: 'var(--text-dim)', fontWeight: 600 }}>{catRules.length} rule{catRules.length !== 1 ? 's' : ''}</span>
            </button>

            {/* Rules */}
            {!collapsed && (
              <div style={{
                border: '1px solid var(--border)', borderTop: 'none',
                borderRadius: '0 0 10px 10px', overflow: 'hidden',
              }}>
                {catRules.map((rule, idx) => (
                  <div key={rule.id} style={{
                    padding: '14px 18px', background: 'var(--bg-surface)',
                    borderTop: idx === 0 ? 'none' : '1px solid var(--border)',
                    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12,
                  }}>
                    {/* Left: rule info */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 14, fontWeight: 700, color: rule.is_active ? 'var(--text)' : 'var(--text-dim)' }}>{rule.rule_name}</span>
                        <Badge tone={rule.hard_constraint ? 'danger' : 'warn'}>{rule.hard_constraint ? 'Hard' : 'Soft'}</Badge>
                        <span style={{ fontSize: 10, color: 'var(--text-dim)', fontWeight: 600 }}>Priority: {rule.priority_rank}</span>
                        <Badge tone="info">{rule.applies_to_provider_group}</Badge>
                        <RuleActivityBadge activity={activity} ruleId={rule.id} isActive={rule.is_active} />
                      </div>
                      {rule.explanation_text && (
                        <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: 6 }}>{rule.explanation_text}</div>
                      )}
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {rule.applies_to_shift_types && rule.applies_to_shift_types.length > 0 && rule.applies_to_shift_types.map((st: string) => (
                          <span key={st} style={{
                            fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 4,
                            background: 'rgba(14,165,233,0.1)', color: '#38bdf8',
                          }}>{st}</span>
                        ))}
                        {rule.applies_to_day_types && rule.applies_to_day_types.length > 0 && rule.applies_to_day_types.map((dt: string) => (
                          <span key={dt} style={{
                            fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 4,
                            background: 'rgba(251,191,36,0.1)', color: '#fbbf24',
                          }}>{dt}</span>
                        ))}
                      </div>
                    </div>

                    {/* Right: actions */}
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                      {/* Active toggle */}
                      <button
                        onClick={() => toggleRuleActive(rule)}
                        title={rule.is_active ? 'Disable rule' : 'Enable rule'}
                        style={{
                          width: 36, height: 20, borderRadius: 10, cursor: 'pointer', border: 'none',
                          background: rule.is_active ? '#10b981' : 'var(--border)',
                          position: 'relative', transition: 'background 0.15s',
                        }}
                      >
                        <span style={{
                          position: 'absolute', top: 2, width: 16, height: 16, borderRadius: '50%',
                          background: '#fff', transition: 'left 0.15s',
                          left: rule.is_active ? 18 : 2,
                        }} />
                      </button>
                      <Button variant="secondary" size="sm" onClick={() => { setEditingRule(rule); setShowAddRule(true); }}>Edit</Button>
                      <Button variant="danger" size="sm" onClick={() => deleteRule(rule.id)}>Del</Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* Rule Builder Modal */}
      {showAddRule && (
        <RuleBuilderModal
          ruleSetId={id}
          shiftTypes={shiftTypes}
          existing={editingRule}
          onClose={() => { setShowAddRule(false); setEditingRule(null); }}
          onSaved={() => { setShowAddRule(false); setEditingRule(null); loadData(); }}
        />
      )}
    </div>
  );
}

// ── Rule Builder Modal ────────────────────────────────────────────────────────

function RuleBuilderModal({ ruleSetId, shiftTypes, existing, onClose, onSaved }: {
  ruleSetId: string;
  shiftTypes: ShiftType[];
  existing: RuleDefinition | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!existing;

  const [ruleName, setRuleName] = useState(existing?.rule_name || '');
  const [category, setCategory] = useState<RuleCategory>(existing?.rule_category || 'coverage');
  const [hardConstraint, setHardConstraint] = useState(existing?.hard_constraint ?? true);
  const [priorityRank, setPriorityRank] = useState(existing?.priority_rank ?? 10);
  const [providerGroup, setProviderGroup] = useState<'physician' | 'crna' | 'both'>(existing?.applies_to_provider_group || 'both');
  const [explanationText, setExplanationText] = useState(existing?.explanation_text || '');
  const [selectedShiftTypes, setSelectedShiftTypes] = useState<string[]>(existing?.applies_to_shift_types || []);
  const [selectedDayTypes, setSelectedDayTypes] = useState<string[]>(existing?.applies_to_day_types || []);
  const [saving, setSaving] = useState(false);

  // Category-specific state
  // Sequence
  const [seqTriggerShift, setSeqTriggerShift] = useState((existing?.condition as Record<string, string>)?.trigger_shift_code || '');
  const [seqLinkedShift, setSeqLinkedShift] = useState((existing?.action as Record<string, string>)?.linked_shift_code || '');
  const [seqRelationship, setSeqRelationship] = useState((existing?.condition as Record<string, string>)?.relationship || 'post_call');

  // Rest
  const [restAfterShift, setRestAfterShift] = useState((existing?.condition as Record<string, string>)?.after_shift_code || '');
  const [restType, setRestType] = useState((existing?.condition as Record<string, string>)?.rest_type || 'day_off');
  const [restMinHours, setRestMinHours] = useState((existing?.action as Record<string, number>)?.min_hours || 12);

  // Pairing
  const [pairPrimary, setPairPrimary] = useState((existing?.condition as Record<string, string>)?.primary_shift_code || '');
  const [pairBackup, setPairBackup] = useState((existing?.action as Record<string, string>)?.required_backup_code || '');
  const [pairSameDay, setPairSameDay] = useState((existing?.action as Record<string, boolean>)?.same_day ?? true);

  // Eligibility
  const [eligShift, setEligShift] = useState((existing?.condition as Record<string, string>)?.shift_code || '');
  const [eligRequirement, setEligRequirement] = useState((existing?.condition as Record<string, string>)?.requirement_type || 'call_taker_only');
  const [eligValue, setEligValue] = useState((existing?.action as Record<string, string>)?.required_value || '');

  // Frequency
  const [freqCategory, setFreqCategory] = useState((existing?.condition as Record<string, string>)?.shift_category || 'weekday_call');
  const [freqPeriod, setFreqPeriod] = useState((existing?.condition as Record<string, string>)?.period || 'month');
  const [freqMax, setFreqMax] = useState((existing?.action as Record<string, number>)?.max_count || 6);
  const [freqMin, setFreqMin] = useState((existing?.action as Record<string, number>)?.min_count || 0);

  // Fairness
  const [fairBurden, setFairBurden] = useState((existing?.condition as Record<string, string>)?.burden_category || 'weekday_call');
  const [fairMethod, setFairMethod] = useState((existing?.action as Record<string, string>)?.distribution_method || 'equal');

  const buildConditionAction = (): { condition: Record<string, unknown>; action: Record<string, unknown> } => {
    switch (category) {
      case 'sequence':
        return {
          condition: { trigger_shift_code: seqTriggerShift, relationship: seqRelationship },
          action: { linked_shift_code: seqLinkedShift },
        };
      case 'rest':
        return {
          condition: { after_shift_code: restAfterShift, rest_type: restType },
          action: restType === 'min_hours' ? { min_hours: restMinHours } : {},
        };
      case 'pairing':
        return {
          condition: { primary_shift_code: pairPrimary },
          action: { required_backup_code: pairBackup, same_day: pairSameDay },
        };
      case 'eligibility':
        return {
          condition: { shift_code: eligShift, requirement_type: eligRequirement },
          action: { required_value: eligValue },
        };
      case 'frequency':
        return {
          condition: { shift_category: freqCategory, period: freqPeriod },
          action: { max_count: freqMax, ...(freqMin ? { min_count: freqMin } : {}) },
        };
      case 'fairness':
        return {
          condition: { burden_category: fairBurden },
          action: { distribution_method: fairMethod },
        };
      default:
        return { condition: {}, action: {} };
    }
  };

  const submit = async () => {
    if (!ruleName.trim()) return;
    setSaving(true);
    const { condition, action } = buildConditionAction();

    const payload = {
      rule_set_id: ruleSetId,
      rule_name: ruleName.trim(),
      rule_category: category,
      hard_constraint: hardConstraint,
      priority_rank: priorityRank,
      applies_to_provider_group: providerGroup,
      applies_to_shift_types: selectedShiftTypes.length > 0 ? selectedShiftTypes : null,
      applies_to_day_types: selectedDayTypes.length > 0 ? selectedDayTypes : null,
      condition,
      action,
      explanation_text: explanationText.trim() || null,
      is_active: existing?.is_active ?? true,
    };

    if (isEdit && existing) {
      await fetch(`/api/scheduling/rule-definitions/${existing.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } else {
      await fetch('/api/scheduling/rule-definitions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }
    onSaved();
  };

  const toggleShiftType = (code: string) => {
    setSelectedShiftTypes(prev => prev.includes(code) ? prev.filter(s => s !== code) : [...prev, code]);
  };

  const toggleDayType = (dt: string) => {
    setSelectedDayTypes(prev => prev.includes(dt) ? prev.filter(d => d !== dt) : [...prev, dt]);
  };

  const selectStyle: React.CSSProperties = {
    ...inputStyle, cursor: 'pointer',
  };

  const shiftOptions = shiftTypes.map(st => ({ value: st.code, label: `${st.code} - ${st.name}` }));

  return (
    <Modal
      open
      onClose={onClose}
      title={isEdit ? 'Edit Rule' : 'Add Rule'}
      width={620}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={saving || !ruleName.trim()}>
            {saving ? 'Saving...' : (isEdit ? 'Update Rule' : 'Add Rule')}
          </Button>
        </>
      }
    >
        {/* Rule Name */}
        <label style={labelStyle}>Rule Name *</label>
        <input style={inputStyle} placeholder="e.g. C1 Post-Call Day Off" value={ruleName} onChange={e => setRuleName(e.target.value)} />

        {/* Category buttons */}
        <label style={labelStyle}>Rule Category *</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
          {CATEGORIES.map(c => (
            <button key={c.value} onClick={() => setCategory(c.value)} style={{
              padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 700,
              border: `1px solid ${category === c.value ? c.color : 'var(--border)'}`,
              background: category === c.value ? c.color + '20' : 'transparent',
              color: category === c.value ? c.color : 'var(--text-muted)',
            }}>{c.label}</button>
          ))}
        </div>

        {/* Hard Constraint toggle */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
          <label style={{ ...labelStyle, marginBottom: 0 }}>Hard Constraint</label>
          <InfoTip text="Hard constraints cannot be broken by the scheduler. Soft constraints generate warnings but can be overridden." />
          <button
            onClick={() => setHardConstraint(!hardConstraint)}
            style={{
              width: 40, height: 22, borderRadius: 11, cursor: 'pointer', border: 'none',
              background: hardConstraint ? '#ef4444' : '#f59e0b',
              position: 'relative', transition: 'background 0.15s',
            }}
          >
            <span style={{
              position: 'absolute', top: 3, width: 16, height: 16, borderRadius: '50%',
              background: '#fff', transition: 'left 0.15s',
              left: hardConstraint ? 21 : 3,
            }} />
          </button>
          <span style={{ fontSize: 12, fontWeight: 700, color: hardConstraint ? '#ef4444' : '#f59e0b' }}>
            {hardConstraint ? 'Hard (cannot break)' : 'Soft (warning only)'}
          </span>
        </div>

        {/* Priority Rank */}
        <label style={labelStyle}>Priority Rank <InfoTip text="Lower number = higher priority. Rules with lower rank are evaluated first." /></label>
        <input type="number" style={{ ...inputStyle, width: 120 }} value={priorityRank} onChange={e => setPriorityRank(parseInt(e.target.value) || 0)} min={1} />

        {/* Provider Group */}
        <label style={labelStyle}>Provider Group</label>
        <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
          {(['physician', 'crna', 'both'] as const).map(pg => (
            <button key={pg} onClick={() => setProviderGroup(pg)} style={{
              padding: '6px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 700,
              border: `1px solid ${providerGroup === pg ? '#6366f1' : 'var(--border)'}`,
              background: providerGroup === pg ? 'rgba(99,102,241,0.12)' : 'transparent',
              color: providerGroup === pg ? '#818cf8' : 'var(--text-muted)',
              textTransform: 'capitalize',
            }}>{pg}</button>
          ))}
        </div>

        {/* Explanation Text */}
        <label style={labelStyle}>Explanation Text</label>
        <textarea
          value={explanationText}
          onChange={e => setExplanationText(e.target.value)}
          placeholder="Human-readable description of what this rule does..."
          style={{ ...inputStyle, minHeight: 60, resize: 'vertical', fontFamily: 'inherit' }}
        />

        {/* ── Category-specific fields ─────────────────────── */}
        <div style={{
          background: 'var(--bg-deep)', border: '1px solid var(--border)', borderRadius: 10,
          padding: 16, marginBottom: 14,
        }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: CAT_COLOR_MAP[category] || 'var(--text)', marginBottom: 12, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            {category} Configuration
          </div>

          {/* Sequence */}
          {category === 'sequence' && (
            <>
              <label style={labelStyle}>Trigger Shift</label>
              <select value={seqTriggerShift} onChange={e => setSeqTriggerShift(e.target.value)} style={selectStyle}>
                <option value="">Select shift...</option>
                {shiftOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>

              <label style={labelStyle}>Relationship</label>
              <select value={seqRelationship} onChange={e => setSeqRelationship(e.target.value)} style={selectStyle}>
                <option value="post_call">Post-Call (provider who did trigger yesterday gets linked today)</option>
                <option value="pre_call">Pre-Call (provider who will do trigger tomorrow gets linked today)</option>
                <option value="same_day_pair">Same-Day Pair (same provider does both on same day)</option>
                <option value="weekend_continuation">Weekend Continuation (friday trigger continues to sat/sun)</option>
              </select>

              <label style={labelStyle}>Linked Shift</label>
              <select value={seqLinkedShift} onChange={e => setSeqLinkedShift(e.target.value)} style={selectStyle}>
                <option value="">Select shift...</option>
                {shiftOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </>
          )}

          {/* Rest */}
          {category === 'rest' && (
            <>
              <label style={labelStyle}>After Shift</label>
              <select value={restAfterShift} onChange={e => setRestAfterShift(e.target.value)} style={selectStyle}>
                <option value="">Select shift...</option>
                {shiftOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>

              <label style={labelStyle}>Rest Type</label>
              <select value={restType} onChange={e => setRestType(e.target.value)} style={selectStyle}>
                <option value="day_off">Day Off (next day off)</option>
                <option value="min_hours">Minimum Hours (min rest before next shift)</option>
                <option value="early_out">Early Out (leave early next day)</option>
              </select>

              {restType === 'min_hours' && (
                <>
                  <label style={labelStyle}>Minimum Hours</label>
                  <input type="number" value={restMinHours} onChange={e => setRestMinHours(parseInt(e.target.value) || 0)} style={{ ...inputStyle, width: 120 }} min={1} />
                </>
              )}
            </>
          )}

          {/* Pairing */}
          {category === 'pairing' && (
            <>
              <label style={labelStyle}>Primary Shift</label>
              <select value={pairPrimary} onChange={e => setPairPrimary(e.target.value)} style={selectStyle}>
                <option value="">Select shift...</option>
                {shiftOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>

              <label style={labelStyle}>Required Backup Shift</label>
              <select value={pairBackup} onChange={e => setPairBackup(e.target.value)} style={selectStyle}>
                <option value="">Select shift...</option>
                {shiftOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>

              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                <label style={{ ...labelStyle, marginBottom: 0 }}>Same Day Required</label>
                <button
                  onClick={() => setPairSameDay(!pairSameDay)}
                  style={{
                    width: 36, height: 20, borderRadius: 10, cursor: 'pointer', border: 'none',
                    background: pairSameDay ? '#10b981' : 'var(--border)',
                    position: 'relative', transition: 'background 0.15s',
                  }}
                >
                  <span style={{
                    position: 'absolute', top: 2, width: 16, height: 16, borderRadius: '50%',
                    background: '#fff', transition: 'left 0.15s',
                    left: pairSameDay ? 18 : 2,
                  }} />
                </button>
              </div>
            </>
          )}

          {/* Eligibility */}
          {category === 'eligibility' && (
            <>
              <label style={labelStyle}>Shift</label>
              <select value={eligShift} onChange={e => setEligShift(e.target.value)} style={selectStyle}>
                <option value="">Select shift...</option>
                {shiftOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>

              <label style={labelStyle}>Requirement</label>
              <select value={eligRequirement} onChange={e => setEligRequirement(e.target.value)} style={selectStyle}>
                <option value="call_taker_only">Call Taker Only</option>
                <option value="fellowship_required">Fellowship Required</option>
                <option value="skill_required">Skill Required</option>
                <option value="exclude_provider_type">Exclude Provider Type</option>
              </select>

              <label style={labelStyle}>Required Value <InfoTip text="For fellowship or skill requirements, enter the specific name. For exclusions, enter the provider type." /></label>
              <input style={inputStyle} placeholder="e.g. Cardiac, Pediatric, Part-Time" value={eligValue} onChange={e => setEligValue(e.target.value)} />
            </>
          )}

          {/* Frequency */}
          {category === 'frequency' && (
            <>
              <label style={labelStyle}>Shift Category</label>
              <select value={freqCategory} onChange={e => setFreqCategory(e.target.value)} style={selectStyle}>
                <option value="weekday_call">Weekday Call</option>
                <option value="weekend_call">Weekend Call</option>
                <option value="holiday_call">Holiday Call</option>
                <option value="friday_call">Friday Call</option>
                <option value="backup_call">Backup Call</option>
              </select>

              <label style={labelStyle}>Period</label>
              <select value={freqPeriod} onChange={e => setFreqPeriod(e.target.value)} style={selectStyle}>
                <option value="week">Week</option>
                <option value="month">Month</option>
                <option value="quarter">Quarter</option>
                <option value="year">Year</option>
              </select>

              <div style={{ display: 'flex', gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <label style={labelStyle}>Max Count</label>
                  <input type="number" value={freqMax} onChange={e => setFreqMax(parseInt(e.target.value) || 0)} style={inputStyle} min={0} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={labelStyle}>Min Count (optional)</label>
                  <input type="number" value={freqMin} onChange={e => setFreqMin(parseInt(e.target.value) || 0)} style={inputStyle} min={0} />
                </div>
              </div>
            </>
          )}

          {/* Fairness */}
          {category === 'fairness' && (
            <>
              <label style={labelStyle}>Burden Category</label>
              <select value={fairBurden} onChange={e => setFairBurden(e.target.value)} style={selectStyle}>
                <option value="weekday_call">Weekday Call</option>
                <option value="weekend_call">Weekend Call</option>
                <option value="holiday_call">Holiday Call</option>
                <option value="friday_call">Friday Call</option>
                <option value="backup_call">Backup Call</option>
              </select>

              <label style={labelStyle}>Distribution Method</label>
              <select value={fairMethod} onChange={e => setFairMethod(e.target.value)} style={selectStyle}>
                <option value="equal">Equal Distribution</option>
                <option value="weighted_by_fte">Weighted by FTE</option>
                <option value="manual_targets">Manual Targets</option>
              </select>
            </>
          )}

          {/* Generic categories: coverage, open_slot, time_off, cross_site */}
          {['coverage', 'open_slot', 'time_off', 'cross_site'].includes(category) && (
            <div style={{ fontSize: 12, color: 'var(--text-dim)', fontStyle: 'italic' }}>
              Use the Explanation Text field above to describe this rule. Configure applicable shift types and day types below.
            </div>
          )}
        </div>

        {/* ── Applies To section ───────────────────────────── */}
        <div style={{
          background: 'var(--bg-deep)', border: '1px solid var(--border)', borderRadius: 10,
          padding: 16, marginBottom: 14,
        }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', marginBottom: 12, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Applies To
          </div>

          {/* Shift types */}
          <label style={labelStyle}>Shift Types</label>
          {shiftTypes.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 12, fontStyle: 'italic' }}>No shift types configured for this site.</div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
              {shiftTypes.map(st => {
                const selected = selectedShiftTypes.includes(st.code);
                return (
                  <button key={st.id} onClick={() => toggleShiftType(st.code)} style={{
                    padding: '5px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 700,
                    border: `1px solid ${selected ? '#0ea5e9' : 'var(--border)'}`,
                    background: selected ? 'rgba(14,165,233,0.15)' : 'transparent',
                    color: selected ? '#38bdf8' : 'var(--text-muted)',
                  }}>{st.code}</button>
                );
              })}
            </div>
          )}

          {/* Day types */}
          <label style={labelStyle}>Day Types</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {DAY_TYPES.map(dt => {
              const selected = selectedDayTypes.includes(dt);
              return (
                <button key={dt} onClick={() => toggleDayType(dt)} style={{
                  padding: '5px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 700,
                  border: `1px solid ${selected ? '#fbbf24' : 'var(--border)'}`,
                  background: selected ? 'rgba(251,191,36,0.12)' : 'transparent',
                  color: selected ? '#fbbf24' : 'var(--text-muted)',
                  textTransform: 'capitalize',
                }}>{dt.replace('_', ' ')}</button>
              );
            })}
          </div>
        </div>
    </Modal>
  );
}
