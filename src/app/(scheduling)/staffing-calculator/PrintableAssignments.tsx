'use client';

/* ── Printable daily assignment sheet ────────────────────────────────────────
 * DYNAMICALLY IMPORTED (next/dynamic, ssr: false) by the staffing calculator.
 * It renders only once printing is armed, and is `display: none` on screen even
 * then — it exists purely for the print stylesheet. Statically imported, a
 * whole second rendering of the assignment set would sit in the route's first
 * load to serve the rare click on Print. `ssr: false` is correct: it is
 * triggered by a user action and drives the browser's own print pipeline.
 *
 * ── WHY NOT PRINT THE DIAGRAM ITSELF ───────────────────────────────────────
 * The supervision map is a set of absolutely-positioned lanes with an SVG
 * connector overlay measured off live DOM rectangles. A fixed-position print
 * area clips rather than paginates (the Call Counts sheet documents that
 * hazard), and the connector lines are measured against a container that does
 * not exist at print size — they would land in the wrong places or vanish. So
 * this renders a plain table the browser can break naturally, carrying the same
 * facts the lines carry: who supervises whom, and where.
 *
 * ── WHY THERE ARE NO DESIGN TOKENS IN THIS FILE ────────────────────────────
 * Everything here paints PAPER, and paper has no theme. A CSS custom property
 * resolves against whatever the viewer's document is set to, so `--text` on a
 * sheet printed by someone in dark mode is #e2e8f0 — near-white ink on white
 * stock. The literals below are stated outright and are the same document
 * whichever theme produced them, and they survive a MONOCHROME printer: the
 * shading is three distinct greys, and cross-cover carries its meaning in the
 * word and the arrow as well as in colour.
 * ───────────────────────────────────────────────────────────────────────── */

import type { CalculatorOutput, StaffAssignment, SiteCatalogEntry } from '@/lib/staffingCalculator';

export interface PrintableAssignmentsProps {
  facilityName: string;
  date: string;
  out: CalculatorOutput;
  siteCatalog: SiteCatalogEntry[];
  /** MDs/CRNAs the panel says are available, for the header line. */
  avail: { mds: number; crnas: number };
  /** Whether the overnight call team is counted in `avail`. Printed, because a
   *  sheet read tomorrow cannot otherwise tell which way the box was set. */
  includeOvernight: boolean;
  /** People on the schedule with nobody assigned to them in the diagram —
   *  printed rather than dropped, so the sheet is a complete account of the
   *  day rather than only of the positions that got filled. */
  unplaced: Array<{ name: string; type: 'MD' | 'CRNA'; shiftCodes: string[] }>;
}

function longDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
}

/** A position's occupant, or a visible blank. An empty cell on a printed sheet
 *  reads as an oversight; "—" reads as a decision not yet made. */
function occupant(a: StaffAssignment): string {
  return a.providerName || '—';
}

export function PrintableAssignments({
  facilityName, date, out, siteCatalog, avail, includeOvernight, unplaced,
}: PrintableAssignmentsProps) {
  const mds = out.assignments.filter(a => a.type === 'MD');
  const crnas = out.assignments.filter(a => a.type === 'CRNA');

  const laneLabel = (key: string) =>
    siteCatalog.find(s => s.key === key)?.label ?? key;

  // Lane order from the catalog, then anything the algorithm produced that was
  // not pre-registered — so a custom site never falls off the printout.
  const catalogKeys = siteCatalog.map(s => s.key);
  const extra = [...new Set(out.assignments.map(a => a.site))].filter(k => !catalogKeys.includes(k));
  const lanes = [...catalogKeys, ...extra]
    .filter(k => out.assignments.some(a => a.site === k));

  const named = out.assignments.filter(a => a.providerName).length;

  return (
    <div id="sc-print" style={{ display: 'none' }}>
      <style>{`
        @media print {
          /* Portrait: this is a list, and its width is one narrow table. */
          @page { size: portrait; margin: 0.4in; }
          body * { visibility: hidden !important; }
          #sc-print, #sc-print * { visibility: visible !important; }
          #sc-print {
            display: block !important;
            position: absolute !important; left: 0 !important; top: 0 !important;
            width: 100% !important; background: #fff !important; color: #000 !important;
            font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
          }
          #sc-print table { width: 100%; border-collapse: collapse; }
          #sc-print th, #sc-print td {
            border: 1px solid #999; padding: 4px 6px; font-size: 11px;
            text-align: left; vertical-align: top;
          }
          #sc-print th { background: #eee !important; -webkit-print-color-adjust: exact; }
          /* A lane heading must not be the last thing on a page. */
          #sc-print .lane { page-break-inside: avoid; break-inside: avoid; }
          #sc-print .lanehead {
            background: #f2f2f2 !important; -webkit-print-color-adjust: exact;
            font-weight: 700;
          }
          #sc-print .sub { color: #666; font-size: 10px; }
          /* Cross-cover prints in the WORD and the arrow as well as the colour:
             browsers strip backgrounds unless the reader ticks "Background
             graphics", and a monochrome printer flattens the hue entirely. */
          #sc-print .xcov { color: #b91c1c; font-weight: 700; }
          #sc-print .blank { color: #999; }
        }
      `}</style>

      <h1 style={{ margin: '0 0 2px', fontSize: 17, fontWeight: 700 }}>
        {facilityName} — daily assignments
      </h1>
      <div style={{ fontSize: 12, marginBottom: 2 }}>{longDate(date)}</div>
      <div className="sub" style={{ fontSize: 10, color: '#666', marginBottom: 10 }}>
        {mds.length} MD · {crnas.length} CRNA positions · {named} named
        {' · '}available {avail.mds} MD / {avail.crnas} CRNA
        {' · '}overnight call team {includeOvernight ? 'included' : 'excluded'}
      </div>

      {lanes.map(key => {
        const laneMDs = mds.filter(m => m.site === key);
        const laneCRNAs = crnas.filter(c => c.site === key);
        // A CRNA here whose supervisor sits in another lane — the relationship
        // the red line draws on screen.
        const supervisorOf = (c: StaffAssignment) => mds.find(m => m.id === c.supervisedBy);

        return (
          <div key={key} className="lane" style={{ marginBottom: 10 }}>
            <table>
              <thead>
                <tr><th className="lanehead" colSpan={3}>{laneLabel(key)}</th></tr>
                <tr>
                  <th style={{ width: '28%' }}>Position</th>
                  <th style={{ width: '40%' }}>Assigned</th>
                  <th style={{ width: '32%' }}>Supervision</th>
                </tr>
              </thead>
              <tbody>
                {laneMDs.map(m => {
                  const mine = crnas.filter(c => c.supervisedBy === m.id);
                  const away = mine.filter(c => c.site !== key);
                  return (
                    <tr key={m.id}>
                      <td>
                        <strong>{m.role}</strong>
                        {m.isSolo && <span className="sub"> · solo</span>}
                      </td>
                      <td className={m.providerName ? undefined : 'blank'}>{occupant(m)}</td>
                      <td>
                        {mine.length === 0
                          ? <span className="sub">—</span>
                          : mine.map(c => c.role).join(', ')}
                        {away.length > 0 && (
                          <div className="xcov">
                            ⇄ covers {away.map(c => `${c.role} (${laneLabel(c.site)})`).join(', ')}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}

                {laneCRNAs.map(c => {
                  const sup = supervisorOf(c);
                  const remote = sup && sup.site !== key;
                  return (
                    <tr key={c.id}>
                      <td>
                        {c.role}
                        {c.isAddOn && <span className="sub"> · add-on</span>}
                      </td>
                      <td className={c.providerName ? undefined : 'blank'}>{occupant(c)}</td>
                      <td className={remote ? 'xcov' : undefined}>
                        {sup
                          ? (remote ? `⇄ ${sup.role} — ${laneLabel(sup.site)}` : sup.role)
                          : <span className="sub">unassigned</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}

      {/* On the schedule, in nobody's room. The sheet is an account of the day,
          so somebody working and unplaced is a fact worth carrying — it is the
          slack the floor runner has left. */}
      {unplaced.length > 0 && (
        <div className="lane" style={{ marginTop: 12 }}>
          <table>
            <thead>
              <tr><th className="lanehead" colSpan={2}>On the schedule, not placed above</th></tr>
              <tr>
                <th style={{ width: '60%' }}>Name</th>
                <th style={{ width: '40%' }}>Shift</th>
              </tr>
            </thead>
            <tbody>
              {unplaced.map(p => (
                <tr key={p.name + p.shiftCodes.join()}>
                  <td>{p.name} <span className="sub">({p.type})</span></td>
                  <td className="sub">{p.shiftCodes.join(' + ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="sub" style={{ fontSize: 9, color: '#666', marginTop: 12 }}>
        Staffing model from the FloorRunner calculator; names from the published
        schedule for {longDate(date)}. Room assignments are made on the day and
        are not part of the schedule of record.
      </div>
    </div>
  );
}
