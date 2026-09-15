'use client';

/* ── Printable schedule sheet ────────────────────────────────────────────────
 * DYNAMICALLY IMPORTED (next/dynamic, ssr: false) by the schedule grid page.
 * It renders only once `printingSchedule` is set, and is `display: none` on
 * screen even then — it exists purely for the print stylesheet. Statically
 * imported, a whole second rendering of the block (per-week tables for every
 * date in the schedule) sat in the route's first load to serve the rare click
 * on Print. `ssr: false` is correct: it is triggered by a user action and
 * drives the browser's own print pipeline.
 *
 * Moved verbatim out of page.tsx — same props, same logic, same rendering.
 * ───────────────────────────────────────────────────────────────────────── */

import { useMemo } from 'react';
import { gridTokens } from './gridTheme';
import { normalizeHighlightColor, type HighlightColor } from '@/lib/highlightColor';
import { isUnfilledCallSlot } from '@/lib/availableCalls';
import { weeksOf, printRows, weekLabel } from '@/lib/printableSchedule';
import {
  DAYS_SHORT, formatMMDD,
  type GridData, type Slot, type ShiftTypeInfo, type Provider, type Holiday,
} from './gridShared';

/* ── Printable schedule (Gabriel 2026-08-02) ───────────────────────────────
 * "print in landscape a full version of the schedule or create a pdf for
 * sending. It should print just the Schedule in the most efficently viewing
 * possible."
 *
 * Hidden on screen, visible only in print. The interactive grid CANNOT be
 * printed directly — it is one CSS grid with sticky headers inside an overflow
 * container, 77 columns wide at Paoli, and a fixed-position print area clips
 * rather than paginates (the Call Counts sheet documents that hazard). So this
 * renders plain per-week tables the browser can break naturally, and the grid
 * is hidden for print.
 *
 * Layout rationale lives in lib/printableSchedule.ts.
 */
export function PrintableSchedule({
  grid, slotMap, shiftTypes, allDates, holidayMap, observanceByDate,
  offByDate, icuByDate, ptoByDate, overParAssignmentIds, callTakerIds,
}: {
  grid: GridData;
  slotMap: Record<string, Record<string, Slot>>;
  shiftTypes: ShiftTypeInfo[];
  allDates: string[];
  holidayMap: Record<string, Holiday>;
  observanceByDate: Map<string, string[]>;
  offByDate: Record<string, Provider[]>;
  icuByDate: Record<string, Provider[]>;
  ptoByDate: Record<string, Provider[]>;
  overParAssignmentIds: Set<string>;
  callTakerIds: Set<string>;
}) {
  const weeks = useMemo(() => weeksOf(allDates), [allDates]);
  const rows = useMemo(() => printRows(grid.slots), [grid]);
  const stByCode = useMemo(() => {
    const m: Record<string, ShiftTypeInfo> = {};
    for (const st of shiftTypes) m[st.code] = st;
    return m;
  }, [shiftTypes]);

  const cellIn = (code: string, date: string) => {
    const st = stByCode[code];
    const empty = { name: '', mark: null as HighlightColor | null, extra: false, open: false };
    if (!st) return empty;
    const slot = slotMap[st.id]?.[date];
    if (!slot) return { ...empty, name: '—' };   // no slot stood that day
    const a = (slot.assignments ?? []).find(x => x.provider_id);
    const isCallSlot = st.category === 'call';
    if (!a) {
      // OPEN, and only for CALL slots — the same single-homed predicate the
      // grid's red cells and the Available Call list use, so the printout can
      // never disagree with either about what is up for grabs. An unfilled DAY
      // slot stays blank: nobody is chasing cover for a D6.
      return { ...empty, open: isCallSlot && isUnfilledCallSlot(slot) };
    }
    const provider = a.providers;
    return {
      name: provider?.short_display_name ?? '',
      mark: normalizeHighlightColor(a.highlight_color),
      // "Extra" on paper = either sense the grid paints red: past the
      // provider's rounded obligation (over-par), or picked up by someone who
      // is not in this site's call pool at all. Both are billable extras and a
      // printed sheet is where that gets checked.
      extra: isCallSlot && !!a.id
        && (overParAssignmentIds.has(a.id)
          || (!!provider && !callTakerIds.has(provider.id))),
      open: false,
    };
  };

  // Off / ICU / PTO ride BELOW the shift rows, one row each with the day's
  // names stacked. One row per category rather than the screen's N sub-rows:
  // on paper the stack is the compact form, and a printed schedule is read for
  // "who is away", not for a stable row position.
  const CATEGORY_ROWS: Array<{ label: string; data: Record<string, Provider[]>; color: string }> = [
    { label: 'Off', data: offByDate, color: gridTokens.category.Off },
    { label: 'ICU', data: icuByDate, color: gridTokens.category.ICU },
    { label: 'PTO', data: ptoByDate, color: gridTokens.category.PTO },
  ];

  return (
    <div id="schedule-print" aria-hidden>
      <style>{`
        #schedule-print { display: none; }
        @media print {
          /* Landscape, tight margins — the width is what buys a readable
             column, so it is spent on the table rather than on paper edges. */
          @page { size: landscape; margin: 0.35in; }
          body * { visibility: hidden !important; }
          #schedule-print, #schedule-print * { visibility: visible !important; }
          #schedule-print {
            display: block !important;
            position: absolute !important; left: 0 !important; top: 0 !important;
            width: 100% !important; background: #fff !important; color: #000 !important;
          }
          .sched-week { page-break-after: always; break-after: page; }
          .sched-week:last-child { page-break-after: auto; break-after: auto; }
          .sched-week table { width: 100%; border-collapse: collapse; table-layout: fixed; }
          .sched-week th, .sched-week td {
            border: 1px solid #999; padding: 3px 4px; font-size: 10px;
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          }
          .sched-week th { background: #eee !important; -webkit-print-color-adjust: exact; }
          .sched-week .rowlab { font-weight: 700; text-align: left; width: 62px; background: #f6f6f6 !important; }
          .sched-week .we { background: #f2f2f2 !important; -webkit-print-color-adjust: exact; }
          .sched-week .callrow td, .sched-week .callrow th { font-weight: 700; }
          /* OVER / EXTRA and OPEN both print RED — and the signal is the TEXT
             colour, not a fill. Browsers strip backgrounds unless the reader
             ticks "Background graphics", so a fill-only cue would vanish on a
             default print; text colour always prints. The tint is a bonus for
             readers who have backgrounds on, never the signal itself. */
          .sched-week td.extra {
            color: #b91c1c !important; font-weight: 800;
            background: #fdecec !important;
          }
          .sched-week td.open {
            color: #b91c1c !important; font-weight: 800; font-style: italic;
            background: #fdecec !important;
          }
          /* Off / ICU / PTO sit visually apart from the staffed rows. */
          .sched-week .catrow td, .sched-week .catrow th {
            font-size: 9px; vertical-align: top;
          }
          .sched-week tr.catrow:first-of-type td, .sched-week tr.catrow:first-of-type th {
            border-top: 2px solid #666;
          }
          /* Colour fidelity: without this every background is stripped and the
             marks/shading vanish. The reader must ALSO tick "Background
             graphics" in the print dialog — no stylesheet can override that. */
          #schedule-print, #schedule-print * {
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }
          .sched-week h2 { font-size: 13px; margin: 0 0 1px 0; }
          .sched-week .sub { font-size: 9px; color: #444; margin: 0 0 5px 0; }
        }
      `}</style>

      {weeks.map(week => (
        <section className="sched-week" key={week.start}>
          <h2>{grid.schedule.schedule_name}</h2>
          <p className="sub">{weekLabel(week)}</p>
          <table>
            <thead>
              <tr>
                <th className="rowlab" />
                {week.dates.map(d => {
                  const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
                  const isWe = dow === 0 || dow === 6;
                  const note = observanceByDate.get(d)?.join(' · ');
                  return (
                    <th key={d} className={isWe ? 'we' : undefined}>
                      {DAYS_SHORT[dow]} {formatMMDD(d)}
                      {holidayMap[d] && <div style={{ fontWeight: 400 }}>{holidayMap[d].holiday_name}</div>}
                      {note && <div style={{ fontWeight: 400 }}>{note}</div>}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.code} className={r.category === 'call' ? 'callrow' : undefined}>
                  <th className="rowlab">{r.code}</th>
                  {week.dates.map(d => {
                    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
                    const isWe = dow === 0 || dow === 6;
                    const { name, mark, extra, open } = cellIn(r.code, d);
                    return (
                      <td
                        key={d}
                        className={[isWe ? 'we' : '', open ? 'open' : '', extra ? 'extra' : '']
                          .filter(Boolean).join(' ') || undefined}
                        // The hand-set billing mark survives to paper — it is
                        // the whole point of the mark, and a printed sheet is
                        // where a physician checks what they can bill. An
                        // over/extra call out-ranks it: the .extra class sets
                        // its own colour after this.
                        style={mark && !extra && !open
                          ? { background: gridTokens.manualHighlight[mark] } : undefined}
                      >
                        {open ? 'open' : name}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {CATEGORY_ROWS.map(cat => (
                <tr key={cat.label} className="catrow">
                  <th className="rowlab" style={{ borderLeft: `3px solid ${cat.color}` }}>
                    {cat.label}
                  </th>
                  {week.dates.map(d => {
                    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
                    const isWe = dow === 0 || dow === 6;
                    const people = cat.data[d] ?? [];
                    return (
                      <td key={d} className={isWe ? 'we' : undefined}>
                        {people.map(p => (
                          <div key={p.id} style={{ color: cat.color }}>{p.short_display_name}</div>
                        ))}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
