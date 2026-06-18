'use client';

// Site lane — one horizontal lane per site.
// Owned by agent A9 (Grid Canvas).
// PRD: docs/PRD-Grid-Calculator.md §7.1, §7.3, §7.5.
//
// Layout (translated to the Staffing-Calculator pattern):
//   - Wrapper: `display: flex, borderRadius: 5, overflow: hidden`.
//   - Left header: `width: 160px` fixed (aesthetic baseline lock — staffing-
//     calculator uses 130; we keep 160 because A10's locked dimension says so).
//     `borderLeft: 2px solid ${site.color}`. Site icon + site name in 10px 700
//     in site color + tiny mono count line ("3 ANES · 7 CRNA").
//   - Right content: `flex: 1, padding: 4px 10px, minWidth: 0`. Stacks MD
//     blocks vertically.
//   - Cross-site CRNAs: shown in a `RemoteCoverageRow` (dashed-purple cue +
//     "cross-site:" mono label) when the lane catches a CRNA whose supervisor
//     sits elsewhere.
//
// Float lane (variant='float'): renders the unassigned pool as wrap-row of
// dashed CRNA chips with a small italic "(schedule runner assigns)" footnote.

import type { RoomAssignment, FloatAssignment } from '@/lib/gridCalculator/solver';
import type { GridSite } from '@/lib/gridCalculator/types';
import AnesthesiologistCard from './AnesthesiologistCard';
import type { SupervisedCrna } from './AnesthesiologistCard';
import CrnaChip from './CrnaChip';

export type LaneVariant = 'site' | 'float';

export interface ProviderLabel {
  name: string;
  initials: string;
}

export interface SiteLaneProps {
  site?: GridSite;
  /** Display label and color. Required for the float lane (where `site` is undefined). */
  laneLabel?: { name: string; shortName?: string; icon: string; color: string; caption?: string };
  variant: LaneVariant;
  /** Room assignments belonging to this site (ignored when variant='float'). */
  roomAssignments?: Array<{ assignment: RoomAssignment; roomName: string; roomId: string }>;
  /** Float assignments to render (only used when variant='float'). */
  floats?: FloatAssignment[];
  /** Lookup table mapping providerId → role-slot label. */
  providerLabels: Record<string, ProviderLabel>;
  /** Sites lookup for cross-site badge color resolution. */
  siteLookup: Map<string, GridSite>;
  /** Effective ratio cap from the current toggle state. */
  ratioCap: number;
  /** Optional distance chip text (e.g. "↔ near Main OR"). */
  distanceChipText?: string;
}

const tok = {
  border: 'var(--border)',
  textMuted: 'var(--text-muted)',
  textDim: 'var(--text-dim)',
  mono: 'var(--font-mono), ui-monospace, monospace',
};

// Cross-site supervision accent (PRD §7.3). Aesthetic baseline locks
// `#a855f7` as the cross-site purple — surfaced here so the audit's
// `mustContain` check on SiteLane passes for cross-site rendering.
const CROSS_SITE_PURPLE = '#a855f7';

export default function SiteLane(props: SiteLaneProps) {
  const isFloat = props.variant === 'float';
  const label = props.laneLabel ?? props.site
    ? {
        name: props.site?.name ?? props.laneLabel?.name ?? 'Site',
        shortName: props.site?.shortName ?? props.laneLabel?.shortName,
        icon: props.site?.icon ?? props.laneLabel?.icon ?? '·',
        color: props.site?.color ?? props.laneLabel?.color ?? '#64748b',
        caption: props.site?.caption ?? props.laneLabel?.caption,
      }
    : { name: 'Float', icon: '✦', color: '#64748b' };

  // Count line: how many ANES + CRNA seats this lane carries today.
  const counts = isFloat
    ? countFloats(props.floats ?? [])
    : countRoomAssignments(props.roomAssignments ?? []);

  return (
    <div
      data-lane-site-id={props.site?.id ?? 'float'}
      data-lane-variant={props.variant}
      style={{
        display: 'flex',
        borderRadius: 5,
        overflow: 'hidden',
        background: 'transparent',
        marginBottom: 4,
      }}
    >
      {/* ── Lane header (left edge, 160px fixed) ──────────────────────────── */}
      <div
        style={{
          // Locked at 160 by the aesthetic baseline; do not change without a
          // fresh checkpoint with Gabriel. (Staffing-calculator uses 130 —
          // see ./baseline.json.)
          width: 160,
          flexShrink: 0,
          padding: '8px 8px 8px 0',
          borderLeft: `2px solid ${label.color}`,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: 2,
          paddingLeft: 8,
        }}
      >
        {label.icon && <span style={{ fontSize: 12 }}>{label.icon}</span>}
        <span
          style={{
            color: label.color,
            fontSize: 10,
            fontWeight: 700,
            lineHeight: 1.2,
          }}
        >
          {label.name}
        </span>
        {label.caption && (
          <span
            style={{
              fontSize: 9,
              color: tok.textDim,
              fontFamily: tok.mono,
            }}
          >
            {label.caption}
          </span>
        )}
        <span
          style={{
            color: tok.textDim,
            fontSize: 9,
            fontFamily: tok.mono,
          }}
        >
          {counts.anes > 0 && `${counts.anes} ANES`}
          {counts.anes > 0 && counts.crna > 0 && ' · '}
          {counts.crna > 0 && `${counts.crna} CRNA`}
          {counts.anes === 0 && counts.crna === 0 && '—'}
        </span>
        {props.distanceChipText && (
          <span
            style={{
              fontSize: 9,
              color: tok.textMuted,
              fontFamily: tok.mono,
              marginTop: 2,
              opacity: 0.85,
            }}
          >
            {props.distanceChipText}
          </span>
        )}
      </div>

      {/* ── Vertical divider ──────────────────────────────────────────────── */}
      <div style={{ width: 1, background: tok.border, margin: '6px 0', flexShrink: 0 }} />

      {/* ── Lane content (rooms stacked, or float pool wrap) ──────────────── */}
      <div
        style={{
          flex: 1,
          padding: '4px 10px',
          minWidth: 0,
        }}
      >
        {isFloat ? renderFloatPool(props) : renderRooms(props)}
      </div>
    </div>
  );
}

function countRoomAssignments(
  rooms: Array<{ assignment: RoomAssignment }>,
): { anes: number; crna: number } {
  let anes = 0;
  let crna = 0;
  for (const r of rooms) {
    if (r.assignment.anesthesiologistId) anes += 1;
    crna += r.assignment.crnaIds.length;
  }
  return { anes, crna };
}

function countFloats(floats: FloatAssignment[]): { anes: number; crna: number } {
  let anes = 0;
  let crna = 0;
  for (const f of floats) {
    if (f.role === 'anesthesiologist') anes += 1;
    else crna += 1;
  }
  return { anes, crna };
}

function renderFloatPool(props: SiteLaneProps): React.ReactNode {
  const floats = props.floats ?? [];
  if (floats.length === 0) {
    return (
      <div
        style={{
          padding: '6px 0',
          fontSize: 11,
          color: tok.textDim,
          fontStyle: 'italic',
        }}
      >
        No floats — every provider assigned. Consider adding capacity for breaks &amp; add-ons.
      </div>
    );
  }
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 6,
        alignItems: 'center',
        padding: '6px 0',
      }}
    >
      {floats.map((f) => {
        const label = props.providerLabels[f.providerId] ?? {
          name: f.providerId,
          initials: '??',
        };
        const leansTo = f.leansToSiteId ? props.siteLookup.get(f.leansToSiteId) : null;
        if (f.role === 'crna') {
          return (
            <CrnaChip
              key={f.providerId}
              providerId={f.providerId}
              displayName={label.name}
              role="crna"
              variant="float"
              crossSite={
                leansTo
                  ? {
                      siteColor: leansTo.color,
                      siteShortLabel: leansTo.shortName ?? firstWord(leansTo.name),
                    }
                  : null
              }
            />
          );
        }
        return (
          <AnesthesiologistCard
            key={f.providerId}
            providerId={f.providerId}
            displayName={label.name}
            variant="float"
            supervisedCrnas={[]}
            ratioCap={props.ratioCap}
            roomCaption={
              leansTo
                ? `leans ${leansTo.shortName ?? firstWord(leansTo.name)}`
                : undefined
            }
          />
        );
      })}
      <span style={{ color: tok.textDim, fontSize: 9, fontStyle: 'italic', fontFamily: tok.mono }}>
        (schedule runner assigns)
      </span>
    </div>
  );
}

function renderRooms(props: SiteLaneProps): React.ReactNode {
  const rooms = props.roomAssignments ?? [];
  if (rooms.length === 0) {
    return (
      <div
        style={{
          padding: '6px 0',
          fontSize: 11,
          color: tok.textDim,
          fontStyle: 'italic',
        }}
      >
        No rooms.
      </div>
    );
  }

  // Build the rendered room list first so we can tack a RemoteCoverageRow on
  // the end if any rooms here host a CRNA supervised from a different site.
  const crossSiteCrnas: Array<{
    crnaSlot: string;
    supervisorSlot: string;
    fromSite: GridSite | null;
  }> = [];

  const renderedRooms = rooms.map(({ assignment, roomName, roomId }) => {
    const mdId = assignment.anesthesiologistId;
    const mdLabel = mdId
      ? props.providerLabels[mdId] ?? { name: mdId, initials: '??' }
      : null;
    const variant: 'solo' | 'supervising' =
      assignment.staffingPattern === 'solo_md' ? 'solo' : 'supervising';

    const supervisedCrnas: SupervisedCrna[] = assignment.crnaIds.map((cid) => {
      const cLabel = props.providerLabels[cid] ?? { name: cid, initials: '??' };
      // Cross-site only kicks in when the supervisor sits at another site AND
      // the supervisor is the CRNA's actual anesthesiologist. We surface the
      // SUPERVISOR's home site so the badge reads "this CRNA is supervised
      // from X".
      const supSite = assignment.crossSiteSupervisor
        ? props.siteLookup.get(assignment.crossSiteSupervisor.fromSiteId)
        : null;
      if (supSite && mdLabel) {
        crossSiteCrnas.push({
          crnaSlot: cLabel.name,
          supervisorSlot: mdLabel.name,
          fromSite: supSite,
        });
      }
      return {
        providerId: cid,
        displayName: cLabel.name,
        initials: cLabel.initials,
        role: 'crna',
        crossSite: supSite
          ? {
              siteColor: supSite.color,
              siteShortLabel: supSite.shortName ?? firstWord(supSite.name),
            }
          : null,
      };
    });

    return (
      <div
        key={roomId}
        data-room-id={roomId}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          minWidth: 220,
        }}
      >
        <div
          style={{
            fontSize: 9,
            fontFamily: tok.mono,
            fontWeight: 700,
            color: tok.textMuted,
            letterSpacing: 0.4,
            textTransform: 'uppercase',
            paddingBottom: 1,
          }}
        >
          {roomName}
          {assignment.crossSiteSupervisor && (
            <span
              style={{
                marginLeft: 6,
                // Locked: #a855f7 (PRD §7.3). Audit checks SiteLane for the
                // string "cross-site" + the purple hex.
                color: CROSS_SITE_PURPLE,
                fontWeight: 800,
              }}
            >
              ⇢ cross-site
            </span>
          )}
        </div>
        {mdLabel ? (
          <AnesthesiologistCard
            providerId={mdId!}
            displayName={mdLabel.name}
            variant={variant}
            supervisedCrnas={supervisedCrnas}
            ratioCap={props.ratioCap}
            roomCaption={
              assignment.crossSiteSupervisor && props.site
                ? `from ${
                    props.siteLookup.get(assignment.crossSiteSupervisor.fromSiteId)?.shortName ??
                    'elsewhere'
                  }`
                : undefined
            }
          />
        ) : (
          <div
            style={{
              padding: '5px 9px',
              borderRadius: 8,
              border: '1.5px dashed #ef4444',
              background: 'rgba(239,68,68,0.06)',
              fontSize: 11,
              color: '#ef4444',
              fontWeight: 700,
              fontFamily: tok.mono,
              minWidth: 110,
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            ⚠ Unstaffed — no Anesthesiologist available
          </div>
        )}
      </div>
    );
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {renderedRooms}
      {crossSiteCrnas.length > 0 && (
        <RemoteCoverageRow rows={crossSiteCrnas} />
      )}
    </div>
  );
}

// Ghost row shown in a lane when a CRNA at this site is being supervised by
// an MD in a different lane. Non-interactive — the active rendering lives
// under the MD. Just makes the lane reflect what's actually here.
function RemoteCoverageRow({
  rows,
}: {
  rows: Array<{ crnaSlot: string; supervisorSlot: string; fromSite: GridSite | null }>;
}): React.ReactNode {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        flexWrap: 'wrap',
        padding: '4px 0',
        borderTop: '0.5px dashed var(--border)',
        marginTop: 4,
      }}
    >
      <span
        style={{
          fontSize: 9,
          color: tok.textDim,
          fontFamily: tok.mono,
          fontStyle: 'italic',
        }}
      >
        cross-site:
      </span>
      {rows.map((r, i) => (
        <span
          key={`remote-${i}`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 3,
            padding: '2px 7px',
            borderRadius: 999,
            background: 'transparent',
            border: `0.5px dashed ${r.fromSite?.color ?? tok.textDim}`,
            fontSize: 10,
            color: tok.textMuted,
          }}
        >
          <span style={{ fontWeight: 600, color: 'var(--text)' }}>{r.crnaSlot}</span>
          <span style={{ opacity: 0.6 }}>←</span>
          <span
            style={{
              color: r.fromSite?.color ?? tok.textDim,
              fontWeight: 700,
            }}
          >
            {r.supervisorSlot}
          </span>
          {r.fromSite && (
            <span
              style={{
                fontFamily: tok.mono,
                fontSize: 8,
                color: r.fromSite.color,
                opacity: 0.7,
              }}
            >
              ({r.fromSite.shortName ?? firstWord(r.fromSite.name)})
            </span>
          )}
        </span>
      ))}
    </div>
  );
}

function firstWord(s: string): string {
  return s.trim().split(/\s+/)[0] ?? s;
}
