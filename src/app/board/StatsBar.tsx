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

export default function StatsBar({ staff, assignedStaffIds, supervisionLoads, sites }: Props) {
  const totalRooms = sites.filter((s) => !s.is_float).reduce((n, s) => n + s.rooms.length, 0);

  const statsByRole = (role: Role) => ({
    assigned: staff.filter((p) => p.role === role && assignedStaffIds.has(p.id)).length,
    total:    staff.filter((p) => p.role === role).length,
  });

  const mdsOverLimit = Object.values(supervisionLoads).filter((l) => l.overCrna || l.overResident).length;
  const mdsAtLimit   = Object.values(supervisionLoads).filter((l) => !l.overCrna && !l.overResident && (l.atCrna || l.atResident)).length;

  const md   = statsByRole('physician');
  const crna = statsByRole('crna');

  return (
    <div style={{ marginBottom: 14 }}>
      {/* Supervision alert */}
      {(mdsOverLimit > 0 || mdsAtLimit > 0) && (
        <div style={{
          marginBottom: 8, padding: '7px 13px', borderRadius: 9,
          background: mdsOverLimit > 0 ? 'rgba(248,113,113,0.1)' : 'rgba(251,191,36,0.08)',
          border: `1px solid ${mdsOverLimit > 0 ? 'rgba(248,113,113,0.35)' : 'rgba(251,191,36,0.3)'}`,
          display: 'flex', alignItems: 'center', gap: 10,
          fontSize: 12, fontWeight: 600,
          color: mdsOverLimit > 0 ? '#f87171' : '#fbbf24',
        }}>
          <span style={{ fontSize: 14 }}>{mdsOverLimit > 0 ? '🚨' : '⚠️'}</span>
          {mdsOverLimit > 0
            ? `${mdsOverLimit} physician${mdsOverLimit > 1 ? 's' : ''} OVER supervision limit`
            : `${mdsAtLimit} physician${mdsAtLimit > 1 ? 's' : ''} at max supervision capacity`}
          <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.7 }}>
            Limits: {SUPERVISION_LIMITS.crna} CRNA · {SUPERVISION_LIMITS.resident} Resident
          </span>
        </div>
      )}

      {/* Compact stats — single box, right-aligned */}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <div style={{
          background: 'var(--bg-surface)', border: '1px solid var(--border)',
          borderRadius: 10, padding: '7px 14px',
          display: 'flex', alignItems: 'center', gap: 16,
        }}>
          <StatPill label="MDs"   assigned={md.assigned}   total={md.total}   color={ROLE_META.physician.color} />
          <div style={{ width: 1, height: 22, background: 'var(--border)' }} />
          <StatPill label="CRNAs" assigned={crna.assigned} total={crna.total} color={ROLE_META.crna.color} />
          <div style={{ width: 1, height: 22, background: 'var(--border)' }} />
          <span style={{ fontSize: 11, color: 'var(--text-dim)', fontWeight: 700 }}>
            <span style={{ color: '#64748b', fontWeight: 800 }}>{totalRooms}</span>
            <span style={{ marginLeft: 4 }}>rooms</span>
          </span>
        </div>
      </div>
    </div>
  );
}

function StatPill({ label, assigned, total, color }: { label: string; assigned: number; total: number; color: string }) {
  const rgb = hexToRgb(color);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 7, height: 7, borderRadius: 2, background: color, display: 'inline-block', flexShrink: 0 }} />
      <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 700 }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 800, color, background: `rgba(${rgb},0.1)`, border: `1px solid rgba(${rgb},0.2)`, borderRadius: 5, padding: '1px 7px' }}>
        {assigned}<span style={{ fontSize: 10, opacity: 0.6 }}>/{total}</span>
      </span>
    </div>
  );
}
