'use client';

// Physician Planner card (2026-07-20) — the pre-generation "what will this
// block look like for Dr. X" calculator on the scheduling dashboard.
//
//   B. Current stats  — picker + call obligation / working-days numbers for a
//      range, with draft-schedule actuals when one overlaps.
//   C. What-if        — hypothetical FTE / PTO / sell-back / par
//      overrides, side-by-side vs current. Changes nothing.
//   D. Future block   — template×day-type estimates for a range with no
//      schedule yet (default: next month).
//   E. Compare+roster — second physician side-by-side + whole-roster table
//      (the pre-generation analogue of the engine's workDayReport).
//
// ZERO math lives here: every displayed number comes from lib/plannerMath.ts
// (which assembles the single-homed engine helpers) and formatting/order/
// parsing from ./plannerView.ts — both vitest-covered. This file only fetches,
// holds UI state, and renders. Collapsed by default: picker + summary chips.

import { useEffect, useId, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import Link from 'next/link';
import {
  Badge, Banner, Button, Card, EmptyState, Skeleton, Table, scheduleStatusTone,
} from '@/components/ui';
import {
  buildPlannerContext,
  plannerYearCounters,
  providerPlannerNumbers,
  type PlannerAvailabilityRow,
  type PlannerContext,
  type PlannerPayload,
  type PlannerWhatIf,
  type ProviderPlannerNumbers,
} from '@/lib/plannerMath';
import {
  EMPTY_WHAT_IF_INPUTS,
  bucketLabel,
  buildWhatIf,
  deltaTone,
  filterRoster,
  fmt1,
  fmtFte,
  monthRangeAfter,
  monthRangeContaining,
  numberDelta,
  providerLabel,
  signed,
  signedFmt,
  sortBucketRows,
  validPlannerRange,
  yearRangeOf,
  type PlannerRange,
  type WhatIfInputs,
} from './plannerView';

// ── Styles (design-token only — both themes) ─────────────────────────────────

const CONTROL: CSSProperties = {
  background: 'var(--bg-surface)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  padding: '5px 8px',
  fontSize: 'var(--fs-sm)',
  fontFamily: 'inherit',
  lineHeight: 1.4,
  minWidth: 0,
};

const FIELD_LABEL: CSSProperties = {
  display: 'block',
  fontSize: 'var(--fs-xs)',
  fontWeight: 500,
  fontFamily: 'var(--font-mono), ui-monospace, monospace',
  textTransform: 'uppercase',
  letterSpacing: 0.6,
  color: 'var(--text-muted)',
  marginBottom: 'var(--space-1)',
};

const SECTION_HEAD: CSSProperties = {
  fontSize: 'var(--fs-xs)',
  fontWeight: 700,
  fontFamily: 'var(--font-mono), ui-monospace, monospace',
  textTransform: 'uppercase',
  letterSpacing: 1,
  color: 'var(--text-muted)',
  borderBottom: '1px solid var(--border-faint)',
  paddingBottom: 'var(--space-1)',
  marginBottom: 'var(--space-3)',
};

const HINT: CSSProperties = {
  fontSize: 'var(--fs-xs)',
  color: 'var(--text-dim)',
  lineHeight: 1.5,
};

const STAT_LABEL: CSSProperties = {
  fontSize: 'var(--fs-sm)',
  color: 'var(--text-muted)',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--space-1)',
};

const STAT_VALUE: CSSProperties = {
  fontSize: 'var(--fs-sm)',
  fontWeight: 700,
  color: 'var(--text-strong)',
  fontVariantNumeric: 'tabular-nums',
};

// ── Tiny presentational helpers ──────────────────────────────────────────────

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <label htmlFor={id} style={FIELD_LABEL}>{label}</label>
      {children}
    </div>
  );
}

// Hover/focus/click info tooltip (same voice as the provider profile's
// InfoTip, made keyboard-reachable: a real button, Escape/blur closes).
function InfoTip({ text }: { text: string }) {
  const [show, setShow] = useState(false);
  return (
    <span
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      <button
        type="button"
        className="fr-focus"
        aria-label={`Explain: ${text}`}
        onClick={() => setShow(v => !v)}
        onFocus={() => setShow(true)}
        onBlur={() => setShow(false)}
        onKeyDown={e => { if (e.key === 'Escape') setShow(false); }}
        style={{
          width: 14, height: 14, borderRadius: '50%', display: 'inline-flex',
          alignItems: 'center', justifyContent: 'center', padding: 0,
          fontSize: 9, fontWeight: 800, cursor: 'pointer',
          background: 'var(--info-bg)', color: 'var(--info)',
          border: '1px solid var(--border)', flexShrink: 0,
          fontFamily: 'var(--font-mono), ui-monospace, monospace',
        }}
      >
        i
      </button>
      {show && (
        <div
          role="tooltip"
          style={{
            position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)',
            marginTop: 6, padding: '8px 12px', borderRadius: 'var(--radius-sm)',
            fontSize: 'var(--fs-xs)', lineHeight: 1.5,
            background: '#1e293b', color: '#e2e8f0', border: '1px solid #334155',
            boxShadow: 'var(--shadow-card)', width: 280, zIndex: 300, fontWeight: 500,
            whiteSpace: 'normal',
          }}
        >
          {text}
        </div>
      )}
    </span>
  );
}

function StatLine({ label, value, tip, badge }: {
  label: string;
  value: string;
  tip?: string;
  badge?: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', padding: '3px 0' }}>
      <span style={STAT_LABEL}>
        {label}
        {tip && <InfoTip text={tip} />}
      </span>
      <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
        <span style={STAT_VALUE}>{value}</span>
        {badge}
      </span>
    </div>
  );
}

function Chip({ label, value, tip }: { label: string; value: string; tip?: string }) {
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)',
        padding: '3px 10px', borderRadius: 999,
        background: 'var(--tint-surface)', border: '1px solid var(--border-faint)',
        fontSize: 'var(--fs-xs)', whiteSpace: 'nowrap',
      }}
    >
      <span style={{ color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, fontFamily: 'var(--font-mono), ui-monospace, monospace' }}>
        {label}
      </span>
      <span style={{ fontWeight: 700, color: 'var(--text-strong)', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
      {tip && <InfoTip text={tip} />}
    </span>
  );
}

function RangeInputs({ idBase, range, onChange, presets }: {
  idBase: string;
  range: PlannerRange;
  onChange: (r: PlannerRange) => void;
  presets?: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', alignItems: 'flex-end' }}>
      <Field id={`${idBase}-start`} label="From">
        <input
          id={`${idBase}-start`} type="date" className="fr-focus" style={CONTROL}
          value={range.date_start}
          onChange={e => onChange({ ...range, date_start: e.target.value })}
        />
      </Field>
      <Field id={`${idBase}-end`} label="To">
        <input
          id={`${idBase}-end`} type="date" className="fr-focus" style={CONTROL}
          value={range.date_end}
          onChange={e => onChange({ ...range, date_end: e.target.value })}
        />
      </Field>
      {presets}
      {!validPlannerRange(range) && (
        <span style={{ ...HINT, color: 'var(--warn)' }}>Pick a valid range (start ≤ end, ≤ 400 days).</span>
      )}
    </div>
  );
}

// ── Fetch plumbing ───────────────────────────────────────────────────────────

interface Remote<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

// Fetch-on-URL-change hook: null URL clears; stale responses are dropped.
// Errors surface verbatim (Banner) — never rendered as zeros (queries.ts ethos).
function useJson<T>(url: string | null): Remote<T> {
  const [state, setState] = useState<Remote<T>>({ data: null, error: null, loading: false });
  useEffect(() => {
    if (!url) {
      setState({ data: null, error: null, loading: false });
      return;
    }
    let alive = true;
    setState(s => ({ data: s.data, error: null, loading: true }));
    (async () => {
      try {
        const res = await fetch(url);
        const body = await res.json().catch(() => null);
        if (!alive) return;
        if (!res.ok) {
          const msg = body && typeof body.error === 'string' ? body.error : `request failed (${res.status})`;
          setState({ data: null, error: msg, loading: false });
        } else {
          setState({ data: body as T, error: null, loading: false });
        }
      } catch (e) {
        if (alive) setState({ data: null, error: e instanceof Error ? e.message : 'request failed', loading: false });
      }
    })();
    return () => { alive = false; };
  }, [url]);
  return state;
}

interface SiteOption {
  id: string;
  name: string;
  short_name: string | null;
}

// ── Tooltip copy (single place, so the formulas read consistently) ───────────

function obligationTip(n: ProviderPlannerNumbers): string {
  return `Fractional expected calls ${fmt1(n.totalExpected)} = ${n.totalCallSlots} call slots ÷ par ${fmt1(n.parLevel)} × FTE ${fmtFte(n.fte)}, rounded half-up. The stored par is authoritative — it is NOT clamped to the call pool's ΣFTE (${fmt1(n.poolFte)}); when the pool is smaller than the par, obligations under-cover the range and the remainder is the paid-pickup layer, taken after the schedule is built.`;
}

function extrasTip(): string {
  return 'Call weight past the rounded obligation. On the schedule the OVER labels land on the smallest-weight set of the provider\'s calls that covers that overage (later dates first on a tie), so a flagged call can weigh more than the overage itself when no smaller combination fits.';
}

function requiredTip(n: ProviderPlannerNumbers): string {
  return `round(FTE ${fmtFte(n.fte)} × ${n.days.workingDays} working days) − ${n.days.ptoWeekdays} netted PTO weekdays, floored at 0. Working days = weekdays minus MAJOR holidays (minor federal holidays are worked).`;
}

function ptoNettedTip(): string {
  return 'Working days covered by PTO-netting leave (PTO / FMLA / parental / military; pending included, denied/canceled ignored). Sold-back days are removed — the group bought them back, so they are owed again.';
}

function entitledTip(): string {
  return 'Working days − round(FTE × working days): the partial-FTE physician\'s inherent unassigned-days entitlement for the range, independent of PTO.';
}

function yearCountersTip(year: number): string {
  return `Same counting rules as the provider profile page. PTO: weekdays (Mon–Fri) consumed from the pool in ${year}, INCLUDING sold-back days (selling back burns the PTO day and the provider works it at premium); calendar figure counts weekends too. Sell-back / days off / other leave: calendar days. Denied/canceled entries excluded; pending counts; ICU rotation blocks are worked time, not leave.`;
}

// ── The card ─────────────────────────────────────────────────────────────────

export default function PhysicianPlannerCard() {
  const uid = useId();
  const todayIso = useMemo(() => new Date().toISOString().split('T')[0], []);

  const [expanded, setExpanded] = useState(false);
  const [siteId, setSiteId] = useState('');
  const [range, setRange] = useState<PlannerRange>(() => monthRangeContaining(todayIso));
  const [futureRange, setFutureRange] = useState<PlannerRange>(() => monthRangeAfter(todayIso));
  const [search, setSearch] = useState('');
  const [pid, setPid] = useState('');
  const [pid2, setPid2] = useState('');
  const [rosterMode, setRosterMode] = useState(false);
  const [whatIfInputs, setWhatIfInputs] = useState<WhatIfInputs>(EMPTY_WHAT_IF_INPUTS);

  // Sites (org-wide, display_order): the card's scope selector.
  const sitesQ = useJson<SiteOption[]>('/api/scheduling/sites');
  useEffect(() => {
    if (!siteId && sitesQ.data && sitesQ.data.length > 0) setSiteId(sitesQ.data[0].id);
  }, [siteId, sitesQ.data]);

  // Site switch invalidates provider selections (different roster).
  useEffect(() => {
    setPid('');
    setPid2('');
    setSearch('');
  }, [siteId]);

  const plannerUrl = siteId && validPlannerRange(range)
    ? `/api/scheduling/planner?site_id=${encodeURIComponent(siteId)}&date_start=${range.date_start}&date_end=${range.date_end}`
    : null;
  const payloadQ = useJson<PlannerPayload>(plannerUrl);

  const futureUrl = expanded && siteId && validPlannerRange(futureRange)
    ? `/api/scheduling/planner?site_id=${encodeURIComponent(siteId)}&date_start=${futureRange.date_start}&date_end=${futureRange.date_end}`
    : null;
  const futureQ = useJson<PlannerPayload>(futureUrl);

  const yearRange = useMemo(() => yearRangeOf(todayIso), [todayIso]);
  const yearUrl = expanded && pid
    ? `/api/scheduling/availability?provider_id=${encodeURIComponent(pid)}&from=${yearRange.from}&to=${yearRange.to}`
    : null;
  const yearQ = useJson<PlannerAvailabilityRow[]>(yearUrl);

  // ── Derived numbers (all math in plannerMath / plannerView) ────────────────
  const ctx: PlannerContext | null = useMemo(
    () => (payloadQ.data ? buildPlannerContext(payloadQ.data) : null),
    [payloadQ.data],
  );
  const futureCtx: PlannerContext | null = useMemo(
    () => (futureQ.data ? buildPlannerContext(futureQ.data) : null),
    [futureQ.data],
  );

  const roster = payloadQ.data?.roster ?? [];
  const filtered = useMemo(() => filterRoster(roster, search), [roster, search]);
  const rosterHas = (id: string) => roster.some(r => r.provider_id === id);

  const cur = ctx && pid && rosterHas(pid) ? providerPlannerNumbers(ctx, pid) : null;
  const whatIf: PlannerWhatIf | null = useMemo(() => buildWhatIf(whatIfInputs), [whatIfInputs]);
  const hyp = ctx && pid && whatIf && cur ? providerPlannerNumbers(ctx, pid, whatIf) : null;
  const fut = futureCtx && pid && futureCtx.payload.roster.some(r => r.provider_id === pid)
    ? providerPlannerNumbers(futureCtx, pid)
    : null;
  const cmp = ctx && pid2 && rosterHas(pid2) ? providerPlannerNumbers(ctx, pid2) : null;
  const rosterNumbers = useMemo(
    () => (ctx ? ctx.payload.roster.map(r => providerPlannerNumbers(ctx, r.provider_id)) : []),
    [ctx],
  );
  const yearCounters = useMemo(
    () => (yearQ.data ? plannerYearCounters(yearQ.data, yearRange.year) : null),
    [yearQ.data, yearRange.year],
  );

  const nameOf = (id: string) => {
    const r = roster.find(x => x.provider_id === id);
    return r ? providerLabel(r) : id;
  };

  const actualsInfo = payloadQ.data?.actuals ?? null;
  const detailId = `${uid}-detail`;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <Card
      title="Physician Planner"
      actions={
        <>
          <label htmlFor={`${uid}-site`} style={{ ...FIELD_LABEL, marginBottom: 0 }}>Site</label>
          <select
            id={`${uid}-site`} className="fr-focus" style={CONTROL}
            value={siteId} onChange={e => setSiteId(e.target.value)}
            disabled={!sitesQ.data || sitesQ.data.length === 0}
          >
            {(sitesQ.data ?? []).map(s => (
              <option key={s.id} value={s.id}>{s.short_name || s.name}</option>
            ))}
          </select>
          <Button
            variant="secondary" size="sm"
            ariaExpanded={expanded} ariaControls={detailId}
            onClick={() => setExpanded(v => !v)}
          >
            {expanded ? 'Collapse' : 'Expand'}
          </Button>
        </>
      }
    >
      {sitesQ.error && <Banner tone="error">Sites: {sitesQ.error}</Banner>}
      {payloadQ.error && <Banner tone="error">Planner data: {payloadQ.error}</Banner>}

      {!payloadQ.error && !sitesQ.error && (
        sitesQ.data && sitesQ.data.length === 0 ? (
          <EmptyState
            icon="⚑"
            title="No sites yet"
            hint="The planner scopes to one site's roster, templates and par level. Add a site to start planning."
            action={
              <Link href="/sites" style={{ textDecoration: 'none' }}>
                <Button variant="secondary" size="sm">Go to sites</Button>
              </Link>
            }
          />
        ) : !payloadQ.data ? (
          // Pre-fetch and in-flight states both render skeletons — an empty
          // state before the first payload lands would be a fake zero.
          <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
            <Skeleton width="40%" />
            <Skeleton width="70%" />
            <Skeleton width="55%" />
          </div>
        ) : roster.length === 0 ? (
          <EmptyState
            icon="⚖"
            title="No physicians at this site"
            hint="The planner works from active providers with an employment profile homed at the selected site. Add providers and set their FTE / call flags to plan with them."
            action={
              <Link href="/providers" style={{ textDecoration: 'none' }}>
                <Button variant="secondary" size="sm">Go to providers</Button>
              </Link>
            }
          />
        ) : (
          <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
            {/* ── Picker (always visible) ─────────────────────────────────── */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)', alignItems: 'flex-end' }}>
              <Field id={`${uid}-search`} label="Filter roster">
                <input
                  id={`${uid}-search`} type="search" className="fr-focus"
                  style={{ ...CONTROL, width: 140 }}
                  placeholder="Name or initials…"
                  value={search} onChange={e => setSearch(e.target.value)}
                />
              </Field>
              <Field id={`${uid}-pid`} label="Physician">
                <select
                  id={`${uid}-pid`} className="fr-focus" style={{ ...CONTROL, maxWidth: 260 }}
                  value={pid} onChange={e => setPid(e.target.value)}
                >
                  <option value="">Select physician…</option>
                  {filtered.map(r => (
                    <option key={r.provider_id} value={r.provider_id}>
                      {providerLabel(r)}{ctx ? ` — FTE ${fmtFte(ctx.census.fteFor(r.provider_id))}` : ''}
                    </option>
                  ))}
                </select>
              </Field>
              {search && filtered.length === 0 && (
                <span style={HINT}>No roster match for “{search}”.</span>
              )}
              {/* Labels the payload being displayed (state may be mid-edit). */}
              <span style={{ ...HINT, marginLeft: 'auto' }}>
                {payloadQ.data ? `${payloadQ.data.range.date_start} → ${payloadQ.data.range.date_end}` : ''}
                {payloadQ.loading ? ' (updating…)' : ''}
              </span>
            </div>

            {/* ── Summary chips (collapsed view) ──────────────────────────── */}
            {cur ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', alignItems: 'center' }}>
                <Chip label="FTE" value={fmtFte(cur.fte)} />
                <Chip label="Call slots" value={String(cur.totalCallSlots)} />
                <Chip label="Obligation" value={String(cur.obligation)} tip={obligationTip(cur)} />
                {cur.assignedCalls != null && <Chip label="Assigned" value={String(cur.assignedCalls)} />}
                {cur.remainingCalls != null && <Chip label="Remaining" value={String(cur.remainingCalls)} />}
                {cur.extra != null && cur.extra > 0 && (
                  <Badge tone="warn">{cur.extra} extra</Badge>
                )}
                <Chip label="Required days" value={String(cur.days.required)} tip={requiredTip(cur)} />
                <Chip label="Entitled off" value={String(cur.days.entitledOff)} tip={entitledTip()} />
                {cur.dayDelta != null && (
                  <Badge tone={deltaTone(cur.dayDelta)}>{signed(cur.dayDelta)} days</Badge>
                )}
              </div>
            ) : (
              <div style={HINT}>
                Pick a physician to see their expected call obligation and working-days numbers for the range
                {expanded ? '.' : ' — expand for what-if, future blocks, compare, and the roster table.'}
              </div>
            )}

            {/* ── Expanded detail ─────────────────────────────────────────── */}
            {expanded && (
              <div id={detailId} style={{ display: 'grid', gap: 'var(--space-5)' }}>
                {/* B — current block */}
                <section aria-label="Current block stats">
                  <div style={SECTION_HEAD}>Current block</div>
                  <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
                    <RangeInputs
                      idBase={`${uid}-cur`} range={range} onChange={setRange}
                      presets={
                        <>
                          <Button variant="ghost" size="sm" onClick={() => setRange(monthRangeContaining(todayIso))}>
                            This month
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setRange(monthRangeAfter(todayIso))}>
                            Next month
                          </Button>
                        </>
                      }
                    />
                    {actualsInfo ? (
                      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)', ...HINT }}>
                        <span>Actuals from</span>
                        <span style={{ fontWeight: 700, color: 'var(--text-strong)' }}>{actualsInfo.schedule.schedule_name}</span>
                        <Badge tone={scheduleStatusTone(actualsInfo.schedule.status)}>{actualsInfo.schedule.status}</Badge>
                        <span>v{actualsInfo.schedule.version_number} · {actualsInfo.schedule.date_start} → {actualsInfo.schedule.date_end}, clipped to the range</span>
                      </div>
                    ) : (
                      payloadQ.data && (
                        <Banner tone="info">
                          No schedule overlaps this range yet — call numbers are template estimates and the
                          assigned/credited columns are hidden (they would be guesses, not facts).
                        </Banner>
                      )
                    )}

                    {cur ? (
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
                          gap: 'var(--space-4)',
                          alignItems: 'start',
                        }}
                      >
                        {/* Call numbers */}
                        <div>
                          <div style={{ ...FIELD_LABEL, marginBottom: 'var(--space-2)' }}>Call</div>
                          <StatLine label="Rounded obligation" value={String(cur.obligation)} tip={obligationTip(cur)} />
                          {cur.assignedCalls != null && (
                            <>
                              <StatLine label="Assigned" value={String(cur.assignedCalls)} />
                              <StatLine label="Remaining to obligation" value={String(cur.remainingCalls ?? 0)} />
                              <StatLine
                                label="Extras" value={String(cur.extra ?? 0)} tip={extrasTip()}
                                badge={cur.extra != null && cur.extra > 0 ? <Badge tone="warn">over</Badge> : undefined}
                              />
                            </>
                          )}
                          <div style={{ marginTop: 'var(--space-2)' }}>
                            <Table
                              headers={cur.hasActuals
                                ? ['Bucket', 'Slots', 'Expected', 'Assigned']
                                : ['Bucket', 'Slots', 'Expected']}
                              rows={sortBucketRows(cur.buckets).map(b => (cur.hasActuals
                                ? [bucketLabel(b.bucket), String(b.slots), fmt1(b.expected), String(b.assigned ?? 0)]
                                : [bucketLabel(b.bucket), String(b.slots), fmt1(b.expected)]))}
                              empty={<div style={{ ...HINT, padding: 'var(--space-3)' }}>No call templates produce slots in this range.</div>}
                            />
                          </div>
                        </div>

                        {/* Days numbers */}
                        <div>
                          <div style={{ ...FIELD_LABEL, marginBottom: 'var(--space-2)' }}>Working days</div>
                          <StatLine label="Working days in range" value={String(cur.days.workingDays)} tip="Weekdays minus MAJOR federal holidays; minor federal holidays are worked." />
                          <StatLine label="PTO weekdays (netted)" value={String(cur.days.ptoWeekdays)} tip={ptoNettedTip()} />
                          <StatLine label="Required days" value={String(cur.days.required)} tip={requiredTip(cur)} />
                          {cur.credited && (
                            <StatLine
                              label="Credited"
                              value={`${cur.credited.total} (${cur.credited.assignments} assigned · ${cur.credited.postCall} post-call · ${cur.credited.icu} ICU)`}
                              tip="Distinct working days credited by the overlapping schedule: days with any assignment, the working day after each 24h in-house call (post-call rest), and ICU-rotation days. The three sets never overlap."
                            />
                          )}
                          <StatLine label="Entitled off" value={String(cur.days.entitledOff)} tip={entitledTip()} />
                          {cur.dayDelta != null && (
                            <StatLine
                              label="Credited − required"
                              value={signed(cur.dayDelta)}
                              badge={<Badge tone={deltaTone(cur.dayDelta)}>{cur.dayDelta > 0 ? 'over' : cur.dayDelta < 0 ? 'under' : 'on target'}</Badge>}
                            />
                          )}

                          {/* Year counters (profile-page parity) */}
                          <div style={{ marginTop: 'var(--space-3)' }}>
                            <div style={{ ...FIELD_LABEL, marginBottom: 'var(--space-1)', display: 'inline-flex', gap: 'var(--space-1)', alignItems: 'center' }}>
                              {yearRange.year} counters
                              <InfoTip text={yearCountersTip(yearRange.year)} />
                            </div>
                            {yearQ.error ? (
                              <Banner tone="error">Year counters: {yearQ.error}</Banner>
                            ) : yearQ.loading && !yearCounters ? (
                              <Skeleton width="60%" />
                            ) : yearCounters ? (
                              <div style={HINT}>
                                PTO <b style={{ color: 'var(--text-strong)' }}>{yearCounters.pto.weekdaysBooked}</b> wkd
                                {yearCounters.pto.weekdaysSold > 0 ? ` (incl. ${yearCounters.pto.weekdaysSold} sold back)` : ''}
                                {' · '}{yearCounters.pto.calendarBooked} cal
                                {' — sell-back '}<b style={{ color: 'var(--text-strong)' }}>{yearCounters.sellbackDays}</b>
                                {' · days off '}<b style={{ color: 'var(--text-strong)' }}>{yearCounters.daysOffDays}</b>
                                {' · other leave '}<b style={{ color: 'var(--text-strong)' }}>{yearCounters.otherDays}</b>
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div style={HINT}>Pick a physician above to populate this section.</div>
                    )}
                  </div>
                </section>

                {/* C — what-if */}
                <section aria-label="What-if calculator">
                  <div style={{ ...SECTION_HEAD, display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                    <span>What-if</span>
                    <Badge tone="info">hypothetical — changes nothing</Badge>
                    <span style={{ marginLeft: 'auto' }}>
                      <Button variant="ghost" size="sm" onClick={() => setWhatIfInputs(EMPTY_WHAT_IF_INPUTS)} disabled={!whatIf}>
                        Reset
                      </Button>
                    </span>
                  </div>
                  {cur ? (
                    <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)', alignItems: 'flex-end' }}>
                        <Field id={`${uid}-wi-fte`} label={`FTE (now ${fmtFte(cur.fte)})`}>
                          <input
                            id={`${uid}-wi-fte`} type="number" min={0.1} max={1} step={0.05}
                            className="fr-focus" style={{ ...CONTROL, width: 90 }}
                            value={whatIfInputs.fte}
                            onChange={e => setWhatIfInputs(v => ({ ...v, fte: e.target.value }))}
                          />
                        </Field>
                        <Field id={`${uid}-wi-pto`} label="Extra PTO weekdays">
                          <input
                            id={`${uid}-wi-pto`} type="number" min={0} step={1}
                            className="fr-focus" style={{ ...CONTROL, width: 90 }}
                            value={whatIfInputs.extraPto}
                            onChange={e => setWhatIfInputs(v => ({ ...v, extraPto: e.target.value }))}
                          />
                        </Field>
                        <Field id={`${uid}-wi-sell`} label="Sell-back days">
                          <input
                            id={`${uid}-wi-sell`} type="number" min={0} step={1}
                            className="fr-focus" style={{ ...CONTROL, width: 90 }}
                            value={whatIfInputs.sellback}
                            onChange={e => setWhatIfInputs(v => ({ ...v, sellback: e.target.value }))}
                          />
                        </Field>
                        <Field id={`${uid}-wi-par`} label={`Par level (now ${fmt1(cur.parLevel)})`}>
                          <input
                            id={`${uid}-wi-par`} type="number" min={1} step={1}
                            className="fr-focus" style={{ ...CONTROL, width: 90 }}
                            value={whatIfInputs.par}
                            onChange={e => setWhatIfInputs(v => ({ ...v, par: e.target.value }))}
                          />
                        </Field>
                        {/* The Advanced pool-ΣFTE override is gone (par-
                            authoritative 2026-07-24): the pool no longer
                            feeds any denominator, so the lever was dead. */}
                      </div>
                      {hyp ? (
                        <Table
                          headers={['Metric', 'Current', 'What-if', 'Δ']}
                          rows={[
                            ['FTE', fmtFte(cur.fte), fmtFte(hyp.fte), signedFmt(numberDelta(cur.fte, hyp.fte), 2)],
                            ['Par (denominator)', fmt1(cur.parLevel), fmt1(hyp.parLevel), signedFmt(numberDelta(cur.parLevel, hyp.parLevel), 1)],
                            ['Expected calls (fractional)', fmt1(cur.totalExpected), fmt1(hyp.totalExpected), signedFmt(numberDelta(cur.totalExpected, hyp.totalExpected), 1)],
                            ['Rounded obligation', String(cur.obligation), String(hyp.obligation), signed(numberDelta(cur.obligation, hyp.obligation))],
                            ['PTO weekdays (netted)', String(cur.days.ptoWeekdays), String(hyp.days.ptoWeekdays), signed(numberDelta(cur.days.ptoWeekdays, hyp.days.ptoWeekdays))],
                            ['Required days', String(cur.days.required), String(hyp.days.required), signed(numberDelta(cur.days.required, hyp.days.required))],
                            ['Entitled off', String(cur.days.entitledOff), String(hyp.days.entitledOff), signed(numberDelta(cur.days.entitledOff, hyp.days.entitledOff))],
                          ]}
                        />
                      ) : (
                        <div style={HINT}>
                          Set any variable above to see the hypothetical numbers side-by-side with current.
                          Nothing you enter here is saved or affects any schedule.
                        </div>
                      )}
                    </div>
                  ) : (
                    <div style={HINT}>Pick a physician above to run what-ifs.</div>
                  )}
                </section>

                {/* D — future block */}
                <section aria-label="Future block planning">
                  <div style={SECTION_HEAD}>Future block</div>
                  <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
                    <RangeInputs
                      idBase={`${uid}-fut`} range={futureRange} onChange={setFutureRange}
                      presets={
                        <Button variant="ghost" size="sm" onClick={() => setFutureRange(monthRangeAfter(todayIso))}>
                          Next month
                        </Button>
                      }
                    />
                    <div style={HINT}>
                      Estimated from the active templates × the range&apos;s day-type mix (Friday overrides and
                      holiday day types included). Actual schedules may differ — e.g. later required_count changes.
                    </div>
                    {futureQ.error && <Banner tone="error">Future block: {futureQ.error}</Banner>}
                    {futureQ.loading && !futureQ.data && <Skeleton width="50%" />}
                    {futureQ.data?.actuals && (
                      <div style={HINT}>
                        Note: “{futureQ.data.actuals.schedule.schedule_name}” already overlaps this range —
                        the numbers below remain pure template estimates (its actuals show in Current block when the ranges match).
                      </div>
                    )}
                    {fut ? (
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
                          gap: 'var(--space-4)',
                          alignItems: 'start',
                        }}
                      >
                        <Table
                          headers={['Bucket', 'Slots', 'Expected']}
                          rows={sortBucketRows(fut.buckets).map(b => [bucketLabel(b.bucket), String(b.slots), fmt1(b.expected)])}
                          empty={<div style={{ ...HINT, padding: 'var(--space-3)' }}>No call templates produce slots in this range.</div>}
                        />
                        <div>
                          <StatLine label="Call slots in range" value={String(fut.totalCallSlots)} />
                          <StatLine label="Expected calls (fractional)" value={fmt1(fut.totalExpected)} tip={obligationTip(fut)} />
                          <StatLine label="Rounded obligation" value={String(fut.obligation)} />
                          <StatLine label="Working days" value={String(fut.days.workingDays)} />
                          <StatLine label="PTO weekdays (netted)" value={String(fut.days.ptoWeekdays)} tip="From availability entries already on file for this future range." />
                          <StatLine label="Required days" value={String(fut.days.required)} tip={requiredTip(fut)} />
                          <StatLine label="Entitled off" value={String(fut.days.entitledOff)} tip={entitledTip()} />
                        </div>
                      </div>
                    ) : (
                      !futureQ.loading && !futureQ.error && (
                        <div style={HINT}>Pick a physician above to estimate their future block.</div>
                      )
                    )}
                  </div>
                </section>

                {/* E — compare + roster */}
                <section aria-label="Compare physicians and roster table">
                  <div style={{ ...SECTION_HEAD, display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                    <span>Compare &amp; roster</span>
                    <label htmlFor={`${uid}-roster-toggle`} style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)', ...HINT, cursor: 'pointer', textTransform: 'none', letterSpacing: 0 }}>
                      <input
                        id={`${uid}-roster-toggle`} type="checkbox" className="fr-focus"
                        checked={rosterMode} onChange={e => setRosterMode(e.target.checked)}
                      />
                      Whole roster
                    </label>
                  </div>
                  <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
                    {!rosterMode && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)', alignItems: 'flex-end' }}>
                        <Field id={`${uid}-pid2`} label="Compare with">
                          <select
                            id={`${uid}-pid2`} className="fr-focus" style={{ ...CONTROL, maxWidth: 260 }}
                            value={pid2} onChange={e => setPid2(e.target.value)}
                          >
                            <option value="">Select second physician…</option>
                            {roster.map(r => (
                              <option key={r.provider_id} value={r.provider_id} disabled={r.provider_id === pid}>
                                {providerLabel(r)}
                              </option>
                            ))}
                          </select>
                        </Field>
                      </div>
                    )}

                    {rosterMode ? (
                      <Table
                        minWidth={640}
                        headers={ctx?.payload.actuals
                          ? ['Physician', 'FTE', 'Expected', 'Oblig.', 'Assigned', 'Extra', 'PTO wkd', 'Req. days', 'Credited', 'Δ days', 'Off']
                          : ['Physician', 'FTE', 'Expected', 'Oblig.', 'PTO wkd', 'Req. days', 'Off']}
                        rows={rosterNumbers.map(n => {
                          const base = [
                            <span key="n" style={{ fontWeight: 600, color: 'var(--text-strong)' }}>{nameOf(n.providerId)}</span>,
                            fmtFte(n.fte),
                            fmt1(n.totalExpected),
                            String(n.obligation),
                          ];
                          const days = [String(n.days.ptoWeekdays), String(n.days.required)];
                          if (!ctx?.payload.actuals) return [...base, ...days, String(n.days.entitledOff)];
                          return [
                            ...base,
                            String(n.assignedCalls ?? 0),
                            String(n.extra ?? 0),
                            ...days,
                            String(n.credited?.total ?? 0),
                            <Badge key="d" tone={deltaTone(n.dayDelta ?? 0)}>{signed(n.dayDelta ?? 0)}</Badge>,
                            String(n.days.entitledOff),
                          ];
                        })}
                      />
                    ) : cur && cmp ? (
                      <Table
                        headers={['Metric', nameOf(pid), nameOf(pid2)]}
                        rows={[
                          ['FTE', fmtFte(cur.fte), fmtFte(cmp.fte)],
                          ['Expected calls (fractional)', fmt1(cur.totalExpected), fmt1(cmp.totalExpected)],
                          ['Rounded obligation', String(cur.obligation), String(cmp.obligation)],
                          ...(cur.hasActuals
                            ? [
                                ['Assigned calls', String(cur.assignedCalls ?? 0), String(cmp.assignedCalls ?? 0)],
                                ['Extras', String(cur.extra ?? 0), String(cmp.extra ?? 0)],
                              ]
                            : []),
                          ['Working days', String(cur.days.workingDays), String(cmp.days.workingDays)],
                          ['PTO weekdays (netted)', String(cur.days.ptoWeekdays), String(cmp.days.ptoWeekdays)],
                          ['Required days', String(cur.days.required), String(cmp.days.required)],
                          ...(cur.credited && cmp.credited
                            ? [['Credited days', String(cur.credited.total), String(cmp.credited.total)]]
                            : []),
                          ['Entitled off', String(cur.days.entitledOff), String(cmp.days.entitledOff)],
                        ]}
                      />
                    ) : (
                      <div style={HINT}>
                        Pick two physicians for a side-by-side, or flip “Whole roster” for the full table —
                        the pre-generation analogue of the work-day report.
                      </div>
                    )}
                  </div>
                </section>
              </div>
            )}
          </div>
        )
      )}
    </Card>
  );
}
