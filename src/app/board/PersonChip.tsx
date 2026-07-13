'use client';

import { Assignment, ROLE_META, ShiftHours, StaffMember } from '@/types';
import { ShiftBadge } from './Sidebar';

// ── Person chip inside a room ─────────────────────────────────────────────────
export default function PersonChip({ assignment, person, alertLevels, dailyShifts, onRemove }: {
  assignment: Assignment; person: StaffMember;
  alertLevels: Record<string, 'none' | 'warning' | 'critical'>;
  dailyShifts: Record<string, ShiftHours>;
  onRemove: () => void;
}) {
  const m     = ROLE_META[person.role] || ROLE_META.crna;
  const alert = alertLevels[person.id] || 'none';
  const hours = person.role !== 'physician' && person.role !== 'surgeon' ? (dailyShifts[person.id] || person.hours) : null;

  // Surgeon shown in room header, not as chip
  if (person.role === 'surgeon') return null;

  return (
    <div onClick={onRemove} title={person.name + ' — click to unassign'}
      style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 7px', borderRadius: 6, cursor: 'pointer', background: m.bg, color: m.color, border: '1px solid ' + (alert === 'critical' ? 'color-mix(in srgb, var(--danger) 70%, transparent)' : alert === 'warning' ? 'color-mix(in srgb, var(--warn) 60%, transparent)' : m.border), fontSize: 12, fontWeight: 700, position: 'relative', transition: 'opacity 0.12s' }}
      onMouseEnter={(e) => (e.currentTarget.style.opacity = '0.7')}
      onMouseLeave={(e) => (e.currentTarget.style.opacity = '1')}>
      {alert !== 'none' && <div style={{ position: 'absolute', inset: 0, borderRadius: 6, border: '1px solid ' + (alert === 'critical' ? 'color-mix(in srgb, var(--danger) 70%, transparent)' : 'color-mix(in srgb, var(--warn) 60%, transparent)'), animation: 'relief-flash ' + (alert === 'critical' ? '1s' : '2s') + ' ease-in-out infinite', pointerEvents: 'none' }} />}
      <span style={{ fontWeight: 800, fontSize: 11, fontFamily: 'var(--font-mono), ui-monospace, monospace' }}>{person.initials}</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 90 }}>{person.name.split(' ').pop()}</span>
      {hours && <ShiftBadge hours={hours} role={person.role} />}
      <span style={{ opacity: 0.4, fontSize: 12 }}>×</span>
    </div>
  );
}
