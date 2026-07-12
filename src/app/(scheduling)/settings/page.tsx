'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { CUSTOM_FIELD_TYPES } from '@/lib/validation/customFields';
import { PROVIDER_TYPES } from '@/lib/validation/providers';
import { PageHeader, Card, Badge, Button, Table, EmptyState, Banner, Modal } from '@/components/ui';

interface CustomFieldDefinition {
  id: string;
  organization_id: string;
  field_name: string;
  display_label: string;
  field_type: typeof CUSTOM_FIELD_TYPES[number];
  options: string[];
  required: boolean;
  applies_to_provider_types: string[];
  applies_to_sites: string[];
  is_active: boolean;
  admin_only: boolean;
  display_order: number;
}

interface Site { id: string; name: string; short_name: string | null; }

const TABLE_HEADERS = ['Label', 'Field Name', 'Type', 'Required', 'Scope', 'Status', ''];

export default function SettingsPage() {
  const [orgId, setOrgId] = useState<string>('');
  const [sites, setSites] = useState<Site[]>([]);
  const [defs, setDefs] = useState<CustomFieldDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [includeInactive, setIncludeInactive] = useState(false);

  useEffect(() => {
    (async () => {
      const orgRes = await fetch('/api/scheduling/organizations');
      const orgs = await orgRes.json();
      if (orgs.length > 0) setOrgId(orgs[0].id);
      setLoading(false);
    })();
  }, []);

  const loadDefs = useCallback(async () => {
    if (!orgId) return;
    const params = new URLSearchParams({ org_id: orgId });
    if (includeInactive) params.set('include_inactive', 'true');
    const res = await fetch(`/api/scheduling/custom-fields?${params}`);
    if (res.ok) setDefs(await res.json());
  }, [orgId, includeInactive]);

  const loadSites = useCallback(async () => {
    if (!orgId) return;
    const res = await fetch(`/api/scheduling/sites?org_id=${orgId}`);
    if (res.ok) setSites(await res.json());
  }, [orgId]);

  useEffect(() => { loadDefs(); }, [loadDefs]);
  useEffect(() => { loadSites(); }, [loadSites]);

  if (loading) {
    return (
      <div style={{ maxWidth: 960 }}>
        <PageHeader title="Settings" />
        <Card pad={false}>
          <Table headers={TABLE_HEADERS} rows={undefined} minWidth={640} />
        </Card>
      </div>
    );
  }
  if (!orgId) {
    return (
      <div style={{ maxWidth: 960 }}>
        <PageHeader title="Settings" />
        <Banner tone="warn">Create an organization first.</Banner>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 960 }}>
      <PageHeader title="Settings" subtitle="Organization-level configuration." />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 12, gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)' }}>Provider Custom Fields</h2>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
            Extra fields that appear on every provider profile. Great for org-specific data like DEA number, preferred pager, or team assignment.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)' }}>
            <input type="checkbox" checked={includeInactive} onChange={e => setIncludeInactive(e.target.checked)} style={{ accentColor: '#0ea5e9' }} />
            Show inactive
          </label>
          <Button onClick={() => setShowAdd(true)}>+ Add Field</Button>
        </div>
      </div>

      <Card pad={false}>
        <Table
          headers={TABLE_HEADERS}
          minWidth={640}
          rows={defs.map(d => {
            const scope: string[] = [];
            if (d.applies_to_provider_types.length) scope.push(`${d.applies_to_provider_types.length} types`);
            if (d.applies_to_sites.length) scope.push(`${d.applies_to_sites.length} sites`);
            // Inactive rows keep the original whole-row dimming, applied per cell
            // (the shared Table has no row-level style hook).
            const dim = (node: ReactNode) => (
              <span style={{ opacity: d.is_active ? 1 : 0.55, display: 'inline-block' }}>{node}</span>
            );
            return [
              dim(<span style={{ color: 'var(--text)', fontWeight: 600 }}>{d.display_label}</span>),
              dim(<span style={{ color: 'var(--text-muted)', fontFamily: 'monospace', fontSize: 12 }}>{d.field_name}</span>),
              dim(<Badge tone="info">{d.field_type}</Badge>),
              dim(d.required ? <Badge tone="warn">Required</Badge> : <Badge tone="neutral">Optional</Badge>),
              dim(scope.length ? <span style={{ fontSize: 12 }}>{scope.join(' · ')}</span> : <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>All providers</span>),
              dim(
                <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                  <Badge tone={d.is_active ? 'ok' : 'neutral'}>{d.is_active ? 'Active' : 'Inactive'}</Badge>
                  {d.admin_only && <Badge tone="warn">Admin</Badge>}
                </span>
              ),
              dim(<RowActions def={d} sites={sites} onChanged={loadDefs} />),
            ];
          })}
          empty={
            <EmptyState
              icon="⚙"
              title="No custom fields defined yet"
              hint="Add a field to capture org-specific provider data — DEA number, preferred pager, team assignment — right on each profile."
              action={<Button size="sm" onClick={() => setShowAdd(true)}>+ Add Field</Button>}
            />
          }
        />
      </Card>

      {showAdd && (
        <DefinitionModal
          mode="create"
          orgId={orgId}
          sites={sites}
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); loadDefs(); }}
        />
      )}
    </div>
  );
}

function RowActions({ def, sites, onChanged }: { def: CustomFieldDefinition; sites: Site[]; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);

  const handleDelete = async () => {
    if (!confirm(`Permanently delete custom field "${def.display_label}"? All provider values for this field will also be removed.`)) return;
    const res = await fetch(`/api/scheduling/custom-fields/${def.id}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(`Failed to delete: ${err.error || res.statusText}`);
      return;
    }
    onChanged();
  };

  const handleToggleActive = async () => {
    const res = await fetch(`/api/scheduling/custom-fields/${def.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: !def.is_active }),
    });
    if (res.ok) onChanged();
  };

  return (
    <>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', whiteSpace: 'nowrap' }}>
        <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>Edit</Button>
        <Button variant="secondary" size="sm" onClick={handleToggleActive}>
          {def.is_active ? 'Deactivate' : 'Activate'}
        </Button>
        <Button variant="danger" size="sm" onClick={handleDelete}>Delete</Button>
      </div>
      {editing && (
        <DefinitionModal
          mode="edit"
          def={def}
          orgId={def.organization_id}
          sites={sites}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); onChanged(); }}
        />
      )}
    </>
  );
}

function DefinitionModal({ mode, def, orgId, sites, onClose, onSaved }: {
  mode: 'create' | 'edit';
  def?: CustomFieldDefinition;
  orgId: string;
  sites: Site[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [fieldName, setFieldName] = useState(def?.field_name ?? '');
  const [displayLabel, setDisplayLabel] = useState(def?.display_label ?? '');
  const [fieldType, setFieldType] = useState<typeof CUSTOM_FIELD_TYPES[number]>(def?.field_type ?? 'text');
  const [optionsText, setOptionsText] = useState((def?.options ?? []).join('\n'));
  const [required, setRequired] = useState(def?.required ?? false);
  const [adminOnly, setAdminOnly] = useState(def?.admin_only ?? false);
  const [providerTypes, setProviderTypes] = useState<string[]>(def?.applies_to_provider_types ?? []);
  const [siteIds, setSiteIds] = useState<string[]>(def?.applies_to_sites ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameValid = /^[a-z][a-z0-9_]{0,63}$/.test(fieldName);
  const needsOptions = fieldType === 'select' || fieldType === 'multiselect';
  const opts = optionsText.split('\n').map(s => s.trim()).filter(Boolean);
  const errors: Record<string, string> = {};
  if (!displayLabel.trim()) errors.displayLabel = 'Required';
  if (!fieldName.trim()) errors.fieldName = 'Required';
  else if (!nameValid) errors.fieldName = 'Use lowercase letters, digits, underscore — start with a letter';
  if (needsOptions && opts.length === 0) errors.options = 'At least one option required';

  const canSave = Object.keys(errors).length === 0 && !saving;

  const toggle = (arr: string[], v: string) => arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v];

  const save = async () => {
    if (!canSave) return;
    setSaving(true); setError(null);
    try {
      const body: Record<string, unknown> = {
        field_name: fieldName,
        display_label: displayLabel,
        field_type: fieldType,
        options: needsOptions ? opts : [],
        required,
        admin_only: adminOnly,
        applies_to_provider_types: providerTypes,
        applies_to_sites: siteIds,
      };
      if (mode === 'create') body.organization_id = orgId;
      const url = mode === 'create'
        ? '/api/scheduling/custom-fields'
        : `/api/scheduling/custom-fields/${def!.id}`;
      const res = await fetch(url, {
        method: mode === 'create' ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || `Failed (${res.status})`);
        return;
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={mode === 'create' ? 'New Custom Field' : `Edit "${def!.display_label}"`}
      width={540}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={!canSave}>
            {saving ? 'Saving...' : mode === 'create' ? 'Create Field' : 'Save Changes'}
          </Button>
        </>
      }
    >
      {error && (
        <div style={{ marginBottom: 14 }}>
          <Banner tone="error">{error}</Banner>
        </div>
      )}

      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>Display Label *</label>
        <input
          value={displayLabel}
          onChange={e => {
            setDisplayLabel(e.target.value);
            if (mode === 'create' && !fieldName) {
              // Auto-derive a slug from the label on first entry.
              const slug = e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
              if (slug) setFieldName(slug);
            }
          }}
          placeholder="e.g. DEA Number"
          style={{ ...inputStyle, border: `1px solid ${errors.displayLabel ? 'var(--danger)' : 'var(--border)'}` }}
        />
        {errors.displayLabel && <div style={errorTextStyle}>{errors.displayLabel}</div>}
      </div>

      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>Field Name (internal key) *</label>
        <input
          value={fieldName}
          onChange={e => setFieldName(e.target.value)}
          disabled={mode === 'edit'}
          placeholder="e.g. dea_number"
          style={{
            ...inputStyle,
            fontFamily: 'monospace',
            border: `1px solid ${errors.fieldName ? 'var(--danger)' : 'var(--border)'}`,
            opacity: mode === 'edit' ? 0.6 : 1,
          }}
        />
        {errors.fieldName ? (
          <div style={errorTextStyle}>{errors.fieldName}</div>
        ) : (
          <div style={hintStyle}>Stable identifier used by rules and integrations. Cannot be changed after creation.</div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <div>
          <label style={labelStyle}>Field Type</label>
          <select value={fieldType} onChange={e => setFieldType(e.target.value as typeof CUSTOM_FIELD_TYPES[number])} style={inputStyle}>
            {CUSTOM_FIELD_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 8, paddingBottom: 4 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-muted)' }}>
            <input type="checkbox" checked={required} onChange={e => setRequired(e.target.checked)} style={{ accentColor: '#0ea5e9' }} />
            Required on every profile
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--warn)' }}>
            <input type="checkbox" checked={adminOnly} onChange={e => setAdminOnly(e.target.checked)} style={{ accentColor: '#f59e0b' }} />
            Admin-only (hide from non-admin views)
          </label>
        </div>
      </div>

      {needsOptions && (
        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Options (one per line)</label>
          <textarea
            value={optionsText}
            onChange={e => setOptionsText(e.target.value)}
            placeholder={'Option 1\nOption 2\nOption 3'}
            style={{ ...inputStyle, minHeight: 90, resize: 'vertical', border: `1px solid ${errors.options ? 'var(--danger)' : 'var(--border)'}` }}
          />
          {errors.options && <div style={errorTextStyle}>{errors.options}</div>}
        </div>
      )}

      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>Scope — Provider Types</label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {PROVIDER_TYPES.map(t => (
            <Button
              key={t}
              variant="secondary"
              size="sm"
              onClick={() => setProviderTypes(prev => toggle(prev, t))}
              style={providerTypes.includes(t)
                ? { borderColor: 'var(--blue)', background: 'var(--info-bg)', color: 'var(--blue)' }
                : { color: 'var(--text-muted)' }}
            >
              {t}
            </Button>
          ))}
        </div>
        <div style={hintStyle}>Empty = applies to all provider types.</div>
      </div>

      {sites.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>Scope — Sites</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {sites.map(s => (
              <Button
                key={s.id}
                variant="secondary"
                size="sm"
                onClick={() => setSiteIds(prev => toggle(prev, s.id))}
                style={siteIds.includes(s.id)
                  ? { borderColor: 'var(--blue)', background: 'var(--info-bg)', color: 'var(--blue)' }
                  : { color: 'var(--text-muted)' }}
              >
                {s.short_name || s.name}
              </Button>
            ))}
          </div>
          <div style={hintStyle}>Empty = applies regardless of site.</div>
        </div>
      )}
    </Modal>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid var(--border)',
  background: 'var(--bg-deep)', color: 'var(--text)', fontSize: 13,
};
const labelStyle: React.CSSProperties = {
  fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 5, fontWeight: 600, letterSpacing: 0.5,
};
const errorTextStyle: React.CSSProperties = { fontSize: 10, color: 'var(--danger)', marginTop: 3 };
const hintStyle: React.CSSProperties = { fontSize: 10, color: 'var(--text-dim)', marginTop: 3 };
