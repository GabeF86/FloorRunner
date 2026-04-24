'use client';

import { useCallback, useEffect, useState } from 'react';
import { CUSTOM_FIELD_TYPES } from '@/lib/validation/customFields';
import { PROVIDER_TYPES } from '@/lib/validation/providers';

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

  if (loading) return <div style={{ padding: 40, color: 'var(--text-muted)' }}>Loading...</div>;
  if (!orgId) return <div style={{ padding: 40, color: 'var(--text-muted)' }}>Create an organization first.</div>;

  return (
    <div style={{ padding: '32px 40px', maxWidth: 960 }}>
      <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)', marginBottom: 4 }}>Settings</h1>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 28 }}>
        Organization-level configuration.
      </p>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 12 }}>
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)' }}>Provider Custom Fields</h2>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
            Extra fields that appear on every provider profile. Great for org-specific data like DEA number, preferred pager, or team assignment.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)' }}>
            <input type="checkbox" checked={includeInactive} onChange={e => setIncludeInactive(e.target.checked)} style={{ accentColor: '#0ea5e9' }} />
            Show inactive
          </label>
          <button onClick={() => setShowAdd(true)} style={primaryBtn}>+ Add Field</button>
        </div>
      </div>

      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)', background: 'rgba(14,165,233,0.04)' }}>
              {['Label', 'Field Name', 'Type', 'Required', 'Scope', 'Status', ''].map(h => (
                <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 10, fontWeight: 800, color: 'var(--text-dim)', letterSpacing: 1, textTransform: 'uppercase' }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {defs.length === 0 && (
              <tr>
                <td colSpan={7} style={{ padding: '30px 14px', textAlign: 'center', color: 'var(--text-dim)', fontStyle: 'italic' }}>
                  No custom fields defined yet.
                </td>
              </tr>
            )}
            {defs.map(d => (
              <DefinitionRow key={d.id} def={d} sites={sites} onChanged={loadDefs} />
            ))}
          </tbody>
        </table>
      </div>

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

function DefinitionRow({ def, sites, onChanged }: { def: CustomFieldDefinition; sites: Site[]; onChanged: () => void }) {
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

  const scope: string[] = [];
  if (def.applies_to_provider_types.length) scope.push(`${def.applies_to_provider_types.length} types`);
  if (def.applies_to_sites.length) scope.push(`${def.applies_to_sites.length} sites`);

  return (
    <>
      <tr style={{ borderBottom: '1px solid rgba(30,58,95,0.4)', opacity: def.is_active ? 1 : 0.55 }}>
        <td style={{ padding: '10px 14px', color: 'var(--text)', fontWeight: 600 }}>{def.display_label}</td>
        <td style={{ padding: '10px 14px', color: 'var(--text-muted)', fontFamily: 'monospace', fontSize: 12 }}>{def.field_name}</td>
        <td style={{ padding: '10px 14px', color: 'var(--text-muted)' }}>
          <span style={{
            fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 5,
            background: 'rgba(99,102,241,0.15)', color: '#818cf8',
          }}>
            {def.field_type}
          </span>
        </td>
        <td style={{ padding: '10px 14px', color: 'var(--text-muted)' }}>
          {def.required ? <span style={{ color: '#f59e0b', fontWeight: 700, fontSize: 12 }}>Required</span> : <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>Optional</span>}
        </td>
        <td style={{ padding: '10px 14px', color: 'var(--text-muted)', fontSize: 12 }}>
          {scope.length ? scope.join(' · ') : <span style={{ color: 'var(--text-dim)' }}>All providers</span>}
        </td>
        <td style={{ padding: '10px 14px' }}>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            <span style={{
              fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 6,
              background: def.is_active ? 'rgba(16,185,129,0.12)' : 'rgba(100,116,139,0.12)',
              color: def.is_active ? '#10b981' : '#94a3b8',
            }}>
              {def.is_active ? 'Active' : 'Inactive'}
            </span>
            {def.admin_only && (
              <span style={{
                fontSize: 10, fontWeight: 800, padding: '2px 7px', borderRadius: 6,
                background: 'rgba(245,158,11,0.15)', color: '#f59e0b',
                letterSpacing: 0.5,
              }}>
                ADMIN
              </span>
            )}
          </div>
        </td>
        <td style={{ padding: '10px 14px', textAlign: 'right' }}>
          <button onClick={() => setEditing(true)} style={smallBtn}>Edit</button>
          <button onClick={handleToggleActive} style={{ ...smallBtn, marginLeft: 6 }}>
            {def.is_active ? 'Deactivate' : 'Activate'}
          </button>
          <button onClick={handleDelete} style={{ ...smallBtn, marginLeft: 6, color: '#f87171', borderColor: 'rgba(248,113,113,0.3)' }}>
            Delete
          </button>
        </td>
      </tr>
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
    <div style={modalBackdrop} onClick={onClose}>
      <div style={modalBox} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 17, fontWeight: 800, color: '#f1f5f9', marginBottom: 20 }}>
          {mode === 'create' ? 'New Custom Field' : `Edit "${def!.display_label}"`}
        </div>

        {error && (
          <div style={{
            background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)',
            color: '#f87171', padding: '10px 14px', borderRadius: 8, marginBottom: 14, fontSize: 13,
          }}>{error}</div>
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
            style={{ ...inputStyle, border: `1px solid ${errors.displayLabel ? 'rgba(248,113,113,0.6)' : 'var(--border)'}` }}
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
              border: `1px solid ${errors.fieldName ? 'rgba(248,113,113,0.6)' : 'var(--border)'}`,
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
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#f59e0b' }}>
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
              style={{ ...inputStyle, minHeight: 90, resize: 'vertical', border: `1px solid ${errors.options ? 'rgba(248,113,113,0.6)' : 'var(--border)'}` }}
            />
            {errors.options && <div style={errorTextStyle}>{errors.options}</div>}
          </div>
        )}

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Scope — Provider Types</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {PROVIDER_TYPES.map(t => (
              <button
                key={t}
                type="button"
                onClick={() => setProviderTypes(prev => toggle(prev, t))}
                style={{
                  padding: '5px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  border: `1px solid ${providerTypes.includes(t) ? '#0ea5e9' : 'var(--border)'}`,
                  background: providerTypes.includes(t) ? 'rgba(14,165,233,0.15)' : 'transparent',
                  color: providerTypes.includes(t) ? '#0ea5e9' : 'var(--text-muted)',
                }}
              >
                {t}
              </button>
            ))}
          </div>
          <div style={hintStyle}>Empty = applies to all provider types.</div>
        </div>

        {sites.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <label style={labelStyle}>Scope — Sites</label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {sites.map(s => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSiteIds(prev => toggle(prev, s.id))}
                  style={{
                    padding: '5px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                    border: `1px solid ${siteIds.includes(s.id) ? '#0ea5e9' : 'var(--border)'}`,
                    background: siteIds.includes(s.id) ? 'rgba(14,165,233,0.15)' : 'transparent',
                    color: siteIds.includes(s.id) ? '#0ea5e9' : 'var(--text-muted)',
                  }}
                >
                  {s.short_name || s.name}
                </button>
              ))}
            </div>
            <div style={hintStyle}>Empty = applies regardless of site.</div>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} style={cancelBtn}>Cancel</button>
          <button onClick={save} disabled={!canSave} style={{ ...primaryBtn, opacity: canSave ? 1 : 0.5, cursor: canSave ? 'pointer' : 'not-allowed' }}>
            {saving ? 'Saving...' : mode === 'create' ? 'Create Field' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

const primaryBtn: React.CSSProperties = {
  padding: '9px 20px', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13,
  background: 'linear-gradient(135deg,#0ea5e9,#6366f1)', color: '#fff', border: 'none',
};
const cancelBtn: React.CSSProperties = {
  padding: '9px 18px', borderRadius: 8, cursor: 'pointer', background: 'transparent',
  color: 'var(--text-muted)', border: '1px solid var(--border)', fontWeight: 600, fontSize: 13,
};
const smallBtn: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', background: 'none',
  border: '1px solid var(--border)', borderRadius: 6, padding: '4px 10px', cursor: 'pointer',
};
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid var(--border)',
  background: 'var(--bg-deep)', color: 'var(--text)', fontSize: 13,
};
const labelStyle: React.CSSProperties = {
  fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 5, fontWeight: 600, letterSpacing: 0.5,
};
const errorTextStyle: React.CSSProperties = { fontSize: 10, color: '#f87171', marginTop: 3 };
const hintStyle: React.CSSProperties = { fontSize: 10, color: 'var(--text-dim)', marginTop: 3 };
const modalBackdrop: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
};
const modalBox: React.CSSProperties = {
  background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 16,
  padding: 28, width: 540, maxHeight: '85vh', overflowY: 'auto',
};
