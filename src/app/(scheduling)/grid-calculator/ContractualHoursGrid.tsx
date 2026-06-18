'use client';

// Contractual Hours Grid — the "what administrators see" view.
//
// Renders the timeline-by-hour-block spreadsheet that hospital admins use
// to size their contractual obligation. The data shape is decided by
// `buildContractualGrid` in `src/lib/gridCalculator/contractualHours.ts` —
// this file is presentation only.
//
// LAYOUT
// ------
//   - Premium card surface (matches the rest of the canvas via the `tok` object).
//   - Section title + subtitle on top.
//   - One CSS grid with 19 columns: [group][label][12 × time-block][5 × hrs].
//   - One body row per `ContractualRow`. Group label cells visually grouped
//     by a coloured left border.
//   - Footer rows summarize totals: weekly hours, FTE mandated, vacation FTE,
//     projected FTE — mirroring the screenshot's bottom-line block.
//
// Mono fonts + 11px text + hairline 0.5px borders match the spreadsheet feel.

import { useMemo } from 'react';

import {
  TIME_BLOCKS,
  buildContractualGrid,
  type ContractualGroupId,
  type ContractualRow,
} from '@/lib/gridCalculator/contractualHours';
import type { GridSite } from '@/lib/gridCalculator/types';

// Shared token object — mirrors GridCanvas.tsx (lines 40-56) verbatim so the
// aesthetic-audit baseline sees the same surface tokens used elsewhere.
const tok = {
  card: 'var(--bg-surface)',
  surface: 'var(--bg-deep)',
  border: 'var(--border)',
  hairline: '1px solid var(--border)',
  text: 'var(--text)',
  textMuted: 'var(--text-muted)',
  textDim: 'var(--text-dim)',
  mono: 'var(--font-mono), ui-monospace, monospace',
  accent: '#0284c7',
  radius: 14,
  radiusSm: 9,
  shadow: '0 1px 2px rgba(15,23,42,0.05), 0 10px 28px -16px rgba(15,23,42,0.18)',
};

// Group accent colors — drives the left-border swatch on the group label
// column. Semantic, not site-specific (sites carry their own bar color).
const GROUP_ACCENT: Record<ContractualGroupId, string> = {
  main_or: '#0ea5e9', // cyan — matches Paoli Main OR
  nora: '#a78bfa', // purple — Non-OR Anesthesia
  float: '#80cbc4', // teal — Float
  weekday_call: '#f59e0b', // amber — call
  weekend_call: '#fb7185', // rose — weekend call
};

// Visual sizing.
const GROUP_COL_PX = 60;
const LABEL_COL_PX = 120;
const BLOCK_COL_PX = 36;
const HRS_COL_PX = 50;
const ROW_HEIGHT_PX = 26;

export interface ContractualHoursGridProps {
  sites: GridSite[];
}

export default function ContractualHoursGrid({ sites }: ContractualHoursGridProps) {
  const grid = useMemo(() => buildContractualGrid(sites), [sites]);

  // Build a templateColumns string — group | label | 12 × block | 5 × hrs.
  const gridTemplateColumns = `${GROUP_COL_PX}px ${LABEL_COL_PX}px repeat(${TIME_BLOCKS.length}, ${BLOCK_COL_PX}px) repeat(5, ${HRS_COL_PX}px)`;

  // Group rows by groupId so we can render group-name cell only on the first
  // row of each group (rowspan-like effect via visibility).
  const groupedRows = useMemo(() => {
    const out: Array<{ row: ContractualRow; isGroupHead: boolean; groupSpan: number }> = [];
    let i = 0;
    while (i < grid.rows.length) {
      const row = grid.rows[i];
      // Count consecutive rows in the same group.
      let span = 1;
      while (i + span < grid.rows.length && grid.rows[i + span].groupId === row.groupId) {
        span++;
      }
      for (let k = 0; k < span; k++) {
        out.push({ row: grid.rows[i + k], isGroupHead: k === 0, groupSpan: span });
      }
      i += span;
    }
    return out;
  }, [grid.rows]);

  return (
    <div
      style={{
        background: tok.card,
        border: '1px solid var(--border)',
        borderRadius: tok.radius,
        boxShadow: tok.shadow,
        padding: '18px 20px',
      }}
    >
      {/* Section header */}
      <div
        style={{
          fontSize: 13.5,
          fontWeight: 650,
          color: tok.text,
          letterSpacing: -0.15,
          paddingBottom: 4,
          marginBottom: 2,
          display: 'flex',
          alignItems: 'baseline',
          gap: 10,
        }}
      >
        Contractual hours grid
        <span style={{ fontSize: 11, fontWeight: 500, color: tok.textMuted }}>
          What administrators see — weekly coverage hours per location
        </span>
      </div>
      <div
        style={{
          height: 1,
          background: 'var(--border)',
          marginBottom: 10,
        }}
      />

      {/* Sub-banner mirroring the screenshot's "Locations and Hours of Coverage" header. */}
      <div
        style={{
          fontSize: 10,
          fontFamily: tok.mono,
          fontWeight: 700,
          color: tok.textDim,
          letterSpacing: 0.6,
          textTransform: 'uppercase',
          marginBottom: 6,
        }}
      >
        Locations and Hours of Coverage
      </div>

      {/* Scroll wrapper so narrow viewports don't squash the cells. */}
      <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
        <div style={{ minWidth: GROUP_COL_PX + LABEL_COL_PX + TIME_BLOCKS.length * BLOCK_COL_PX + 5 * HRS_COL_PX }}>
          {/* Header row */}
          <HeaderRow gridTemplateColumns={gridTemplateColumns} />

          {/* Body rows */}
          {groupedRows.map(({ row, isGroupHead, groupSpan }, idx) => (
            <BodyRow
              key={`${row.groupId}::${row.label}::${idx}`}
              row={row}
              isGroupHead={isGroupHead}
              groupSpan={groupSpan}
              gridTemplateColumns={gridTemplateColumns}
            />
          ))}

          {/* Footer rows — totals */}
          <FooterRows totals={grid.totals} gridTemplateColumns={gridTemplateColumns} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header row — two stacked rows: section banner + FROM/TO time labels.
// ---------------------------------------------------------------------------

function HeaderRow({ gridTemplateColumns }: { gridTemplateColumns: string }) {
  return (
    <>
      {/* FROM row */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns,
          background: tok.surface,
          borderTop: `0.5px solid ${tok.border}`,
          borderLeft: `0.5px solid ${tok.border}`,
          borderRight: `0.5px solid ${tok.border}`,
        }}
      >
        <HeaderCell label="" />
        <HeaderCell label="LOCATION" align="left" />
        {TIME_BLOCKS.map((b, i) => (
          <HeaderCell
            key={`from-${i}`}
            label={i === 0 ? `FROM ${pad4(b.start)}` : pad4(b.start)}
          />
        ))}
        <HeaderCell label="CRNA HRS" />
        <HeaderCell label="ANES HRS" />
        <HeaderCell label="DAYS / WK" />
        <HeaderCell label="CRNA / WK" />
        <HeaderCell label="ANES / WK" />
      </div>
      {/* TO row */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns,
          background: tok.surface,
          borderLeft: `0.5px solid ${tok.border}`,
          borderRight: `0.5px solid ${tok.border}`,
          borderBottom: `0.5px solid ${tok.border}`,
        }}
      >
        <HeaderCell label="" />
        <HeaderCell label="" />
        {TIME_BLOCKS.map((b, i) => (
          <HeaderCell key={`to-${i}`} label={i === 0 ? `TO ${pad4(b.end)}` : pad4(b.end)} />
        ))}
        <HeaderCell label="per day" muted />
        <HeaderCell label="per day" muted />
        <HeaderCell label="" />
        <HeaderCell label="weekly" muted />
        <HeaderCell label="weekly" muted />
      </div>
    </>
  );
}

function HeaderCell({
  label,
  align = 'center',
  muted = false,
}: {
  label: string;
  align?: 'left' | 'center' | 'right';
  muted?: boolean;
}) {
  return (
    <div
      style={{
        padding: '4px 6px',
        fontSize: 9,
        fontFamily: tok.mono,
        fontWeight: 700,
        letterSpacing: 0.4,
        textTransform: 'uppercase',
        color: muted ? tok.textDim : tok.textMuted,
        textAlign: align,
        borderRight: `0.5px solid ${tok.border}`,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {label}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Body row — one ContractualRow → 1 + 1 + 12 + 5 cells.
// ---------------------------------------------------------------------------

function BodyRow({
  row,
  isGroupHead,
  groupSpan,
  gridTemplateColumns,
}: {
  row: ContractualRow;
  isGroupHead: boolean;
  groupSpan: number;
  gridTemplateColumns: string;
}) {
  const accent = GROUP_ACCENT[row.groupId];
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns,
        minHeight: ROW_HEIGHT_PX,
        borderLeft: `0.5px solid ${tok.border}`,
        borderRight: `0.5px solid ${tok.border}`,
        borderBottom: `0.5px solid ${tok.border}`,
      }}
    >
      {/* Group label cell — only printed on the first row of each group. */}
      <div
        style={{
          padding: '4px 6px',
          fontSize: 9,
          fontFamily: tok.mono,
          fontWeight: 700,
          letterSpacing: 0.4,
          textTransform: 'uppercase',
          color: accent,
          borderLeft: `3px solid ${accent}`,
          borderRight: `0.5px solid ${tok.border}`,
          background: `${accent}10`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          // Inherit visual-rowspan via centering + writing the label only on
          // the head row. Lower rows keep the accent bar but no text.
        }}
      >
        {isGroupHead ? row.groupLabel : ''}
        {/* Tiny "of N" sub-counter on the group head for clarity. */}
        {isGroupHead && groupSpan > 1 ? (
          <span style={{ marginLeft: 4, color: tok.textDim, fontWeight: 500 }}>
            ×{groupSpan}
          </span>
        ) : null}
      </div>

      {/* Location label */}
      <div
        style={{
          padding: '4px 8px',
          fontSize: 11,
          color: tok.text,
          fontWeight: 600,
          borderRight: `0.5px solid ${tok.border}`,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
        title={row.note ? `${row.label} — ${row.note}` : row.label}
      >
        <span>{row.label}</span>
        {row.note && (
          <span style={{ fontSize: 9, color: tok.textDim, fontFamily: tok.mono }}>
            {row.note}
          </span>
        )}
      </div>

      {/* 12 time-block cells */}
      {row.blocks.map((active, i) => (
        <div
          key={`b-${i}`}
          style={{
            borderRight: `0.5px solid ${tok.border}`,
            padding: 2,
            display: 'flex',
            alignItems: 'stretch',
          }}
        >
          {active ? (
            <div
              style={{
                flex: 1,
                background: `${row.barColor}33`,
                borderTop: `1.5px solid ${row.barColor}`,
                borderBottom: `1.5px solid ${row.barColor}`,
                borderRadius: 1,
              }}
            />
          ) : (
            <div style={{ flex: 1 }} />
          )}
        </div>
      ))}

      {/* 5 numeric cells */}
      <NumericCell value={row.crnaHrsPerDay} />
      <NumericCell value={row.mdHrsPerDay} />
      <NumericCell value={row.daysPerWeek} integer />
      <NumericCell value={row.crnaHrsPerDay * row.daysPerWeek} />
      <NumericCell value={row.mdHrsPerDay * row.daysPerWeek} />
    </div>
  );
}

function NumericCell({ value, integer = false }: { value: number; integer?: boolean }) {
  const text = value <= 0 ? '—' : integer ? String(value) : value.toFixed(2);
  return (
    <div
      style={{
        padding: '4px 8px',
        fontSize: 11,
        fontFamily: tok.mono,
        color: tok.text,
        textAlign: 'right',
        borderRight: `0.5px solid ${tok.border}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
      }}
    >
      {text}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Footer rows — one row per total in the screenshot's bottom block.
// ---------------------------------------------------------------------------

function FooterRows({
  totals,
  gridTemplateColumns,
}: {
  totals: ReturnType<typeof buildContractualGrid>['totals'];
  gridTemplateColumns: string;
}) {
  const rows: Array<{ label: string; crna: string; md: string; emphasis?: boolean }> = [
    {
      label: 'TOTAL COVERAGE HRS',
      crna: totals.crnaWeeklyHours.toFixed(0),
      md: totals.mdWeeklyHours.toFixed(0),
      emphasis: true,
    },
    {
      label: 'FTE HOURS PER WEEK',
      crna: '40',
      md: '40',
    },
    {
      label: 'FTE MANDATED BY HOURS',
      crna: totals.crnaFteMandated.toFixed(2),
      md: totals.mdFteMandated.toFixed(2),
      emphasis: true,
    },
    {
      label: 'VACATION WEEKS / FTE',
      crna: String(totals.vacationWeeksPerFte),
      md: String(totals.vacationWeeksPerFte),
    },
    {
      label: 'VACATION HOURS',
      crna: String(totals.vacationHoursPerFte),
      md: String(totals.vacationHoursPerFte),
    },
    {
      label: 'VACATION FTEs',
      crna: totals.crnaVacationFte.toFixed(2),
      md: totals.mdVacationFte.toFixed(2),
    },
    {
      label: 'PROJECTED TOTAL FTEs',
      crna: totals.crnaProjectedFte.toFixed(2),
      md: totals.mdProjectedFte.toFixed(2),
      emphasis: true,
    },
  ];

  return (
    <>
      {rows.map((r, i) => (
        <FooterRow
          key={`f-${i}`}
          label={r.label}
          crna={r.crna}
          md={r.md}
          emphasis={r.emphasis}
          gridTemplateColumns={gridTemplateColumns}
        />
      ))}
    </>
  );
}

function FooterRow({
  label,
  crna,
  md,
  emphasis,
  gridTemplateColumns,
}: {
  label: string;
  crna: string;
  md: string;
  emphasis?: boolean;
  gridTemplateColumns: string;
}) {
  // Span the group + label + 12-block region as a single label cell, then
  // use the last 5 numeric columns as CRNA / MD / blank / blank / blank.
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns,
        minHeight: ROW_HEIGHT_PX,
        borderLeft: `0.5px solid ${tok.border}`,
        borderRight: `0.5px solid ${tok.border}`,
        borderBottom: `0.5px solid ${tok.border}`,
        background: emphasis ? `${tok.accent}0A` : tok.surface,
      }}
    >
      {/* Label cell spans group + label + 12 time blocks (= 14 columns). */}
      <div
        style={{
          gridColumn: `1 / span ${2 + TIME_BLOCKS.length}`,
          padding: '4px 12px',
          fontSize: 10,
          fontFamily: tok.mono,
          fontWeight: 700,
          letterSpacing: 0.5,
          textTransform: 'uppercase',
          color: emphasis ? tok.accent : tok.textMuted,
          borderRight: `0.5px solid ${tok.border}`,
          display: 'flex',
          alignItems: 'center',
        }}
      >
        {label}
      </div>
      {/* CRNA total */}
      <div
        style={{
          padding: '4px 8px',
          fontSize: 11,
          fontFamily: tok.mono,
          fontWeight: emphasis ? 700 : 500,
          color: emphasis ? tok.accent : tok.text,
          textAlign: 'right',
          borderRight: `0.5px solid ${tok.border}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gridColumn: 'span 2',
        }}
        title="CRNA"
      >
        {crna}
      </div>
      {/* MD total */}
      <div
        style={{
          padding: '4px 8px',
          fontSize: 11,
          fontFamily: tok.mono,
          fontWeight: emphasis ? 700 : 500,
          color: emphasis ? tok.accent : tok.text,
          textAlign: 'right',
          borderRight: `0.5px solid ${tok.border}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gridColumn: 'span 3',
        }}
        title="Anesthesiologist"
      >
        {md}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format an hour-int as 4-digit clock time. 700 → "0700", 2400 → "2400", 300 → "0300". */
function pad4(n: number): string {
  return String(n).padStart(4, '0');
}
