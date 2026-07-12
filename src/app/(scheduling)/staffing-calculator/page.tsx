'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  CALCULATORS,
  getCalculator,
  CalculatorConfig,
  ConfigField,
  StaffAssignment,
  CalculatorOutput,
  AvailableStaff,
  Contingency,
  SiteCatalogEntry,
} from '@/lib/staffingCalculator';
import { buildBreakAnalysis } from '@/lib/staffingCalculator/shared';
import { Card } from '@/components/ui';

/* ── Shared style tokens ─────────────────────────────────────────────────── */
// All values resolve to the global var(--*) tokens so both themes render
// correctly. Tinted variants use color-mix so no hex ever lives here.

const tok = {
  card: 'var(--bg-surface)',
  surface: 'var(--bg-deep)',
  border: 'var(--border)',
  hairline: '1px solid var(--border)',
  text: 'var(--text)',
  textMuted: 'var(--text-muted)',
  textDim: 'var(--text-dim)',
  mono: 'var(--font-mono), ui-monospace, monospace',
  md: {
    fg: 'var(--indigo)',
    bg: 'color-mix(in srgb, var(--indigo) 12%, transparent)',
    bd: 'color-mix(in srgb, var(--indigo) 35%, transparent)',
  },
  crna: {
    fg: 'var(--blue)',
    bg: 'color-mix(in srgb, var(--blue) 12%, transparent)',
    bd: 'color-mix(in srgb, var(--blue) 35%, transparent)',
  },
  accent: 'var(--blue)',
  warning: 'var(--warn)',
  // Orange lane accent derived from the status tokens (no dedicated orange var).
  crossSite: 'color-mix(in srgb, var(--warn) 55%, var(--danger))',
  radius: 'var(--radius-lg)',
  radiusSm: 'var(--radius-md)',
  // Soft, layered elevation — a single source of truth for card depth.
  shadow: 'var(--shadow-card)',
};

// A user-defined site, local to the current facility's calculator state. Lives
// only in component state (cleared by reset) — it overlays the algorithm output
// as extra site columns and, for room-based sites, seeds CRNA "rooms" that the
// user supervises/staffs manually. Kept deliberately out of the pure calculate()
// functions so the per-facility algorithms stay focused on built-in sites.
type CustomSite = {
  key: string;       // unique within the facility (matches StaffAssignment.site)
  label: string;
  color: string;
  hasRooms: boolean; // room-based (shows +/- stepper) vs single-site location
  rooms: number;     // current room count when hasRooms
};

// Muted palette for custom sites — distinct from the built-in lane colors but
// in the same desaturated family so custom lanes read as "first-class".
const CUSTOM_SITE_COLORS = ['#7C9CBF', '#C18FE0', '#5FB0A8', '#E0A458', '#B0708F', '#6FA8C7', '#9C8FB0'];

// Overlay custom-site rooms onto a freshly-computed output. Each room-based
// custom site contributes `rooms` unsupervised CRNA chips so they appear in the
// map and count toward CRNAs-needed / the staffing gap, exactly like a built-in
// room-based site. Single-site customs add no staff (manual via the diagram).
// Ids are deterministic so React keys stay stable across recomputes.
function injectCustomSites(base: CalculatorOutput, sites: CustomSite[]): CalculatorOutput {
  const extra: StaffAssignment[] = [];
  for (const s of sites) {
    if (!s.hasRooms) continue;
    for (let i = 0; i < s.rooms; i++) {
      extra.push({
        id: `cc-${s.key}-r${i}`, type: 'CRNA',
        role: s.rooms > 1 ? `Room ${i + 1}` : 'Room',
        site: s.key, supervisedBy: null, supervises: [],
        notes: 'Custom site room — assign a supervising MD or add staff manually.',
      });
    }
  }
  if (extra.length === 0) return base;
  const assignments = [...base.assignments, ...extra];
  const totalMDs = assignments.filter((a) => a.type === 'MD').length;
  const totalCRNAs = assignments.filter((a) => a.type === 'CRNA').length;
  // Each injected room is a provider who needs a break, so fold them into the
  // break-coverage demand (capacity is unchanged — custom rooms bring no relief
  // source) — otherwise the break panel would disagree with the staffing totals.
  const breakAnalysis = buildBreakAnalysis(base.breakAnalysis.demand + extra.length, base.breakAnalysis.sources);
  return { ...base, assignments, totalMDs, totalCRNAs, totalStaff: totalMDs + totalCRNAs, breakAnalysis };
}

// Merge custom sites into the lane catalog just before the Float pool, so custom
// lanes always render as columns (even empty / single-site) and look identical
// to built-in lanes.
function mergeSiteCatalog(base: SiteCatalogEntry[], customSites: CustomSite[]): SiteCatalogEntry[] {
  if (customSites.length === 0) return base;
  const customEntries: SiteCatalogEntry[] = customSites.map((s) => ({ key: s.key, label: s.label, color: s.color, icon: '✚' }));
  const floatIdx = base.findIndex((s) => s.key === 'Float');
  if (floatIdx === -1) return [...base, ...customEntries];
  return [...base.slice(0, floatIdx), ...customEntries, ...base.slice(floatIdx)];
}

/* ── Page ────────────────────────────────────────────────────────────────── */

export default function StaffingCalculatorPage() {
  const [facilityId, setFacilityId] = useState<string>(CALCULATORS[0].facilityId);
  const calc = getCalculator(facilityId);
  const isPlaceholder = calc?.status === 'placeholder';

  // Per-facility cfg state — switching facilities preserves both inputs.
  const [configs, setConfigs] = useState<Record<string, CalculatorConfig>>(
    () => Object.fromEntries(CALCULATORS.map((c) => [c.facilityId, { ...c.defaultConfig }])),
  );
  const cfg = configs[facilityId] ?? {};

  const setCfgValue = (key: string, value: number | boolean | string) => {
    setConfigs((prev) => ({
      ...prev,
      [facilityId]: { ...prev[facilityId], [key]: value },
    }));
  };

  const [avail, setAvail] = useState<AvailableStaff>({ mds: 12, crnas: 14 });

  // Per-facility custom sites — local UI state, cleared by reset.
  const [customSites, setCustomSites] = useState<Record<string, CustomSite[]>>(
    () => Object.fromEntries(CALCULATORS.map((c) => [c.facilityId, [] as CustomSite[]])),
  );
  const facilityCustomSites = customSites[facilityId] ?? [];
  const [showAddSite, setShowAddSite] = useState(false);

  // Result is held as state (not derived) so the diagram can apply local
  // reassignments (drag-CRNA-onto-MD, drag-MD-to-site) without re-running
  // the algorithm. cfg / avail / facility / custom-site changes wipe local
  // edits and recompute fresh — that's the intended reset semantic.
  const [result, setResult] = useState<CalculatorOutput | null>(null);
  useEffect(() => {
    if (!calc || isPlaceholder) { setResult(null); return; }
    setResult(injectCustomSites(calc.calculate(cfg, avail), customSites[facilityId] ?? []));
  }, [calc, cfg, avail, isPlaceholder, customSites, facilityId]);

  const reset = () => {
    if (!calc) return;
    setConfigs((prev) => ({ ...prev, [facilityId]: { ...calc.defaultConfig } }));
    setCustomSites((prev) => ({ ...prev, [facilityId]: [] }));
  };

  const addCustomSite = (input: { name: string; hasRooms: boolean; rooms: number }) => {
    setCustomSites((prev) => {
      const list = prev[facilityId] ?? [];
      const color = CUSTOM_SITE_COLORS[list.length % CUSTOM_SITE_COLORS.length];
      // Random suffix (not list.length) so a remove-then-add can't reuse a key —
      // which would collide React keys and the deterministic `cc-<key>-r<i>` room ids.
      const key = `cs-${facilityId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const site: CustomSite = {
        key,
        label: input.name.trim() || 'Custom site',
        color,
        hasRooms: input.hasRooms,
        rooms: input.hasRooms ? Math.max(1, input.rooms) : 0,
      };
      return { ...prev, [facilityId]: [...list, site] };
    });
  };
  const setCustomSiteRooms = (key: string, rooms: number) => {
    setCustomSites((prev) => ({
      ...prev,
      [facilityId]: (prev[facilityId] ?? []).map((s) => (s.key === key ? { ...s, rooms: Math.max(0, rooms) } : s)),
    }));
  };
  const removeCustomSite = (key: string) => {
    setCustomSites((prev) => ({
      ...prev,
      [facilityId]: (prev[facilityId] ?? []).filter((s) => s.key !== key),
    }));
  };

  return (
    <div style={{ padding: '20px 24px 36px', maxWidth: 1200, margin: '0 auto' }}>
      {/* Breadcrumb */}
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 14, fontFamily: tok.mono, display: 'flex', alignItems: 'center', gap: 6, textTransform: 'uppercase', letterSpacing: 0.4 }}>
        <span style={{ color: tok.textMuted }}>scheduling</span>
        <span style={{ opacity: 0.5 }}>/</span>
        <span style={{ color: tok.textMuted }}>staffing calculator</span>
      </div>

      {/* Header */}
      <Card style={{ marginBottom: 12 }}>
       <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 750, color: tok.text, letterSpacing: -0.6, lineHeight: 1.1 }}>
            Staffing Calculator
          </h1>
          <div style={{ fontSize: 12, color: tok.textMuted, marginTop: 4, lineHeight: 1.35 }}>
            Plan tomorrow&apos;s staffing — enter site config, drag MDs &amp; CRNAs to test scenarios.
          </div>
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {CALCULATORS.map((c) => {
            const isActive = c.facilityId === facilityId;
            const placeholder = c.status === 'placeholder';
            return (
              <button
                key={c.facilityId}
                onClick={() => setFacilityId(c.facilityId)}
                title={placeholder ? `${c.facilityName} — algorithm not yet ported` : c.facilityName}
                style={{
                  padding: '4px 10px', borderRadius: 999, fontSize: 10, fontWeight: 700, fontFamily: tok.mono,
                  background: isActive ? '#E1F5EE' : 'transparent',
                  color: isActive ? '#085041' : tok.textMuted,
                  border: '0.5px solid ' + (isActive ? '#A8DBC9' : tok.border),
                  cursor: 'pointer', position: 'relative',
                  opacity: placeholder ? 0.7 : 1,
                }}
              >
                {c.abbreviation}
                {placeholder && <span style={{ marginLeft: 4, fontSize: 8, opacity: 0.7 }}>·draft</span>}
              </button>
            );
          })}
          <button onClick={reset} title="Reset cfg + clear manual edits" style={{
            padding: '4px 10px', borderRadius: 4, fontSize: 10, fontWeight: 600,
            background: 'transparent', color: tok.textMuted, border: tok.hairline, cursor: 'pointer',
          }}>↺ reset</button>
        </div>
       </div>
      </Card>

      {isPlaceholder && (
        <div style={{
          padding: '10px 14px', marginBottom: 14, borderRadius: 6,
          background: 'rgba(245,158,11,0.10)', border: '0.5px solid rgba(245,158,11,0.30)',
          fontSize: 12, color: '#b45309',
        }}>
          ⚠ The {calc?.facilityName} algorithm hasn&apos;t been ported yet. Inputs and output are disabled until it&apos;s wired up.
        </div>
      )}

      {/* Main grid: inputs (left) | output (right) */}
      <div style={{ display: 'grid', gridTemplateColumns: '280px minmax(0, 1fr)', gap: 12, alignItems: 'start' }}>
        {/* Left: inputs */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, position: 'sticky', top: 12 }}>
          {!isPlaceholder && calc && (
            <ConfigPanel
              schema={calc.schema}
              cfg={cfg}
              onChange={setCfgValue}
              customSites={facilityCustomSites}
              onAddSiteClick={() => setShowAddSite(true)}
              onChangeCustomRooms={setCustomSiteRooms}
              onRemoveCustomSite={removeCustomSite}
            />
          )}
          <AvailableStaffPanel avail={avail} setAvail={setAvail} disabled={isPlaceholder} />
        </div>

        {/* Right: output */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
          {result && <TotalsPanel out={result} avail={avail} />}
          {result && calc && (
            <StaffingDiagram
              result={result}
              setResult={setResult}
              siteCatalog={mergeSiteCatalog(calc.siteCatalog || [], facilityCustomSites)}
            />
          )}
          {result && result.contingencies.length > 0 && <ContingencyCoverage contingencies={result.contingencies} assignments={result.assignments} />}
          {result && <NotesPanel notes={result.notes} />}
          {result && <BreakAnalysisPanel breakAnalysis={result.breakAnalysis} />}
          {!result && (
            <div style={{
              padding: '24px', background: tok.card, border: tok.hairline, borderRadius: 6,
              color: tok.textDim, fontSize: 12, fontStyle: 'italic', textAlign: 'center',
            }}>
              Output not available — facility calculator pending.
            </div>
          )}
        </div>
      </div>

      {showAddSite && (
        <AddSiteModal
          onAdd={(input) => { addCustomSite(input); setShowAddSite(false); }}
          onCancel={() => setShowAddSite(false)}
        />
      )}
    </div>
  );
}

/* ── Config inputs ──────────────────────────────────────────────────────── */

function ConfigPanel({ schema, cfg, onChange, customSites, onAddSiteClick, onChangeCustomRooms, onRemoveCustomSite }: {
  schema: ConfigField[];
  cfg: CalculatorConfig;
  onChange: (key: string, value: number | boolean | string) => void;
  customSites: CustomSite[];
  onAddSiteClick: () => void;
  onChangeCustomRooms: (key: string, rooms: number) => void;
  onRemoveCustomSite: (key: string) => void;
}) {
  // Fields with `attachTo` render inline beside their parent's row (the compact
  // "Cross cover" toggle) — they're excluded from the standalone grouping and
  // looked up per-parent below.
  const attachedByParent = new Map<string, ConfigField>();
  for (const f of schema) if (f.attachTo) attachedByParent.set(f.attachTo, f);

  const grouped: Record<string, ConfigField[]> = {};
  for (const f of schema) {
    if (f.attachTo) continue;
    if (f.visibleWhen && !f.visibleWhen(cfg)) continue;
    if (!grouped[f.section]) grouped[f.section] = [];
    grouped[f.section].push(f);
  }

  const sectionHeader: React.CSSProperties = {
    fontSize: 9.5, fontWeight: 700, color: tok.textDim,
    letterSpacing: 0.55, textTransform: 'uppercase', marginBottom: 4,
  };
  const rowLabel: React.CSSProperties = { fontSize: 12, color: tok.text, fontWeight: 500, lineHeight: 1.2 };

  return (
    <Card>
      <SectionTitle>📋 Site configuration</SectionTitle>
      {Object.entries(grouped).map(([section, fields]) => (
        <div key={section} style={{ marginTop: 10 }}>
          <div style={sectionHeader}>{section}</div>
          {fields.map((f) => {
            // Select → full-width segmented control (the section header is the
            // label). Used for the 3-way staffing-strategy weight.
            if (f.kind === 'select') {
              const current = String(cfg[f.key] ?? f.defaultValue);
              return (
                <div key={f.key} style={{ padding: '2px 2px 2px' }}>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {(f.options || []).map((o) => {
                      const active = current === o.value;
                      return (
                        <button
                          key={o.value}
                          onClick={() => onChange(f.key, o.value)}
                          aria-pressed={active}
                          style={{
                            flex: 1, padding: '5px 3px', borderRadius: tok.radiusSm, cursor: 'pointer',
                            fontSize: 10, fontWeight: 700, lineHeight: 1.15, whiteSpace: 'nowrap',
                            background: active ? `color-mix(in srgb, ${tok.accent} 14%, transparent)` : 'var(--bg-deep)',
                            border: `1px solid ${active ? tok.accent : tok.border}`,
                            color: active ? tok.accent : tok.textMuted,
                          }}
                        >{o.label}</button>
                      );
                    })}
                  </div>
                  {f.helpText && (
                    <div style={{ fontSize: 9, color: tok.textDim, marginTop: 4, lineHeight: 1.3 }}>{f.helpText}</div>
                  )}
                </div>
              );
            }
            const attached = attachedByParent.get(f.key);
            const attachedVisible = !!attached && (!attached.visibleWhen || attached.visibleWhen(cfg));
            return (
              <div key={f.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '3px 2px', gap: 10 }}>
                <span style={rowLabel}>{f.label}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  {f.kind === 'number' ? (
                    <Stepper
                      value={Number(cfg[f.key] ?? 0)}
                      onChange={(v) => onChange(f.key, v)}
                      min={f.min ?? 0}
                      max={f.max ?? 30}
                      color={f.accentColor}
                    />
                  ) : (
                    <ToggleBtn
                      on={Boolean(cfg[f.key])}
                      onClick={() => onChange(f.key, !cfg[f.key])}
                      color={f.accentColor}
                    />
                  )}
                  {attached && attachedVisible && (
                    <CrossCoverToggle
                      label={attached.label}
                      title={attached.helpText}
                      on={Boolean(cfg[attached.key])}
                      onClick={() => onChange(attached.key, !cfg[attached.key])}
                      color={attached.accentColor}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ))}

      {customSites.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={sectionHeader}>Custom sites</div>
          {customSites.map((s) => (
            <div key={s.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '3px 2px', gap: 10 }}>
              <span style={{ ...rowLabel, display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                <span style={{ width: 8, height: 8, borderRadius: 3, background: s.color, flexShrink: 0 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.label}</span>
                {!s.hasRooms && (
                  <span style={{
                    fontSize: 7.5, fontFamily: tok.mono, fontWeight: 800, color: tok.textDim,
                    border: tok.hairline, borderRadius: 3, padding: '0 3px', letterSpacing: 0.2,
                  }}>single</span>
                )}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {s.hasRooms && (
                  <Stepper value={s.rooms} onChange={(v) => onChangeCustomRooms(s.key, v)} min={0} max={12} color={s.color} />
                )}
                <button
                  onClick={() => onRemoveCustomSite(s.key)}
                  title="Remove site"
                  aria-label={`Remove ${s.label}`}
                  style={{
                    width: 18, height: 18, borderRadius: 5, lineHeight: 1, fontSize: 12, fontWeight: 800,
                    background: 'transparent', color: '#dc2626', border: '0.5px solid #dc262655',
                    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                  }}
                >×</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <button
        onClick={onAddSiteClick}
        style={{
          marginTop: 12, width: '100%', padding: '6px 8px', borderRadius: tok.radiusSm,
          background: 'transparent', color: tok.accent, cursor: 'pointer',
          border: `1px dashed color-mix(in srgb, ${tok.accent} 45%, var(--border))`,
          fontSize: 11, fontWeight: 750, fontFamily: tok.mono, letterSpacing: 0.2,
        }}
      >+ Add site</button>
    </Card>
  );
}

// Compact pill toggle for the inline "Cross cover" intent beside an intermittent
// site's stepper. Distinct from the ON/OFF ToggleBtn used for plain options.
function CrossCoverToggle({ label, on, onClick, color, title }: {
  label: string; on: boolean; onClick: () => void; color?: string; title?: string;
}) {
  const c = color || tok.crossSite;
  return (
    <button
      onClick={onClick}
      title={title || 'Cross cover — absorb with floats / flexible staff before adding dedicated coverage'}
      aria-pressed={on}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 3, whiteSpace: 'nowrap',
        padding: '2px 7px', borderRadius: 999, fontSize: 8.5, fontWeight: 800, cursor: 'pointer',
        fontFamily: tok.mono, letterSpacing: 0.2,
        background: on ? `color-mix(in srgb, ${c} 16%, transparent)` : 'transparent',
        border: `1px solid ${on ? c : tok.border}`,
        color: on ? c : tok.textMuted,
      }}
    >
      <span style={{ fontSize: 9, lineHeight: 1 }}>⇄</span>{label}
    </button>
  );
}

function modalBtnStyle(kind: 'neutral' | 'confirm'): React.CSSProperties {
  const color = kind === 'confirm' ? tok.accent : tok.textMuted;
  return {
    padding: '5px 9px',
    borderRadius: 6,
    background: kind === 'confirm' ? `color-mix(in srgb, ${tok.accent} 12%, transparent)` : 'var(--bg-deep)',
    border: `1px solid ${kind === 'neutral' ? tok.border : `color-mix(in srgb, ${color} 40%, transparent)`}`,
    color,
    cursor: 'pointer',
    fontSize: 10,
    fontWeight: 800,
    fontFamily: tok.mono,
  };
}

function AddSiteModal({ onAdd, onCancel }: {
  onAdd: (input: { name: string; hasRooms: boolean; rooms: number }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [hasRooms, setHasRooms] = useState(true);
  const [rooms, setRooms] = useState(2);
  const canAdd = name.trim().length > 0;
  const submit = () => { if (canAdd) onAdd({ name, hasRooms, rooms }); };

  const fieldLabel: React.CSSProperties = {
    fontSize: 10, fontFamily: tok.mono, fontWeight: 800, color: tok.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.4, marginTop: 13, marginBottom: 5,
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.18)', zIndex: 50,
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 120,
    }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 360, borderRadius: 12, background: tok.card,
          border: `1px solid color-mix(in srgb, ${tok.accent} 33%, transparent)`,
          boxShadow: '0 18px 50px -28px rgba(15,23,42,0.55), 0 0 0 1px rgba(255,255,255,0.8) inset',
          padding: 16,
        }}
      >
        <div style={{ color: tok.accent, fontSize: 10, fontFamily: tok.mono, fontWeight: 850, letterSpacing: 0.4, textTransform: 'uppercase' }}>
          New site
        </div>
        <div style={{ marginTop: 6, color: tok.text, fontSize: 15, fontWeight: 780, lineHeight: 1.3 }}>
          Add a site to this facility
        </div>

        <div style={fieldLabel}>Site name</div>
        <input
          value={name}
          autoFocus
          placeholder="e.g. Pre-op, MRI, Off-site OR"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onCancel(); }}
          style={{
            width: '100%', boxSizing: 'border-box', padding: '7px 9px', borderRadius: tok.radiusSm,
            border: tok.hairline, background: 'var(--bg-deep)', color: tok.text, fontSize: 13,
            outline: 'none',
          }}
        />

        <div style={fieldLabel}>Multiple rooms?</div>
        <div style={{ display: 'flex', gap: 6 }}>
          <SegBtn active={hasRooms} onClick={() => setHasRooms(true)}>Yes — room based</SegBtn>
          <SegBtn active={!hasRooms} onClick={() => setHasRooms(false)}>No — single site</SegBtn>
        </div>

        {hasRooms && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 13 }}>
            <span style={{ fontSize: 12, color: tok.text, fontWeight: 500 }}>Initial rooms</span>
            <Stepper value={rooms} onChange={setRooms} min={1} max={12} color={tok.accent} />
          </div>
        )}

        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', gap: 7 }}>
          <button onClick={onCancel} style={modalBtnStyle('neutral')}>Cancel</button>
          <button
            onClick={submit}
            disabled={!canAdd}
            style={{ ...modalBtnStyle('confirm'), opacity: canAdd ? 1 : 0.45, cursor: canAdd ? 'pointer' : 'not-allowed' }}
          >Add site</button>
        </div>
      </div>
    </div>
  );
}

function SegBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1, padding: '6px 8px', borderRadius: tok.radiusSm, cursor: 'pointer',
        fontSize: 11, fontWeight: 700, fontFamily: tok.mono,
        background: active ? `color-mix(in srgb, ${tok.accent} 12%, transparent)` : 'var(--bg-deep)',
        border: `1px solid ${active ? tok.accent : tok.border}`,
        color: active ? tok.accent : tok.textMuted,
      }}
    >{children}</button>
  );
}

function AvailableStaffPanel({ avail, setAvail, disabled }: {
  avail: AvailableStaff;
  setAvail: (a: AvailableStaff) => void;
  disabled?: boolean;
}) {
  return (
    <Card style={{ opacity: disabled ? 0.5 : 1 }}>
      <SectionTitle>👥 Available staff</SectionTitle>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '3px 2px', marginTop: 2 }}>
        <span style={{ fontSize: 12, color: tok.text, fontWeight: 500 }}>MDs available</span>
        <Stepper value={avail.mds} onChange={(v) => setAvail({ ...avail, mds: v })} min={0} max={30} color={tok.md.fg} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '3px 2px' }}>
        <span style={{ fontSize: 12, color: tok.text, fontWeight: 500 }}>CRNAs available</span>
        <Stepper value={avail.crnas} onChange={(v) => setAvail({ ...avail, crnas: v })} min={0} max={30} color={tok.crna.fg} />
      </div>
    </Card>
  );
}

function Stepper({ value, onChange, min, max, color }: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  color?: string;
}) {
  const c = color || '#0ea5e9';
  const btn: React.CSSProperties = {
    width: 22, height: 22, borderRadius: 6, border: `1px solid color-mix(in srgb, ${c} 45%, var(--border))`,
    background: `color-mix(in srgb, ${c} 7%, transparent)`, color: c, fontSize: 13, cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1, fontWeight: 600,
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <button
        aria-label="decrease"
        onClick={() => onChange(Math.max(min, value - 1))}
        disabled={value <= min}
        style={{ ...btn, opacity: value <= min ? 0.35 : 1 }}
      >−</button>
      <span style={{
        color: tok.text, fontSize: 13, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
        minWidth: 18, textAlign: 'center',
      }}>{value}</span>
      <button
        aria-label="increase"
        onClick={() => onChange(Math.min(max, value + 1))}
        disabled={value >= max}
        style={{ ...btn, opacity: value >= max ? 0.35 : 1 }}
      >+</button>
    </div>
  );
}

function ToggleBtn({ on, onClick, color }: { on: boolean; onClick: () => void; color?: string }) {
  const c = color || '#0ea5e9';
  return (
    <button
      onClick={onClick}
      style={{
        padding: '2px 8px', borderRadius: 4, fontSize: 9, fontWeight: 700, cursor: 'pointer', fontFamily: tok.mono,
        background: on ? `${c}25` : 'transparent',
        border: `0.5px solid ${on ? c : tok.border}`,
        color: on ? c : tok.textMuted,
      }}
    >
      {on ? 'ON' : 'OFF'}
    </button>
  );
}

/* ── Output: totals ─────────────────────────────────────────────────────── */

function TotalsPanel({ out, avail }: { out: CalculatorOutput; avail: AvailableStaff }) {
  const mdGap = out.totalMDs - avail.mds;
  const crnaGap = out.totalCRNAs - avail.crnas;
  return (
    <Card>
      <SectionTitle>🎯 Staffing needs</SectionTitle>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginTop: 6 }}>
        <BigStat label="MDs needed" value={out.totalMDs} fg={tok.md.fg} bg={tok.md.bg} bd={tok.md.bd} subtitle={gapLine(mdGap)} subtitleColor={mdGap > 0 ? 'var(--danger)' : 'var(--ok)'} />
        <BigStat label="CRNAs needed" value={out.totalCRNAs} fg={tok.crna.fg} bg={tok.crna.bg} bd={tok.crna.bd} subtitle={gapLine(crnaGap)} subtitleColor={crnaGap > 0 ? 'var(--danger)' : 'var(--ok)'} />
        <BigStat label="Total staff" value={out.totalStaff} fg="var(--text)" bg="var(--bg-deep)" bd="var(--border)" subtitle={`avail ${avail.mds + avail.crnas}`} subtitleColor={tok.textDim} />
      </div>
    </Card>
  );
}

function gapLine(gap: number): string {
  if (gap === 0) return 'matches available';
  if (gap > 0) return `short by ${gap}`;
  return `surplus of ${-gap}`;
}

function BigStat({ label, value, fg, bg, bd, subtitle, subtitleColor }: {
  label: string; value: number; fg: string; bg: string; bd: string;
  subtitle: string; subtitleColor: string;
}) {
  return (
    <div style={{
      padding: '12px 12px 11px', borderRadius: tok.radiusSm,
      background: bg, border: `1px solid ${bd}`,
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <div style={{
        fontSize: 9.5, color: fg, opacity: 0.8,
        textTransform: 'uppercase', letterSpacing: 0.6, fontWeight: 700,
      }}>{label}</div>
      <div style={{ fontSize: 34, fontWeight: 800, color: fg, lineHeight: 0.95, letterSpacing: -1.2, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
      <div style={{
        fontSize: 10, color: subtitleColor, fontWeight: 600,
        background: `color-mix(in srgb, ${subtitleColor} 12%, transparent)`,
        alignSelf: 'flex-start', padding: '2px 8px', borderRadius: 999,
      }}>
        {subtitle}
      </div>
    </div>
  );
}

/* ── Staffing diagram (site lanes + MD blocks + CRNA chips) ─────────────── */

// Pure function — reassigns a CRNA to a different supervising MD.
// By default (`keepSite: false`) the CRNA also moves to the new MD's site,
// which is the natural behavior for "this MD is taking over this room."
// Pass `keepSite: true` to set up cross-site supervision — same MD, but
// the CRNA stays where they are. We use this for cases like a Main OR
// supervising MD also covering a CRNA in EP Lab without leaving Main OR.
function reassignCRNAInResult(
  prev: CalculatorOutput,
  crnaId: string,
  mdId: string,
  opts?: { keepSite?: boolean },
): CalculatorOutput {
  const next = prev.assignments.map((a) => ({ ...a, supervises: [...(a.supervises || [])] }));
  const c = next.find((a) => a.id === crnaId);
  const newMd = next.find((a) => a.id === mdId);
  if (!c || !newMd) return prev;
  const oldMd = next.find((a) => a.id === c.supervisedBy);
  if (oldMd) oldMd.supervises = (oldMd.supervises || []).filter((id) => id !== crnaId);
  c.supervisedBy = mdId;
  if (!opts?.keepSite) c.site = newMd.site;
  newMd.supervises = newMd.supervises || [];
  if (!newMd.supervises.includes(crnaId)) newMd.supervises.push(crnaId);
  newMd.isSolo = false;
  return computeTotals({ ...prev, assignments: next });
}

function moveMDInResult(prev: CalculatorOutput, mdId: string, newSite: string): CalculatorOutput {
  const next = prev.assignments.map((a) => ({ ...a, supervises: [...(a.supervises || [])] }));
  const md = next.find((a) => a.id === mdId);
  if (md) md.site = newSite;
  return computeTotals({ ...prev, assignments: next });
}

// Delete an assignment. If the deleted person is an MD, every CRNA they
// supervised becomes unsupervised (`supervisedBy = null`) but stays in the
// same site so the user can drag them somewhere else or delete them. If the
// deleted person is a CRNA, the supervising MD's `supervises` array is
// cleaned up so totals and supervision counts stay accurate.
function deleteAssignmentInResult(prev: CalculatorOutput, id: string): CalculatorOutput {
  const target = prev.assignments.find((a) => a.id === id);
  if (!target) return prev;
  const next = prev.assignments
    .filter((a) => a.id !== id)
    .map((a) => ({ ...a, supervises: [...(a.supervises || [])] }));

  if (target.type === 'MD') {
    for (const a of next) {
      if (a.supervisedBy === id) a.supervisedBy = null;
    }
  } else {
    for (const a of next) {
      if (a.supervises) a.supervises = a.supervises.filter((sid) => sid !== id);
    }
  }
  // Also drop any contingencies referencing the deleted person.
  const contingencies = prev.contingencies.filter((c) => c.fromId !== id && c.toId !== id);
  return computeTotals({ ...prev, assignments: next, contingencies });
}

// Add a new MD to a given site. Generates a fresh id and a role label that
// reflects the requested kind. Cardiac MDs continue the existing `Cardiac N`
// series at the site so the numbering stays consistent with the algorithm.
function addMDInResult(
  prev: CalculatorOutput,
  site: string,
  opts: { isSolo: boolean; isCardiac?: boolean },
): CalculatorOutput {
  const id = `md-custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  let role: string;
  if (opts.isCardiac) {
    const nextNum = prev.assignments.filter((a) => a.isCardiac && a.site === site).length + 1;
    role = `Cardiac ${nextNum}`;
  } else {
    role = opts.isSolo ? 'Solo MD (added)' : 'Supv MD (added)';
  }
  const newMD: StaffAssignment = {
    id, type: 'MD', role, site, supervises: [],
    isSolo: opts.isSolo,
    ...(opts.isCardiac ? { isCardiac: true } : {}),
    notes: 'Manually added.',
  };
  const next = [
    ...prev.assignments.map((a) => ({ ...a, supervises: [...(a.supervises || [])] })),
    newMD,
  ];
  return computeTotals({ ...prev, assignments: next });
}

// Add a new CRNA to a site, unsupervised. The user drags it onto an MD to
// pair them up, or leaves it free (Float lanes show free CRNAs as a pool).
function addCRNAInResult(prev: CalculatorOutput, site: string): CalculatorOutput {
  const id = `crna-custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const next = [
    ...prev.assignments.map((a) => ({ ...a, supervises: [...(a.supervises || [])] })),
    { id, type: 'CRNA', role: 'CRNA (added)', site, supervisedBy: null, supervises: [], notes: 'Manually added.' } as StaffAssignment,
  ];
  return computeTotals({ ...prev, assignments: next });
}

// Helper — recompute totals after edits so the staffing-needs panel stays
// in sync (counts change when assignments are added or removed via the diagram).
function computeTotals(out: CalculatorOutput): CalculatorOutput {
  const totalMDs = out.assignments.filter((a) => a.type === 'MD').length;
  const totalCRNAs = out.assignments.filter((a) => a.type === 'CRNA').length;
  return { ...out, totalMDs, totalCRNAs, totalStaff: totalMDs + totalCRNAs };
}

function StaffingDiagram({ result, setResult, siteCatalog }: {
  result: CalculatorOutput;
  setResult: React.Dispatch<React.SetStateAction<CalculatorOutput | null>>;
  siteCatalog: SiteCatalogEntry[];
}) {
  const [selectedCRNA, setSelectedCRNA] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  // How cross-site supervision is shown: 'linked' = a secondary MD card in the
  // covered lane joined to the home card by a connecting line; 'compact' = the
  // original inline ghost row.
  const [crossMode, setCrossMode] = useState<'linked' | 'compact'>('linked');
  const lanesRef = useRef<HTMLDivElement>(null);

  const assignments = result.assignments;
  const mds = assignments.filter((a) => a.type === 'MD');
  const crnas = assignments.filter((a) => a.type === 'CRNA');

  // Build effective lane list — siteCatalog order, plus any extra sites the
  // algorithm produced that weren't pre-registered (e.g. a generic "Other").
  const catalogKeys = new Set(siteCatalog.map((s) => s.key));
  const extraSites = [...new Set(assignments.map((a) => a.site).filter((s) => !catalogKeys.has(s)))];
  const allLanes: SiteCatalogEntry[] = [
    ...siteCatalog,
    ...extraSites.map((k) => ({ key: k, label: k, color: '#6B7280', icon: '·' })),
  ];

  const lanes = allLanes.filter((s) =>
    // Custom sites (cs-…) always show a lane — even single-site / unstaffed —
    // so they remain reachable to add MDs/CRNAs. Built-in empty lanes stay hidden.
    s.key.startsWith('cs-') ||
    mds.some((m) => m.site === s.key) || crnas.some((c) => c.site === s.key),
  );

  // Connector links for 'linked' mode: each (MD, lane) pair where the MD lives
  // elsewhere but supervises ≥1 CRNA in this lane → a line from the home card
  // to the secondary card. `version` forces the SVG overlay to re-measure when
  // supervision/sites/lanes/selection change.
  const connectorLinks = crossMode === 'linked'
    ? lanes.flatMap((site) =>
        mds
          .filter((m) => m.site !== site.key && crnas.some((c) => c.site === site.key && c.supervisedBy === m.id))
          .map((m) => ({ mdId: m.id, laneKey: site.key })),
      )
    : [];
  const connectorVersion = crossMode + '|' + (selectedCRNA ?? '') + '|'
    + assignments.map((a) => `${a.id}:${a.site}:${a.supervisedBy ?? ''}`).join(',')
    + '|' + lanes.map((l) => l.key).join(',');

  // Track whether the current click/drop should be treated as cross-site
  // supervision — Shift held → keep CRNA at their current site, only swap
  // the supervising MD. The flag rides on the keyboard event for clicks and
  // on dataTransfer for drops (read out in the drop handler).
  const reassignCRNAToMD = (crnaId: string, mdId: string, keepSite = false) => {
    setResult((prev) => prev ? reassignCRNAInResult(prev, crnaId, mdId, { keepSite }) : prev);
  };
  const moveMDToSite = (mdId: string, newSite: string) => {
    setResult((prev) => prev ? moveMDInResult(prev, mdId, newSite) : prev);
  };
  const deleteAssignment = (id: string) => {
    setResult((prev) => prev ? deleteAssignmentInResult(prev, id) : prev);
    if (selectedCRNA === id) setSelectedCRNA(null);
  };
  const addMD = (site: string, opts: { isSolo: boolean; isCardiac?: boolean }) => {
    setResult((prev) => prev ? addMDInResult(prev, site, opts) : prev);
  };
  const addCRNA = (site: string) => {
    setResult((prev) => prev ? addCRNAInResult(prev, site) : prev);
  };

  // Click handlers — click CRNA to select, click MD to reassign that CRNA.
  // Shift-clicking the MD triggers cross-site supervision (CRNA keeps site).
  const onCRNAClick = (crna: StaffAssignment) =>
    setSelectedCRNA((prev) => (prev === crna.id ? null : crna.id));
  const onMDClick = (md: StaffAssignment, e?: React.MouseEvent) => {
    if (!selectedCRNA) return;
    reassignCRNAToMD(selectedCRNA, md.id, !!e?.shiftKey);
    setSelectedCRNA(null);
  };

  // Drag handlers — Shift held during drop → cross-site supervision.
  const onDragStartCRNA = (e: React.DragEvent, crna: StaffAssignment) => {
    e.dataTransfer.setData('crnaId', crna.id);
    e.dataTransfer.effectAllowed = 'move';
  };
  const onDragStartMD = (e: React.DragEvent, md: StaffAssignment) => {
    e.dataTransfer.setData('mdId', md.id);
    e.dataTransfer.effectAllowed = 'move';
  };
  const onDropOnMD = (e: React.DragEvent, md: StaffAssignment) => {
    e.preventDefault();
    setDropTarget(null);
    const crnaId = e.dataTransfer.getData('crnaId');
    if (crnaId) reassignCRNAToMD(crnaId, md.id, e.shiftKey);
  };
  const onDropOnLane = (e: React.DragEvent, siteKey: string) => {
    e.preventDefault();
    setDropTarget(null);
    const mdId = e.dataTransfer.getData('mdId');
    if (mdId) moveMDToSite(mdId, siteKey);
  };
  const onDragOver = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    setDropTarget(targetId);
  };
  const onDragLeave = () => setDropTarget(null);

  return (
    <Card>
      <SectionTitle>
        <span>🏥 By site — supervision map</span>
        <div style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ fontSize: 8.5, color: tok.textDim, fontFamily: tok.mono, fontWeight: 800, letterSpacing: 0.4 }}>CROSS-SITE</span>
          {([['linked', '⇄ Linked'], ['compact', 'Compact']] as const).map(([m, label]) => {
            const on = crossMode === m;
            return (
              <button
                key={m}
                onClick={() => setCrossMode(m)}
                aria-pressed={on}
                style={{
                  padding: '2px 8px', borderRadius: 999, fontSize: 9, fontWeight: 800, fontFamily: tok.mono, cursor: 'pointer',
                  background: on ? `color-mix(in srgb, ${tok.crossSite} 16%, transparent)` : 'transparent',
                  border: `1px solid ${on ? tok.crossSite : tok.border}`,
                  color: on ? tok.crossSite : tok.textMuted,
                }}
              >{label}</button>
            );
          })}
        </div>
      </SectionTitle>

      {selectedCRNA && (
        <div style={{
          background: 'rgba(14,165,233,0.10)', border: `0.5px solid ${tok.accent}`,
          borderRadius: 5, padding: '6px 12px', marginTop: 6, marginBottom: 8,
          color: tok.accent, fontSize: 11, fontWeight: 600,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span>🔄</span> CRNA selected — click any MD to reassign &nbsp;
          <span style={{ fontSize: 10, fontWeight: 500, opacity: 0.85 }}>
            (hold <kbd style={kbdStyle}>Shift</kbd> to keep CRNA at current site — cross-site supervision)
          </span>
          <button onClick={() => setSelectedCRNA(null)} style={{
            marginLeft: 'auto', background: 'transparent', border: `0.5px solid ${tok.accent}`,
            color: tok.accent, borderRadius: 3, padding: '1px 8px', cursor: 'pointer',
            fontSize: 10, fontFamily: tok.mono,
          }}>cancel</button>
        </div>
      )}

      <div ref={lanesRef} style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6, position: 'relative' }}>
        {crossMode === 'linked' && connectorLinks.length > 0 && (
          <CrossCoverConnectors containerRef={lanesRef} links={connectorLinks} version={connectorVersion} />
        )}
        {lanes.map((site) => {
          const siteMDs = mds.filter((m) => m.site === site.key);
          const siteCRNAs = crnas.filter((c) => c.site === site.key);
          const isFloatPool = site.key === 'Float';
          const displayCRNACount = siteCRNAs.length;
          const isLaneTarget = dropTarget === 'lane-' + site.key;

          return (
            <div
              key={site.key}
              onDrop={(e) => onDropOnLane(e, site.key)}
              onDragOver={(e) => onDragOver(e, 'lane-' + site.key)}
              onDragLeave={onDragLeave}
              style={{
                display: 'flex',
                borderRadius: 5,
                overflow: 'hidden',
                background: isLaneTarget ? `${site.color}15` : 'transparent',
                border: isLaneTarget ? `0.5px dashed ${site.color}` : `0.5px solid transparent`,
                transition: 'all 0.15s',
              }}
            >
              {/* Lane label column */}
              <div style={{
                width: 130, flexShrink: 0, padding: '8px 8px 8px 0',
                borderLeft: `2px solid ${site.color}`,
                display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2,
                paddingLeft: 8,
              }}>
                {site.icon && <span style={{ fontSize: 12 }}>{site.icon}</span>}
                <span style={{ color: site.color, fontSize: 10, fontWeight: 700, lineHeight: 1.2 }}>
                  {site.label}
                </span>
                <span style={{ color: tok.textDim, fontSize: 9, fontFamily: tok.mono }}>
                  {siteMDs.length > 0 && `${siteMDs.length}MD`}
                  {siteMDs.length > 0 && displayCRNACount > 0 && ' · '}
                  {displayCRNACount > 0 && `${displayCRNACount}CRNA`}
                </span>
              </div>

              {/* Vertical divider */}
              <div style={{ width: 1, background: tok.border, margin: '6px 0', flexShrink: 0 }} />

              {/* Lane content */}
              <div style={{ flex: 1, padding: '4px 10px', minWidth: 0 }}>
                <div style={{ width: '100%' }}>
                  {siteMDs.map((md) => (
                    <MDBlock
                      key={md.id + site.key}
                      md={md}
                      crnas={crnas}
                      selectedCRNA={selectedCRNA}
                      dropTarget={dropTarget}
                      onMDClick={onMDClick}
                      onCRNAClick={onCRNAClick}
                      onDragStartMD={onDragStartMD}
                      onDragStartCRNA={onDragStartCRNA}
                      onDropOnMD={onDropOnMD}
                      onDragOver={onDragOver}
                      onDragLeave={onDragLeave}
                      onDelete={deleteAssignment}
                      siteCatalog={allLanes}
                      showCrossSiteCRNAs={crossMode === 'compact'}
                      dataNode={'home-' + md.id}
                    />
                  ))}

                  {/* Linked mode: secondary (ghost) cards for MDs whose home
                      lane is elsewhere but who cover a CRNA here — joined to the
                      home card by the SVG connector line above. */}
                  {crossMode === 'linked' && mds
                    .filter((m) => m.site !== site.key && siteCRNAs.some((c) => c.supervisedBy === m.id))
                    .map((m) => (
                      <SecondaryMDCard
                        key={'sec-' + m.id + '-' + site.key}
                        md={m}
                        crnas={siteCRNAs.filter((c) => c.supervisedBy === m.id)}
                        homeSite={allLanes.find((s) => s.key === m.site) || { key: m.site, label: m.site, color: '#6B7280' }}
                        selectedCRNA={selectedCRNA}
                        onMDClick={onMDClick}
                        onCRNAClick={onCRNAClick}
                        onDragStartCRNA={onDragStartCRNA}
                        onDelete={deleteAssignment}
                        dataNode={'remote-' + m.id + '-' + site.key}
                      />
                    ))}

                  {/* Free CRNAs (no supervisor) sitting at this site — happens
                      either in the Float pool or after deleting an MD whose
                      CRNAs got orphaned. Always render them so they're
                      reachable for re-routing or deletion. */}
                  {(() => {
                    const freeCRNAs = siteCRNAs.filter((c) => !c.supervisedBy);
                    return freeCRNAs.length > 0 ? (
                      <FloatPoolRow
                        crnas={freeCRNAs}
                        selectedCRNA={selectedCRNA}
                        onCRNAClick={onCRNAClick}
                        onDragStartCRNA={onDragStartCRNA}
                        onDelete={deleteAssignment}
                        label={isFloatPool ? '(schedule runner assigns)' : '(unassigned — drop on an MD)'}
                      />
                    ) : null;
                  })()}

                  {/* Compact mode: inline ghost row noting that a CRNA here is
                      supervised by an MD in another lane. (Linked mode renders
                      a secondary MD card above instead.) */}
                  {crossMode === 'compact' && (() => {
                    const remote = siteCRNAs.filter((c) => {
                      if (!c.supervisedBy) return false;
                      const sup = mds.find((m) => m.id === c.supervisedBy);
                      return sup && sup.site !== site.key;
                    });
                    return remote.length > 0 ? (
                      <RemoteCoverageRow
                        crnas={remote}
                        mds={mds}
                        siteCatalog={allLanes}
                      />
                    ) : null;
                  })()}

                  {/* Per-lane add controls — change ratios in place without
                      having to reset the whole calculator. */}
                  <LaneAddControls
                    onAddSupv={() => addMD(site.key, { isSolo: false })}
                    onAddSolo={() => addMD(site.key, { isSolo: true })}
                    onAddCardiac={
                      site.key === 'Cardiac'
                        ? () => addMD(site.key, { isSolo: true, isCardiac: true })
                        : undefined
                    }
                    onAddCRNA={() => addCRNA(site.key)}
                    laneColor={site.color}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{
        marginTop: 10, padding: '6px 10px', borderRadius: 5,
        background: tok.surface, border: tok.hairline,
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        fontSize: 9, color: tok.textDim, fontFamily: tok.mono,
      }}>
        <span style={{ fontWeight: 700, color: tok.textMuted }}>LEGEND</span>
        <LegendDot color="#4A90D9" label="Supervising MD" shape="square" />
        <LegendDot color="#B06AE8" label="Solo MD" shape="square" />
        <LegendDot color="#E05599" label="Cardiac" shape="square" />
        <LegendDot color="#FFD54F" label="8101" shape="square" />
        <LegendDot color={tok.crna.fg} label="CRNA" shape="round" />
        <LegendDot color={tok.warning} label="Add-On" shape="round" dashed />
        <span style={{ marginLeft: 'auto', color: tok.textMuted }}>
          💡 click CRNA → click MD · drag CRNA onto MD · drag MD to lane · <kbd style={kbdStyle}>shift</kbd>+drop = cross-site
        </span>
      </div>
    </Card>
  );
}

const kbdStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono), ui-monospace, monospace',
  fontSize: 9, padding: '1px 4px', borderRadius: 3,
  background: 'var(--bg-deep)', border: '0.5px solid var(--border)',
  color: 'var(--text)',
};

function LegendDot({ color, label, shape, dashed }: { color: string; label: string; shape: 'round' | 'square'; dashed?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={{
        width: shape === 'round' ? 8 : 12, height: shape === 'round' ? 8 : 10,
        borderRadius: shape === 'round' ? 4 : 3,
        border: `1.5px ${dashed ? 'dashed' : 'solid'} ${color}`,
        background: 'transparent', flexShrink: 0,
      }} />
      <span>{label}</span>
    </span>
  );
}

function FloatPoolRow({ crnas, selectedCRNA, onCRNAClick, onDragStartCRNA, onDelete, label }: {
  crnas: StaffAssignment[];
  selectedCRNA: string | null;
  onCRNAClick: (c: StaffAssignment) => void;
  onDragStartCRNA: (e: React.DragEvent, c: StaffAssignment) => void;
  onDelete?: (id: string) => void;
  label?: string;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: '6px 0' }}>
      {crnas.map((c) => (
        <CRNAChip
          key={c.id}
          crna={c}
          selected={selectedCRNA === c.id}
          onClick={() => onCRNAClick(c)}
          onDragStart={(e) => onDragStartCRNA(e, c)}
          onDelete={onDelete}
        />
      ))}
      {crnas.length > 0 && label && (
        <span style={{ color: tok.textDim, fontSize: 9, fontStyle: 'italic' }}>
          {label}
        </span>
      )}
    </div>
  );
}

// Ghost row shown in a lane when a CRNA at this site is being supervised by
// an MD in a different lane. Non-interactive — the active rendering lives
// under the MD. Just makes the lane reflect what's actually here.
function RemoteCoverageRow({ crnas, mds, siteCatalog }: {
  crnas: StaffAssignment[];
  mds: StaffAssignment[];
  siteCatalog: SiteCatalogEntry[];
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: '5px 0', borderTop: `1px dashed color-mix(in srgb, ${tok.crossSite} 33%, transparent)`, marginTop: 4 }}>
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 3,
        fontSize: 9.5, color: tok.crossSite, fontFamily: tok.mono, fontWeight: 900,
        letterSpacing: 0.5, textTransform: 'uppercase',
        background: `color-mix(in srgb, ${tok.crossSite} 13%, transparent)`,
        border: `1px solid color-mix(in srgb, ${tok.crossSite} 40%, transparent)`, borderRadius: 4, padding: '1px 6px',
      }}>
        <span style={{ fontSize: 11 }}>⇄</span> Cross-site
      </span>
      {crnas.map((c) => {
        const sup = mds.find((m) => m.id === c.supervisedBy);
        const supSite = sup ? siteCatalog.find((s) => s.key === sup.site) : null;
        return (
          <span key={'remote-' + c.id} style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '2px 8px', borderRadius: 999,
            background: 'transparent',
            border: `1px solid ${supSite?.color ?? tok.textDim}`,
            fontSize: 10, color: tok.textMuted,
          }}>
            <span style={{ fontWeight: 700, color: tok.text }}>{c.role}</span>
            <span style={{ color: tok.crossSite, fontWeight: 800 }}>←</span>
            <span style={{ color: supSite?.color ?? tok.textDim, fontWeight: 800 }}>{sup?.role ?? 'unknown'}</span>
            {supSite && <span style={{ fontFamily: tok.mono, fontSize: 8.5, color: supSite.color, fontWeight: 700 }}>({supSite.label.split(/[(–—]/)[0].trim()})</span>}
          </span>
        );
      })}
    </div>
  );
}

// Per-lane add row — small ghost buttons for spinning up extra MDs and CRNAs
// without wiping the algorithm's output. Lives inside each lane below the MDs.
function LaneAddControls({ onAddSupv, onAddSolo, onAddCardiac, onAddCRNA, laneColor }: {
  onAddSupv: () => void;
  onAddSolo: () => void;
  // Only set on the Cardiac lane — when present, it takes the slot the
  // Supv MD button would otherwise occupy (cardiac MDs are always solo).
  onAddCardiac?: () => void;
  onAddCRNA: () => void;
  laneColor: string;
}) {
  const btn = (label: string, onClick: () => void, color: string): React.CSSProperties => ({
    padding: '2px 8px', borderRadius: 4, fontSize: 9, fontWeight: 700, cursor: 'pointer',
    background: 'transparent', color, border: `0.5px dashed ${color}`,
    fontFamily: tok.mono, letterSpacing: 0.3,
  });
  return (
    <div style={{ display: 'flex', gap: 5, padding: '4px 0 2px', flexWrap: 'wrap' }}>
      {onAddCardiac ? (
        <button onClick={onAddCardiac} style={btn('+ Cardiac MD', onAddCardiac, '#E05599')}>+ Cardiac MD</button>
      ) : (
        <button onClick={onAddSupv} style={btn('+ Supv MD', onAddSupv, '#4A90D9')}>+ Supv MD</button>
      )}
      <button onClick={onAddSolo} style={btn('+ Solo MD', onAddSolo, '#B06AE8')}>+ Solo MD</button>
      <button onClick={onAddCRNA} style={btn('+ CRNA', onAddCRNA, tok.crna.fg)}>+ CRNA</button>
      <span style={{ marginLeft: 4, color: tok.textDim, fontSize: 9, alignSelf: 'center' }}>
        in <span style={{ color: laneColor, fontWeight: 700 }}>this lane</span>
      </span>
    </div>
  );
}

function MDBlock({ md, crnas, selectedCRNA, dropTarget, onMDClick, onCRNAClick, onDragStartMD, onDragStartCRNA, onDropOnMD, onDragOver, onDragLeave, onDelete, siteCatalog, showCrossSiteCRNAs = true, dataNode }: {
  md: StaffAssignment;
  crnas: StaffAssignment[];
  selectedCRNA: string | null;
  dropTarget: string | null;
  onMDClick: (md: StaffAssignment, e?: React.MouseEvent) => void;
  onCRNAClick: (c: StaffAssignment) => void;
  onDragStartMD: (e: React.DragEvent, md: StaffAssignment) => void;
  onDragStartCRNA: (e: React.DragEvent, c: StaffAssignment) => void;
  onDropOnMD: (e: React.DragEvent, md: StaffAssignment) => void;
  onDragOver: (e: React.DragEvent, targetId: string) => void;
  onDragLeave: () => void;
  onDelete: (id: string) => void;
  siteCatalog: SiteCatalogEntry[];
  // When false (linked mode), CRNAs supervised across sites are shown in their
  // own lane's secondary card instead of here; the home card shows a small
  // cross-cover tag pointing to those lanes.
  showCrossSiteCRNAs?: boolean;
  dataNode?: string;
}) {
  const [hov, setHov] = useState(false);
  const isSolo = md.isSolo;
  // Pick an outline color that says what KIND of MD this is
  const borderCol = isSolo
    ? (md.isCardiac ? '#E05599' : md.is8101 ? '#FFD54F' : md.isFloat ? '#80CBC4' : md.isFloorRunner ? '#00D4AA' : '#B06AE8')
    : (md.is8101 ? '#FFD54F' : md.isFloorRunner ? '#00D4AA' : '#4A90D9');

  const canAccept = !!selectedCRNA;
  const isHovered = dropTarget === md.id;

  const myCRNAs = crnas.filter((c) => c.supervisedBy === md.id);
  // In linked mode the cross-site CRNAs render under their own lane's secondary
  // card, so the home card shows only same-site CRNAs plus a "⇄ Lane" tag.
  const crossLanes = [...new Set(myCRNAs.filter((c) => c.site !== md.site).map((c) => c.site))];
  const shownCRNAs = showCrossSiteCRNAs ? myCRNAs : myCRNAs.filter((c) => c.site === md.site);

  return (
    <div
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      draggable
      onDragStart={(e) => onDragStartMD(e, md)}
      onDrop={(e) => onDropOnMD(e, md)}
      onDragOver={(e) => onDragOver(e, md.id)}
      onDragLeave={onDragLeave}
      onClick={(e) => onMDClick(md, e)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 0',
        cursor: selectedCRNA ? 'pointer' : 'grab',
      }}
    >
      <div data-ccnode={dataNode} style={{
        display: 'flex', alignItems: 'center', gap: 7,
        padding: '5px 9px', borderRadius: 6,
        background: (canAccept || isHovered) ? 'rgba(16,185,129,0.10)' : tok.surface,
        border: `1.5px solid ${(canAccept || isHovered) ? '#16a34a' : borderCol}`,
        minWidth: 110, flexShrink: 0, transition: 'all 0.15s',
        position: 'relative',
      }}>
        {/* Delete × — appears on hover, top-right of the block. Stops propagation
            so the click doesn't trigger the reassign-CRNA-to-this-MD branch. */}
        {hov && (
          <button
            title="Delete this MD"
            onClick={(e) => { e.stopPropagation(); onDelete(md.id); }}
            style={{
              position: 'absolute', top: -7, right: -7,
              width: 16, height: 16, borderRadius: '50%',
              background: tok.card, color: '#dc2626',
              border: '0.5px solid #dc2626',
              fontSize: 11, lineHeight: 1, padding: 0, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontWeight: 800, zIndex: 5,
            }}
          >×</button>
        )}
        <div style={{
          width: 22, height: 22, borderRadius: 5,
          background: borderCol + '20', border: `1.5px solid ${borderCol}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <span style={{ color: borderCol, fontSize: 8, fontWeight: 800, fontFamily: tok.mono }}>MD</span>
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: tok.text, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {md.role}
          </div>
          <div style={{ display: 'flex', gap: 3, alignItems: 'center', marginTop: 1, flexWrap: 'wrap' }}>
            {isSolo && <Badge color={borderCol} text="SOLO" />}
            {md.is8101 && <Badge color="#FFD54F" text="8101" dark />}
            {md.isFloorRunner && <Badge color="#00D4AA" text="FR" dark />}
            {myCRNAs.length > 0 && (
              <span style={{ color: tok.textDim, fontSize: 9, fontFamily: tok.mono }}>
                {myCRNAs.length}c
              </span>
            )}
            {!showCrossSiteCRNAs && crossLanes.map((laneKey) => {
              const ls = siteCatalog.find((s) => s.key === laneKey);
              return (
                <span key={'xtag-' + laneKey} title={`Cross-covers ${ls?.label ?? laneKey}`} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 2,
                  fontSize: 8, fontFamily: tok.mono, fontWeight: 850, color: tok.crossSite,
                  border: `1px solid color-mix(in srgb, ${tok.crossSite} 40%, transparent)`, borderRadius: 3, padding: '0 3px',
                }}>⇄ {ls ? shortLabel(ls) : laneKey}</span>
              );
            })}
          </div>
        </div>
      </div>
      {shownCRNAs.length > 0 && (
        <span style={{ color: borderCol, fontSize: 11, opacity: 0.5 }}>›</span>
      )}
      {shownCRNAs.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, minWidth: 0 }}>
          {shownCRNAs.map((c) => {
            // Cross-site supervision = CRNA's site doesn't match the MD's
            // own site. Pass the catalog entry through so the badge can use
            // the destination site's color.
            const crossSite = c.site !== md.site
              ? siteCatalog.find((s) => s.key === c.site) || null
              : null;
            return (
              <CRNAChip
                key={c.id}
                crna={c}
                selected={selectedCRNA === c.id}
                onClick={() => onCRNAClick(c)}
                onDragStart={(e) => onDragStartCRNA(e, c)}
                onDelete={onDelete}
                crossSite={crossSite}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// Linked-mode "ghost" projection of a supervising MD into a lane that isn't
// their home — shown next to the CRNA(s) they cover here, joined to the real
// card by the connector line. Non-draggable (the home card is the real one);
// clicking it still reassigns a selected CRNA, and its CRNA chips stay live.
function SecondaryMDCard({ md, crnas, homeSite, selectedCRNA, onMDClick, onCRNAClick, onDragStartCRNA, onDelete, dataNode }: {
  md: StaffAssignment;
  crnas: StaffAssignment[];
  homeSite: SiteCatalogEntry;
  selectedCRNA: string | null;
  onMDClick: (md: StaffAssignment, e?: React.MouseEvent) => void;
  onCRNAClick: (c: StaffAssignment) => void;
  onDragStartCRNA: (e: React.DragEvent, c: StaffAssignment) => void;
  onDelete: (id: string) => void;
  dataNode: string;
}) {
  const tone = tok.crossSite;
  return (
    <div
      onClick={(e) => onMDClick(md, e)}
      title={`${md.role} — home lane: ${homeSite.label}`}
      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', cursor: selectedCRNA ? 'pointer' : 'default' }}
    >
      <div data-ccnode={dataNode} style={{
        display: 'flex', alignItems: 'center', gap: 7,
        padding: '5px 9px', borderRadius: 6,
        background: selectedCRNA ? 'rgba(16,185,129,0.10)' : 'rgba(249,115,22,0.07)',
        border: `1.5px dashed ${selectedCRNA ? '#16a34a' : tone}`,
        minWidth: 110, flexShrink: 0, position: 'relative',
      }}>
        <div style={{
          width: 22, height: 22, borderRadius: 5,
          background: `color-mix(in srgb, ${tone} 12%, transparent)`, border: `1.5px solid ${tone}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <span style={{ color: tone, fontSize: 8, fontWeight: 800, fontFamily: tok.mono }}>MD</span>
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: tok.text, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {md.role}
          </div>
          <div style={{ display: 'flex', gap: 3, alignItems: 'center', marginTop: 1 }}>
            <Badge color={tone} text="XCOV" />
            <span style={{ color: tone, fontSize: 8.5, fontFamily: tok.mono, fontWeight: 800 }}>↑ {shortLabel(homeSite)}</span>
          </div>
        </div>
      </div>
      {crnas.length > 0 && <span style={{ color: tone, fontSize: 11, opacity: 0.6 }}>›</span>}
      {crnas.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, minWidth: 0 }}>
          {crnas.map((c) => (
            <CRNAChip
              key={c.id}
              crna={c}
              selected={selectedCRNA === c.id}
              onClick={() => onCRNAClick(c)}
              onDragStart={(e) => onDragStartCRNA(e, c)}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// SVG overlay that draws a connecting line between each supervising MD's home
// card and its secondary card in a cross-covered lane. Measures live DOM
// positions (re-measuring on `version` change + container resize) so the lines
// track the cards. Bows left into the gutter so it doesn't cross other cards.
function CrossCoverConnectors({ containerRef, links, version }: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  links: { mdId: string; laneKey: string }[];
  version: string;
}) {
  const [segs, setSegs] = useState<{ id: string; d: string; x1: number; y1: number; x2: number; y2: number }[]>([]);
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const cr = el.getBoundingClientRect();
      const next: { id: string; d: string; x1: number; y1: number; x2: number; y2: number }[] = [];
      links.forEach((lk, i) => {
        const home = el.querySelector(`[data-ccnode="home-${lk.mdId}"]`) as HTMLElement | null;
        const rem = el.querySelector(`[data-ccnode="remote-${lk.mdId}-${lk.laneKey}"]`) as HTMLElement | null;
        if (!home || !rem) return;
        const hr = home.getBoundingClientRect();
        const rr = rem.getBoundingClientRect();
        const x1 = hr.left - cr.left;
        const y1 = hr.top - cr.top + hr.height / 2;
        const x2 = rr.left - cr.left;
        const y2 = rr.top - cr.top + rr.height / 2;
        const k = 16 + i * 12; // bow depth into the gutter, staggered per link
        const d = `M ${x1} ${y1} C ${x1 - k} ${y1}, ${x2 - k} ${y2}, ${x2} ${y2}`;
        next.push({ id: `${lk.mdId}-${lk.laneKey}`, d, x1, y1, x2, y2 });
      });
      setSegs(next);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
    // `version` encodes the supervision/lane/selection state; depending on it
    // (not the freshly-built `links` array) avoids a measure→setState render loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef, version]);

  if (segs.length === 0) return null;
  return (
    <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible', zIndex: 3 }}>
      {segs.map((s) => (
        <g key={s.id}>
          <path d={s.d} fill="none" stroke={tok.crossSite} strokeWidth={2} strokeLinecap="round" strokeDasharray="5 4" opacity={0.9} />
          <circle cx={s.x1} cy={s.y1} r={3.5} fill={tok.crossSite} />
          <circle cx={s.x2} cy={s.y2} r={3.5} fill={tok.crossSite} />
        </g>
      ))}
    </svg>
  );
}

function Badge({ color, text, dark }: { color: string; text: string; dark?: boolean }) {
  return (
    <span style={{
      background: color, color: dark ? '#1a1a1a' : '#fff',
      fontSize: 7, fontWeight: 800, padding: '1px 4px', borderRadius: 2,
      letterSpacing: 0.3, fontFamily: tok.mono,
    }}>{text}</span>
  );
}

function CRNAChip({ crna, selected, onClick, onDragStart, onDelete, crossSite }: {
  crna: StaffAssignment;
  selected: boolean;
  onClick: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDelete?: (id: string) => void;
  // When set, the chip renders a small "@SiteName" badge using this lane's
  // accent color. Indicates the room is elsewhere — supervision crosses sites.
  crossSite?: SiteCatalogEntry | null;
}) {
  const [hov, setHov] = useState(false);
  const addOn = crna.isAddOn;
  const ringColor = addOn ? tok.warning : crossSite ? crossSite.color : tok.crna.fg;
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      title={crossSite ? `Cross-site supervision — room is at ${crossSite.label}` : undefined}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '3px 8px', borderRadius: 999,
        background: selected ? 'rgba(14,165,233,0.18)' : tok.crna.bg,
        border: `1.5px ${addOn ? 'dashed' : 'solid'} ${selected ? tok.accent : addOn ? `color-mix(in srgb, ${tok.warning} 50%, transparent)` : crossSite ? crossSite.color + '80' : tok.crna.bd}`,
        cursor: 'grab', transition: 'all 0.12s', whiteSpace: 'nowrap', flexShrink: 0,
        position: 'relative',
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: 3, background: ringColor, flexShrink: 0 }} />
      <span style={{
        color: selected ? tok.accent : tok.crna.fg,
        fontSize: 10, fontWeight: 600,
      }}>
        {crna.role}
      </span>
      {crossSite && (
        <span style={{
          fontSize: 8, fontFamily: tok.mono, fontWeight: 800,
          padding: '0 4px', borderRadius: 2,
          background: crossSite.color + '25', color: crossSite.color,
          letterSpacing: 0.3,
        }}>
          @{shortLabel(crossSite)}
        </span>
      )}
      {onDelete && (hov || selected) && (
        <button
          title="Delete this CRNA"
          onClick={(e) => { e.stopPropagation(); onDelete(crna.id); }}
          style={{
            background: 'transparent', border: 'none', padding: 0,
            color: '#dc2626', fontSize: 13, lineHeight: 1, cursor: 'pointer',
            fontWeight: 800, marginLeft: 1,
          }}
        >×</button>
      )}
    </div>
  );
}

// Compact site label for the @badge — strips parenthetical and uses just the
// short name (e.g. "EP Lab" from "EP Lab", "Endo" from "Endoscopy (GI)").
function shortLabel(site: SiteCatalogEntry): string {
  const name = site.label.split(/[(–—]/)[0].trim();
  if (name.length <= 8) return name;
  // Custom sites carry an internal "cs-…" key that must never surface in the UI —
  // truncate the label instead. Built-in lanes have short, readable keys.
  if (site.key.startsWith('cs-')) return name.slice(0, 7).trim() + '…';
  return site.key;
}

/* ── Output: contingency coverage ───────────────────────────────────────── */

function ContingencyCoverage({ contingencies, assignments }: {
  contingencies: Contingency[];
  assignments: StaffAssignment[];
}) {
  return (
    <Card>
      <SectionTitle>🚨 Contingency coverage</SectionTitle>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8, marginTop: 8 }}>
        {contingencies.map((cg, i) => {
          const from = assignments.find((a) => a.id === cg.fromId);
          const to = assignments.find((a) => a.id === cg.toId);
          if (!from || !to) return null;
          const t = contingencyType(cg.type);
          return (
            <div key={i} style={{
              padding: '8px 12px', borderRadius: 5,
              background: t.bg, border: `0.5px solid ${t.col}`,
            }}>
              <div style={{
                color: t.col, fontSize: 10, fontWeight: 700, marginBottom: 4,
                display: 'flex', alignItems: 'center', gap: 5, fontFamily: tok.mono,
                textTransform: 'uppercase', letterSpacing: 0.3,
              }}>
                <span style={{ fontSize: 11 }}>{t.icon}</span>{cg.label}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{
                  background: tok.surface, border: `0.5px solid ${tok.md.fg}`, borderRadius: 3,
                  padding: '1px 6px', fontWeight: 700, fontSize: 10, color: tok.text,
                }}>{from.role}</span>
                {cg.fromId !== cg.toId ? (
                  <>
                    <span style={{ color: t.col, fontSize: 12, fontWeight: 800 }}>→</span>
                    <span style={{
                      background: tok.surface, border: `0.5px solid ${tok.crna.fg}`, borderRadius: 999,
                      padding: '1px 6px', fontWeight: 700, fontSize: 10, color: tok.text,
                    }}>{to.role}</span>
                  </>
                ) : (
                  <span style={{ color: t.col, fontSize: 10, fontStyle: 'italic' }}>
                    covers independently
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function contingencyType(type: string): { col: string; bg: string; icon: string } {
  switch (type) {
    case 'trauma':    return { col: '#dc2626', bg: 'rgba(239,68,68,0.10)', icon: '🚨' };
    case 'emergCS':   return { col: '#dc2626', bg: 'rgba(239,68,68,0.10)', icon: '🚨' };
    case 'neuro':     return { col: '#FFD93D', bg: 'rgba(255,217,61,0.10)', icon: '🧠' };
    case 'epTEE':     return { col: '#29B6F6', bg: 'rgba(41,182,246,0.10)', icon: '⚡' };
    case 'teeBackup': return { col: '#CE93D8', bg: 'rgba(206,147,216,0.10)', icon: '☕' };
    case 'teeBreaks': return { col: '#29B6F6', bg: 'rgba(41,182,246,0.10)', icon: '☕' };
    case 'addOnFlex': return { col: '#80CBC4', bg: 'rgba(128,203,196,0.10)', icon: '♻️' };
    case 'irFlex':    return { col: '#FFAB40', bg: 'rgba(255,171,64,0.10)', icon: '📡' };
    default:          return { col: tok.textMuted, bg: tok.surface, icon: '📌' };
  }
}

/* ── Output: notes & break analysis ─────────────────────────────────────── */

function NotesPanel({ notes }: { notes: string[] }) {
  return (
    <Card>
      <SectionTitle>📝 Notes &amp; warnings</SectionTitle>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
        {notes.map((n, i) => (
          <div key={i} style={{
            fontSize: 11, color: n.startsWith('──') ? tok.textMuted : tok.text,
            fontWeight: n.startsWith('──') ? 700 : 500,
            paddingLeft: n.startsWith('  ') ? 14 : 0,
            fontFamily: n.startsWith('──') ? tok.mono : 'inherit',
            letterSpacing: n.startsWith('──') ? 0.5 : 0,
            lineHeight: 1.5,
          }}>
            {n}
          </div>
        ))}
      </div>
    </Card>
  );
}

function BreakAnalysisPanel({ breakAnalysis }: { breakAnalysis: CalculatorOutput['breakAnalysis'] }) {
  const sev = breakAnalysis.severity;
  const colorMap = {
    ok:       { fg: '#16a34a', bg: 'rgba(16,185,129,0.10)', bd: 'rgba(16,185,129,0.35)' },
    tight:    { fg: '#b45309', bg: 'rgba(245,158,11,0.10)', bd: 'rgba(245,158,11,0.35)' },
    warning:  { fg: '#dc2626', bg: 'rgba(239,68,68,0.10)',  bd: 'rgba(239,68,68,0.35)' },
    critical: { fg: '#dc2626', bg: 'rgba(239,68,68,0.18)',  bd: 'rgba(239,68,68,0.55)' },
  } as const;
  const c = colorMap[sev];
  return (
    <Card>
      <SectionTitle>☕ Break coverage</SectionTitle>
      <div style={{
        marginTop: 8, padding: '8px 12px', borderRadius: 5,
        background: c.bg, border: `0.5px solid ${c.bd}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 16, fontWeight: 800, color: c.fg, fontFamily: tok.mono }}>
            {breakAnalysis.pct}%
          </span>
          <span style={{ fontSize: 10, color: c.fg, textTransform: 'uppercase', letterSpacing: 0.5, fontFamily: tok.mono, fontWeight: 700 }}>
            {sev}
          </span>
          <span style={{ marginLeft: 'auto', fontSize: 10, color: tok.textMuted, fontFamily: tok.mono }}>
            {breakAnalysis.capacity}/{breakAnalysis.demand} slots
          </span>
        </div>
        {breakAnalysis.unrelieved > 0 && (
          <div style={{ fontSize: 11, color: c.fg, fontWeight: 600 }}>
            {breakAnalysis.unrelieved} provider{breakAnalysis.unrelieved > 1 ? 's' : ''} may not get a timely break.
          </div>
        )}
      </div>
      <div style={{ marginTop: 8 }}>
        {breakAnalysis.sources.map((s, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, padding: '2px 0', color: tok.textMuted }}>
            <span>{s.label}</span>
            <span style={{ fontFamily: tok.mono, color: tok.text }}>{s.breaks} <span style={{ color: tok.textDim, fontSize: 9 }}>({s.detail})</span></span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 12.5, fontWeight: 700, color: tok.text, letterSpacing: -0.1,
      paddingBottom: 7, marginBottom: 9, borderBottom: '1px solid var(--border)',
      display: 'flex', alignItems: 'center', gap: 7,
    }}>
      {children}
    </div>
  );
}
