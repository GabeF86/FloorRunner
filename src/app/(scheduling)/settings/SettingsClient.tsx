'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
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

// Page frame + header copy are shared by the loading, empty and loaded states so
// the header does not shift or re-typeset when the fetch resolves.
const PAGE_STYLE: React.CSSProperties = { maxWidth: 960 };
const PAGE_SUBTITLE = 'Organization-level configuration.';

export interface SettingsClientProps {
  /** Read by the server in the same request as the page shell. */
  initialCustomFields: CustomFieldDefinition[];
  initialSites: Site[];
  orgId: string;
  /** Set when the server's organizations or custom-field read failed — shown
   *  INSTEAD of the list, so a transient failure never reads as "no fields
   *  defined" and invites a duplicate. */
  loadError: string | null;
}

export default function SettingsClient(
  { initialCustomFields, initialSites, orgId, loadError }: SettingsClientProps,
) {
  const [sites, setSites] = useState<Site[]>(initialSites);
  const [defs, setDefs] = useState<CustomFieldDefinition[]>(initialCustomFields);
  // `loading` starts FALSE: the rows arrived with the HTML. Starting true would
  // paint a skeleton over data the user can already see, which is the exact
  // flash this refactor removes.
  const [loading] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  // False is the default the SERVER renders too — it asks for active
  // definitions only — so ticking "Show inactive" widens the list rather than
  // appearing to change one that was already unfiltered.
  const [includeInactive, setIncludeInactive] = useState(false);

  // The definitions effect below also fires on mount, which would immediately
  // refetch the list the server just sent and reinstate the very waterfall this
  // page was converted to avoid. The first run is skipped; every later one is a
  // real change (the inactive toggle, or a reload after an edit).
  const seeded = useRef(true);

  // The organization used to be fetched here and both other queries gated
  // behind it — a round trip to learn an id that never changes. The server
  // component resolves it now and passes it in, and reports its own failure
  // through `loadError`.

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

  useEffect(() => {
    if (seeded.current) { seeded.current = false; return; }
    loadDefs();
  }, [loadDefs]);
  // Sites are seeded too and only change from the Sites screen, so this fetch
  // exists for the case where the server's sites read failed and left the
  // scope pickers empty.
  useEffect(() => {
    if (sites.length > 0) return;
    loadSites();
  }, [loadSites, sites.length]);

  if (loading) {
    return (
      <div style={PAGE_STYLE}>
        <PageHeader title="Settings" subtitle={PAGE_SUBTITLE} />
        <Card pad={false}>
          <Table headers={TABLE_HEADERS} rows={undefined} minWidth={640} />
        </Card>
      </div>
    );
  }
  // Only reached when a server read genuinely FAILED — checked before the
  // "no organization" branch below, which is the genuinely-empty case.
  if (loadError) {
    return (
      <div style={PAGE_STYLE}>
        <PageHeader title="Settings" subtitle={PAGE_SUBTITLE} />
        <Banner tone="error">{loadError} Reload the page to try again.</Banner>
      </div>
    );
  }
  if (!orgId) {
    return (
      <div style={PAGE_STYLE}>
        <PageHeader title="Settings" subtitle={PAGE_SUBTITLE} />
        <Banner tone="warn">Create an organization first.</Banner>
      </div>
    );
  }

  return (
    <div style={PAGE_STYLE}>
      <PageHeader title="Settings" subtitle={PAGE_SUBTITLE} />

      {/* Section head: this page is the hub for the Settings group (Block Prep,
          Rules, Requests sit beside it in the sidebar), so its own content is
          titled as a section rather than running straight off the page H1. */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 'var(--space-3)', gap: 'var(--space-3)' }}>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ fontSize: 'var(--fs-lg)', fontWeight: 700, letterSpacing: -0.3, lineHeight: 1.2, color: 'var(--text-strong)' }}>
            Provider Custom Fields
          </h2>
          <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', marginTop: 'var(--space-1)', lineHeight: 1.45 }}>
            Extra fields that appear on every provider profile. Great for org-specific data like DEA number, preferred pager, or team assignment.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexShrink: 0 }}>
          <label style={checkboxLabelStyle}>
            <input type="checkbox" checked={includeInactive} onChange={e => setIncludeInactive(e.target.checked)} style={checkboxStyle} />
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
              dim(<span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{d.display_label}</span>),
              dim(<span style={{ color: 'var(--text-muted)', fontFamily: monoStack, fontSize: 'var(--fs-xs)' }}>{d.field_name}</span>),
              dim(<Badge tone="info">{d.field_type}</Badge>),
              dim(d.required ? <Badge tone="warn">Required</Badge> : <Badge tone="neutral">Optional</Badge>),
              dim(scope.length
                ? <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)' }}>{scope.join(' · ')}</span>
                : <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-dim)' }}>All providers</span>),
              dim(
                <span style={{ display: 'inline-flex', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
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
      <div style={{ display: 'flex', gap: 'var(--space-1)', justifyContent: 'flex-end', whiteSpace: 'nowrap' }}>
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
        <div style={{ marginBottom: 'var(--space-4)' }}>
          <Banner tone="error">{error}</Banner>
        </div>
      )}

      <div style={{ marginBottom: 'var(--space-3)' }}>
        <label style={labelStyle}>Display Label *</label>
        <input
          className="fr-field"
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
          style={{ ...inputStyle, borderColor: errors.displayLabel ? 'var(--danger)' : 'var(--border)' }}
        />
        {errors.displayLabel && <div style={errorTextStyle}>{errors.displayLabel}</div>}
      </div>

      <div style={{ marginBottom: 'var(--space-3)' }}>
        <label style={labelStyle}>Field Name (internal key) *</label>
        <input
          className="fr-field"
          value={fieldName}
          onChange={e => setFieldName(e.target.value)}
          disabled={mode === 'edit'}
          placeholder="e.g. dea_number"
          style={{
            ...inputStyle,
            fontFamily: monoStack,
            borderColor: errors.fieldName ? 'var(--danger)' : 'var(--border)',
            // Locked after creation: read as disabled, not as a faded input —
            // the dim text token says "not editable" without washing the border out.
            color: mode === 'edit' ? 'var(--text-disabled)' : 'var(--text)',
            cursor: mode === 'edit' ? 'not-allowed' : 'text',
          }}
        />
        {errors.fieldName ? (
          <div style={errorTextStyle}>{errors.fieldName}</div>
        ) : (
          <div style={hintStyle}>Stable identifier used by rules and integrations. Cannot be changed after creation.</div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
        <div>
          <label style={labelStyle}>Field Type</label>
          <select className="fr-field" value={fieldType} onChange={e => setFieldType(e.target.value as typeof CUSTOM_FIELD_TYPES[number])} style={{ ...inputStyle, cursor: 'pointer' }}>
            {CUSTOM_FIELD_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 'var(--space-2)', paddingBottom: 'var(--space-1)' }}>
          <label style={{ ...checkboxLabelStyle, fontSize: 'var(--fs-sm)' }}>
            <input type="checkbox" checked={required} onChange={e => setRequired(e.target.checked)} style={checkboxStyle} />
            Required on every profile
          </label>
          {/* Admin-only is a restriction, so it carries the warn tone — matching
              the "Admin" badge this same flag paints on the table row. */}
          <label style={{ ...checkboxLabelStyle, fontSize: 'var(--fs-sm)', color: 'var(--warn)' }}>
            <input type="checkbox" checked={adminOnly} onChange={e => setAdminOnly(e.target.checked)} style={{ ...checkboxStyle, accentColor: 'var(--warn)' }} />
            Admin-only (hide from non-admin views)
          </label>
        </div>
      </div>

      {needsOptions && (
        <div style={{ marginBottom: 'var(--space-3)' }}>
          <label style={labelStyle}>Options (one per line)</label>
          <textarea
            className="fr-field"
            value={optionsText}
            onChange={e => setOptionsText(e.target.value)}
            placeholder={'Option 1\nOption 2\nOption 3'}
            style={{ ...inputStyle, minHeight: 90, resize: 'vertical', borderColor: errors.options ? 'var(--danger)' : 'var(--border)' }}
          />
          {errors.options && <div style={errorTextStyle}>{errors.options}</div>}
        </div>
      )}

      <div style={{ marginBottom: 'var(--space-3)' }}>
        <label style={labelStyle}>Scope — Provider Types</label>
        <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
          {PROVIDER_TYPES.map(t => (
            <Button
              key={t}
              variant="secondary"
              size="sm"
              onClick={() => setProviderTypes(prev => toggle(prev, t))}
              style={providerTypes.includes(t) ? scopeChipOnStyle : scopeChipOffStyle}
            >
              {t}
            </Button>
          ))}
        </div>
        <div style={hintStyle}>Empty = applies to all provider types.</div>
      </div>

      {sites.length > 0 && (
        <div style={{ marginBottom: 'var(--space-4)' }}>
          <label style={labelStyle}>Scope — Sites</label>
          <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
            {sites.map(s => (
              <Button
                key={s.id}
                variant="secondary"
                size="sm"
                onClick={() => setSiteIds(prev => toggle(prev, s.id))}
                style={siteIds.includes(s.id) ? scopeChipOnStyle : scopeChipOffStyle}
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

// The Table header already uses this stack; the internal-key field and the
// field_name column are the same kind of value, so they read the same way.
const monoStack = 'var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace';

// Fields pair this layout with class="fr-field", which supplies the hover
// border and the keyboard focus outline (a pseudo-class an inline style cannot
// express). Border is set as a longhand `border` here so callers can override
// borderColor alone for the error state without re-declaring the shorthand.
const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: 'var(--space-2) var(--space-3)',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border)',
  background: 'var(--bg-deep)',
  color: 'var(--text)',
  fontSize: 'var(--fs-sm)',
  // Textareas and selects default to the UA font; without this the modal shows
  // three different typefaces down one column.
  fontFamily: 'inherit',
};
const labelStyle: React.CSSProperties = {
  fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', display: 'block',
  marginBottom: 'var(--space-1)', fontWeight: 600, letterSpacing: 0.5,
};
const errorTextStyle: React.CSSProperties = { fontSize: 'var(--fs-xs)', color: 'var(--danger)', marginTop: 'var(--space-1)' };
const hintStyle: React.CSSProperties = { fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 'var(--space-1)' };

// Checkboxes: the accent was the dark-theme blue hardcoded into a light-default
// app; --blue tracks the theme and meets AA on both surfaces.
const checkboxStyle: React.CSSProperties = { accentColor: 'var(--blue)', cursor: 'pointer', margin: 0 };
const checkboxLabelStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
  fontSize: 'var(--fs-sm)', color: 'var(--text-muted)',
  cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap',
};

// Scope toggles are secondary Buttons, so hover/press/focus come from .fr-btn;
// only the selected tint is stated here. One accent family (blue) for on,
// muted text for off — a selected chip should differ in colour, not in weight.
const scopeChipOnStyle: React.CSSProperties = {
  borderColor: 'var(--blue)', background: 'var(--info-bg)', color: 'var(--blue)',
};
const scopeChipOffStyle: React.CSSProperties = { color: 'var(--text-muted)' };
