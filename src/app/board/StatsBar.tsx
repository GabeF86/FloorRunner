'use client';

import { StaffMember, Site, Role, ROLE_META, SupervisionLoad, SUPERVISION_LIMITS } from '@/types';
import { hexToRgb } from './BoardClient';
import { Banner } from '@/components/ui';

interface StatsInlineProps {
  staff:            StaffMember[];
  assignedStaffIds: Set<string>;
  sites:            Site[];
}

// Slim inline stats — StatPills + room count in one ~30px row, no outer
// box/margins. Lives inside BoardClient's header row (task 4: folds the old
// standalone StatsBar box into the header line, reclaiming ~40px of height).
export function StatsInline({ staff, assignedStaffIds, sites }: StatsInlineProps) {
  const totalRooms = sites.filter((s) => !s.is_float).reduce((n, s) => n + s.rooms.length, 0);

  const statsByRole = (role: Role) => ({
    assigned: staff.filter((p) => p.role === role && assignedStaffIds.has(p.id)).length,
    total:    staff.filter((p) => p.role === role).length,
  });

  const md   = statsByRole('physician');
  const crna = statsByRole('crna');

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
      <StatPill label="MDs"   assigned={md.assigned}   total={md.total}   color={ROLE_META.physician.color} />
      <div style={{ width: 1, height: 14, background: 'var(--border)' }} />
      <StatPill label="CRNAs" assigned={crna.assigned} total={crna.total} color={ROLE_META.crna.color} />
      <div style={{ width: 1, height: 14, background: 'var(--border)' }} />
      <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', fontWeight: 700, fontFamily: 'var(--font-mono), ui-monospace, monospace' }}>
        <span style={{ color: 'var(--text-muted)', fontWeight: 800 }}>{totalRooms}</span>
        <span style={{ marginLeft: 'var(--space-1)' }}>rooms</span>
      </span>
    </div>
  );
}

interface SupervisionBannerProps {
  supervisionLoads: Record<string, SupervisionLoad>;
}

// Full-width supervision alert — unchanged thresholds/copy from the old
// combined StatsBar. Self-contained: renders null when nobody is at/over
// limit, so BoardClient can mount it unconditionally.
export function SupervisionBanner({ supervisionLoads }: SupervisionBannerProps) {
  const mdsOverLimit = Object.values(supervisionLoads).filter((l) => l.overCrna || l.overResident).length;
  const mdsAtLimit   = Object.values(supervisionLoads).filter((l) => !l.overCrna && !l.overResident && (l.atCrna || l.atResident)).length;

  if (mdsOverLimit === 0 && mdsAtLimit === 0) return null;

  return (
    <div style={{ padding: '6px 12px' }}>
      <Banner tone={mdsOverLimit > 0 ? 'error' : 'warn'}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontWeight: 600 }}>
          <span>{mdsOverLimit > 0 ? '🚨' : '⚠️'}</span>
          {mdsOverLimit > 0
            ? `${mdsOverLimit} physician${mdsOverLimit > 1 ? 's' : ''} over limit`
            : `${mdsAtLimit} physician${mdsAtLimit > 1 ? 's' : ''} at max capacity`}
          <span style={{ marginLeft: 'auto', fontSize: 'var(--fs-xs)', opacity: 0.7, fontFamily: 'var(--font-mono), ui-monospace, monospace' }}>
            limits: {SUPERVISION_LIMITS.crna}c · {SUPERVISION_LIMITS.resident}r
          </span>
        </span>
      </Banner>
    </div>
  );
}

function StatPill({ label, assigned, total, color }: { label: string; assigned: number; total: number; color: string }) {
  const rgb = hexToRgb(color);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
      <span style={{ width: 6, height: 6, borderRadius: 2, background: color, display: 'inline-block', flexShrink: 0 }} />
      <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', fontWeight: 700 }}>{label}</span>
      <span style={{ fontSize: 'var(--fs-xs)', fontWeight: 800, color, background: `rgba(${rgb},0.1)`, border: `1px solid rgba(${rgb},0.2)`, borderRadius: 3, padding: '0 5px', fontFamily: 'var(--font-mono), ui-monospace, monospace' }}>
        {assigned}<span style={{ fontSize: 'var(--fs-xs)', opacity: 0.6 }}>/{total}</span>
      </span>
    </div>
  );
}
