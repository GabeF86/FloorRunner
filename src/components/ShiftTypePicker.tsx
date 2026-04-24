'use client';

import { useEffect, useMemo, useState } from 'react';

export interface ShiftType {
  id: string;
  site_id: string;
  code: string;
  name: string;
  category: string;
  color_hex?: string | null;
  is_active?: boolean;
}

interface BasePickerProps {
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
  accent?: string;
  emptyHint?: string;
}

// Per-site picker — shows the codes available at one specific site. Used in
// the Sites & Credentials tab where allowed/excluded shift types are scoped
// to that site. `includeCategories` (optional) narrows the picker to a
// subset of shift_category values — e.g. pass ['regular'] to hide call/leave
// shifts when the caller only cares about day shifts.
export function SiteShiftTypePicker({
  siteId,
  label,
  values,
  onChange,
  accent = '#0ea5e9',
  emptyHint,
  includeCategories,
  filter,
}: BasePickerProps & {
  siteId: string;
  includeCategories?: string[];
  // Optional post-load filter applied to the "available to add" dropdown.
  // Selected values already in `values` still render their tags (so legacy
  // entries aren't silently hidden), but they can only be *added* if this
  // predicate returns true.
  filter?: (st: ShiftType) => boolean;
}) {
  const [shiftTypes, setShiftTypes] = useState<ShiftType[]>([]);
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/scheduling/shift-types?site_id=${siteId}`)
      .then(r => r.json())
      .then(data => {
        if (cancelled) return;
        const active: ShiftType[] = Array.isArray(data)
          ? data.filter((t: ShiftType) => t.is_active !== false)
          : [];
        const filtered = includeCategories && includeCategories.length > 0
          ? active.filter(t => includeCategories.includes(t.category))
          : active;
        setShiftTypes(filtered);
        setLoading(false);
      })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // includeCategories intentionally stringified to keep effect key stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId, (includeCategories || []).join(',')]);

  const byCode = useMemo(() => {
    const m = new Map<string, ShiftType>();
    for (const t of shiftTypes) m.set(t.code, t);
    return m;
  }, [shiftTypes]);

  const available = shiftTypes.filter(t =>
    !values.includes(t.code) && (filter ? filter(t) : true),
  );

  const add = () => {
    if (!sel || values.includes(sel)) return;
    onChange([...values, sel]);
    setSel('');
  };

  return (
    <Chrome
      label={label}
      values={values}
      byCode={byCode}
      accent={accent}
      onRemove={(code) => onChange(values.filter(v => v !== code))}
      picker={
        loading ? (
          <div style={{ ...inputStyle, color: 'var(--text-dim)', fontSize: 12, padding: '10px 12px' }}>
            Loading shift types...
          </div>
        ) : shiftTypes.length === 0 ? (
          <div style={{ ...inputStyle, color: 'var(--text-dim)', fontSize: 12, padding: '10px 12px' }}>
            {emptyHint ?? 'No shift types configured for this site yet.'}
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            <select value={sel} onChange={e => setSel(e.target.value)} style={{ ...inputStyle, flex: 1 }}>
              <option value="">Select a shift type...</option>
              {available.map(t => (
                <option key={t.id} value={t.code}>{t.code} — {t.name} ({t.category})</option>
              ))}
            </select>
            <button
              type="button"
              onClick={add}
              disabled={!sel}
              style={addBtnStyle(!!sel)}
            >
              Add
            </button>
          </div>
        )
      }
    />
  );
}

// Cross-site picker — shows codes from every site in the org, grouped by site
// name. Used in the Preferences tab where preferences are not tied to one
// site. Stores just the code string so two sites with the same shift code are
// collapsed (which is the intended semantic).
export function OrgShiftTypePicker({
  orgId,
  label,
  values,
  onChange,
  accent = '#0ea5e9',
}: BasePickerProps & { orgId: string }) {
  const [shiftTypes, setShiftTypes] = useState<ShiftType[]>([]);
  const [sites, setSites] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      fetch('/api/scheduling/shift-types').then(r => r.json()),
      fetch(`/api/scheduling/sites?org_id=${orgId}`).then(r => r.json()),
    ]).then(([shiftTypesRaw, sitesRaw]) => {
      if (cancelled) return;
      const siteMap: Record<string, string> = {};
      const siteIds = new Set<string>();
      if (Array.isArray(sitesRaw)) {
        for (const s of sitesRaw) {
          siteMap[s.id] = s.short_name || s.name;
          siteIds.add(s.id);
        }
      }
      setSites(siteMap);
      // Filter to only shift types belonging to sites in this org — the
      // API returns all when unscoped, and the service-role key bypasses
      // RLS.
      const filtered = Array.isArray(shiftTypesRaw)
        ? shiftTypesRaw.filter((t: ShiftType) => siteIds.has(t.site_id) && t.is_active !== false)
        : [];
      setShiftTypes(filtered);
      setLoading(false);
    }).catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [orgId]);

  // Unique codes, with a preferred shift-type picked for display.
  const codeOptions = useMemo(() => {
    const byCode = new Map<string, { code: string; display: string; sites: string[] }>();
    for (const t of shiftTypes) {
      const existing = byCode.get(t.code);
      const siteLabel = sites[t.site_id] || '';
      if (existing) {
        if (siteLabel && !existing.sites.includes(siteLabel)) existing.sites.push(siteLabel);
      } else {
        byCode.set(t.code, { code: t.code, display: t.name, sites: siteLabel ? [siteLabel] : [] });
      }
    }
    return Array.from(byCode.values()).sort((a, b) => a.code.localeCompare(b.code));
  }, [shiftTypes, sites]);

  const byCode = useMemo(() => {
    const m = new Map<string, ShiftType>();
    for (const t of shiftTypes) if (!m.has(t.code)) m.set(t.code, t);
    return m;
  }, [shiftTypes]);

  const available = codeOptions.filter(o => !values.includes(o.code));

  const add = () => {
    if (!sel || values.includes(sel)) return;
    onChange([...values, sel]);
    setSel('');
  };

  return (
    <Chrome
      label={label}
      values={values}
      byCode={byCode}
      accent={accent}
      onRemove={(code) => onChange(values.filter(v => v !== code))}
      picker={
        loading ? (
          <div style={{ ...inputStyle, color: 'var(--text-dim)', fontSize: 12, padding: '10px 12px' }}>
            Loading shift types...
          </div>
        ) : codeOptions.length === 0 ? (
          <div style={{ ...inputStyle, color: 'var(--text-dim)', fontSize: 12, padding: '10px 12px' }}>
            No shift types configured yet. Define them under Sites → Shift Types.
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            <select value={sel} onChange={e => setSel(e.target.value)} style={{ ...inputStyle, flex: 1 }}>
              <option value="">Select a shift type...</option>
              {available.map(o => (
                <option key={o.code} value={o.code}>
                  {o.code} — {o.display}{o.sites.length ? ` · ${o.sites.join(', ')}` : ''}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={add}
              disabled={!sel}
              style={addBtnStyle(!!sel)}
            >
              Add
            </button>
          </div>
        )
      }
    />
  );
}

function Chrome({
  label, values, byCode, accent, onRemove, picker,
}: {
  label: string;
  values: string[];
  byCode: Map<string, ShiftType>;
  accent: string;
  onRemove: (code: string) => void;
  picker: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={labelStyle}>{label}</label>
      {picker}
      {values.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
          {values.map(code => {
            const t = byCode.get(code);
            // Unknown codes are still editable/removable — they may have been
            // created before the associated shift type was removed or may
            // reference another org's shift types.
            return (
              <span key={code} style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                fontSize: 11, fontWeight: 600, padding: '3px 4px 3px 9px', borderRadius: 6,
                background: `${accent}20`, color: accent, border: `1px solid ${accent}30`,
              }}>
                <strong>{code}</strong>
                {t ? <span style={{ opacity: 0.75, fontWeight: 500 }}>— {t.name}</span> : <span style={{ opacity: 0.6 }}>(unknown)</span>}
                <button
                  type="button"
                  onClick={() => onRemove(code)}
                  style={{
                    background: 'none', border: 'none', color: accent, cursor: 'pointer',
                    fontSize: 14, lineHeight: 1, padding: '0 4px',
                  }}
                  aria-label={`Remove ${code}`}
                >×</button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid var(--border)',
  background: 'var(--bg-deep)', color: 'var(--text)', fontSize: 13,
};
const labelStyle: React.CSSProperties = {
  fontSize: 11, color: 'var(--text-muted)', display: 'block',
  marginBottom: 5, fontWeight: 600, letterSpacing: 0.5,
};
const addBtnStyle = (enabled: boolean): React.CSSProperties => ({
  padding: '8px 14px', borderRadius: 8, cursor: enabled ? 'pointer' : 'not-allowed',
  fontSize: 12, fontWeight: 700, background: 'var(--bg-surface)', color: 'var(--text-muted)',
  border: '1px solid var(--border)', opacity: enabled ? 1 : 0.5,
});
