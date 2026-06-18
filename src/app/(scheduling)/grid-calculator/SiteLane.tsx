'use client';

// Site lane — one horizontal lane per site.
// Owned by agent A9 (Grid Canvas).
// PRD: docs/PRD-Grid-Calculator.md §7.1, §7.3, §7.5.
//
// Layout rules (PRD §7.1):
//   - Left edge: site icon + name + small distance indicator chip.
//   - Right side: the room cells stacked horizontally, each carrying its
//     Anesthesiologist card + nested CRNA chips.
//   - Float lane is always last (PRD §7.5); the parent canvas decides position
//     and passes `variant='float'` here so the lane reads as "outlined cards
//     (not solid)".
//
// Cross-site supervision (PRD §7.3): the parent canvas draws an SVG overlay
// of dashed-purple connectors above the lanes. This component just exposes
// per-room layout anchors via data-attributes for the parent to query if it
// wants to upgrade later. v1 inlines the cross-site signal inside the CRNA
// chip's destination badge so the visual works without the SVG.

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
  /** Lookup table mapping providerId → display label. */
  providerLabels: Record<string, ProviderLabel>;
  /** Sites lookup for cross-site badge color resolution. */
  siteLookup: Map<string, GridSite>;
  /** Effective ratio cap from the current toggle state. */
  ratioCap: number;
  /** Optional distance chip text (e.g. "↔ near Main OR"). */
  distanceChipText?: string;
}

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

  return (
    <div
      data-lane-site-id={props.site?.id ?? 'float'}
      data-lane-variant={props.variant}
      style={{
        display: 'flex',
        background: 'var(--bg-surface)',
        borderRadius: 10,
        border: '1px solid var(--border)',
        borderLeft: `3px solid ${label.color}`,
        overflow: 'hidden',
        marginBottom: 10,
        boxShadow: isFloat ? 'none' : '0 1px 2px rgba(0,0,0,0.04)',
        opacity: isFloat ? 0.97 : 1,
      }}
    >
      {/* ── Lane header (left edge) ──────────────────────────────────────── */}
      <div
        style={{
          width: 160,
          flexShrink: 0,
          padding: '10px 12px 10px 10px',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          borderRight: '1px solid var(--border)',
          background: `linear-gradient(135deg, ${hexA(label.color, 0.08)} 0%, transparent 100%)`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              width: 26,
              height: 26,
              borderRadius: 6,
              background: hexA(label.color, 0.14),
              border: `1px solid ${hexA(label.color, 0.3)}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 13,
              flexShrink: 0,
            }}
          >
            {label.icon}
          </span>
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                color: label.color,
                fontSize: 12,
                fontWeight: 800,
                letterSpacing: -0.2,
                lineHeight: 1.15,
              }}
            >
              {label.name}
            </div>
            {label.caption && (
              <div
                style={{
                  fontSize: 9,
                  color: 'var(--text-dim)',
                  fontFamily: 'var(--font-mono), ui-monospace, monospace',
                }}
              >
                {label.caption}
              </div>
            )}
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 9,
            color: 'var(--text-muted)',
            fontFamily: 'var(--font-mono), ui-monospace, monospace',
          }}
        >
          {isFloat ? (
            <span
              style={{
                padding: '1px 5px',
                borderRadius: 3,
                border: `0.5px dashed ${hexA(label.color, 0.6)}`,
              }}
            >
              float lane
            </span>
          ) : (
            <span
              style={{
                padding: '1px 5px',
                borderRadius: 3,
                background: hexA(label.color, 0.08),
                color: label.color,
                fontWeight: 700,
              }}
            >
              {props.site?.rooms.length ?? props.roomAssignments?.length ?? 0} room
              {(props.site?.rooms.length ?? props.roomAssignments?.length ?? 0) === 1 ? '' : 's'}
            </span>
          )}
          {props.distanceChipText && (
            <span style={{ opacity: 0.85 }}>{props.distanceChipText}</span>
          )}
        </div>
      </div>

      {/* ── Lane content (rooms or float pool) ───────────────────────────── */}
      <div
        style={{
          flex: 1,
          padding: '10px 12px',
          display: 'flex',
          alignItems: 'flex-start',
          flexWrap: 'wrap',
          gap: 10,
          minWidth: 0,
        }}
      >
        {isFloat ? renderFloatPool(props) : renderRooms(props)}
      </div>
    </div>
  );
}

function renderFloatPool(props: SiteLaneProps): React.ReactNode {
  const floats = props.floats ?? [];
  if (floats.length === 0) {
    return (
      <div
        style={{
          flex: 1,
          padding: '6px 0',
          fontSize: 11,
          color: 'var(--text-dim)',
          fontStyle: 'italic',
          textAlign: 'center',
        }}
      >
        No floats — every provider assigned. Consider adding capacity for breaks &amp; add-ons.
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
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
              initials={label.initials}
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
            initials={label.initials}
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
    </div>
  );
}

function renderRooms(props: SiteLaneProps): React.ReactNode {
  const rooms = props.roomAssignments ?? [];
  if (rooms.length === 0) {
    return (
      <div
        style={{
          flex: 1,
          padding: '6px 0',
          fontSize: 11,
          color: 'var(--text-dim)',
          fontStyle: 'italic',
        }}
      >
        No rooms.
      </div>
    );
  }
  return rooms.map(({ assignment, roomName, roomId }) => {
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
      // from X" — that's the more useful direction at a glance.
      const supSite = assignment.crossSiteSupervisor
        ? props.siteLookup.get(assignment.crossSiteSupervisor.fromSiteId)
        : null;
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
          gap: 4,
          minWidth: 220,
        }}
      >
        <div
          style={{
            fontSize: 9,
            fontFamily: 'var(--font-mono), ui-monospace, monospace',
            fontWeight: 700,
            color: 'var(--text-muted)',
            letterSpacing: 0.4,
            textTransform: 'uppercase',
            paddingBottom: 2,
            borderBottom: '0.5px solid var(--border)',
          }}
        >
          {roomName}
          {assignment.crossSiteSupervisor && (
            <span
              style={{
                marginLeft: 6,
                color: '#a855f7',
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
            initials={mdLabel.initials}
            variant={variant}
            supervisedCrnas={supervisedCrnas}
            ratioCap={props.ratioCap}
            roomCaption={
              assignment.crossSiteSupervisor && props.site
                ? `supervises from ${
                    props.siteLookup.get(assignment.crossSiteSupervisor.fromSiteId)?.shortName ??
                    'elsewhere'
                  }`
                : undefined
            }
          />
        ) : (
          <div
            style={{
              padding: '8px 10px',
              borderRadius: 8,
              border: '1.5px dashed #ef4444',
              background: 'rgba(239,68,68,0.06)',
              fontSize: 11,
              color: '#ef4444',
              fontWeight: 700,
              fontFamily: 'var(--font-mono), ui-monospace, monospace',
            }}
          >
            ⚠ Unstaffed — no Anesthesiologist available
          </div>
        )}
      </div>
    );
  });
}

function firstWord(s: string): string {
  return s.trim().split(/\s+/)[0] ?? s;
}

function hexA(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(100,116,139,${alpha})`;
  const v = parseInt(m[1], 16);
  const r = (v >> 16) & 0xff;
  const g = (v >> 8) & 0xff;
  const b = v & 0xff;
  return `rgba(${r},${g},${b},${alpha})`;
}
