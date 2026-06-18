// Print-optimized layout for the Grid Calculator export route.
// Owned by agent A16 (Export) per PRD §14.
//
// PURPOSE
// -------
// Render a `PrintSnapshot` (from `src/lib/gridCalculator/export.ts`) as a
// paper-friendly, admin-presentable artifact. The route consumer hits
// Cmd+P / Ctrl+P to save as PDF — there is intentionally NO server-side
// PDF renderer to keep the install footprint flat.
//
// PRD VISUAL ALIGNMENT
// --------------------
//   - PRD §2: admin-presentable. Header carries hospital name + date.
//   - PRD §7.1 — Lanes per site, color-accented left edge, name + caption.
//   - PRD §7.2 — Anesthesiologist cards (amber), CRNA chips (cyan).
//   - PRD §7.3 — Cross-site supervision = dashed connector / badge.
//   - PRD §7.4 — Float lane last, outlined cards.
//   - PRD §7.5 — Always "Anesthesiologist" / "CRNA" labels in UI.
//   - PRD §7.6 — Inherit FloorRunner palette: amber + cyan + dashed-purple.
//
// PRINT RULES (CSS @media print)
//   - No toggle bar, no sidebar, no buttons, no shimmer animation.
//   - Borders darker for paper (slate-700 instead of var(--border)).
//   - Float lane uses dashed outline borders rather than solid fills.
//   - Page break avoided inside a site lane where possible.
//   - Letter portrait by default; landscape applied via inline `@page` block
//     when `orientation === 'landscape'`.

import type {
  PrintFloatEntry,
  PrintRoomRow,
  PrintSiteLane,
  PrintSnapshot,
} from '@/lib/gridCalculator/export';

const AMBER = '#b45309';
const AMBER_BG = '#fef3c7';
const AMBER_BORDER = '#d97706';
const CYAN = '#0369a1';
const CYAN_BG = '#e0f2fe';
const CYAN_BORDER = '#0284c7';
const PURPLE = '#7c3aed';
const SLATE_INK = '#1e293b';
const SLATE_LINE = '#334155';
const SLATE_MUTED = '#64748b';
const SLATE_DIM = '#94a3b8';

export interface PrintLayoutProps {
  snapshot: PrintSnapshot;
}

export default function PrintLayout({ snapshot }: PrintLayoutProps) {
  const { header, siteLanes, floatLane, fte, footer, orientation } = snapshot;
  const pageSize = orientation === 'landscape' ? 'Letter landscape' : 'Letter portrait';

  return (
    <article
      id="grid-export-root"
      data-orientation={orientation}
      style={{
        fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
        color: SLATE_INK,
        background: 'white',
        padding: '32px 36px',
        maxWidth: orientation === 'landscape' ? '11in' : '8.5in',
        minHeight: orientation === 'landscape' ? '8.5in' : '11in',
        margin: '0 auto',
        boxSizing: 'border-box',
      }}
    >
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header
        style={{
          borderBottom: `2px solid ${SLATE_LINE}`,
          paddingBottom: 12,
          marginBottom: 20,
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: 16,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <h1
            style={{
              fontSize: 20,
              fontWeight: 700,
              letterSpacing: -0.3,
              margin: 0,
              lineHeight: 1.2,
            }}
          >
            {header.title}
          </h1>
          <p
            style={{
              fontSize: 12,
              color: SLATE_MUTED,
              margin: '4px 0 0 0',
              letterSpacing: 0.2,
            }}
          >
            {header.subtitle}
          </p>
        </div>
        <div
          style={{
            fontSize: 11,
            fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
            color: SLATE_MUTED,
            textAlign: 'right',
            whiteSpace: 'nowrap',
          }}
        >
          {header.dateStamp}
        </div>
      </header>

      {/* ── Two-column body: grid lanes (left) + FTE recommendation (right) ── */}
      <section
        style={{
          display: 'grid',
          gridTemplateColumns: orientation === 'landscape' ? '1.6fr 1fr' : '1fr',
          gap: 20,
          alignItems: 'flex-start',
        }}
      >
        {/* ── Grid lanes ─────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
          <SectionTitle>Coverage Grid</SectionTitle>
          {siteLanes.map((lane) => (
            <SiteLanePrint key={lane.siteId} lane={lane} />
          ))}
          <FloatLanePrint floats={floatLane.providers} />
        </div>

        {/* ── FTE recommendation panel ───────────────────────────────────── */}
        <aside style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <SectionTitle>FTE Recommendation</SectionTitle>
          <FTEPanel snapshot={snapshot} />

          {fte.backupCallDistribution.length > 0 && (
            <BackupCallTable snapshot={snapshot} />
          )}

          <RationaleBlock rationale={fte.rationale} />
        </aside>
      </section>

      {/* ── Footer ─────────────────────────────────────────────────────────── */}
      <footer
        style={{
          marginTop: 28,
          paddingTop: 12,
          borderTop: `1px solid ${SLATE_DIM}`,
          fontSize: 10,
          color: SLATE_MUTED,
          fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <div>{footer.caption}</div>
        <div>{footer.bindingNote}</div>
        <div style={{ wordBreak: 'break-all' }}>{footer.configReference}</div>
      </footer>

      {/* ── Print-only CSS rules ───────────────────────────────────────────── */}
      <style
        // Inline so the export route does not require a global stylesheet.
        // The rules are scoped to `#grid-export-root` where it matters.
        dangerouslySetInnerHTML={{
          __html: `
            @page { size: ${pageSize}; margin: 0.5in; }
            @media print {
              body { background: white; }
              #grid-export-root { padding: 0; max-width: 100%; }
              .no-print { display: none !important; }
              .lane-print { break-inside: avoid; page-break-inside: avoid; }
              .room-card-print { break-inside: avoid; page-break-inside: avoid; }
            }
          `,
        }}
      />
    </article>
  );
}

// ---------------------------------------------------------------------------
// Section title — small caps, dim, top of each block
// ---------------------------------------------------------------------------

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2
      style={{
        fontSize: 10,
        textTransform: 'uppercase',
        letterSpacing: 0.6,
        fontWeight: 700,
        color: SLATE_MUTED,
        margin: '0 0 4px 0',
        borderBottom: `0.5px solid ${SLATE_DIM}`,
        paddingBottom: 4,
        fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      }}
    >
      {children}
    </h2>
  );
}

// ---------------------------------------------------------------------------
// Site lane — one row per site
// ---------------------------------------------------------------------------

function SiteLanePrint({ lane }: { lane: PrintSiteLane }) {
  return (
    <div
      className="lane-print"
      style={{
        display: 'flex',
        border: `1px solid ${SLATE_LINE}`,
        borderRadius: 4,
        borderLeft: `4px solid ${lane.color}`,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          width: 110,
          flexShrink: 0,
          padding: '8px 10px',
          borderRight: `1px solid ${SLATE_DIM}`,
          background: hexA(lane.color, 0.05),
        }}
      >
        <div
          style={{
            fontSize: 12,
            fontWeight: 700,
            color: lane.color,
            lineHeight: 1.2,
          }}
        >
          {lane.siteName}
        </div>
        {lane.caption && (
          <div
            style={{
              fontSize: 9,
              color: SLATE_MUTED,
              marginTop: 2,
              fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
            }}
          >
            {lane.caption}
          </div>
        )}
        <div
          style={{
            fontSize: 9,
            fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
            color: lane.color,
            fontWeight: 700,
            marginTop: 4,
          }}
        >
          {lane.rooms.length} room{lane.rooms.length === 1 ? '' : 's'}
        </div>
      </div>

      <div
        style={{
          flex: 1,
          padding: '8px 10px',
          display: 'flex',
          flexWrap: 'wrap',
          gap: 8,
        }}
      >
        {lane.rooms.map((room) => (
          <RoomCardPrint key={room.roomId} room={room} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Room card — anesthesiologist + supervised CRNAs, with cross-site badge
// ---------------------------------------------------------------------------

function RoomCardPrint({ room }: { room: PrintRoomRow }) {
  const isSolo = room.staffingPattern === 'solo_md';
  const isUnstaffed = !room.anesthesiologist;

  return (
    <div
      className="room-card-print"
      data-room-id={room.roomId}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        minWidth: 150,
        flex: '1 0 150px',
      }}
    >
      <div
        style={{
          fontSize: 9,
          fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
          fontWeight: 700,
          color: SLATE_MUTED,
          letterSpacing: 0.4,
          textTransform: 'uppercase',
          paddingBottom: 2,
          borderBottom: `0.5px solid ${SLATE_DIM}`,
        }}
      >
        {room.roomName}
        {room.crossSite && (
          <span style={{ marginLeft: 6, color: PURPLE, fontWeight: 800 }}>
            ⇢ {room.crossSite.fromSiteShortLabel}
          </span>
        )}
      </div>

      {isUnstaffed ? (
        <div
          style={{
            padding: '6px 8px',
            border: `1.5px dashed ${SLATE_LINE}`,
            background: hexA('#ef4444', 0.06),
            fontSize: 10,
            color: '#b91c1c',
            fontWeight: 700,
            borderRadius: 3,
          }}
        >
          Unstaffed
        </div>
      ) : (
        <div
          style={{
            padding: '6px 8px',
            border: `1px solid ${AMBER_BORDER}`,
            background: AMBER_BG,
            borderRadius: 3,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span
            style={{
              fontSize: 9,
              fontWeight: 800,
              color: AMBER,
              padding: '1px 4px',
              border: `1px solid ${AMBER_BORDER}`,
              borderRadius: 2,
              flexShrink: 0,
            }}
          >
            {room.anesthesiologist!.initials}
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: AMBER, lineHeight: 1.1 }}>
              {room.anesthesiologist!.name}
            </div>
            <div
              style={{
                fontSize: 8,
                color: SLATE_MUTED,
                fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
                textTransform: 'uppercase',
                letterSpacing: 0.4,
                marginTop: 1,
              }}
            >
              Anesthesiologist {isSolo ? '(solo)' : `· supervises ${room.crnas.length}`}
            </div>
          </div>
        </div>
      )}

      {room.crnas.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, paddingLeft: 8 }}>
          {room.crnas.map((c) => (
            <div
              key={c.name}
              style={{
                padding: '3px 6px',
                border: `1px solid ${CYAN_BORDER}`,
                background: CYAN_BG,
                borderRadius: 999,
                fontSize: 10,
                color: CYAN,
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <span
                style={{
                  fontSize: 8,
                  fontWeight: 800,
                  letterSpacing: 0.3,
                  background: 'rgba(2,132,199,0.18)',
                  padding: '0 4px',
                  borderRadius: 2,
                }}
              >
                {c.initials}
              </span>
              <span style={{ lineHeight: 1.1 }}>{c.name}</span>
            </div>
          ))}
        </div>
      )}

      {room.notes && (
        <div
          style={{
            fontSize: 9,
            color: SLATE_MUTED,
            fontStyle: 'italic',
            paddingLeft: 8,
            lineHeight: 1.3,
          }}
        >
          {room.notes}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Float lane — always last per PRD §7.4
// ---------------------------------------------------------------------------

function FloatLanePrint({ floats }: { floats: PrintFloatEntry[] }) {
  return (
    <div
      className="lane-print"
      style={{
        display: 'flex',
        border: `1px dashed ${SLATE_LINE}`,
        borderRadius: 4,
        borderLeft: `4px dashed ${SLATE_MUTED}`,
        overflow: 'hidden',
        marginTop: 4,
      }}
    >
      <div
        style={{
          width: 110,
          flexShrink: 0,
          padding: '8px 10px',
          borderRight: `1px dashed ${SLATE_DIM}`,
          background: hexA(SLATE_MUTED, 0.05),
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 700, color: SLATE_INK, lineHeight: 1.2 }}>
          Float
        </div>
        <div
          style={{
            fontSize: 9,
            color: SLATE_MUTED,
            marginTop: 2,
            fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
          }}
        >
          breaks / add-ons
        </div>
        <div
          style={{
            fontSize: 9,
            fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
            color: SLATE_INK,
            fontWeight: 700,
            marginTop: 4,
          }}
        >
          {floats.length} provider{floats.length === 1 ? '' : 's'}
        </div>
      </div>

      <div
        style={{
          flex: 1,
          padding: '8px 10px',
          display: 'flex',
          flexWrap: 'wrap',
          gap: 6,
        }}
      >
        {floats.length === 0 ? (
          <div style={{ fontSize: 10, color: SLATE_MUTED, fontStyle: 'italic' }}>
            No floats — every provider assigned.
          </div>
        ) : (
          floats.map((f, idx) => (
            <div
              key={`${f.provider.name}-${idx}`}
              style={{
                padding: '4px 8px',
                border: f.role === 'crna' ? `1px dashed ${CYAN_BORDER}` : `1px dashed ${AMBER_BORDER}`,
                background: 'white',
                borderRadius: 999,
                fontSize: 10,
                color: f.role === 'crna' ? CYAN : AMBER,
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <span
                style={{
                  fontSize: 8,
                  fontWeight: 800,
                  letterSpacing: 0.3,
                  background: f.role === 'crna' ? CYAN_BG : AMBER_BG,
                  padding: '0 4px',
                  borderRadius: 2,
                }}
              >
                {f.provider.initials}
              </span>
              <span style={{ lineHeight: 1.1 }}>{f.provider.name}</span>
              {f.leansToSite && (
                <span
                  style={{
                    fontSize: 8,
                    color: SLATE_MUTED,
                    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
                    marginLeft: 2,
                  }}
                >
                  → {f.leansToSite.shortName}
                </span>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FTE Panel
// ---------------------------------------------------------------------------

function FTEPanel({ snapshot }: { snapshot: PrintSnapshot }) {
  const { fte } = snapshot;

  return (
    <div
      style={{
        border: `1px solid ${SLATE_LINE}`,
        borderRadius: 4,
        padding: 12,
        background: 'white',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div>
        <p
          style={{
            fontSize: 10,
            color: SLATE_MUTED,
            margin: 0,
            lineHeight: 1.4,
            fontStyle: 'italic',
          }}
        >
          Recommendation = max(worst case, p95). PRD §10.
        </p>
      </div>

      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: 10,
        }}
      >
        <thead>
          <tr>
            <th style={tableHeaderStyle}>Role</th>
            <th style={tableHeaderStyle}>Worst case</th>
            <th style={tableHeaderStyle}>p50</th>
            <th style={tableHeaderStyle}>p95</th>
            <th style={tableHeaderStyle}>Rec.</th>
            <th style={tableHeaderStyle}>Binding</th>
          </tr>
        </thead>
        <tbody>
          {fte.rows.map((row) => (
            <tr key={row.label}>
              <td style={tableCellStyle}>
                <strong style={{ color: rowAccent(row.label) }}>{row.label}</strong>
              </td>
              <td style={tableCellStyle}>{row.worstCase}</td>
              <td style={tableCellStyle}>{row.p50}</td>
              <td style={tableCellStyle}>{row.p95}</td>
              <td
                style={{
                  ...tableCellStyle,
                  fontWeight: 800,
                  color: rowAccent(row.label),
                  fontSize: 12,
                }}
              >
                {row.recommended}
              </td>
              <td style={{ ...tableCellStyle, fontSize: 9, color: SLATE_MUTED }}>
                {row.binding || '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function rowAccent(label: string): string {
  if (label.startsWith('Anesthesiologists')) return AMBER;
  if (label.startsWith('CRNAs')) return CYAN;
  return SLATE_INK;
}

const tableHeaderStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '4px 6px',
  borderBottom: `1px solid ${SLATE_LINE}`,
  fontSize: 9,
  fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
  fontWeight: 700,
  color: SLATE_MUTED,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
};

const tableCellStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '6px 6px',
  borderBottom: `0.5px solid ${SLATE_DIM}`,
  fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
  color: SLATE_INK,
  verticalAlign: 'top',
};

// ---------------------------------------------------------------------------
// Backup call distribution table — only shown when populated
// ---------------------------------------------------------------------------

function BackupCallTable({ snapshot }: { snapshot: PrintSnapshot }) {
  const rows = snapshot.fte.backupCallDistribution;
  return (
    <div
      style={{
        border: `1px solid ${SLATE_DIM}`,
        borderRadius: 4,
        padding: 10,
        background: 'white',
      }}
    >
      <div
        style={{
          fontSize: 9,
          fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
          fontWeight: 700,
          color: SLATE_MUTED,
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          marginBottom: 6,
        }}
      >
        Backup call distribution
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
        <thead>
          <tr>
            <th style={tableHeaderStyle}>Provider</th>
            <th style={tableHeaderStyle}>FTE share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.providerId}>
              <td style={tableCellStyle}>{row.displayName}</td>
              <td style={tableCellStyle}>{row.fteShare}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rationale block
// ---------------------------------------------------------------------------

function RationaleBlock({ rationale }: { rationale: string }) {
  return (
    <div
      style={{
        border: `1px solid ${SLATE_DIM}`,
        background: '#f8fafc',
        borderRadius: 4,
        padding: 10,
        fontSize: 10,
        color: SLATE_INK,
        lineHeight: 1.5,
      }}
    >
      <div
        style={{
          fontSize: 9,
          fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
          fontWeight: 700,
          color: SLATE_MUTED,
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          marginBottom: 4,
        }}
      >
        Rationale
      </div>
      {rationale}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Utility — hex color → rgba string (mirrors GridCanvas.tsx convention)
// ---------------------------------------------------------------------------

function hexA(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(100,116,139,${alpha})`;
  const v = parseInt(m[1], 16);
  const r = (v >> 16) & 0xff;
  const g = (v >> 8) & 0xff;
  const b = v & 0xff;
  return `rgba(${r},${g},${b},${alpha})`;
}
