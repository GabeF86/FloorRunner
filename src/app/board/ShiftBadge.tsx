'use client';

import { Role, ROLE_META } from '@/types';
import { hexToRgb } from './BoardClient';
import { BT, LATE_SHIFT_TONE } from './boardTheme';

// The badge component lives here — a neutral home, since it's imported by
// Sidebar, SiteCard, and PersonChip alike (2026-07-13, board visual refresh).
// The tones themselves are in boardTheme, which AddStaffModal also reads for
// the 24hr option so a long shift is the same red wherever it appears.

export function ShiftBadge({ hours, role }: { hours: string; role: Role }) {
  const lateColor = LATE_SHIFT_TONE[hours];
  const roleColor = ROLE_META[role]?.color || BT.color.roleFallback;
  const color     = lateColor ?? roleColor;
  return (
    <span style={{
      fontSize: 9, fontWeight: 800, padding: '1px 5px', borderRadius: 3,
      background: `rgba(${hexToRgb(color)},${lateColor ? 0.18 : 0.12})`,
      color,
      border: `1px solid rgba(${hexToRgb(color)},${lateColor ? 0.45 : 0.28})`,
      letterSpacing: lateColor ? 0.2 : 0,
      fontFamily: 'var(--font-mono), ui-monospace, monospace',
    }}>
      {hours.replace('hr', 'h')}
    </span>
  );
}
