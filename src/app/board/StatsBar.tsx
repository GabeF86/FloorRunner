'use client';

import { StaffMember, Assignment, Site, Role, ROLE_META, SupervisionLoad, SUPERVISION_LIMITS } from '@/types';
import { hexToRgb } from './BoardClient';

interface Props {
  staff:            StaffMember[];
  assignments:      Assignment[];
  assignedStaffIds: Set<string>;
  supervisionLoads: Record<string, SupervisionLoad>;
  sites:            Site[];
}

export default function StatsBar({ staff, assignments, assignedStaffIds, supervisionLoads, sites }: Props) {
  const totalRooms = sites.reduce((n, s) => n + s.rooms.length, 0);
  const statsByRole = (role: Role) => ({
    total: staff.filter((p) => p.role === role).length,
    avail: staff.filter((p) => p.role === role && !assignedStaffIds.has(p.id)).length,
  });

  // Count physicians over limit
  const mdsOverLimit = Object.values(supervisionLoads).filter(
    (l) => l.overCrna || l.overResident
  ).length;
  const mdsAtLimit = Object.values(supervisionLoads).filter(
    (l) => !l.overCrna && !l.overResident && (l.atCrna || l.atResident)
  ).length;

  const stats = [
    { label: 'Assigned',  value: assignedStaffIds.size, sub: `of ${staff.length}`, color: '#0ea5e9' },
    { label: 'Physicians', ...statsByRole('physician'), color: ROLE_META.physician.color },
    { label: 'CRNAs',      ...statsByRole('crna'),      color: ROLE_META.crna.color },
    { label: 'SRNAs',      ...statsByRole('srna'),      color: ROLE_META.srna.color },
    { label: 'Residents',  ...statsByRole('resident'),  color: ROLE_META.resident.color },
    { label: 'Surgeons',   ...statsByRole('surgeon'),   color: ROLE_META.surgeon.color },
    { label: 'Rooms',      value: totalRooms,            color: '#64748b' },
  ];

  return (
    <div style={{ marginBottom: 16 }}>
      {/* Supervision alert banner */}
      {(mdsOverLimit > 0 || mdsAtLimit > 0) && (
        <div style={{
          marginBottom: 10, padding: '8px 14px', borderRadius: 9,
          background: mdsOverLimit > 0 ? 'rgba(248,113,113,0.1)' : 'rgba(251,191,36,0.08)',
          border: `1px solid ${mdsOverLimit > 0 ? 'rgba(248,113,113,0.35)' : 'rgba(251,191,36,0.3)'}`,
          display: 'flex', alignItems: 'center', gap: 10,
          fontSize: 12, fontWeight: 600,
          color: mdsOverLimit > 0 ? '#f87171' : '#fbbf24',
        }}>
          <span style={{ fontSize: 15 }}>{mdsOverLimit > 0 ? '🚨' : '⚠️'}</span>
          {mdsOverLimit > 0
            ? `${mdsOverLimit} physician${mdsOverLimit > 1 ? 's are' : ' is'} OVER supervision limit — check sidebar for details`
            : `${mdsAtLimit} physician${mdsAtLimit > 1 ? 's are' : ' is'} at maximum supervision capacity`
          }
          <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.7 }}>
            Limits: {SUPERVISION_LIMITS.crna} CRNA · {SUPERVISION_LIMITS.resident} Resident
          </span>
        </div>
      )}

      {/* Stats row */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {stats.map((s) => {
          const rgb     = hexToRgb(s.color);
          const display = 'avail' in s ? `${s.avail}` : s.value;
          const sub     = 'avail' in s ? `/ ${s.total} total` : ('sub' in s ? s.sub : undefined);
          return (
            <div key={s.label} style={{
              flex: '1 1 80px',
              background: 'var(--bg-surface)',
              border: '1px solid var(--border)',
              borderTop: `2px solid rgba(${rgb},0.4)`,
              borderRadius: 10,
              padding: '10px 13px',
            }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: s.color, lineHeight: 1 }}>{display}</div>
              {sub && <div style={{ fontSize: 9, color: 'var(--text-dim)', marginTop: 1 }}>{sub}</div>}
              <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginTop: 3 }}>
                {s.label}
              </div>
            </div>
          );
        })}

        {/* Legend */}
        <div style={{
          flex: '2 1 200px',
          background: 'var(--bg-surface)', border: '1px solid var(--border)',
          borderRadius: 10, padding: '10px 14px',
          display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 5,
        }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px 12px' }}>
            {(Object.entries(ROLE_META) as [Role, typeof ROLE_META[Role]][]).map(([role, meta]) => (
              <span key={role} style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 9, height: 9, borderRadius: 2, background: meta.color, display: 'inline-block' }} />
                {meta.label}
              </span>
            ))}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)', fontStyle: 'italic' }}>
            Physicians can cover multiple rooms · ⚠ yellow border = room needs MD · Hover MD card to see load
          </div>
        </div>
      </div>
    </div>
  );
}
