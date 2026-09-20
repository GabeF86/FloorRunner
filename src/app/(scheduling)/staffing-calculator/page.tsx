'use client';

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
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
import nextDynamic from 'next/dynamic';
import { buildBreakAnalysis } from '@/lib/staffingCalculator/shared';
import {
  availableStaff, availablePeople,
  type ScheduledAvailability, type AvailablePerson,
} from '@/lib/staffingAvailability';
import { Banner, Button, Card, EmptyState, Table } from '@/components/ui';

// Deferred: a second full rendering of the assignment set, loaded only when
// somebody actually prints. ssr:false because it is user-triggered and drives
// the browser's own print pipeline.
const PrintableAssignments = nextDynamic(
  () => import('./PrintableAssignments').then(m => m.PrintableAssignments),
  { ssr: false });

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

/* ── Interaction states ───────────────────────────────────────────────────
   Nearly every control on this page carries a *conditional accent* (the lane
   colour, the field's accentColor, the active-segment tint) which can only be
   expressed as an inline style — and an inline style beats a class rule, so a
   `:hover { background: … }` rule would simply never win. Two consequences:

   · hover tints with an inset shadow instead of `background`. An inset shadow
     paints over whatever background is already there, it comes from one token
     that flips polarity per theme, and it is a property none of these controls
     set inline.
   · focus draws an `outline`, not the --focus-ring box-shadow, so the two
     cannot collide on the same property (this is the same reasoning as
     .fr-field in globals.css).

   Everything transitions on the motion tokens and names its properties — never
   `all`, which animates layout properties nobody asked for. */
const INTERACTION_CSS = `
.sc-btn {
  transition:
    border-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out),
    transform var(--dur-instant) var(--ease-out);
}
.sc-btn:not(:disabled):hover { box-shadow: inset 0 0 0 999px var(--tint-surface); }
.sc-btn:not(:disabled):active { transform: translateY(1px); }
.sc-btn:focus-visible { outline: 2px solid var(--blue); outline-offset: 1px; }

/* Bare glyph buttons (the delete ×): no surface to tint, so hover is carried
   by the glyph itself. */
.sc-icon {
  transition:
    filter var(--dur-fast) var(--ease-out),
    transform var(--dur-instant) var(--ease-out);
}
.sc-icon:hover  { filter: brightness(1.15); }
.sc-icon:active { transform: translateY(1px); }
.sc-icon:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; border-radius: 4px; }

/* Draggable nodes in the supervision map — a grab affordance needs to say it
   is liftable before you press. Quiet: one elevation step, no movement. */
.sc-node {
  transition: box-shadow var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}
.sc-node:hover { box-shadow: var(--shadow-card); }
.sc-node:active { box-shadow: var(--shadow-xs); }
.sc-node:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
`;

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
// These stay literal hex on purpose: a lane colour is DATA (it lands on
// CustomSite.color and flows into the same `site.color` slot as the site
// catalogs in src/lib/staffingCalculator), and several call sites build tints
// by concatenating an alpha suffix — `${site.color}15` — which a var() or a
// color-mix() expression cannot survive.
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

/* ── Reading the schedule ────────────────────────────────────────────────── */

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Step a date by whole days, in UTC so a DST boundary cannot skip one. */
function shiftDate(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

const dayStepStyle: React.CSSProperties = {
  padding: '2px 7px', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
  background: 'transparent', border: `1px solid var(--border)`,
  color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.2, fontWeight: 700,
};

function longDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

interface AvailState {
  data: ScheduledAvailability | null;
  loading: boolean;
  /** A read that failed, as opposed to a day with nobody on it. The panel says
   *  which — a calculator sized for zero staff because a fetch broke is the
   *  same shape on screen as one sized for a genuinely empty day. */
  error: string | null;
}

function useScheduledAvailability(facilityId: string, date: string): AvailState {
  const [state, setState] = useState<AvailState>({ data: null, loading: true, error: null });
  useEffect(() => {
    let live = true;
    setState(s => ({ ...s, loading: true, error: null }));
    fetch(`/api/scheduling/staffing-availability?site=${encodeURIComponent(facilityId)}`
      + `&date=${encodeURIComponent(date)}`)
      .then(async r => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body?.error || `Request failed (${r.status})`);
        return body as ScheduledAvailability;
      })
      .then(data => { if (live) setState({ data, loading: false, error: null }); })
      .catch((e: Error) => {
        if (live) setState({ data: null, loading: false, error: e.message });
      });
    return () => { live = false; };
  }, [facilityId, date]);
  return state;
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

  // ── Available staff, read off the published schedule ────────────────────
  // It used to open on a hardcoded 12 and 14 — numbers that belonged to no
  // site and no day. Now the schedule supplies them, and the steppers stay
  // editable so a what-if is still one click away.
  const [availDate, setAvailDate] = useState<string>(() => todayISO());
  const [includeOvernight, setIncludeOvernight] = useState(false);
  const sched = useScheduledAvailability(facilityId, availDate);
  const [avail, setAvail] = useState<AvailableStaff>({ mds: 0, crnas: 0 });
  // Manual edits win until the source changes. Keyed on the fetch identity, so
  // choosing another site, date or toggle state re-reads the schedule, but
  // nudging a stepper is not immediately undone by a re-render.
  const availKey = `${facilityId}|${availDate}|${includeOvernight}|${sched.data ? 'y' : 'n'}`;
  const appliedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!sched.data || appliedKey.current === availKey) return;
    appliedKey.current = availKey;
    setAvail(availableStaff(sched.data, includeOvernight));
  }, [sched.data, includeOvernight, availKey]);
  const schedulePeople = sched.data ? availablePeople(sched.data, includeOvernight) : [];
  const fromSchedule = sched.data ? availableStaff(sched.data, includeOvernight) : null;
  const edited = !!fromSchedule
    && (fromSchedule.mds !== avail.mds || fromSchedule.crnas !== avail.crnas);

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

  // Printing is armed, then fired on the next frame — the sheet has to be in
  // the DOM before window.print() reads it.
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    if (!printing) return;
    const raf = requestAnimationFrame(() => window.print());
    const done = () => setPrinting(false);
    window.addEventListener('afterprint', done);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('afterprint', done);
    };
  }, [printing]);

  // Who has already been placed on the diagram — the roster strikes them
  // through so the pool left to draw on is readable at a glance.
  const assignedIds = new Set(
    (result?.assignments ?? []).map((a) => a.providerId).filter((x): x is string => !!x));
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
      <style>{INTERACTION_CSS}</style>

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

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* The day everything on this page is about. It lives up here rather
              than inside the staff panel because it governs the whole sheet —
              the headcount, the names offered to every chip, and the printout —
              not just the two steppers it used to sit beside. */}
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
            <button
              className="sc-btn" type="button" title="Previous day"
              aria-label="Previous day"
              onClick={() => setAvailDate(shiftDate(availDate, -1))}
              style={dayStepStyle}
            >‹</button>
            <input
              type="date"
              value={availDate}
              onChange={(e) => e.target.value && setAvailDate(e.target.value)}
              className="fr-field fr-focus"
              aria-label="Date"
              style={{ fontSize: 11, padding: '3px 6px', width: 140 }}
            />
            <button
              className="sc-btn" type="button" title="Next day" aria-label="Next day"
              onClick={() => setAvailDate(shiftDate(availDate, 1))}
              style={dayStepStyle}
            >›</button>
            {availDate !== todayISO() && (
              <Button variant="ghost" size="sm" onClick={() => setAvailDate(todayISO())}
                title="Back to today" style={{ fontSize: 10, fontWeight: 600 }}>today</Button>
            )}
          </div>

          <span aria-hidden style={{ width: 1, alignSelf: 'stretch', background: tok.border, margin: '2px 2px' }} />

          {CALCULATORS.map((c) => {
            const isActive = c.facilityId === facilityId;
            const placeholder = c.status === 'placeholder';
            return (
              <button
                key={c.facilityId}
                className="sc-btn"
                onClick={() => setFacilityId(c.facilityId)}
                aria-pressed={isActive}
                title={placeholder ? `${c.facilityName} — algorithm not yet ported` : c.facilityName}
                style={{
                  padding: '4px 10px', borderRadius: 999, fontSize: 10, fontWeight: 700, fontFamily: tok.mono,
                  // The selected facility is the page's one "you are here" — it
                  // takes the accent, the same signal the segmented controls
                  // below it use, rather than a colour of its own.
                  background: isActive ? `color-mix(in srgb, ${tok.accent} 12%, transparent)` : 'transparent',
                  color: isActive ? tok.accent : tok.textMuted,
                  border: '1px solid ' + (isActive ? `color-mix(in srgb, ${tok.accent} 45%, transparent)` : tok.border),
                  cursor: 'pointer', position: 'relative',
                  opacity: placeholder ? 0.7 : 1,
                }}
              >
                {c.abbreviation}
                {placeholder && <span style={{ marginLeft: 4, fontSize: 8, opacity: 0.7 }}>·draft</span>}
              </button>
            );
          })}
          <Button variant="ghost" size="sm" onClick={() => setPrinting(true)}
            disabled={!result}
            title="Print the day's assignments"
            style={{ fontSize: 10, fontWeight: 600 }}>🖨 print</Button>
          <Button variant="ghost" size="sm" onClick={reset} title="Reset cfg + clear manual edits"
            style={{ fontSize: 10, fontWeight: 600 }}>↺ reset</Button>
        </div>
       </div>
      </Card>

      {isPlaceholder && (
        <div style={{ marginBottom: 14 }}>
          <Banner tone="warn">
            The {calc?.facilityName} algorithm hasn&apos;t been ported yet. Inputs and output are disabled until it&apos;s wired up.
          </Banner>
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
          <AvailableStaffPanel
            avail={avail} setAvail={setAvail} disabled={isPlaceholder}
            date={availDate}
            sched={sched}
            includeOvernight={includeOvernight} setIncludeOvernight={setIncludeOvernight}
            edited={edited}
            onRevert={() => { if (fromSchedule) setAvail(fromSchedule); }}
            assignedIds={assignedIds}
          />
        </div>

        {/* Right: output */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
          {result && <TotalsPanel out={result} avail={avail} />}
          {result && calc && (
            <StaffingDiagram
              result={result}
              setResult={setResult}
              siteCatalog={mergeSiteCatalog(calc.siteCatalog || [], facilityCustomSites)}
              people={schedulePeople}
            />
          )}
          {result && result.contingencies.length > 0 && <ContingencyCoverage contingencies={result.contingencies} assignments={result.assignments} />}
          {result && <NotesPanel notes={result.notes} />}
          {result && <BreakAnalysisPanel breakAnalysis={result.breakAnalysis} />}
          {!result && (
            <Card>
              <EmptyState
                icon="◎"
                title="Output not available"
                hint="This facility's calculator is still pending — pick another site above."
              />
            </Card>
          )}
        </div>
      </div>

      {/* Print sheet — in the DOM only while printing, and display:none even
          then. Everyone on the day's schedule who did not end up on a chip is
          carried too, so the sheet accounts for the whole day rather than only
          the positions that got filled. */}
      {printing && result && calc && (
        <PrintableAssignments
          facilityName={calc.facilityName}
          date={availDate}
          out={result}
          siteCatalog={mergeSiteCatalog(calc.siteCatalog || [], facilityCustomSites)}
          avail={avail}
          includeOvernight={includeOvernight}
          unplaced={schedulePeople
            .filter((p) => !assignedIds.has(p.providerId))
            .map((p) => ({ name: p.name, type: p.type, shiftCodes: p.shiftCodes }))}
        />
      )}

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
                          className="sc-btn"
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
                  className="sc-btn"
                  onClick={() => onRemoveCustomSite(s.key)}
                  title="Remove site"
                  aria-label={`Remove ${s.label}`}
                  style={{
                    width: 18, height: 18, borderRadius: 5, lineHeight: 1, fontSize: 12, fontWeight: 800,
                    background: 'transparent', color: 'var(--danger)',
                    border: '1px solid color-mix(in srgb, var(--danger) 35%, transparent)',
                    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                  }}
                >×</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <button
        className="sc-btn"
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
      className="sc-btn"
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
      position: 'fixed', inset: 0, background: 'var(--bg-modal-backdrop)', zIndex: 50,
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 120,
      animation: 'fr-backdrop-in var(--dur-fast) var(--ease-out)',
    }}
      onClick={onCancel}
    >
      <div
        className="modal-box"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 360, borderRadius: 'var(--radius-lg)', background: tok.card,
          border: `1px solid color-mix(in srgb, ${tok.accent} 33%, transparent)`,
          boxShadow: 'var(--shadow-modal)',
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
          className="fr-field"
          value={name}
          autoFocus
          placeholder="e.g. Pre-op, MRI, Off-site OR"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onCancel(); }}
          // No inline `outline: none` — an inline value would beat .fr-field's
          // focus outline, which is the only keyboard affordance this field has.
          style={{
            width: '100%', boxSizing: 'border-box', padding: '7px 9px', borderRadius: tok.radiusSm,
            border: tok.hairline, background: 'var(--bg-deep)', color: tok.text, fontSize: 13,
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
          <Button variant="secondary" size="sm" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={!canAdd}>Add site</Button>
        </div>
      </div>
    </div>
  );
}

function SegBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className="sc-btn"
      onClick={onClick}
      aria-pressed={active}
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

function AvailableStaffPanel({
  avail, setAvail, disabled, date, sched,
  includeOvernight, setIncludeOvernight, edited, onRevert, assignedIds,
}: {
  avail: AvailableStaff;
  setAvail: (a: AvailableStaff) => void;
  disabled?: boolean;
  /** Only for the caption — the control itself lives in the page header. */
  date: string;
  sched: AvailState;
  includeOvernight: boolean;
  setIncludeOvernight: (v: boolean) => void;
  edited: boolean;
  onRevert: () => void;
  /** Provider ids already dropped onto a chip, so the roster can show which
   *  people are spoken for without re-deriving it from the diagram. */
  assignedIds: ReadonlySet<string>;
}) {
  const a = sched.data;
  const people = a ? availablePeople(a, includeOvernight) : [];
  const overnightN = a ? a.overnightCall.mds + a.overnightCall.crnas : 0;

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

      {/* Where the numbers came from — and, when they no longer match, that
          they have been overridden. A figure read off the schedule and a figure
          typed by hand look identical, and only one of them is evidence. */}
      <div style={{ marginTop: 6, fontSize: 10, color: tok.textDim, lineHeight: 1.55 }}>
        {sched.loading && 'Reading the published schedule…'}
        {sched.error && (
          <span style={{ color: 'var(--danger)' }}>
            Could not read the schedule ({sched.error}). The numbers above are
            whatever was last set, not today&rsquo;s staff.
          </span>
        )}
        {a && !sched.loading && !sched.error && (
          <>
            {a.scheduled
              ? <>From the published schedule for <strong style={{ color: tok.textMuted }}>{longDay(date)}</strong>.</>
              : <span style={{ color: 'var(--warn)' }}>
                  No published schedule covers this site on {longDay(date)} — that is
                  why these read zero, not because nobody is working.
                </span>}
            {edited && (
              <>
                {' '}<span style={{ color: 'var(--warn)' }}>Edited by hand.</span>{' '}
                <button
                  type="button" onClick={onRevert} className="fr-focus"
                  style={{
                    background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                    color: tok.accent, font: 'inherit', textDecoration: 'underline',
                  }}
                >reset to the schedule</button>
              </>
            )}
          </>
        )}
      </div>

      {/* The overnight call team. Off by default: Paoli's C1 and Lankenau's C1
          and C2 run 15:00 → 07:00, so counting them among the day's staff
          builds a grid around people who are not in the building. */}
      {a && a.scheduled && (
        <label style={{
          display: 'flex', alignItems: 'flex-start', gap: 6, marginTop: 8,
          cursor: overnightN > 0 ? 'pointer' : 'default', opacity: overnightN > 0 ? 1 : 0.55,
        }}>
          <input
            type="checkbox"
            checked={includeOvernight}
            disabled={overnightN === 0}
            onChange={(e) => setIncludeOvernight(e.target.checked)}
            style={{ marginTop: 1, accentColor: tok.accent }}
          />
          <span style={{ fontSize: 11, color: tok.text, lineHeight: 1.45 }}>
            Include overnight call team
            <span style={{ display: 'block', fontSize: 10, color: tok.textDim }}>
              {overnightN === 0
                ? 'Nobody is on overnight call here today.'
                : <>
                    {overnightN} more ({a.overnightCall.mds} MD
                    {a.overnightCall.crnas > 0 && <> · {a.overnightCall.crnas} CRNA</>})
                    {a.overnightCodes.length > 0 && <> — {a.overnightCodes.join(', ')}</>},
                    on from 15:00. Off the daytime floor.
                  </>}
            </span>
          </span>
        </label>
      )}

      {/* Starts late but is not call: neither on the day floor nor part of the
          team the checkbox adds. Reported so it can never be silently folded
          into either. */}
      {a && (a.lateOther.mds + a.lateOther.crnas) > 0 && (
        <p style={{ margin: '6px 0 0', fontSize: 10, color: tok.textDim, lineHeight: 1.5 }}>
          A further {a.lateOther.mds + a.lateOther.crnas} start after 15:00 on a
          non-call shift ({a.lateOtherCodes.join(', ')}). Counted in neither total —
          they are not on the daytime floor and not part of the call team.
        </p>
      )}

      {/* Who they actually are. The same shape the staffing board uses at the
          bottom of its page, so the two read as one system. */}
      {people.length > 0 && (
        <div style={{ marginTop: 10, borderTop: tok.hairline, paddingTop: 8 }}>
          <div style={{
            fontSize: 10, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase',
            color: tok.textDim, marginBottom: 5,
          }}>
            On the schedule ({people.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 260, overflowY: 'auto' }}>
            {people.map((p) => (
              <ProviderLine key={p.providerId} person={p} assigned={assignedIds.has(p.providerId)} />
            ))}
          </div>
          <p style={{ margin: '7px 0 0', fontSize: 10, color: tok.textDim, lineHeight: 1.5 }}>
            Click any chip in the diagram to put one of these people in it.
          </p>
        </div>
      )}
    </Card>
  );
}

/** Opening the person picker, published to the chips.
 *
 *  A context rather than a prop: the chips sit five components deep through
 *  MDBlock, the float row and the remote-coverage row, and threading one
 *  callback through all of them would touch every signature between here and
 *  there for no gain. Null when no schedule is loaded, and the slot then does
 *  not render at all — an affordance that opens an empty list is worse than no
 *  affordance. */
const PickPersonContext = createContext<((a: StaffAssignment) => void) | null>(null);

/**
 * The name slot on a chip.
 *
 * A separate click target rather than the chip body, deliberately: the chip
 * body already means something in this diagram — clicking an MD block assigns
 * the selected CRNA to it, clicking a CRNA chip selects it for reassignment.
 * Overloading either would make dragging staff around and naming them the same
 * gesture, and the wrong one would fire constantly.
 */
function NameSlot({ assignment, compact }: {
  assignment: StaffAssignment;
  compact?: boolean;
}) {
  const onOpen = useContext(PickPersonContext);
  if (!onOpen) return null;
  const named = !!assignment.providerName;
  const accent = assignment.type === 'CRNA' ? tok.crna : tok.md;
  return (
    <button
      type="button"
      className="sc-btn fr-focus"
      onClick={(e) => { e.stopPropagation(); onOpen(assignment); }}
      title={named
        ? `${assignment.providerName} — click to change or clear`
        : `Put somebody from today's schedule in ${assignment.role}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 3, maxWidth: compact ? 92 : 128,
        padding: compact ? '0 4px' : '1px 5px', borderRadius: 3, cursor: 'pointer',
        fontSize: compact ? 9 : 10, fontWeight: named ? 700 : 600,
        fontFamily: named ? undefined : tok.mono,
        background: named ? accent.bg : 'transparent',
        color: named ? accent.fg : tok.textDim,
        border: `1px ${named ? 'solid' : 'dashed'} ${named ? accent.bd : tok.border}`,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}
    >
      {named ? assignment.providerName : '+ name'}
    </button>
  );
}

/**
 * Pick somebody for a chip.
 *
 * Only offers the matching discipline: an MD position needs an MD, and a list
 * that let a CRNA be dropped into a supervising role would produce a grid that
 * cannot legally run. Already-placed people stay in the list but are marked —
 * moving somebody from one room to another is ordinary, and hiding them would
 * make it look as though they had vanished from the day.
 */
function PersonPicker({ assignment, people, placed, onPick, onClose }: {
  assignment: StaffAssignment;
  people: AvailablePerson[];
  placed: ReadonlyMap<string, string>;
  onPick: (p: AvailablePerson | null) => void;
  onClose: () => void;
}) {
  const matching = people.filter((p) => p.type === assignment.type);
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 60, background: 'color-mix(in srgb, #000 42%, transparent)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`Assign somebody to ${assignment.role}`}
        style={{
          background: tok.card, border: tok.hairline, borderRadius: tok.radius,
          boxShadow: tok.shadow, width: 320, maxHeight: '70vh', overflow: 'hidden',
          display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{ padding: '10px 12px', borderBottom: tok.hairline }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: tok.text }}>{assignment.role}</div>
          <div style={{ fontSize: 10, color: tok.textDim, marginTop: 1 }}>
            {matching.length > 0
              ? `${matching.length} ${assignment.type} on today's schedule`
              : `No ${assignment.type} is on this site's published schedule for the day.`}
          </div>
        </div>

        <div style={{ overflowY: 'auto', padding: 6 }}>
          {matching.map((p) => {
            const here = placed.get(p.providerId);
            const elsewhere = here && here !== assignment.id;
            return (
              <button
                key={p.providerId}
                type="button"
                className="sc-btn fr-focus"
                onClick={() => onPick(p)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, width: '100%',
                  padding: '5px 7px', borderRadius: tok.radiusSm, cursor: 'pointer',
                  background: 'transparent', border: '1px solid transparent',
                  textAlign: 'left', color: tok.text, fontSize: 11,
                }}
              >
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {p.name}
                </span>
                {p.bucket === 'overnight_call' && (
                  <span style={{ fontFamily: tok.mono, fontSize: 9, color: 'var(--danger)' }}>night</span>
                )}
                <span style={{ fontFamily: tok.mono, fontSize: 9, color: tok.textDim }}>
                  {p.shiftCodes.join('+')}
                </span>
                {elsewhere && (
                  <span style={{ fontFamily: tok.mono, fontSize: 9, color: tok.warning }}>placed</span>
                )}
              </button>
            );
          })}
        </div>

        <div style={{ display: 'flex', gap: 6, padding: 8, borderTop: tok.hairline }}>
          {assignment.providerName && (
            <Button variant="ghost" onClick={() => onPick(null)}>Clear</Button>
          )}
          <div style={{ marginLeft: 'auto' }}>
            <Button variant="ghost" onClick={onClose}>Close</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** One scheduled person, matching the staffing board's row: name, then the
 *  shift code they are on. Struck through once they are placed in the diagram
 *  so the remaining pool is readable at a glance. */
function ProviderLine({ person, assigned }: { person: AvailablePerson; assigned: boolean }) {
  const accent = person.type === 'CRNA' ? tok.crna : tok.md;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 5, fontSize: 11,
      opacity: assigned ? 0.45 : 1,
    }}>
      <span style={{
        fontFamily: tok.mono, fontSize: 9, fontWeight: 700, padding: '0 4px',
        borderRadius: 3, background: accent.bg, color: accent.fg,
        border: `1px solid ${accent.bd}`, flexShrink: 0,
      }}>{person.type}</span>
      <span style={{
        flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
        whiteSpace: 'nowrap', color: tok.text,
        textDecoration: assigned ? 'line-through' : undefined,
      }}>{person.name}</span>
      {person.bucket === 'overnight_call' && (
        <span style={{ fontFamily: tok.mono, fontSize: 9, color: 'var(--danger)' }}>night</span>
      )}
      <span style={{ fontFamily: tok.mono, fontSize: 9, color: tok.textDim, flexShrink: 0 }}>
        {person.shiftCodes.join('+')}
      </span>
    </div>
  );
}

function Stepper({ value, onChange, min, max, color }: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  color?: string;
}) {
  // Field accents arrive as hex from the calculator schema; the fallback is the
  // themed accent token, so every colour here goes through color-mix rather
  // than string-concatenated alpha — which a var() could never survive.
  const c = color || tok.accent;
  const btn: React.CSSProperties = {
    width: 22, height: 22, borderRadius: 6, border: `1px solid color-mix(in srgb, ${c} 45%, var(--border))`,
    background: `color-mix(in srgb, ${c} 7%, transparent)`, color: c, fontSize: 13, cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1, fontWeight: 600,
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <button
        className="sc-btn"
        aria-label="decrease"
        onClick={() => onChange(Math.max(min, value - 1))}
        disabled={value <= min}
        style={{ ...btn, opacity: value <= min ? 0.35 : 1, cursor: value <= min ? 'not-allowed' : 'pointer' }}
      >−</button>
      <span className="fr-nums" style={{
        color: tok.text, fontSize: 13, fontWeight: 700,
        minWidth: 18, textAlign: 'center',
      }}>{value}</span>
      <button
        className="sc-btn"
        aria-label="increase"
        onClick={() => onChange(Math.min(max, value + 1))}
        disabled={value >= max}
        style={{ ...btn, opacity: value >= max ? 0.35 : 1, cursor: value >= max ? 'not-allowed' : 'pointer' }}
      >+</button>
    </div>
  );
}

function ToggleBtn({ on, onClick, color }: { on: boolean; onClick: () => void; color?: string }) {
  const c = color || tok.accent;
  return (
    <button
      className="sc-btn"
      onClick={onClick}
      aria-pressed={on}
      style={{
        padding: '2px 8px', borderRadius: 4, fontSize: 9, fontWeight: 700, cursor: 'pointer', fontFamily: tok.mono,
        background: on ? `color-mix(in srgb, ${c} 15%, transparent)` : 'transparent',
        border: `1px solid ${on ? c : tok.border}`,
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

function StaffingDiagram({ result, setResult, siteCatalog, people }: {
  result: CalculatorOutput;
  setResult: React.Dispatch<React.SetStateAction<CalculatorOutput | null>>;
  siteCatalog: SiteCatalogEntry[];
  /** The day's scheduled staff, offered when a chip is clicked. Empty when
   *  nothing is published for the date — the chips then say so rather than
   *  opening an empty list. */
  people: AvailablePerson[];
}) {
  const [selectedCRNA, setSelectedCRNA] = useState<string | null>(null);
  // Which chip is having a person put in it. One at a time — this is a
  // pick-a-name popover, not a mode.
  const [picking, setPicking] = useState<StaffAssignment | null>(null);

  const assignPerson = (assignmentId: string, person: AvailablePerson | null) => {
    setResult((prev) => prev && ({
      ...prev,
      assignments: prev.assignments.map((a) => (a.id === assignmentId
        ? { ...a, providerId: person?.providerId ?? null, providerName: person?.name ?? null }
        : a)),
    }));
    setPicking(null);
  };
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

  // Connector links for 'linked' mode: one line per cross-covered CRNA, drawn
  // from the supervising MD's home card straight to that CRNA's chip in the
  // lane it actually sits in.
  //
  // It used to be one line per (MD, lane), landing on a GHOST COPY of the MD
  // card rendered inside the covered lane. That duplicate said nothing the line
  // did not already say, and it made every cross-cover cost a second full card
  // — the board read as busier than the staffing actually was. The line now
  // terminates on the CRNA, which is the thing being covered.
  //
  // `version` forces the SVG overlay to re-measure when supervision, sites,
  // lanes or selection change.
  const connectorLinks = crossMode === 'linked'
    ? crnas
        .filter((c) => {
          const sup = c.supervisedBy && mds.find((m) => m.id === c.supervisedBy);
          return !!sup && sup.site !== c.site;
        })
        .map((c) => ({ mdId: c.supervisedBy as string, crnaId: c.id }))
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

  // The pool offered to a chip. Withheld entirely when the day has nobody on
  // it, so the "+ name" affordance never opens onto an empty list.
  const placed = new Map<string, string>();
  for (const a of assignments) if (a.providerId) placed.set(a.providerId, a.id);

  return (
    <PickPersonContext.Provider value={people.length > 0 ? setPicking : null}>
    <Card>
      {picking && (
        <PersonPicker
          assignment={picking}
          people={people}
          placed={placed}
          onPick={(p) => assignPerson(picking.id, p)}
          onClose={() => setPicking(null)}
        />
      )}
      <SectionTitle>
        <span>🏥 By site — supervision map</span>
        <div style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ fontSize: 8.5, color: tok.textDim, fontFamily: tok.mono, fontWeight: 800, letterSpacing: 0.4 }}>CROSS-SITE</span>
          {([['linked', '⇄ Linked'], ['compact', 'Compact']] as const).map(([m, label]) => {
            const on = crossMode === m;
            return (
              <button
                key={m}
                className="sc-btn"
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
          background: `color-mix(in srgb, ${tok.accent} 10%, transparent)`,
          border: `1px solid color-mix(in srgb, ${tok.accent} 45%, transparent)`,
          borderLeft: `3px solid ${tok.accent}`,
          borderRadius: tok.radiusSm, padding: '6px 12px', marginTop: 6, marginBottom: 8,
          color: tok.accent, fontSize: 11, fontWeight: 600,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span>🔄</span> CRNA selected — click any MD to reassign &nbsp;
          <span style={{ fontSize: 10, fontWeight: 500, opacity: 0.85 }}>
            (hold <kbd style={kbdStyle}>Shift</kbd> to keep CRNA at current site — cross-site supervision)
          </span>
          <button className="sc-btn" onClick={() => setSelectedCRNA(null)} style={{
            marginLeft: 'auto', background: 'transparent',
            border: `1px solid color-mix(in srgb, ${tok.accent} 55%, transparent)`,
            color: tok.accent, borderRadius: 'var(--radius-sm)', padding: '1px 8px', cursor: 'pointer',
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
                borderRadius: tok.radiusSm,
                overflow: 'hidden',
                // site.color is catalog DATA (hex), so the drop tint stays a
                // concatenated alpha suffix — see the note on CUSTOM_SITE_COLORS.
                background: isLaneTarget ? `${site.color}15` : 'transparent',
                border: isLaneTarget ? `1px dashed ${site.color}` : `1px solid transparent`,
                transition: `background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out)`,
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
              <div style={{ width: 1, background: 'var(--border-faint)', margin: '6px 0', flexShrink: 0 }} />

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

                  {/* Linked mode: CRNAs here who are covered by an MD in
                      another lane. Just the chips — the connector line above
                      carries the relationship, so a ghost copy of the MD card
                      would be saying it a second time. */}
                  {crossMode === 'linked' && (() => {
                    const covered = siteCRNAs.filter((c) => {
                      const sup = c.supervisedBy && mds.find((m) => m.id === c.supervisedBy);
                      return !!sup && sup.site !== site.key;
                    });
                    return covered.length > 0 ? (
                      <CrossCoveredRow
                        crnas={covered}
                        mds={mds}
                        siteCatalog={allLanes}
                        selectedCRNA={selectedCRNA}
                        onCRNAClick={onCRNAClick}
                        onDragStartCRNA={onDragStartCRNA}
                        onDelete={deleteAssignment}
                      />
                    ) : null;
                  })()}

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
        marginTop: 10, padding: '6px 10px', borderRadius: tok.radiusSm,
        background: tok.surface, border: '1px solid var(--border-faint)',
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
          {people.length > 0 && <> · click <strong>+ name</strong> to place somebody</>}
        </span>
      </div>
    </Card>
    </PickPersonContext.Provider>
  );
}

const kbdStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono), ui-monospace, monospace',
  fontSize: 9, padding: '1px 4px', borderRadius: 3,
  background: 'var(--bg-deep)', border: '1px solid var(--border)',
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
  // The role colours below are the group-wide MD-kind palette (supervising /
  // solo / cardiac), shared verbatim with the grid calculator and the
  // staffingCalculator site catalogs — they encode WHICH KIND of provider this
  // is, not a style choice, so they stay literal here.
  const btn = (label: string, onClick: () => void, color: string): React.CSSProperties => ({
    padding: '2px 8px', borderRadius: 4, fontSize: 9, fontWeight: 700, cursor: 'pointer',
    background: 'transparent', color, border: `1px dashed ${color}`,
    fontFamily: tok.mono, letterSpacing: 0.3,
  });
  return (
    <div style={{ display: 'flex', gap: 5, padding: '4px 0 2px', flexWrap: 'wrap' }}>
      {onAddCardiac ? (
        <button className="sc-btn" onClick={onAddCardiac} style={btn('+ Cardiac MD', onAddCardiac, '#E05599')}>+ Cardiac MD</button>
      ) : (
        <button className="sc-btn" onClick={onAddSupv} style={btn('+ Supv MD', onAddSupv, '#4A90D9')}>+ Supv MD</button>
      )}
      <button className="sc-btn" onClick={onAddSolo} style={btn('+ Solo MD', onAddSolo, '#B06AE8')}>+ Solo MD</button>
      <button className="sc-btn" onClick={onAddCRNA} style={btn('+ CRNA', onAddCRNA, tok.crna.fg)}>+ CRNA</button>
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
  // Pick an outline color that says what KIND of MD this is. These hexes are
  // the group's provider-type palette, shared verbatim with the grid
  // calculator (AnesthesiologistCard / GridCanvas) and the site catalogs — they
  // are an encoding, not a style, and tokenising one copy would desync them.
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
      <div className="sc-node" data-ccnode={dataNode} style={{
        display: 'flex', alignItems: 'center', gap: 7,
        padding: '5px 9px', borderRadius: tok.radiusSm,
        // "This block will accept the selected CRNA" is a success signal, so it
        // takes the --ok pair rather than a green picked by hand.
        background: (canAccept || isHovered) ? 'var(--ok-bg)' : tok.surface,
        border: `1.5px solid ${(canAccept || isHovered) ? 'var(--ok)' : borderCol}`,
        minWidth: 110, flexShrink: 0,
        transition: `background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out)`,
        position: 'relative',
      }}>
        {/* Delete × — appears on hover, top-right of the block. Stops propagation
            so the click doesn't trigger the reassign-CRNA-to-this-MD branch. */}
        {hov && (
          <button
            className="sc-btn"
            title="Delete this MD"
            aria-label={`Delete ${md.role}`}
            onClick={(e) => { e.stopPropagation(); onDelete(md.id); }}
            style={{
              position: 'absolute', top: -7, right: -7,
              width: 16, height: 16, borderRadius: '50%',
              background: tok.card, color: 'var(--danger)',
              border: '1px solid var(--danger)',
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
          <div style={{ marginTop: 2 }}>
            <NameSlot assignment={md} />
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
/**
 * CRNAs sitting in this lane whose supervising MD is in another one.
 *
 * Chips only. The previous design put a dashed GHOST COPY of the MD card here,
 * tagged XCOV with an arrow back to its home lane — which duplicated on screen
 * exactly what the connector line already draws, and cost a full card per
 * cross-cover. Gabriel's call (2026-09-20): extend the line to the CRNA and
 * drop the second card.
 *
 * The supervising MD is still named, in the chip's tooltip and in one quiet
 * lead-in label, so the relationship survives when several lines overlap or
 * when the diagram is printed without hover.
 */
function CrossCoveredRow({ crnas, mds, siteCatalog, selectedCRNA, onCRNAClick, onDragStartCRNA, onDelete }: {
  crnas: StaffAssignment[];
  mds: StaffAssignment[];
  siteCatalog: SiteCatalogEntry[];
  selectedCRNA: string | null;
  onCRNAClick: (c: StaffAssignment) => void;
  onDragStartCRNA: (e: React.DragEvent, c: StaffAssignment) => void;
  onDelete: (id: string) => void;
}) {
  const tone = tok.crossSite;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 0', flexWrap: 'wrap' }}>
      {/* A bare glyph, not a sentence. The line already says "covered from
          elsewhere"; the per-chip tag below says from where. A third label
          spelling it out again is the busyness this change removes. */}
      <span
        title="Supervised from another lane"
        style={{ fontSize: 11, color: tone, flexShrink: 0, lineHeight: 1 }}
      >⇄</span>
      {crnas.map((c) => {
        const sup = mds.find((m) => m.id === c.supervisedBy);
        const home = sup ? siteCatalog.find((sc) => sc.key === sup.site) : null;
        return (
          <span key={c.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <CRNAChip
              crna={c}
              selected={selectedCRNA === c.id}
              onClick={() => onCRNAClick(c)}
              onDragStart={(e) => onDragStartCRNA(e, c)}
              onDelete={onDelete}
              dataNode={'crna-' + c.id}
            />
            {sup && (
              <span
                title={`${c.role} is supervised by ${sup.role}${home ? ` in ${home.label}` : ''}`}
                style={{ fontSize: 8.5, fontFamily: tok.mono, fontWeight: 800, color: tone, whiteSpace: 'nowrap' }}
              >
                {home ? shortLabel(home) : sup.site}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

// SVG overlay joining each supervising MD's card to the CRNA it covers in
// another lane. Measures live DOM positions (re-measuring on `version` change
// + container resize) so the lines track the chips. Bows left into the gutter
// so it doesn't cross other cards.
//
// The far end used to be a ghost copy of the MD card; it is now the CRNA chip
// itself, so the line lands on the thing being covered and the lane carries one
// element instead of two.
function CrossCoverConnectors({ containerRef, links, version }: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  links: { mdId: string; crnaId: string }[];
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
        const rem = el.querySelector(`[data-ccnode="crna-${lk.crnaId}"]`) as HTMLElement | null;
        if (!home || !rem) return;
        const hr = home.getBoundingClientRect();
        const rr = rem.getBoundingClientRect();
        const x1 = hr.left - cr.left;
        const y1 = hr.top - cr.top + hr.height / 2;
        const x2 = rr.left - cr.left;
        const y2 = rr.top - cr.top + rr.height / 2;
        const k = 16 + i * 12; // bow depth into the gutter, staggered per link
        const d = `M ${x1} ${y1} C ${x1 - k} ${y1}, ${x2 - k} ${y2}, ${x2} ${y2}`;
        next.push({ id: `${lk.mdId}-${lk.crnaId}`, d, x1, y1, x2, y2 });
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

// Micro-badge stamped onto a solid role colour. Both inks are deliberately
// theme-invariant: the fill is the role hex (identical in light and dark), so
// the text on top has to be a fixed value too — a --text token would flip to
// near-white in dark mode and vanish on the yellow 8101 fill. `#0f172a` is the
// system's own darkest slate, matching --text-strong in light.
function Badge({ color, text, dark }: { color: string; text: string; dark?: boolean }) {
  return (
    <span style={{
      background: color, color: dark ? '#0f172a' : 'var(--on-accent)',
      fontSize: 7, fontWeight: 800, padding: '1px 4px', borderRadius: 2,
      letterSpacing: 0.3, fontFamily: tok.mono,
    }}>{text}</span>
  );
}

function CRNAChip({ crna, selected, onClick, onDragStart, onDelete, crossSite, dataNode }: {
  crna: StaffAssignment;
  selected: boolean;
  onClick: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDelete?: (id: string) => void;
  // When set, the chip renders a small "@SiteName" badge using this lane's
  // accent color. Indicates the room is elsewhere — supervision crosses sites.
  crossSite?: SiteCatalogEntry | null;
  // Anchor the cross-cover connector terminates on, when this CRNA is covered
  // by an MD in another lane.
  dataNode?: string;
}) {
  const [hov, setHov] = useState(false);
  const addOn = crna.isAddOn;
  const ringColor = addOn ? tok.warning : crossSite ? crossSite.color : tok.crna.fg;
  return (
    <div
      className="sc-node"
      data-ccnode={dataNode}
      draggable
      onDragStart={onDragStart}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      title={crossSite ? `Cross-site supervision — room is at ${crossSite.label}` : undefined}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '3px 8px', borderRadius: 999,
        background: selected ? `color-mix(in srgb, ${tok.accent} 18%, transparent)` : tok.crna.bg,
        border: `1.5px ${addOn ? 'dashed' : 'solid'} ${selected ? tok.accent : addOn ? `color-mix(in srgb, ${tok.warning} 50%, transparent)` : crossSite ? crossSite.color + '80' : tok.crna.bd}`,
        cursor: 'grab', whiteSpace: 'nowrap', flexShrink: 0,
        transition: `background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out)`,
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
      <NameSlot assignment={crna} compact />
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
          className="sc-icon"
          title="Delete this CRNA"
          aria-label={`Delete ${crna.role}`}
          onClick={(e) => { e.stopPropagation(); onDelete(crna.id); }}
          style={{
            background: 'transparent', border: 'none', padding: 0,
            color: 'var(--danger)', fontSize: 13, lineHeight: 1, cursor: 'pointer',
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
              padding: '8px 12px', borderRadius: tok.radiusSm,
              background: t.bg,
              border: `1px solid color-mix(in srgb, ${t.col} 35%, transparent)`,
              borderLeft: `3px solid ${t.col}`,
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
                  background: tok.surface, border: `1px solid ${tok.md.bd}`, borderRadius: 'var(--radius-sm)',
                  padding: '1px 6px', fontWeight: 700, fontSize: 10, color: tok.text,
                }}>{from.role}</span>
                {cg.fromId !== cg.toId ? (
                  <>
                    <span style={{ color: t.col, fontSize: 12, fontWeight: 800 }}>→</span>
                    <span style={{
                      background: tok.surface, border: `1px solid ${tok.crna.bd}`, borderRadius: 999,
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

// Contingency tone. These were eight hand-picked brights whose label text sat
// on a 10% tint of itself — in light mode `#FFD93D` on pale yellow is close to
// unreadable. Each type now maps to the token that describes its URGENCY, so
// the ramp reads red → amber → blue → neutral in either theme and every label
// clears AA. The distinctions that mattered (emergency vs elective-flex vs
// break cover) survive; six hues did the work of eight.
function contingencyType(type: string): { col: string; bg: string; icon: string } {
  switch (type) {
    case 'trauma':    return { col: 'var(--danger)', bg: 'var(--danger-bg)', icon: '🚨' };
    case 'emergCS':   return { col: 'var(--danger)', bg: 'var(--danger-bg)', icon: '🚨' };
    case 'neuro':     return { col: 'var(--warn)',   bg: 'var(--warn-bg)',   icon: '🧠' };
    case 'epTEE':     return { col: 'var(--info)',   bg: 'var(--info-bg)',   icon: '⚡' };
    case 'teeBackup': return { col: 'var(--indigo)', bg: `color-mix(in srgb, var(--indigo) 10%, transparent)`, icon: '☕' };
    case 'teeBreaks': return { col: 'var(--info)',   bg: 'var(--info-bg)',   icon: '☕' };
    case 'addOnFlex': return { col: 'var(--ok)',     bg: 'var(--ok-bg)',     icon: '♻️' };
    case 'irFlex':    return { col: tok.crossSite,   bg: `color-mix(in srgb, ${tok.crossSite} 10%, transparent)`, icon: '📡' };
    default:          return { col: tok.textMuted,   bg: tok.surface,        icon: '📌' };
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
  // Severity is exactly what the status tokens are for. `critical` is the same
  // danger ink on a denser tint and a solid rule, so the two red states stay
  // distinguishable without inventing a second red.
  const colorMap = {
    ok:       { fg: 'var(--ok)',     bg: 'var(--ok-bg)',     bd: 'color-mix(in srgb, var(--ok) 35%, transparent)' },
    tight:    { fg: 'var(--warn)',   bg: 'var(--warn-bg)',   bd: 'color-mix(in srgb, var(--warn) 35%, transparent)' },
    warning:  { fg: 'var(--danger)', bg: 'var(--danger-bg)', bd: 'color-mix(in srgb, var(--danger) 35%, transparent)' },
    critical: { fg: 'var(--danger)', bg: 'color-mix(in srgb, var(--danger) 18%, transparent)', bd: 'var(--danger)' },
  } as const;
  const c = colorMap[sev];
  return (
    <Card>
      <SectionTitle>☕ Break coverage</SectionTitle>
      <div style={{
        marginTop: 8, padding: '8px 12px', borderRadius: tok.radiusSm,
        background: c.bg, border: `1px solid ${c.bd}`, borderLeft: `3px solid ${c.fg}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
          <span className="fr-nums" style={{ fontSize: 16, fontWeight: 800, color: c.fg, fontFamily: tok.mono }}>
            {breakAnalysis.pct}%
          </span>
          <span style={{ fontSize: 10, color: c.fg, textTransform: 'uppercase', letterSpacing: 0.5, fontFamily: tok.mono, fontWeight: 700 }}>
            {sev}
          </span>
          <span className="fr-nums" style={{ marginLeft: 'auto', fontSize: 10, color: tok.textMuted, fontFamily: tok.mono }}>
            {breakAnalysis.capacity}/{breakAnalysis.demand} slots
          </span>
        </div>
        {breakAnalysis.unrelieved > 0 && (
          <div className="fr-nums" style={{ fontSize: 11, color: c.fg, fontWeight: 600 }}>
            {breakAnalysis.unrelieved} provider{breakAnalysis.unrelieved > 1 ? 's' : ''} may not get a timely break.
          </div>
        )}
      </div>
      {/* Relief sources are three aligned columns, not a label/value list —
          splitting the basis out of the parenthetical lets the break counts
          form a real column you can add up by eye. */}
      <div style={{ marginTop: 8 }}>
        <Table
          headers={['Relief source', 'Breaks', 'Basis']}
          rows={breakAnalysis.sources.map((s) => [
            <span key="l" style={{ color: tok.text }}>{s.label}</span>,
            <span key="b" style={{ fontWeight: 700 }}>{s.breaks}</span>,
            <span key="d" style={{ color: tok.textDim }}>{s.detail}</span>,
          ])}
        />
      </div>
    </Card>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 'var(--fs-sm)', fontWeight: 700, color: 'var(--text-strong)', letterSpacing: -0.1,
      // Hairline, matching the kit Card's own header rule — a full --border here
      // read as a second box edge inside a box that already has one.
      paddingBottom: 7, marginBottom: 9, borderBottom: '1px solid var(--border-faint)',
      display: 'flex', alignItems: 'center', gap: 7,
    }}>
      {children}
    </div>
  );
}
