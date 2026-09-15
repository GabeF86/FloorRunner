'use client';

// Availability tab of /providers/[id] — PTO and PTO sell-back, days off,
// no-call / call requests against an open request window, holiday call, the ICU
// rotation pairs, and everything else (sick, FMLA, conference, blocks).
//
// DYNAMICALLY IMPORTED by page.tsx, and it is the single biggest win of that
// split. This is by a wide margin the heaviest of the eight tabs: eight
// categories, nine add/edit forms, the drag-select CalendarMultiPicker, and the
// engine predicates the counters share with the scheduler — roughly half the
// old page module, shipped on every open of the route including the ones that
// never leave the Profile tab.
//
// EVERYTHING here is availability-only and therefore travels with the tab: the
// row/holiday/window row shapes, the sixteen availability categories and their
// tone maps, the shared POST/PATCH helpers, and all the sub-forms. Nothing was
// promoted to a shared module, because nothing outside this tab reads it —
// promoting it anyway would put it back in the initial chunk.

import { useState, useEffect, useCallback } from 'react';
import { reasonCodeLabel } from '@/lib/validation/providers';
import {
  icuWeekEnd,
  pairIcuRows,
  planIcuEntry,
  ICU_POST_CALL_REASON,
  ICU_WEEK_REASON,
  type IcuPair,
} from '@/lib/icuRotation';
// Pure engine predicates reused so the availability-tab counters and the
// sell-back "standalone" hint can never disagree with the scheduler about
// which rows are live (denied/canceled = dismissed), blocking, or
// bookend-extended (effectivePtoRange).
import { BLOCKING_AVAIL, effectivePtoRange, isDismissedAvailability } from '@/lib/rulesEngine/shared';
import {
  callRequestsEnabled, windowRequestDates, countNoCallRequestUnits,
} from '@/lib/validation/requestIntake';
import { collapseDatesToRanges, countDaysInYear, ptoCounterStats, type DateRange, type PtoCounterStats } from '@/lib/dateRanges';
import { HOLIDAY_CALL_CODES, holidayCallHolderNote } from '@/lib/holidayCall';
import { CalendarMultiPicker } from '@/components/CalendarMultiPicker';
import { Badge, Banner, Button, Card, Spinner, type BadgeTone } from '@/components/ui';
import type { EmploymentProfile } from './profileShared';
import {
  addFormBoxStyle, fieldLabelStyle, fieldInputStyle, structureType,
  InfoTip, Hint, NoneYet, TabStack, PreviewNote,
} from './ui';

interface AvailabilityRow {
  id: string;
  availability_type: string;
  start_date: string;
  end_date: string;
  all_day: boolean;
  reason_code: string | null;
  notes: string | null;
  approval_status: string;
  source: string | null;
}

/** One holiday as the holiday-call route returns it: expanded into every day
 *  it covers (a holiday takes in the weekend it touches). */
interface HolidayCallHoliday {
  id: string;
  holiday_name: string;
  holiday_date: string;
  dates: string[];
}

/** One recorded cell of the holiday-call grid, as the route returns it. */
interface HolidayCallEntryRow {
  id: string;
  provider_id: string;
  provider_name: string;
  date: string;
  code: string;
}

interface RequestWindowInfo {
  id: string;
  site_id: string;
  block_start: string;
  block_end: string;
  max_no_call_requests: number;
  // Admin-set call-request cap (patch36); null/absent = category off.
  max_call_requests?: number | null;
  token: string;
  status: string;
}

// Sixteen availability categories used to carry sixteen hand-picked hues.
// They collapse to the kit's five semantic tones here — not to save colours,
// but because they were never sixteen distinct meanings: they are "time off",
// "working anyway", "asked for", and "administrative". No information is lost,
// since every chip has always shown its label as text; what IS gained is that
// all sixteen now invert correctly (most of the old hexes were dark-theme
// values painted onto the light default).
//
// The two that read against intuition are deliberate and pre-existing clinical
// convention: PTO Sell-Back and Holiday Call mean the provider IS WORKING.
const AVAILABILITY_TYPES: { value: string; label: string; tone: BadgeTone }[] = [
  { value: 'pto', label: 'PTO', tone: 'ok' },
  { value: 'sick', label: 'Sick', tone: 'danger' },
  { value: 'fmla', label: 'FMLA', tone: 'warn' },
  { value: 'conference', label: 'Conference', tone: 'info' },
  { value: 'cme', label: 'CME', tone: 'info' },
  { value: 'admin', label: 'Admin', tone: 'neutral' },
  { value: 'jury_duty', label: 'Jury Duty', tone: 'neutral' },
  { value: 'parental_leave', label: 'Parental Leave', tone: 'warn' },
  { value: 'military_leave', label: 'Military Leave', tone: 'neutral' },
  { value: 'unavailable', label: 'Unavailable', tone: 'neutral' },
  { value: 'blocked', label: 'Blocked', tone: 'neutral' },
  { value: 'no_call_request', label: 'No-Call Request', tone: 'warn' },
  { value: 'call_request', label: 'Call Request', tone: 'ok' },
  // Sell-back is a DANGER tone by convention (matches the schedule grid's
  // sell-back treatment): the provider IS WORKING these dates.
  { value: 'pto_sellback', label: 'PTO Sell-Back', tone: 'danger' },
  // Holiday call (patch44): the provider IS WORKING that holiday. Entered
  // from the Holiday Call card on the schedules page, not here.
  { value: 'holiday_call', label: 'Holiday Call', tone: 'info' },
];

const AVAIL_TYPE_MAP: Record<string, { label: string; tone: BadgeTone }> = {};
AVAILABILITY_TYPES.forEach(t => { AVAIL_TYPE_MAP[t.value] = t; });

// Approval state is exactly what the kit's tones are for: approved is the good
// resting state, pending needs attention, denied is a fault, waitlisted is
// informational, canceled is inert.
const APPROVAL_TONES: Record<string, BadgeTone> = {
  approved: 'ok',
  pending: 'warn',
  denied: 'danger',
  waitlisted: 'info',
  canceled: 'neutral',
};

export function AvailabilityTab({ providerId, profile, orgId, sites }: {
  providerId: string;
  profile: EmploymentProfile | null;
  /** Needed to read the org's holiday calendar for the Holiday Call adder. */
  orgId: string;
  /** Org sites — the Holiday Call adder records against one of them. */
  sites: Array<{ id: string; name: string; short_name: string | null }>;
}) {
  const [rows, setRows] = useState<AvailabilityRow[]>([]);
  const [loading, setLoading] = useState(true);

  const loadAvailability = async () => {
    const res = await fetch(`/api/scheduling/availability?provider_id=${providerId}`);
    if (res.ok) setRows(await res.json());
    setLoading(false);
  };

  useEffect(() => { loadAvailability(); }, [providerId]);

  // Open request window for the provider's HOME site — gates the No-Call
  // Requests section: no open window, no section (Gabriel's rule).
  const homeSiteId = profile?.home_site_id ?? null;
  const [openWindow, setOpenWindow] = useState<RequestWindowInfo | null>(null);
  useEffect(() => {
    if (!homeSiteId) { setOpenWindow(null); return; }
    let cancelled = false;
    fetch(`/api/scheduling/request-windows?site_id=${homeSiteId}&status=open`)
      .then(r => (r.ok ? r.json() : []))
      .then(list => { if (!cancelled) setOpenWindow(Array.isArray(list) && list.length > 0 ? list[0] : null); })
      .catch(() => { if (!cancelled) setOpenWindow(null); });
    return () => { cancelled = true; };
  }, [homeSiteId]);

  const deleteEntry = async (id: string) => {
    if (!confirm('Remove this availability entry?')) return;
    await fetch(`/api/scheduling/availability/${id}`, { method: 'DELETE' });
    await loadAvailability();
  };

  // ICU entries delete both pieces (week + post-call Monday) together.
  const deleteIds = async (ids: string[], message: string) => {
    if (!confirm(message)) return;
    for (const id of ids) {
      await fetch(`/api/scheduling/availability/${id}`, { method: 'DELETE' });
    }
    await loadAvailability();
  };

  const formatDate = (d: string) => {
    const date = new Date(d + 'T12:00:00');
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', padding: 'var(--space-5) 0', color: 'var(--text-muted)', fontSize: 'var(--fs-sm)' }}>
        <Spinner /> Loading availability…
      </div>
    );
  }

  // Category split. ICU rows (blocked + icu_* reason) render in the ICU
  // section only; generic blocked rows stay in Other Leave & Blocks.
  const icuPairs = pairIcuRows(rows);
  const icuIds = new Set<string>();
  for (const p of icuPairs) {
    icuIds.add(p.week.id);
    if (p.monday) icuIds.add(p.monday.id);
  }
  // Orphaned icu_post_call rows (their week row was deleted out-of-band)
  // still shouldn't leak into Other — count them as ICU-owned.
  for (const r of rows) {
    if (r.availability_type === 'blocked' &&
        (r.reason_code === ICU_WEEK_REASON || r.reason_code === ICU_POST_CALL_REASON)) {
      icuIds.add(r.id);
    }
  }
  // …but they must not be INVISIBLE either: an orphaned post-ICU Monday still
  // blocks its date, so render it in the ICU section with a warning + delete
  // (previously it was excluded from every section with no UI way to see or
  // remove it). Weeks-without-Mondays already render via pairIcuRows.
  const icuOrphans = rows.filter(r =>
    r.availability_type === 'blocked' && r.reason_code === ICU_POST_CALL_REASON &&
    !icuPairs.some(p => p.monday?.id === r.id));
  const ptoRows = rows.filter(r => r.availability_type === 'pto');
  const sellbackRows = rows.filter(r => r.availability_type === 'pto_sellback');
  const daysOffRows = rows.filter(r => r.availability_type === 'unavailable');
  const noCallRows = rows.filter(r => r.availability_type === 'no_call_request');
  const callReqRows = rows.filter(r => r.availability_type === 'call_request');
  const holidayCallRows = rows.filter(r => r.availability_type === 'holiday_call');
  const otherRows = rows.filter(r =>
    !['pto', 'pto_sellback', 'unavailable', 'no_call_request', 'call_request', 'holiday_call'].includes(r.availability_type) && !icuIds.has(r.id));

  // ── Category counters: CURRENT-CALENDAR-YEAR counts ──────────────────────
  // Only non-dismissed rows count (denied/canceled excluded; pending counts —
  // it still blocks, clinical invariant 2). Two deliberate counting rules,
  // both documented in each counter's InfoTip:
  //   • PTO — WEEKDAYS (Mon–Fri), NET of sell-back: PTO banks are debited in
  //     working days, so the headline must be comparable to the annual
  //     entitlement, and a sold-back date is a working date, not PTO taken
  //     (same netting the engine does in workDays.ts ptoWeekdaysCovered).
  //     A calendar-day figure rides along as secondary context.
  //   • Sell-Back / Days Off / Other — calendar days: each sold-back day
  //     (weekend call included) is a discrete transaction, and days-off /
  //     leave spans read naturally as calendar days.
  const counterYear = new Date().getFullYear();
  const live = (rs: AvailabilityRow[]) => rs.filter(r => !isDismissedAvailability(r));
  const ptoStats = ptoCounterStats(live(ptoRows), live(sellbackRows), counterYear);
  const sellbackDayCount = countDaysInYear(live(sellbackRows), counterYear);
  const daysOffCount = countDaysInYear(live(daysOffRows), counterYear);
  const otherDayCount = countDaysInYear(live(otherRows), counterYear);

  // Sell-back rows that don't overlap ANY live blocking row are legal but
  // inert — flag them so the chief sees they change nothing yet. Uses the
  // engine's own BLOCKING_AVAIL + dismissed semantics, and the engine's
  // bookend-EXTENDED blocking coverage (effectivePtoRange): a sell-back on
  // the Saturday a Monday-start PTO bookends over DOES unblock that Saturday
  // (shared.test.ts pins it), so it must not be labeled inert.
  const liveBlockingRows = rows.filter(r =>
    BLOCKING_AVAIL.has(r.availability_type) && !isDismissedAvailability(r));
  const sellbackNotes: Record<string, string> = {};
  for (const s of sellbackRows) {
    const overlaps = liveBlockingRows.some(b => {
      const eff = effectivePtoRange(b);
      return eff.start <= s.end_date && eff.end >= s.start_date;
    });
    if (!overlaps) {
      sellbackNotes[s.id] = 'standalone — no overlapping PTO/leave; changes nothing until it overlaps blocking time';
    }
  }

  return (
    <TabStack>
      {/* ── PTO Schedule ─────────────────────────────────────────────────── */}
      <AvailSection
        title="PTO Schedule"
        counter={<PtoCounter year={counterYear} stats={ptoStats} />}
        hint="Vacation / paid time off. Counts toward PTO; blocks scheduling for the range (flanking weekends are handled by the scheduler's bookend rule)."
      >
        <PtoAddForm providerId={providerId} onAdded={loadAvailability} />
        <SectionRows rows={ptoRows} onDelete={deleteEntry} onChanged={loadAvailability} formatDate={formatDate} emptyText="No PTO entries yet." />
      </AvailSection>

      {/* ── PTO Sell-Back ────────────────────────────────────────────────── */}
      <AvailSection
        title="PTO Sell-Back"
        counter={<CategoryCounter label="Total PTO Sell-Back" year={counterYear} days={sellbackDayCount} />}
        hint={'The group bought PTO back — the provider IS WORKING these dates. A sell-back day overrides any PTO or other blocking entry covering it (including pending PTO), and each sold-back weekday is owed again in the working-day math. ' +
          'Standalone entries that don’t overlap PTO or other leave are allowed, but they only change anything where they overlap blocking time.'}
      >
        <RangeAddForm
          providerId={providerId}
          availabilityType="pto_sellback"
          addLabel="Add Sell-Back"
          accent="var(--danger)"
          onAdded={loadAvailability}
        />
        <SectionRows
          rows={sellbackRows}
          onDelete={deleteEntry}
          onChanged={loadAvailability}
          formatDate={formatDate}
          emptyText="No sell-back entries yet."
          noteById={sellbackNotes}
        />
      </AvailSection>

      {/* ── Days Off ─────────────────────────────────────────────────────── */}
      <AvailSection
        title="Days Off"
        counter={<CategoryCounter label="Total Days Off" year={counterYear} days={daysOffCount} />}
        hint="Recurring or personal non-work days for partial-FTE and day docs. Entered as date ranges like PTO, but never counted or displayed as PTO."
      >
        <RangeAddForm
          providerId={providerId}
          availabilityType="unavailable"
          addLabel="Add Days Off"
          onAdded={loadAvailability}
        />
        <SectionRows rows={daysOffRows} onDelete={deleteEntry} onChanged={loadAvailability} formatDate={formatDate} emptyText="No days-off entries yet." />
      </AvailSection>

      {/* ── No Call Requests — only while a request window is OPEN ───────── */}
      {openWindow && (
        <AvailSection
          title="No Call Requests"
          hint={`Request window open for the block ${formatDate(openWindow.block_start)} – ${formatDate(openWindow.block_end)}. ` +
            `Up to ${openWindow.max_no_call_requests} requests — a full weekend (Fri, Sat, Sun) counts as ONE request; ` +
            `the schedule generator avoids them when it can (soft — no approval step).`}
        >
          <NoCallAddForm
            providerId={providerId}
            window={openWindow}
            usedDates={windowRequestDates(noCallRows, openWindow.id, 'no_call_request')}
            onAdded={loadAvailability}
          />
          <SectionRows rows={noCallRows} onDelete={deleteEntry} formatDate={formatDate} emptyText="No no-call requests yet." />
        </AvailSection>
      )}
      {!openWindow && noCallRows.length > 0 && (
        <AvailSection
          title="No Call Requests"
          hint="No request window is currently open for this provider's home site — existing requests are shown read-only; new ones can be entered once a window opens."
        >
          <SectionRows rows={noCallRows} onDelete={deleteEntry} formatDate={formatDate} emptyText="" />
        </AvailSection>
      )}

      {/* ── Call Requests — mirror of No Call: entry only while a window with
             the category ENABLED (max_call_requests ≥ 1) is open ──────────── */}
      {openWindow && callRequestsEnabled(openWindow.max_call_requests) && (
        <AvailSection
          title="Call Requests"
          hint={`Request window open for the block ${formatDate(openWindow.block_start)} – ${formatDate(openWindow.block_end)}. ` +
            `Up to ${openWindow.max_call_requests} dates — each date counts as one request; the schedule generator tries to GIVE call on them (soft — no approval step, never guaranteed).`}
        >
          <CallRequestAddForm
            providerId={providerId}
            window={openWindow}
            usedDates={windowRequestDates(callReqRows, openWindow.id, 'call_request')}
            onAdded={loadAvailability}
          />
          <SectionRows rows={callReqRows} onDelete={deleteEntry} formatDate={formatDate} emptyText="No call requests yet." />
        </AvailSection>
      )}
      {(!openWindow || !callRequestsEnabled(openWindow?.max_call_requests)) && callReqRows.length > 0 && (
        <AvailSection
          title="Call Requests"
          hint="No open request window with call requests enabled for this provider's home site — existing requests are shown read-only; new ones can be entered once an enabled window opens."
        >
          <SectionRows rows={callReqRows} onDelete={deleteEntry} formatDate={formatDate} emptyText="" />
        </AvailSection>
      )}

      {/* ── Holiday Call — the chief's recorded holiday plan (patch44) ────
             ADDABLE from here as well as from Schedules → Holiday Call
             (Gabriel 2026-09-07). Both surfaces POST the same
             /api/scheduling/holiday-call cell write, so they mirror each
             other by construction rather than by two code paths agreeing.
             DATES still are not editable here: a row is one cell of that grid
             (a day × a call code), so moving its date from this side would
             break the pairing — change it by clearing the cell and setting
             the one you want. Delete stays, because a row that no longer
             applies must be removable from the provider it sits on. ─────── */}
      <AvailSection
        title="Holiday Call"
        counter={<CategoryCounter label="Holiday Call Days" year={counterYear} days={countDaysInYear(live(holidayCallRows), counterYear)} />}
        hint="Holiday call this provider is down for. The provider IS WORKING these days — it never reads as time off, and it does not override PTO covering the same day (that stays a conflict for you to resolve). Written in as a locked assignment when a schedule covering the date is created. Shared with Schedules → Holiday Call: anything added here appears there, and vice versa."
      >
        <HolidayCallAddForm
          providerId={providerId}
          orgId={orgId}
          sites={sites}
          homeSiteId={profile?.home_site_id ?? null}
          onAdded={loadAvailability}
        />
        <SectionRows
          rows={holidayCallRows}
          onDelete={deleteEntry}
          formatDate={formatDate}
          emptyText="No holiday call recorded for this provider."
        />
      </AvailSection>

      {/* ── ICU Rotation — for flagged ICU docs, and always when an orphaned
             post-ICU Monday exists (it blocks a date and must stay visible/
             deletable even if the doc's ICU flag was later cleared). ──────── */}
      {(profile?.is_icu_doc || icuOrphans.length > 0) && (
        <AvailSection
          title="ICU Rotation"
          hint="Entering an ICU week blocks the week AND the Monday immediately after it (post-ICU recovery day). Both pieces delete together."
        >
          {profile?.is_icu_doc && (
            <IcuAddForm providerId={providerId} rows={rows} onAdded={loadAvailability} />
          )}
          {icuPairs.length === 0 && icuOrphans.length === 0 ? (
            <NoneYet>No ICU weeks entered yet.</NoneYet>
          ) : (
            icuPairs.map(pair => (
              <IcuPairCard
                key={pair.week.id}
                pair={pair}
                providerId={providerId}
                rows={rows}
                formatDate={formatDate}
                onDeletePair={() => deleteIds(
                  pair.monday ? [pair.week.id, pair.monday.id] : [pair.week.id],
                  'Remove this ICU week (and its post-ICU Monday, if any)?',
                )}
                onChanged={loadAvailability}
              />
            ))
          )}
          {icuOrphans.map(o => (
            <div key={o.id} style={{ marginTop: 'var(--space-3)' }}>
              <Banner tone="warn">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
                  <div>
                    <strong>Orphaned post-ICU Monday</strong> — {formatDate(o.start_date)}
                    <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>
                      Its ICU week entry no longer exists, but this day still blocks scheduling. Delete it if the rest day no longer applies.
                    </div>
                  </div>
                  <Button variant="secondary" size="sm" onClick={() => deleteEntry(o.id)}>Delete</Button>
                </div>
              </Banner>
            </div>
          ))}
        </AvailSection>
      )}

      {/* ── Everything else (sick, FMLA, conference, blocks, …) ──────────── */}
      <AvailSection
        title="Other Leave & Blocks"
        counter={<CategoryCounter label="Total Other Leave" year={counterYear} days={otherDayCount} />}
        hint="Sick, FMLA, conference/CME, admin days, jury duty, parental or military leave, and hard blocks."
      >
        <OtherAddForm providerId={providerId} onAdded={loadAvailability} />
        <SectionRows rows={otherRows} onDelete={deleteEntry} onChanged={loadAvailability} formatDate={formatDate} emptyText="No other entries." />
      </AvailSection>
    </TabStack>
  );
}

// One availability category = one Card. The counter rides in the Card's own
// actions slot, which is what it is for, and the category's counting rule stays
// in the hint directly under the title where it explains the number beside it.
function AvailSection({ title, hint, counter, children }: {
  title: string;
  hint: string;
  // Right-aligned header addition — the category's current-year day counter.
  counter?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card title={title} actions={counter}>
      <Hint>{hint}</Hint>
      {children}
    </Card>
  );
}

// Rides in the Card header's actions slot, which does not shrink — and Card
// clips its overflow. The PTO counter is the long one ("Total PTO Days · 2026:
// 12 weekdays (incl. 3 sold back) · 18 calendar"), so it is capped and allowed
// to wrap rather than being set nowrap and silently cut off on a narrow window.
const COUNTER_STYLE: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap',
  gap: 'var(--space-1)',
  fontSize: 'var(--fs-xs)', fontWeight: 500, color: 'var(--text-muted)',
  letterSpacing: 0.3, lineHeight: 1.5, textAlign: 'right', maxWidth: 420,
  fontFamily: 'var(--font-mono), ui-monospace, monospace',
  // These counters stack down the right edge of eight consecutive Card
  // headers, so their digits are read as a column even though they are not
  // in a table.
  fontVariantNumeric: 'tabular-nums',
};

// Current-calendar-year day counter shown beside the Sell-Back / Days Off /
// Other Leave headers. The counting rule (calendar days, weekends included,
// non-dismissed entries only) is documented in the tooltip so nobody mistakes
// it for the scheduler's Mon–Fri PTO math.
function CategoryCounter({ label, year, days }: { label: string; year: number; days: number }) {
  return (
    <span style={COUNTER_STYLE}>
      {label} · {year}: {days} day{days === 1 ? '' : 's'}
      <InfoTip text={`Calendar-day count for ${year}: every covered day counts once — weekends and weekdays alike (the scheduler's Mon–Fri PTO netting is a separate number). Denied/canceled entries are excluded; pending and approved both count. Entries spanning year boundaries count only their ${year} days.`} />
    </span>
  );
}

// The PTO header counter: WEEKDAYS (Mon–Fri) CONSUMED from the PTO pool —
// the number a chief compares to the annual entitlement. Sell-back semantics
// (Gabriel 2026-07-20): a sold-back day is STILL DEDUCTED from the pool (the
// provider burns the PTO day and works it at premium pay), so the headline
// INCLUDES sold-back days; the sold count is shown inline as information.
function PtoCounter({ year, stats }: { year: number; stats: PtoCounterStats }) {
  const { weekdaysBooked, weekdaysSold, calendarBooked } = stats;
  return (
    <span style={COUNTER_STYLE}>
      Total PTO Days · {year}: {weekdaysBooked} weekday{weekdaysBooked === 1 ? '' : 's'}
      {weekdaysSold > 0 ? ` (incl. ${weekdaysSold} sold back)` : ''}
      {' · '}{calendarBooked} calendar
      <InfoTip text={`Weekday (Mon–Fri) PTO consumed from the pool in ${year} — compare THIS number to the annual entitlement. Sold-back days are INCLUDED: selling back deducts the PTO day AND the provider works it at premium (the sell-back counter tracks those separately). The calendar figure counts every covered day including weekends. Major-holiday exclusion (the scheduler's finer working-days budget) is not applied here. Denied/canceled entries are excluded; pending and approved both count; entries spanning year boundaries count only their ${year} days.`} />
    </span>
  );
}

// Entry list for one section, split into current/upcoming then past (dimmed).
// When onChanged is provided, each entry gets an inline Edit flow (PATCH
// start/end/notes); sections without it (no-call requests) stay delete-only.
function SectionRows({ rows, onDelete, onChanged, formatDate, emptyText, noteById }: {
  rows: AvailabilityRow[];
  onDelete: (id: string) => void;
  onChanged?: () => Promise<void>;
  formatDate: (d: string) => string;
  emptyText: string;
  // Optional per-row annotation badge (e.g. the sell-back "standalone" hint).
  noteById?: Record<string, string>;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = rows.filter(r => r.end_date >= today);
  const past = rows.filter(r => r.end_date < today);
  if (rows.length === 0) {
    return emptyText ? <NoneYet>{emptyText}</NoneYet> : null;
  }
  return (
    <>
      {upcoming.map(r => <AvailabilityCard key={r.id} row={r} onDelete={onDelete} onChanged={onChanged} formatDate={formatDate} note={noteById?.[r.id]} />)}
      {past.length > 0 && (
        <div style={{ opacity: 0.6 }}>
          <div style={{ ...structureType, marginTop: 'var(--space-4)', marginBottom: 'var(--space-1)' }}>
            Past
          </div>
          {past.map(r => <AvailabilityCard key={r.id} row={r} onDelete={onDelete} onChanged={onChanged} formatDate={formatDate} note={noteById?.[r.id]} />)}
        </div>
      )}
    </>
  );
}

// Shared POST helper for the section add-forms.
async function postAvailability(body: Record<string, unknown>): Promise<string | null> {
  const res = await fetch('/api/scheduling/availability', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    return data.error || `Failed (${res.status})`;
  }
  return null;
}

// Shared PATCH helper for the inline edit flows. The route is the hardened
// whitelist PATCH (start_date / end_date / notes / availability_type /
// approval_status only — anything else 400s server-side).
async function patchAvailability(id: string, body: Record<string, unknown>): Promise<string | null> {
  const res = await fetch(`/api/scheduling/availability/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    return data.error || `Failed (${res.status})`;
  }
  return null;
}

// POST one row per collapsed range — the calendar tab's submit path. Returns
// the first error (stops there so the user can retry the remainder after
// fixing; already-created rows simply show up on reload).
async function postRanges(
  providerId: string,
  availabilityType: string,
  ranges: DateRange[],
  notes: string,
): Promise<string | null> {
  for (const r of ranges) {
    const err = await postAvailability({
      provider_id: providerId,
      availability_type: availabilityType,
      start_date: r.start,
      end_date: r.end,
      notes: notes || null,
      approval_status: 'approved',
    });
    if (err) return err;
  }
  return null;
}

// PTO add form — date-range or week-number entry. "Week 1" = the Mon-Sun
// week containing Jan 1 (even if Mon lands in the previous December). PTO
// fills Mon-Fri of that week; the weekend is blocked automatically by the
// bookend rule in the scheduler, so there's no reason to enter Sat/Sun here.
function PtoAddForm({ providerId, onAdded }: { providerId: string; onAdded: () => Promise<void> }) {
  const [mode, setMode] = useState<'date' | 'week' | 'calendar'>('date');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [days, setDays] = useState<string[]>([]);
  const [year, setYear] = useState<number>(new Date().getUTCFullYear());
  const [weekNum, setWeekNum] = useState<number>(1);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const week1Monday = (y: number): Date => {
    const jan1 = new Date(Date.UTC(y, 0, 1));
    const dow = jan1.getUTCDay(); // 0=Sun
    const daysBack = dow === 0 ? 6 : dow - 1;
    jan1.setUTCDate(jan1.getUTCDate() - daysBack);
    return jan1;
  };
  const weeksInYear = (y: number): number => {
    const w1 = week1Monday(y);
    const dec31 = new Date(Date.UTC(y, 11, 31));
    const diffDays = Math.floor((dec31.getTime() - w1.getTime()) / 86400000);
    return Math.floor(diffDays / 7) + 1;
  };
  const weekRange = (y: number, w: number): { mon: string; fri: string } => {
    const mon = week1Monday(y);
    mon.setUTCDate(mon.getUTCDate() + (w - 1) * 7);
    const fri = new Date(mon);
    fri.setUTCDate(mon.getUTCDate() + 4);
    return { mon: mon.toISOString().slice(0, 10), fri: fri.toISOString().slice(0, 10) };
  };

  useEffect(() => {
    if (mode !== 'week') return;
    const { mon, fri } = weekRange(year, weekNum);
    setStart(mon);
    setEnd(fri);
  }, [mode, year, weekNum]);

  const add = async () => {
    setBusy(true); setError(null);
    try {
      let err: string | null;
      if (mode === 'calendar') {
        if (days.length === 0) return;
        err = await postRanges(providerId, 'pto', collapseDatesToRanges(days), notes);
      } else {
        if (!start || !end) return;
        if (end < start) { setError('End date must be on or after start date'); return; }
        err = await postAvailability({
          provider_id: providerId,
          availability_type: 'pto',
          start_date: start,
          end_date: end,
          notes: notes || null,
          approval_status: 'approved',
        });
      }
      if (err) { setError(err); return; }
      setStart(''); setEnd(''); setDays([]); setNotes('');
      await onAdded();
    } finally {
      setBusy(false);
    }
  };

  const canAdd = mode === 'calendar' ? days.length > 0 : (!!start && !!end);

  return (
    <div style={addFormBoxStyle}>
      {error && <div style={{ marginBottom: 'var(--space-3)' }}><Banner tone="error">{error}</Banner></div>}
      <ModeTabs
        options={[
          { value: 'date', label: 'Date Range' },
          { value: 'week', label: 'By Week #' },
          { value: 'calendar', label: 'Calendar' },
        ] as const}
        mode={mode}
        onChange={setMode}
      />
      {mode === 'calendar' && <CalendarPane days={days} onDaysChange={setDays} accent="var(--ok)" />}
      <div style={{
        display: 'grid',
        gridTemplateColumns: mode === 'calendar' ? '1fr auto' : '1fr 1fr 1fr auto',
        gap: 'var(--space-3)', alignItems: 'end',
      }}>
        {mode === 'calendar' ? null : mode === 'date' ? (
          <>
            <div>
              <label style={fieldLabelStyle}>Start Date</label>
              <input type="date" value={start} onChange={e => {
                setStart(e.target.value);
                if (!end || e.target.value > end) setEnd(e.target.value);
              }} className="fr-field" style={fieldInputStyle} />
            </div>
            <div>
              <label style={fieldLabelStyle}>End Date</label>
              <input type="date" value={end} onChange={e => setEnd(e.target.value)} min={start} className="fr-field" style={fieldInputStyle} />
            </div>
          </>
        ) : (
          <>
            <div>
              <label style={fieldLabelStyle}>Year</label>
              <select value={year} onChange={e => setYear(parseInt(e.target.value, 10))} className="fr-field" style={fieldInputStyle}>
                {(() => {
                  const cur = new Date().getUTCFullYear();
                  return [cur - 1, cur, cur + 1, cur + 2].map(y => (
                    <option key={y} value={y}>{y}</option>
                  ));
                })()}
              </select>
            </div>
            <div>
              <label style={fieldLabelStyle}>Week #</label>
              <select value={weekNum} onChange={e => setWeekNum(parseInt(e.target.value, 10))} className="fr-field" style={fieldInputStyle}>
                {Array.from({ length: weeksInYear(year) }, (_, i) => i + 1).map(n => (
                  <option key={n} value={n}>Week {n}</option>
                ))}
              </select>
            </div>
          </>
        )}
        <div>
          <label style={fieldLabelStyle}>Notes</label>
          <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional" className="fr-field" style={fieldInputStyle} />
        </div>
        <Button onClick={add} disabled={busy || !canAdd}>
          {busy ? 'Adding...' : 'Add PTO'}
        </Button>
      </div>
      {mode === 'week' && start && end && (
        <PreviewNote>
          Week {weekNum}: {new Date(start + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – {new Date(end + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} (Mon–Fri). Flanking Sat/Sun are blocked automatically.
        </PreviewNote>
      )}
    </div>
  );
}

// Generic date-range add form used by the Days Off and PTO Sell-Back
// sections. Date-range and Calendar entry modes.
function RangeAddForm({ providerId, availabilityType, addLabel, accent = 'var(--blue)', onAdded }: {
  providerId: string;
  availabilityType: string;
  addLabel: string;
  accent?: string;
  onAdded: () => Promise<void>;
}) {
  const [mode, setMode] = useState<'date' | 'calendar'>('date');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [days, setDays] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    setBusy(true); setError(null);
    try {
      let err: string | null;
      if (mode === 'calendar') {
        if (days.length === 0) return;
        err = await postRanges(providerId, availabilityType, collapseDatesToRanges(days), notes);
      } else {
        if (!start || !end) return;
        if (end < start) { setError('End date must be on or after start date'); return; }
        err = await postAvailability({
          provider_id: providerId,
          availability_type: availabilityType,
          start_date: start,
          end_date: end,
          notes: notes || null,
          approval_status: 'approved',
        });
      }
      if (err) { setError(err); return; }
      setStart(''); setEnd(''); setDays([]); setNotes('');
      await onAdded();
    } finally {
      setBusy(false);
    }
  };

  const canAdd = mode === 'calendar' ? days.length > 0 : (!!start && !!end);

  return (
    <div style={addFormBoxStyle}>
      {error && <div style={{ marginBottom: 'var(--space-3)' }}><Banner tone="error">{error}</Banner></div>}
      <ModeTabs
        options={[
          { value: 'date', label: 'Date Range' },
          { value: 'calendar', label: 'Calendar' },
        ] as const}
        mode={mode}
        onChange={setMode}
      />
      {mode === 'calendar' && <CalendarPane days={days} onDaysChange={setDays} accent={accent} />}
      <div style={{
        display: 'grid',
        gridTemplateColumns: mode === 'calendar' ? '1fr auto' : '1fr 1fr 1fr auto',
        gap: 'var(--space-3)', alignItems: 'end',
      }}>
        {mode === 'date' && (
          <>
            <div>
              <label style={fieldLabelStyle}>Start Date</label>
              <input type="date" value={start} onChange={e => {
                setStart(e.target.value);
                if (!end || e.target.value > end) setEnd(e.target.value);
              }} className="fr-field" style={fieldInputStyle} />
            </div>
            <div>
              <label style={fieldLabelStyle}>End Date</label>
              <input type="date" value={end} onChange={e => setEnd(e.target.value)} min={start} className="fr-field" style={fieldInputStyle} />
            </div>
          </>
        )}
        <div>
          <label style={fieldLabelStyle}>Notes</label>
          <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional" className="fr-field" style={fieldInputStyle} />
        </div>
        <Button onClick={add} disabled={busy || !canAdd}>
          {busy ? 'Adding...' : addLabel}
        </Button>
      </div>
    </div>
  );
}

// Window request add (no-call + its 2026-07-22 call-request mirror) — routes
// through the SAME token-gated intake endpoint the public form uses, so each
// per-window cap has exactly one enforcement point. The cap is counted in
// REQUESTS: per-date for call; in weekend units for no-call (a full Fri/Sat/
// Sun weekend = ONE request — countNoCallRequestUnits, Gabriel 2026-07-22),
// which is why the form takes the used DATES, not a bare row count.
function WindowRequestAddForm({ providerId, window: win, usedDates, onAdded, kind }: {
  providerId: string;
  window: RequestWindowInfo;
  usedDates: string[];
  onAdded: () => Promise<void>;
  kind: 'no_call' | 'call';
}) {
  const [mode, setMode] = useState<'date' | 'calendar'>('date');
  const [date, setDate] = useState('');
  // Calendar mode: multiple dates submitted in ONE intake POST (the endpoint
  // takes no_call_dates[]/call_dates[] and enforces the per-window cap
  // itself). The picker is clamped to the window's block range.
  const [days, setDays] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const max = kind === 'no_call' ? win.max_no_call_requests : (win.max_call_requests ?? 0);
  // Tokens. CalendarMultiPicker mixes its tint with color-mix now, so the note
  // that used to sit here — "it concatenates `${accent}26`, so it cannot take a
  // CSS variable" — has been untrue since that component was fixed, and every
  // other CalendarPane call site already passes a token. What was left behind
  // was #fbbf24 / #34d399: the DARK values of --warn and --ok, painted on the
  // light default, where the tokens are deliberately deeper so small accent
  // text clears AA.
  const accent = kind === 'no_call' ? 'var(--warn)' : 'var(--ok)';
  const usedCount = kind === 'no_call' ? countNoCallRequestUnits(usedDates) : usedDates.length;

  const add = async () => {
    const dates = mode === 'calendar' ? days : (date ? [date] : []);
    if (dates.length === 0) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/requests/submit/${win.token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider_id: providerId,
          [kind === 'no_call' ? 'no_call_dates' : 'call_dates']: dates,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || `Failed (${res.status})`);
        return;
      }
      setDate(''); setDays([]);
      await onAdded();
    } finally {
      setBusy(false);
    }
  };

  const selected = mode === 'calendar' ? days : (date ? [date] : []);
  const selectedCount = selected.length;
  // Projected usage if this selection lands: unit math for no-call (union
  // with existing dates, so completing an already-counted weekend is free);
  // plain addition for call.
  const projectedCount = kind === 'no_call'
    ? countNoCallRequestUnits([...usedDates, ...selected])
    : usedDates.length + selectedCount;
  const canAdd = selectedCount > 0 && projectedCount <= max;

  return (
    <div style={addFormBoxStyle}>
      {error && <div style={{ marginBottom: 'var(--space-3)' }}><Banner tone="error">{error}</Banner></div>}
      <ModeTabs
        options={[
          { value: 'date', label: 'Date' },
          { value: 'calendar', label: 'Calendar' },
        ] as const}
        mode={mode}
        onChange={setMode}
      />
      {mode === 'calendar' && (
        <CalendarPane
          days={days}
          onDaysChange={setDays}
          accent={accent}
          minDate={win.block_start}
          maxDate={win.block_end}
        />
      )}
      <div style={{
        display: 'grid',
        gridTemplateColumns: mode === 'calendar' ? 'auto auto' : '1fr auto auto',
        gap: 'var(--space-3)', alignItems: 'end', justifyContent: mode === 'calendar' ? 'start' : undefined,
      }}>
        {mode === 'date' && (
          <div>
            <label style={fieldLabelStyle}>{kind === 'no_call' ? 'No-Call Date' : 'Call Date'}</label>
            <input
              type="date"
              value={date}
              min={win.block_start}
              max={win.block_end}
              onChange={e => setDate(e.target.value)}
              className="fr-field" style={fieldInputStyle}
            />
          </div>
        )}
        <div style={{
          fontSize: 'var(--fs-sm)', color: 'var(--text-muted)',
          paddingBottom: 'var(--space-2)',
          // The tally re-counts on every date the user picks; tabular digits
          // stop the line reflowing as 9/10 becomes 10/10.
          fontVariantNumeric: 'tabular-nums',
        }}>
          {usedCount}/{max} request{max === 1 ? '' : 's'} used
          {mode === 'calendar' && selectedCount > 0 && projectedCount > max && (
            <span style={{ color: 'var(--danger)', fontWeight: 700 }}> — the selection needs {projectedCount} total, over the {max} allowed</span>
          )}
        </div>
        <Button onClick={add} disabled={busy || !canAdd}>
          {busy ? 'Adding...' : selectedCount > 1 ? `Add ${selectedCount} Requests` : 'Add Request'}
        </Button>
      </div>
    </div>
  );
}

function NoCallAddForm(props: {
  providerId: string;
  window: RequestWindowInfo;
  usedDates: string[];
  onAdded: () => Promise<void>;
}) {
  return <WindowRequestAddForm {...props} kind="no_call" />;
}

function CallRequestAddForm(props: {
  providerId: string;
  window: RequestWindowInfo;
  usedDates: string[];
  onAdded: () => Promise<void>;
}) {
  return <WindowRequestAddForm {...props} kind="call" />;
}

// ICU week entry: default end = start + 6; creates the week row and (unless
// already covered) the post-ICU Monday row via planIcuEntry.
// ── Holiday Call add form ───────────────────────────────────────────────────
// The profile-side half of the Holiday Call grid (Gabriel 2026-09-07: "add
// Holiday Call schedule to the physicians profile under availability... This
// should mirror what ever is entered in the holiday call schedule on the
// schedule dashboard and vice versa").
//
// MIRRORING IS BY CONSTRUCTION, NOT BY AGREEMENT. This posts to the very same
// /api/scheduling/holiday-call endpoint the card posts to, and both read the
// same provider_availability rows. There is no second write path to keep in
// step — a change here IS the change there.
//
// Two consequences of that endpoint's contract, surfaced rather than hidden:
//   • The grid is SINGLE-VALUED per (day, code). Assigning this provider to a
//     cell someone else holds REPLACES them. The current holder is shown
//     before you commit, so that is a decision rather than a surprise.
//   • One code per provider per day. A second code for the same day is
//     refused by the route with a 409, whose message we surface verbatim.
//
// The holiday list is the route's own — major holidays only, each expanded
// into every day it covers (Christmas on a Friday is three days), so this
// form can never offer a day the card would not.
function HolidayCallAddForm({ providerId, orgId, sites, homeSiteId, onAdded }: {
  providerId: string;
  orgId: string;
  sites: Array<{ id: string; name: string; short_name: string | null }>;
  homeSiteId: string | null;
  onAdded: () => Promise<void>;
}) {
  const [year, setYear] = useState(() => new Date().getFullYear());
  // The grid is SITE-SCOPED, and call takers span six sites — so which site a
  // row is recorded against decides whether the card shows it. Defaults to the
  // provider's home site, which is the site they would be covering; the picker
  // is here so recording for another site is possible and, more importantly,
  // so the scoping is never invisible.
  const [siteId, setSiteId] = useState<string | null>(homeSiteId);
  useEffect(() => { setSiteId(homeSiteId); }, [homeSiteId]);
  const [holidays, setHolidays] = useState<HolidayCallHoliday[]>([]);
  const [entries, setEntries] = useState<HolidayCallEntryRow[]>([]);
  const [date, setDate] = useState('');
  const [code, setCode] = useState<string>(HOLIDAY_CALL_CODES[0].code);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ org_id: orgId, year: String(year) });
      if (siteId) params.set('site_id', siteId);
      const res = await fetch('/api/scheduling/holiday-call?' + params);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || `Could not load holidays (${res.status})`);
        setHolidays([]); setEntries([]);
        return;
      }
      const json = await res.json();
      setHolidays(json.holidays ?? []);
      setEntries(json.entries ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
      setHolidays([]); setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [orgId, siteId, year]);

  useEffect(() => { load(); }, [load]);

  // Every day of every holiday, flattened, with the holiday it belongs to —
  // the same expansion the card shows, so the two offer identical choices.
  const days = holidays.flatMap(h => h.dates.map(d => ({ date: d, holidayName: h.holiday_name })));
  // Reset a stale selection whenever the year changes under it.
  useEffect(() => {
    if (days.length > 0 && !days.some(d => d.date === date)) setDate(days[0].date);
    if (days.length === 0 && date !== '') setDate('');
    // `days` is derived from holidays; keying on its length + first date is
    // enough to catch a year change without rebuilding the array identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holidays]);

  const holder = entries.find(e => e.date === date && e.code === code);
  const holderNote = holidayCallHolderNote(holder, providerId, code);
  const selectedDay = days.find(d => d.date === date);

  const submit = async () => {
    if (!date || !selectedDay) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/scheduling/holiday-call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider_id: providerId,
          site_id: siteId,
          date,
          code,
          holiday_name: selectedDay.holidayName,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || `Could not save (${res.status})`);
        return;
      }
      await load();
      await onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setSaving(false);
    }
  };

  if (!orgId) return null;

  return (
    <div style={addFormBoxStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <Button variant="secondary" size="sm" title="Previous year" onClick={() => setYear(y => y - 1)}>&larr;</Button>
        <span style={{
          fontSize: 'var(--fs-md)', fontWeight: 700, minWidth: 40, textAlign: 'center',
          fontFamily: 'var(--font-mono), ui-monospace, monospace',
          // Stepping the year must not re-measure the label under the arrows.
          fontVariantNumeric: 'tabular-nums',
        }}>{year}</span>
        <Button variant="secondary" size="sm" title="Next year" onClick={() => setYear(y => y + 1)}>&rarr;</Button>

        <select
          value={date}
          onChange={e => setDate(e.target.value)}
          className="fr-field" style={{ ...fieldInputStyle, cursor: 'pointer', minWidth: 210, width: 'auto' }}
          aria-label="Holiday day"
          disabled={loading || days.length === 0}
        >
          {days.length === 0 && <option value="">{loading ? 'Loading…' : 'No major holidays'}</option>}
          {days.map(d => (
            <option key={d.date} value={d.date}>
              {d.holidayName} — {new Date(d.date + 'T12:00:00').toLocaleDateString('en-US',
                { weekday: 'short', month: 'short', day: 'numeric' })}
            </option>
          ))}
        </select>

        <select
          value={siteId ?? ''}
          onChange={e => setSiteId(e.target.value || null)}
          className="fr-field" style={{ ...fieldInputStyle, cursor: 'pointer', width: 'auto' }}
          aria-label="Site this holiday call is recorded for"
        >
          <option value="">All sites (no site)</option>
          {sites.map(s => (
            <option key={s.id} value={s.id}>{s.short_name || s.name}</option>
          ))}
        </select>

        <select
          value={code}
          onChange={e => setCode(e.target.value)}
          className="fr-field" style={{ ...fieldInputStyle, cursor: 'pointer', width: 'auto' }}
          aria-label="Call code"
        >
          {HOLIDAY_CALL_CODES.map(c => (
            <option key={c.code} value={c.code}>{c.label}</option>
          ))}
        </select>

        <Button onClick={submit}
          disabled={saving || loading || !date}>
          {saving ? 'Saving…' : 'Add'}
        </Button>
      </div>

      {holderNote && (
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--warn)', marginTop: 'var(--space-2)', lineHeight: 1.5 }}>
          {holderNote}
        </div>
      )}

      {error && <div style={{ marginTop: 'var(--space-3)' }}><Banner tone="error">{error}</Banner></div>}
    </div>
  );
}

function IcuAddForm({ providerId, rows, onAdded }: {
  providerId: string;
  rows: AvailabilityRow[];
  onAdded: () => Promise<void>;
}) {
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveEnd = end || (start ? icuWeekEnd(start) : '');

  const add = async () => {
    if (!start) return;
    setBusy(true); setError(null);
    try {
      const plan = planIcuEntry(start, end || undefined, rows);
      const weekErr = await postAvailability({
        provider_id: providerId,
        availability_type: plan.week.availability_type,
        start_date: plan.week.start_date,
        end_date: plan.week.end_date,
        reason_code: plan.week.reason_code,
        approval_status: 'approved',
      });
      if (weekErr) { setError(weekErr); return; }
      if (plan.monday) {
        const mondayErr = await postAvailability({
          provider_id: providerId,
          availability_type: plan.monday.availability_type,
          start_date: plan.monday.start_date,
          end_date: plan.monday.end_date,
          reason_code: plan.monday.reason_code,
          approval_status: 'approved',
        });
        if (mondayErr) { setError(`Week saved, but the post-ICU Monday failed: ${mondayErr}`); return; }
      }
      setStart(''); setEnd('');
      await onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to plan ICU entry');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={addFormBoxStyle}>
      {error && <div style={{ marginBottom: 'var(--space-3)' }}><Banner tone="error">{error}</Banner></div>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 'var(--space-3)', alignItems: 'end' }}>
        <div>
          <label style={fieldLabelStyle}>Week Start</label>
          <input type="date" value={start} onChange={e => setStart(e.target.value)} className="fr-field" style={fieldInputStyle} />
        </div>
        <div>
          <label style={fieldLabelStyle}>Week End (default +6 days)</label>
          <input type="date" value={end} min={start} placeholder="start + 6" onChange={e => setEnd(e.target.value)} className="fr-field" style={fieldInputStyle} />
        </div>
        <Button onClick={add} disabled={busy || !start}>
          {busy ? 'Adding...' : 'Add ICU Week'}
        </Button>
      </div>
      {start && (
        <PreviewNote>
          Blocks {start} – {effectiveEnd}, plus the following Monday off.
        </PreviewNote>
      )}
    </div>
  );
}

// ICU pair display + pairing-aware EDIT flow. The generic AvailabilityCard
// edit (single-row PATCH) must never touch ICU rows — an ICU entry is TWO
// rows (week + post-ICU Monday, src/lib/icuRotation.ts) that have to move
// together. Editing here re-derives the Monday from the new week end via
// planIcuEntry (the same planner the add flow uses) and reconciles:
//   plan wants a Monday, pair has one   → PATCH the Monday row to the new date
//   plan wants a Monday, pair has none  → POST a new icu_post_call row
//   plan says covered, pair has one     → DELETE the now-redundant Monday row
// so week+Monday pairing stays consistent through edits.
function IcuPairCard({ pair, providerId, rows, formatDate, onDeletePair, onChanged }: {
  pair: IcuPair<AvailabilityRow>;
  providerId: string;
  rows: AvailabilityRow[];
  formatDate: (d: string) => string;
  onDeletePair: () => void;
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [start, setStart] = useState(pair.week.start_date);
  const [end, setEnd] = useState(pair.week.end_date);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!start || !end) return;
    if (end < start) { setError('Week end must be on or after the start'); return; }
    setBusy(true); setError(null);
    try {
      // Re-plan against every OTHER row so "Monday already covered" reflects
      // the world without this pair (its own rows are the ones moving).
      const others = rows.filter(r => r.id !== pair.week.id && r.id !== pair.monday?.id);
      const plan = planIcuEntry(start, end, others);

      const weekErr = await patchAvailability(pair.week.id, {
        start_date: plan.week.start_date,
        end_date: plan.week.end_date,
      });
      if (weekErr) { setError(weekErr); return; }

      let mondayErr: string | null = null;
      if (plan.monday && pair.monday) {
        mondayErr = await patchAvailability(pair.monday.id, {
          start_date: plan.monday.start_date,
          end_date: plan.monday.end_date,
        });
      } else if (plan.monday && !pair.monday) {
        mondayErr = await postAvailability({
          provider_id: providerId,
          availability_type: plan.monday.availability_type,
          start_date: plan.monday.start_date,
          end_date: plan.monday.end_date,
          reason_code: plan.monday.reason_code,
          approval_status: 'approved',
        });
      } else if (!plan.monday && pair.monday) {
        const res = await fetch(`/api/scheduling/availability/${pair.monday.id}`, { method: 'DELETE' });
        if (!res.ok) mondayErr = `Failed to remove the old Monday (${res.status})`;
      }
      if (mondayErr) {
        setError(`Week saved, but the post-ICU Monday failed: ${mondayErr}`);
        await onChanged(); // week DID move — resync so the UI shows reality
        return;
      }
      setEditing(false);
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update ICU week');
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <div style={{ ...addFormBoxStyle, borderColor: 'var(--border)', marginTop: 'var(--space-3)' }}>
        {error && <div style={{ marginBottom: 'var(--space-3)' }}><Banner tone="error">{error}</Banner></div>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-3)' }}>
          <Badge tone="info">ICU Week</Badge>
          <span style={structureType}>editing — the post-ICU Monday moves with the week</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto auto', gap: 'var(--space-3)', alignItems: 'end' }}>
          <div style={{ minWidth: 0 }}>
            <label style={fieldLabelStyle}>Week Start</label>
            <input type="date" value={start} onChange={e => setStart(e.target.value)} className="fr-field" style={fieldInputStyle} />
          </div>
          <div style={{ minWidth: 0 }}>
            <label style={fieldLabelStyle}>Week End</label>
            <input type="date" value={end} min={start} onChange={e => setEnd(e.target.value)} className="fr-field" style={fieldInputStyle} />
          </div>
          <Button onClick={save} disabled={busy || !start || !end}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setEditing(false); setError(null);
              setStart(pair.week.start_date); setEnd(pair.week.end_date);
            }}
            disabled={busy}
          >
            Cancel
          </Button>
        </div>
        {start && end && end >= start && (
          <PreviewNote>
            Will block {start} – {end}, plus the following Monday off (re-derived).
          </PreviewNote>
        )}
      </div>
    );
  }

  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      gap: 'var(--space-3)', flexWrap: 'wrap',
      padding: 'var(--space-3) 0',
      borderTop: '1px solid var(--border-faint)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        <Badge tone="info">ICU Week</Badge>
        <div>
          <div style={{ fontSize: 'var(--fs-md)', fontWeight: 600, color: 'var(--text-strong)' }}>
            {formatDate(pair.week.start_date)} — {formatDate(pair.week.end_date)}
          </div>
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', marginTop: 2 }}>
            {pair.monday
              ? `+ post-ICU Monday off ${formatDate(pair.monday.start_date)}`
              : 'post-ICU Monday covered by another blocked entry'}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
        <Button variant="ghost" size="sm" onClick={() => setEditing(true)} title="Edit ICU week (the Monday re-derives)">
          Edit
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onDeletePair}
          title="Delete ICU week + Monday"
          style={{ color: 'var(--danger)' }}
        >
          Remove
        </Button>
      </div>
    </div>
  );
}

// Add form for the remaining availability types (sick, FMLA, conference, …).
// pto_sellback is excluded — it has its own dedicated section.
const OTHER_ENTRY_TYPES = AVAILABILITY_TYPES.filter(
  t => !['pto', 'pto_sellback', 'unavailable', 'no_call_request'].includes(t.value),
);

function OtherAddForm({ providerId, onAdded }: { providerId: string; onAdded: () => Promise<void> }) {
  const [mode, setMode] = useState<'date' | 'calendar'>('date');
  const [type, setType] = useState(OTHER_ENTRY_TYPES[0]?.value || 'sick');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [days, setDays] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    setBusy(true); setError(null);
    try {
      let err: string | null;
      if (mode === 'calendar') {
        if (days.length === 0) return;
        err = await postRanges(providerId, type, collapseDatesToRanges(days), notes);
      } else {
        if (!start || !end) return;
        if (end < start) { setError('End date must be on or after start date'); return; }
        err = await postAvailability({
          provider_id: providerId,
          availability_type: type,
          start_date: start,
          end_date: end,
          notes: notes || null,
          approval_status: 'approved',
        });
      }
      if (err) { setError(err); return; }
      setStart(''); setEnd(''); setDays([]); setNotes('');
      await onAdded();
    } finally {
      setBusy(false);
    }
  };

  const canAdd = mode === 'calendar' ? days.length > 0 : (!!start && !!end);

  return (
    <div style={addFormBoxStyle}>
      {error && <div style={{ marginBottom: 'var(--space-3)' }}><Banner tone="error">{error}</Banner></div>}
      <ModeTabs
        options={[
          { value: 'date', label: 'Date Range' },
          { value: 'calendar', label: 'Calendar' },
        ] as const}
        mode={mode}
        onChange={setMode}
      />
      {mode === 'calendar' && <CalendarPane days={days} onDaysChange={setDays} />}
      <div style={{
        display: 'grid',
        gridTemplateColumns: mode === 'calendar' ? '1fr 1fr auto' : '1fr 1fr 1fr 1fr auto',
        gap: 'var(--space-3)', alignItems: 'end',
      }}>
        <div>
          <label style={fieldLabelStyle}>Type</label>
          <select value={type} onChange={e => setType(e.target.value)} className="fr-field" style={fieldInputStyle}>
            {OTHER_ENTRY_TYPES.map(t => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>
        {mode === 'date' && (
          <>
            <div>
              <label style={fieldLabelStyle}>Start Date</label>
              <input type="date" value={start} onChange={e => {
                setStart(e.target.value);
                if (!end || e.target.value > end) setEnd(e.target.value);
              }} className="fr-field" style={fieldInputStyle} />
            </div>
            <div>
              <label style={fieldLabelStyle}>End Date</label>
              <input type="date" value={end} onChange={e => setEnd(e.target.value)} min={start} className="fr-field" style={fieldInputStyle} />
            </div>
          </>
        )}
        <div>
          <label style={fieldLabelStyle}>Notes</label>
          <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional" className="fr-field" style={fieldInputStyle} />
        </div>
        <Button onClick={add} disabled={busy || !canAdd}>
          {busy ? 'Adding...' : 'Add'}
        </Button>
      </div>
    </div>
  );
}

// Entry-mode tab strip shared by every add box (Date Range / By Week # /
// Calendar). One look, one behavior.
//
// It no longer takes an `accent`: four categories passing four different hex
// accents made the SAME control look like four different controls, and the
// category is already named in the Card title directly above it. This is now a
// plain segmented control — an inset track with the live segment raised onto
// the surface colour.
function ModeTabs<T extends string>({ options, mode, onChange }: {
  options: ReadonlyArray<{ value: T; label: string }>;
  mode: T;
  onChange: (m: T) => void;
}) {
  return (
    <div style={{
      display: 'inline-flex', gap: 2, marginBottom: 'var(--space-3)',
      padding: 2, borderRadius: 'var(--radius-sm)',
      background: 'var(--tint-surface)', border: '1px solid var(--border-faint)',
    }}>
      {options.map(o => {
        const on = mode === o.value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            // Live segment: no hover repaint (it is already the raised one).
            // Dormant segment: the ghost contract — its label warms toward
            // --text. Both get .fr-btn's motion tokens and press nudge.
            className={`fr-focus fr-btn${on ? '' : ' fr-btn-ghost'}`}
            onClick={() => onChange(o.value)}
            style={{
              padding: '4px 12px', cursor: 'pointer',
              // Concentric with the 2px-padded track above, expressed rather
              // than guessed: inner radius = outer radius − the gap.
              borderRadius: 'calc(var(--radius-sm) - 2px)',
              fontSize: 'var(--fs-sm)', fontWeight: on ? 700 : 500, fontFamily: 'inherit',
              // Only the LIVE segment paints inline. The dormant one takes its
              // resting background/ink/border from .fr-btn-ghost, which is the
              // same rule that then warms them on hover — declaring them here
              // outranks the class and the "ghost contract" above becomes a
              // comment describing something that does not happen.
              ...(on ? {
                background: 'var(--bg-surface)',
                color: 'var(--text-strong)',
                border: '1px solid var(--border)',
              } : null),
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

const fmtShortDate = (d: string) =>
  new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const rangeLabel = (r: DateRange) =>
  r.start === r.end ? fmtShortDate(r.start) : `${fmtShortDate(r.start)}–${fmtShortDate(r.end)}`;

// Calendar-tab pane shared by every category's add box: the drag-select month
// grid plus a live summary of what submit will create (contiguous runs
// collapse to date-range rows; isolated days become single-day rows —
// src/lib/dateRanges.ts collapseDatesToRanges).
function CalendarPane({ days, onDaysChange, accent = 'var(--blue)', minDate, maxDate }: {
  days: string[];
  onDaysChange: (next: string[]) => void;
  accent?: string;
  minDate?: string;
  maxDate?: string;
}) {
  const ranges = collapseDatesToRanges(days);
  return (
    <div style={{ marginBottom: 'var(--space-3)' }}>
      <CalendarMultiPicker
        selected={days}
        onChange={onDaysChange}
        accent={accent}
        minDate={minDate}
        maxDate={maxDate}
      />
      {days.length > 0 && (
        <PreviewNote>
          {days.length} day{days.length === 1 ? '' : 's'} selected → {ranges.length}{' '}
          entr{ranges.length === 1 ? 'y' : 'ies'}: {ranges.map(rangeLabel).join(', ')}
        </PreviewNote>
      )}
    </div>
  );
}

// One availability entry, as a FLUSH ROW inside its category Card — not as a
// card of its own. Eight sections each rendering N bordered boxes is what made
// this tab read as boxes inside boxes; a hairline rule separates rows just as
// well and lets the Card be the only surface.
function AvailabilityCard({ row, onDelete, onChanged, formatDate, note }: {
  row: AvailabilityRow;
  // When provided, the card offers an inline Edit flow (start/end/notes PATCH)
  // and calls this after a successful save so the section reloads.
  onDelete: (id: string) => void;
  onChanged?: () => Promise<void>;
  formatDate: (d: string) => string;
  // Optional annotation badge (e.g. the sell-back "standalone" hint).
  note?: string;
}) {
  const [editing, setEditing] = useState(false);
  const typeInfo = AVAIL_TYPE_MAP[row.availability_type]
    || { label: row.availability_type, tone: 'neutral' as BadgeTone };
  const sameDay = row.start_date === row.end_date;
  const reason = reasonCodeLabel(row.reason_code);

  if (editing && onChanged) {
    return (
      <AvailabilityEditForm
        row={row}
        typeLabel={typeInfo.label}
        tone={typeInfo.tone}
        onCancel={() => setEditing(false)}
        onSaved={async () => { setEditing(false); await onChanged(); }}
      />
    );
  }

  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      gap: 'var(--space-3)', flexWrap: 'wrap',
      padding: 'var(--space-3) 0',
      borderTop: '1px solid var(--border-faint)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', minWidth: 0 }}>
        <Badge tone={typeInfo.tone}>{typeInfo.label}</Badge>
        {reason && <Badge tone="neutral">{reason}</Badge>}
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 'var(--fs-md)', fontWeight: 600, color: 'var(--text-strong)' }}>
            {formatDate(row.start_date)}{!sameDay && ` — ${formatDate(row.end_date)}`}
          </div>
          {row.notes && (
            <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', marginTop: 2 }}>{row.notes}</div>
          )}
          {note && (
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 2, lineHeight: 1.4 }} title={note}>
              {note}
            </div>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
        {row.source === 'request_window' && <Badge tone="info">Window</Badge>}
        <Badge tone={APPROVAL_TONES[row.approval_status] ?? 'warn'}>{row.approval_status}</Badge>
        {onChanged && (
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)} title="Edit dates / notes">
            Edit
          </Button>
        )}
        {/* Was an unlabelled "x". A destructive control gets a word. */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onDelete(row.id)}
          title="Delete"
          style={{ color: 'var(--danger)' }}
        >
          Remove
        </Button>
      </div>
    </div>
  );
}

// Inline editor for one availability row: start/end/notes → PATCH through the
// hardened whitelist route. ICU rows never reach this form — the ICU section
// renders its own pair cards with a pairing-aware edit flow (IcuPairCard).
function AvailabilityEditForm({ row, typeLabel, tone, onCancel, onSaved }: {
  row: AvailabilityRow;
  typeLabel: string;
  tone: BadgeTone;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const [start, setStart] = useState(row.start_date);
  const [end, setEnd] = useState(row.end_date);
  const [notes, setNotes] = useState(row.notes || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!start || !end) return;
    if (end < start) { setError('End date must be on or after start date'); return; }
    setBusy(true); setError(null);
    try {
      const err = await patchAvailability(row.id, {
        start_date: start,
        end_date: end,
        notes: notes || null,
      });
      if (err) { setError(err); return; }
      await onSaved();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ ...addFormBoxStyle, borderColor: 'var(--border)', marginTop: 'var(--space-3)' }}>
      {error && <div style={{ marginBottom: 'var(--space-3)' }}><Banner tone="error">{error}</Banner></div>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-3)' }}>
        <Badge tone={tone}>{typeLabel}</Badge>
        <span style={structureType}>editing</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto auto', gap: 'var(--space-3)', alignItems: 'end' }}>
        <div style={{ minWidth: 0 }}>
          <label style={fieldLabelStyle}>Start Date</label>
          <input type="date" value={start} onChange={e => {
            setStart(e.target.value);
            if (e.target.value > end) setEnd(e.target.value);
          }} className="fr-field" style={fieldInputStyle} />
        </div>
        <div style={{ minWidth: 0 }}>
          <label style={fieldLabelStyle}>End Date</label>
          <input type="date" value={end} min={start} onChange={e => setEnd(e.target.value)} className="fr-field" style={fieldInputStyle} />
        </div>
        <div style={{ minWidth: 0 }}>
          <label style={fieldLabelStyle}>Notes</label>
          <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional" className="fr-field" style={fieldInputStyle} />
        </div>
        <Button onClick={save} disabled={busy || !start || !end}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </div>
  );
}
