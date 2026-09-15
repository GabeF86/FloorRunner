'use client';

// Custom Fields tab of /providers/[id] — the organization-defined extra fields
// for one provider, plus the per-field-type input switch behind them.
//
// DYNAMICALLY IMPORTED by page.tsx. Most organizations define few or no custom
// fields, and the tab renders an empty state for every provider the defined
// ones are out of scope for — so this is rendered on a small minority of opens
// while previously costing every one of them.

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Badge, Banner, Button, Card, EmptyState, Spinner } from '@/components/ui';
import {
  fieldLabelStyle, fieldInputStyle,
  Toggle, Stack, TabStack, SaveBar,
} from './ui';

interface CustomFieldDef {
  id: string;
  field_name: string;
  display_label: string;
  field_type: 'text' | 'number' | 'boolean' | 'select' | 'multiselect' | 'date';
  options: string[];
  required: boolean;
  admin_only: boolean;
  applies_to_provider_types: string[];
  applies_to_sites: string[];
  display_order: number;
}

export function CustomFieldsTab({ providerId, providerType, homeSiteId }: { providerId: string; providerType: string; homeSiteId: string | null }) {
  const [defs, setDefs] = useState<CustomFieldDef[]>([]);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const res = await fetch(`/api/scheduling/providers/${providerId}/custom-field-values`);
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error || `Failed (${res.status})`);
      setLoading(false);
      return;
    }
    const data = await res.json();
    const rawDefs = (data.definitions || []) as CustomFieldDef[];
    const vals = (data.values || {}) as Record<string, unknown>;
    setDefs(rawDefs);
    setValues(vals);
    setDraft(vals);
    setLoading(false);
  };

  useEffect(() => { load(); }, [providerId]);

  // Show a definition only if both scope filters pass:
  //   - provider_type scope: empty list = applies to all types
  //   - site scope: empty list = applies regardless of site; otherwise the
  //     provider's home site must be in the list. Providers with no home
  //     site are hidden from site-scoped fields (there's no site to match).
  const visible = defs.filter(d => {
    if (d.applies_to_provider_types.length > 0 && !d.applies_to_provider_types.includes(providerType)) return false;
    if (d.applies_to_sites.length > 0 && (!homeSiteId || !d.applies_to_sites.includes(homeSiteId))) return false;
    return true;
  });

  const dirty = visible.some(d => !deepEqual(draft[d.id], values[d.id]));

  const save = async () => {
    // Client-side required-check — mirrors server validation but gives a
    // better immediate error.
    for (const d of visible) {
      if (d.required) {
        const v = draft[d.id];
        const empty = v === null || v === undefined || v === ''
          || (Array.isArray(v) && v.length === 0);
        if (empty) {
          setError(`"${d.display_label}" is required`);
          return;
        }
      }
    }

    setSaving(true); setError(null);
    try {
      // Only send the fields the user actually visits — unknown defs stay
      // untouched on the server.
      const payload: Record<string, unknown> = {};
      for (const d of visible) payload[d.id] = draft[d.id] ?? null;
      const res = await fetch(`/api/scheduling/providers/${providerId}/custom-field-values`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: payload }),
      });
      if (!res.ok) {
        setError((await res.json().catch(() => ({}))).error || `Failed (${res.status})`);
        return;
      }
      const data = await res.json();
      const next = (data.values || {}) as Record<string, unknown>;
      setValues(next);
      setDraft(next);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', padding: 'var(--space-5) 0', color: 'var(--text-muted)', fontSize: 'var(--fs-sm)' }}>
        <Spinner /> Loading custom fields…
      </div>
    );
  }

  if (visible.length === 0) {
    return (
      <TabStack maxWidth={640}>
        <Card pad={false}>
          <EmptyState
            icon="◎"
            title="No custom fields apply to this provider"
            hint="Custom fields can be scoped to a provider type or a site, so this provider may simply be out of scope for the ones that exist."
            action={
              <Link href="/settings" className="fr-focus" style={{ color: 'var(--blue)', fontSize: 'var(--fs-sm)', textDecoration: 'none' }}>
                Settings → Provider Custom Fields
              </Link>
            }
          />
        </Card>
      </TabStack>
    );
  }

  return (
    <TabStack maxWidth={640}>
      {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}

      <Card title="Custom fields">
        <Stack>
          {visible.map(d => (
            <CustomFieldInput
              key={d.id}
              def={d}
              value={draft[d.id]}
              onChange={v => setDraft(prev => ({ ...prev, [d.id]: v }))}
            />
          ))}
        </Stack>
      </Card>

      <SaveBar>
        <Button onClick={save} disabled={!dirty || saving}>
          {saving ? 'Saving…' : 'Save Changes'}
        </Button>
      </SaveBar>
    </TabStack>
  );
}

function CustomFieldInput({ def, value, onChange }: {
  def: CustomFieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  // The ADMIN marker was an 8–9px uppercase span with a hand-mixed amber tint.
  // It is a status on a field, which is exactly what the kit's Badge is.
  const markers = (
    <>
      {def.required && <span style={{ color: 'var(--danger)' }} title="Required">*</span>}
      {def.admin_only && <Badge tone="warn">admin</Badge>}
    </>
  );
  const label = (
    <label style={{ ...fieldLabelStyle, display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
      {def.display_label}
      {markers}
    </label>
  );

  switch (def.field_type) {
    case 'text':
      return (
        <div>
          {label}
          <input
            value={typeof value === 'string' ? value : ''}
            onChange={e => onChange(e.target.value || null)}
            className="fr-field"
            style={fieldInputStyle}
          />
        </div>
      );
    case 'number':
      return (
        <div>
          {label}
          <input
            type="number"
            value={value === null || value === undefined ? '' : String(value)}
            onChange={e => onChange(e.target.value === '' ? null : Number(e.target.value))}
            className="fr-field"
            style={fieldInputStyle}
          />
        </div>
      );
    case 'date':
      return (
        <div>
          {label}
          <input
            type="date"
            value={typeof value === 'string' ? value : ''}
            onChange={e => onChange(e.target.value || null)}
            className="fr-field"
            style={fieldInputStyle}
          />
        </div>
      );
    case 'boolean':
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <Toggle
            label={def.display_label}
            checked={value === true}
            onChange={v => onChange(v)}
          />
          {markers}
        </div>
      );
    case 'select':
      return (
        <div>
          {label}
          <select
            value={typeof value === 'string' ? value : ''}
            onChange={e => onChange(e.target.value || null)}
            className="fr-field"
            style={fieldInputStyle}
          >
            <option value="">— None —</option>
            {def.options.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
      );
    case 'multiselect': {
      const arr = Array.isArray(value) ? value as string[] : [];
      return (
        <div>
          {label}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
            {def.options.map(o => {
              const selected = arr.includes(o);
              return (
                <button
                  key={o}
                  type="button"
                  // Same pill contract as the Available-Weekdays row above.
                  className={`fr-focus fr-btn${selected ? '' : ' fr-btn-secondary'}`}
                  aria-pressed={selected}
                  onClick={() => {
                    const next = selected ? arr.filter(x => x !== o) : [...arr, o];
                    onChange(next);
                  }}
                  style={{
                    padding: '6px 12px', borderRadius: 'var(--radius-sm)',
                    fontSize: 'var(--fs-sm)', fontWeight: selected ? 700 : 500,
                    fontFamily: 'inherit', cursor: 'pointer',
                    border: `1px solid ${selected ? 'var(--blue)' : 'var(--border)'}`,
                    background: selected ? 'var(--info-bg)' : 'transparent',
                    color: selected ? 'var(--text-strong)' : 'var(--text-muted)',
                  }}
                >
                  {o}
                </button>
              );
            })}
          </div>
        </div>
      );
    }
    default:
      return null;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  // Null vs undefined should be treated equivalently for "no value set".
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  return false;
}
