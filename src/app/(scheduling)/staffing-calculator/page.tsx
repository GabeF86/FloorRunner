'use client';

import { useEffect, useState } from 'react';
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

/* ── Shared style tokens ─────────────────────────────────────────────────── */

const tok = {
  card: 'var(--bg-surface)',
  surface: 'var(--bg-deep)',
  border: 'var(--border)',
  hairline: '0.5px solid var(--border)',
  text: 'var(--text)',
  textMuted: 'var(--text-muted)',
  textDim: 'var(--text-dim)',
  mono: 'var(--font-mono), ui-monospace, monospace',
  md: { fg: '#3C3489', bg: '#EEEDFE', bd: '#CECBF6' },
  crna: { fg: '#0C447C', bg: '#E6F1FB', bd: '#B5D4F4' },
  accent: '#0ea5e9',
  warning: '#E8C854',
};

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

  const setCfgValue = (key: string, value: number | boolean) => {
    setConfigs((prev) => ({
      ...prev,
      [facilityId]: { ...prev[facilityId], [key]: value },
    }));
  };

  const [avail, setAvail] = useState<AvailableStaff>({ mds: 12, crnas: 14 });

  // Result is held as state (not derived) so the diagram can apply local
  // reassignments (drag-CRNA-onto-MD, drag-MD-to-site) without re-running
  // the algorithm. cfg / avail / facility changes wipe local edits and
  // recompute fresh — that's the intended reset semantic.
  const [result, setResult] = useState<CalculatorOutput | null>(null);
  useEffect(() => {
    if (!calc || isPlaceholder) { setResult(null); return; }
    setResult(calc.calculate(cfg, avail));
  }, [calc, cfg, avail, isPlaceholder]);

  const reset = () => {
    if (!calc) return;
    setConfigs((prev) => ({ ...prev, [facilityId]: { ...calc.defaultConfig } }));
  };

  return (
    <div style={{ padding: '14px 22px 28px', maxWidth: 1280 }}>
      {/* Breadcrumb */}
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 10, fontFamily: tok.mono, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ color: tok.textMuted }}>scheduling</span>
        <span>/</span>
        <span style={{ color: tok.textMuted }}>staffing calculator</span>
      </div>

      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 14,
        padding: '12px 14px', marginBottom: 14,
        background: tok.card, border: tok.hairline, borderRadius: 6,
      }}>
        <div>
          <h1 style={{ fontSize: 16, fontWeight: 700, color: tok.text, letterSpacing: -0.2 }}>
            Staffing Calculator
          </h1>
          <div style={{ fontSize: 11, color: tok.textDim, marginTop: 2, fontFamily: tok.mono }}>
            Plan tomorrow's staffing — enter site config, drag MDs &amp; CRNAs to test scenarios.
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
      <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 14, alignItems: 'start' }}>
        {/* Left: inputs */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {!isPlaceholder && calc && (
            <ConfigPanel schema={calc.schema} cfg={cfg} onChange={setCfgValue} />
          )}
          <AvailableStaffPanel avail={avail} setAvail={setAvail} disabled={isPlaceholder} />
        </div>

        {/* Right: output */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {result && <TotalsPanel out={result} avail={avail} />}
          {result && calc && (
            <StaffingDiagram
              result={result}
              setResult={setResult}
              siteCatalog={calc.siteCatalog || []}
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
    </div>
  );
}

/* ── Config inputs ──────────────────────────────────────────────────────── */

function ConfigPanel({ schema, cfg, onChange }: {
  schema: ConfigField[];
  cfg: CalculatorConfig;
  onChange: (key: string, value: number | boolean) => void;
}) {
  const grouped: Record<string, ConfigField[]> = {};
  for (const f of schema) {
    if (f.visibleWhen && !f.visibleWhen(cfg)) continue;
    if (!grouped[f.section]) grouped[f.section] = [];
    grouped[f.section].push(f);
  }

  return (
    <div style={{ background: tok.card, border: tok.hairline, borderRadius: 6, padding: '10px 12px' }}>
      <SectionTitle>📋 Site configuration</SectionTitle>
      {Object.entries(grouped).map(([section, fields]) => (
        <div key={section} style={{ marginTop: 8 }}>
          <div style={{
            fontSize: 9, fontWeight: 700, color: tok.textMuted,
            letterSpacing: 0.5, textTransform: 'uppercase', fontFamily: tok.mono,
            paddingBottom: 3, borderBottom: tok.hairline, marginBottom: 4,
          }}>
            {section}
          </div>
          {fields.map((f) => (
            <div key={f.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 2px' }}>
              <span style={{ fontSize: 11, color: tok.textMuted, fontWeight: 600 }}>{f.label}</span>
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
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function AvailableStaffPanel({ avail, setAvail, disabled }: {
  avail: AvailableStaff;
  setAvail: (a: AvailableStaff) => void;
  disabled?: boolean;
}) {
  return (
    <div style={{
      background: tok.card, border: tok.hairline, borderRadius: 6, padding: '10px 12px',
      opacity: disabled ? 0.5 : 1,
    }}>
      <SectionTitle>👥 Available staff</SectionTitle>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 2px', marginTop: 4 }}>
        <span style={{ fontSize: 11, color: tok.textMuted, fontWeight: 600 }}>MDs available</span>
        <Stepper value={avail.mds} onChange={(v) => setAvail({ ...avail, mds: v })} min={0} max={30} color={tok.md.fg} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 2px' }}>
        <span style={{ fontSize: 11, color: tok.textMuted, fontWeight: 600 }}>CRNAs available</span>
        <Stepper value={avail.crnas} onChange={(v) => setAvail({ ...avail, crnas: v })} min={0} max={30} color={tok.crna.fg} />
      </div>
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
  const c = color || '#0ea5e9';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <button
        onClick={() => onChange(Math.max(min, value - 1))}
        disabled={value <= min}
        style={{
          width: 22, height: 22, borderRadius: 4, border: `0.5px solid ${c}`,
          background: 'transparent', color: c, fontSize: 13, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          opacity: value <= min ? 0.4 : 1,
        }}
      >−</button>
      <span style={{
        color: tok.text, fontSize: 13, fontWeight: 700, fontFamily: tok.mono,
        minWidth: 22, textAlign: 'center',
      }}>{value}</span>
      <button
        onClick={() => onChange(Math.min(max, value + 1))}
        disabled={value >= max}
        style={{
          width: 22, height: 22, borderRadius: 4, border: `0.5px solid ${c}`,
          background: 'transparent', color: c, fontSize: 13, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          opacity: value >= max ? 0.4 : 1,
        }}
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
        padding: '3px 10px', borderRadius: 4, fontSize: 10, fontWeight: 700, cursor: 'pointer', fontFamily: tok.mono,
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
    <div style={{ background: tok.card, border: tok.hairline, borderRadius: 6, padding: '12px 14px' }}>
      <SectionTitle>🎯 Staffing needs</SectionTitle>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginTop: 8 }}>
        <BigStat label="MDs needed" value={out.totalMDs} fg={tok.md.fg} bg={tok.md.bg} bd={tok.md.bd} subtitle={gapLine(mdGap)} subtitleColor={mdGap > 0 ? '#dc2626' : '#16a34a'} />
        <BigStat label="CRNAs needed" value={out.totalCRNAs} fg={tok.crna.fg} bg={tok.crna.bg} bd={tok.crna.bd} subtitle={gapLine(crnaGap)} subtitleColor={crnaGap > 0 ? '#dc2626' : '#16a34a'} />
        <BigStat label="Total staff" value={out.totalStaff} fg="var(--text)" bg="var(--bg-deep)" bd="var(--border)" subtitle={`avail ${avail.mds + avail.crnas}`} subtitleColor={tok.textDim} />
      </div>
    </div>
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
      padding: '10px 12px', borderRadius: 5,
      background: bg, border: `0.5px solid ${bd}`,
    }}>
      <div style={{
        fontSize: 9, color: fg, opacity: 0.75,
        textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700, fontFamily: tok.mono,
      }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 800, color: fg, fontFamily: tok.mono, lineHeight: 1.1, marginTop: 2 }}>
        {value}
      </div>
      <div style={{ fontSize: 10, color: subtitleColor, marginTop: 2, fontFamily: tok.mono }}>
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

// Add a new MD to a given site. Generates a fresh id and uses a generic role
// label — the user can rename later if we ever wire up inline editing.
function addMDInResult(prev: CalculatorOutput, site: string, isSolo: boolean): CalculatorOutput {
  const id = `md-custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const role = isSolo ? 'Solo MD (added)' : 'Supv MD (added)';
  const next = [
    ...prev.assignments.map((a) => ({ ...a, supervises: [...(a.supervises || [])] })),
    { id, type: 'MD', role, site, supervises: [], isSolo, notes: 'Manually added.' } as StaffAssignment,
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
    mds.some((m) => m.site === s.key) || crnas.some((c) => c.site === s.key),
  );

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
  const addMD = (site: string, isSolo: boolean) => {
    setResult((prev) => prev ? addMDInResult(prev, site, isSolo) : prev);
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
    <div style={{ background: tok.card, border: tok.hairline, borderRadius: 6, padding: '12px 14px' }}>
      <SectionTitle>🏥 By site — supervision map</SectionTitle>

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

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
        {lanes.map((site) => {
          const siteMDs = mds.filter((m) => m.site === site.key);
          const siteCRNAs = crnas.filter((c) => c.site === site.key);
          const isFloatPool = site.key === 'Float';
          const is8101Lane = site.key === '8101';
          const displayCRNACount = is8101Lane
            ? crnas.filter((c) => siteMDs.some((m) => m.supervises?.includes(c.id))).length
            : siteCRNAs.length;
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

                  {/* Cross-site coverage: this CRNA's room is at this site,
                      but their supervising MD is elsewhere. Show a ghost row
                      so the lane reflects what's happening here. */}
                  {(() => {
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
                    onAddSupv={() => addMD(site.key, false)}
                    onAddSolo={() => addMD(site.key, true)}
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
    </div>
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
    <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', padding: '4px 0', borderTop: '0.5px dashed var(--border)', marginTop: 4 }}>
      <span style={{ fontSize: 9, color: tok.textDim, fontFamily: tok.mono, fontStyle: 'italic' }}>
        cross-site:
      </span>
      {crnas.map((c) => {
        const sup = mds.find((m) => m.id === c.supervisedBy);
        const supSite = sup ? siteCatalog.find((s) => s.key === sup.site) : null;
        return (
          <span key={'remote-' + c.id} style={{
            display: 'inline-flex', alignItems: 'center', gap: 3,
            padding: '2px 7px', borderRadius: 999,
            background: 'transparent',
            border: `0.5px dashed ${supSite?.color ?? tok.textDim}`,
            fontSize: 10, color: tok.textMuted,
          }}>
            <span style={{ fontWeight: 600, color: tok.text }}>{c.role}</span>
            <span style={{ opacity: 0.6 }}>←</span>
            <span style={{ color: supSite?.color ?? tok.textDim, fontWeight: 700 }}>{sup?.role ?? 'unknown'}</span>
            {supSite && <span style={{ fontFamily: tok.mono, fontSize: 8, color: supSite.color, opacity: 0.7 }}>({supSite.label.split(/[(–—]/)[0].trim()})</span>}
          </span>
        );
      })}
    </div>
  );
}

// Per-lane add row — small ghost buttons for spinning up extra MDs and CRNAs
// without wiping the algorithm's output. Lives inside each lane below the MDs.
function LaneAddControls({ onAddSupv, onAddSolo, onAddCRNA, laneColor }: {
  onAddSupv: () => void;
  onAddSolo: () => void;
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
      <button onClick={onAddSupv} style={btn('+ Supv MD', onAddSupv, '#4A90D9')}>+ Supv MD</button>
      <button onClick={onAddSolo} style={btn('+ Solo MD', onAddSolo, '#B06AE8')}>+ Solo MD</button>
      <button onClick={onAddCRNA} style={btn('+ CRNA', onAddCRNA, tok.crna.fg)}>+ CRNA</button>
      <span style={{ marginLeft: 4, color: tok.textDim, fontSize: 9, alignSelf: 'center' }}>
        in <span style={{ color: laneColor, fontWeight: 700 }}>this lane</span>
      </span>
    </div>
  );
}

function MDBlock({ md, crnas, selectedCRNA, dropTarget, onMDClick, onCRNAClick, onDragStartMD, onDragStartCRNA, onDropOnMD, onDragOver, onDragLeave, onDelete, siteCatalog }: {
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
}) {
  const [hov, setHov] = useState(false);
  const isSolo = md.isSolo;
  // Pick an outline color that says what KIND of MD this is
  const borderCol = isSolo
    ? (md.isCardiac ? '#E05599' : md.is8101 ? '#FFD54F' : md.isFloat ? '#80CBC4' : md.isFloorRunner ? '#00D4AA' : '#B06AE8')
    : (md.is8101 ? '#FFD54F' : md.isFloorRunner ? '#00D4AA' : '#4A90D9');

  const canAccept = !!selectedCRNA;
  const isHovered = dropTarget === md.id;

  // Show every CRNA this MD supervises, regardless of site. Cross-site
  // ones get a "@SiteName" badge so it's obvious where the room actually is.
  // (Previously only 8101 escaped the site filter; we generalized that to
  // every MD because real practice has supervising MDs covering across sites.)
  const myCRNAs = crnas.filter((c) => c.supervisedBy === md.id);

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
      <div style={{
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
          <div style={{ display: 'flex', gap: 3, alignItems: 'center', marginTop: 1 }}>
            {isSolo && <Badge color={borderCol} text="SOLO" />}
            {md.is8101 && <Badge color="#FFD54F" text="8101" dark />}
            {md.isFloorRunner && <Badge color="#00D4AA" text="FR" dark />}
            {myCRNAs.length > 0 && (
              <span style={{ color: tok.textDim, fontSize: 9, fontFamily: tok.mono }}>
                {myCRNAs.length}c
              </span>
            )}
          </div>
        </div>
      </div>
      {myCRNAs.length > 0 && (
        <span style={{ color: borderCol, fontSize: 11, opacity: 0.5 }}>›</span>
      )}
      {myCRNAs.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, minWidth: 0 }}>
          {myCRNAs.map((c) => {
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
        border: `1.5px ${addOn ? 'dashed' : 'solid'} ${selected ? tok.accent : addOn ? tok.warning + '80' : crossSite ? crossSite.color + '80' : tok.crna.bd}`,
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
  return name.length > 8 ? site.key : name;
}

/* ── Output: contingency coverage ───────────────────────────────────────── */

function ContingencyCoverage({ contingencies, assignments }: {
  contingencies: Contingency[];
  assignments: StaffAssignment[];
}) {
  return (
    <div style={{ background: tok.card, border: tok.hairline, borderRadius: 6, padding: '12px 14px' }}>
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
    </div>
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
    <div style={{ background: tok.card, border: tok.hairline, borderRadius: 6, padding: '12px 14px' }}>
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
    </div>
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
    <div style={{ background: tok.card, border: tok.hairline, borderRadius: 6, padding: '12px 14px' }}>
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
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 12, fontWeight: 700, color: '#0ea5e9',
      paddingBottom: 4, borderBottom: tok.hairline, marginBottom: 4,
    }}>
      {children}
    </div>
  );
}
