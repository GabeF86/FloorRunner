'use client';

import { Role, ROLE_META } from '@/types';
import { hexToRgb } from './BoardClient';

// Moved out of Sidebar.tsx (2026-07-13, board visual refresh) — neutral home
// since it's imported by Sidebar, SiteCard, and PersonChip alike.
const LATE_SHIFT_COLORS: Record<string, string> = {
  '10hr': '#f59e0b',  // amber
  '12hr': '#f97316',  // orange
  '16hr': '#ef4444',  // red-orange
  '24hr': '#f87171',  // bright red
};

export function ShiftBadge({ hours, role }: { hours: string; role: Role }) {
  const lateColor = LATE_SHIFT_COLORS[hours];
  const roleColor = ROLE_META[role]?.color || '#94a3b8';
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
