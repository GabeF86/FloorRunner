'use client';

import { useState } from 'react';
import { StaffMember, ROLE_META, Role, ShiftHours, DraggedPerson, MDDesignation } from '@/types';
import { hexToRgb } from './BoardClient';
import { BT } from './boardTheme';

interface Props {
  staff:         StaffMember[];
  floatIds:      Set<string>;      // in float/breaks zone
  assignedIds:   Set<string>;      // in a real room
  activeStaffIds: Set<string>;     // checked in / working today
  dailyShifts:   Record<string, ShiftHours>;
  designations:  Record<string, MDDesignation>;
  onDragStart:   (p: DraggedPerson) => void;
}

export default function FloatBar({ staff, floatIds, assignedIds, activeStaffIds, dailyShifts, designations, onDragStart }: Props) {
  const [collapsed, setCollapsed] = useState(false);

  // Available = checked in today AND not in a real room (float staff are available — giving breaks)
  // Surgeons are excluded — they don't float for break coverage
  const available = staff.filter((p) => p.role !== 'surgeon' && activeStaffIds.has(p.id) && (!assignedIds.has(p.id) || floatIds.has(p.id)));

  const byRole = (role: Role) => available.filter((p) => p.role === role);

  return (
    <div style={{
      background: 'var(--bg-surface)',
      border: '0.5px solid var(--border)',
      borderRadius: 'var(--radius-sm)',
      marginBottom: 'var(--space-2)',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div
        onClick={() => setCollapsed(v => !v)}
        style={{
          padding: 'var(--space-1) var(--space-3)',
          display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
          cursor: 'pointer',
          borderBottom: collapsed ? 'none' : '0.5px solid var(--border)',
          background: 'color-mix(in srgb, var(--ok) 4%, transparent)',
        }}
      >
        <span style={{ fontSize: 'var(--fs-xs)' }}>🟢</span>
        <span style={{ fontSize: 'var(--fs-xs)', fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--ok)' }}>
          Available
        </span>
        <span style={{
          fontSize: 'var(--fs-xs)', fontWeight: 700, color: 'var(--text-dim)',
          background: 'var(--ok-bg)', border: '0.5px solid color-mix(in srgb, var(--ok) 25%, transparent)',
          borderRadius: 999, padding: '0 6px', fontFamily: 'var(--font-mono), ui-monospace, monospace',
        }}>
          {available.length}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>
          {collapsed ? '▲' : '▼'}
        </span>
      </div>

      {!collapsed && (
        <div style={{ padding: 'var(--space-2) var(--space-3)', display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2) var(--space-4)' }}>
          {available.length === 0 && (
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', fontStyle: 'italic' }}>
              All staff are currently assigned
            </span>
          )}

          {(Object.keys(ROLE_META) as Role[]).map((role) => {
            const members = byRole(role);
            if (!members.length) return null;
            const meta = ROLE_META[role];
            return (
              <div key={role} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
                <span style={{
                  fontSize: 'var(--fs-xs)', fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase',
                  color: meta.color, minWidth: 36,
                }}>
                  {role === 'physician' ? 'MDs' : meta.label.replace(/s$/, '')}
                </span>
                {members.map((person) => {
                  const isFloat = floatIds.has(person.id);
                  const desg    = role === 'physician' ? designations[person.id] : undefined;
                  const hours   = role !== 'physician' ? (dailyShifts[person.id] || person.hours) : undefined;
                  return (
                    <div
                      key={person.id}
                      draggable
                      onDragStart={() => onDragStart({ ...person, role })}
                      title={person.name + (isFloat ? ' — Floating' : '')}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 'var(--space-1)',
                        padding: BT.chip.pad, minHeight: BT.chip.minHeight, borderRadius: BT.chip.radius, cursor: 'grab',
                        background: isFloat ? 'var(--ok-bg)' : meta.bg,
                        border: '1px solid ' + (isFloat ? 'color-mix(in srgb, var(--ok) 35%, transparent)' : meta.border),
                        color: isFloat ? 'var(--ok)' : meta.color,
                        fontSize: BT.font.chip, fontWeight: 600,
                        transition: 'opacity 120ms ease',
                        userSelect: 'none',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.opacity = '0.75')}
                      onMouseLeave={(e) => (e.currentTarget.style.opacity = '1')}
                    >
                      <span style={{ fontWeight: 800, fontSize: BT.font.chipSub, fontFamily: 'var(--font-mono), ui-monospace, monospace' }}>{person.initials}</span>
                      <span>{person.name.split(' ').pop()}</span>
                      {isFloat && <span style={{ fontSize: BT.font.chipSub, opacity: 0.7 }}>🔄</span>}
                      {desg && (
                        <span style={{
                          fontSize: BT.font.chipSub, fontWeight: 800, padding: '0 4px', borderRadius: 3,
                          background: 'rgba(' + hexToRgb(meta.color) + ',0.15)',
                          border: '0.5px solid rgba(' + hexToRgb(meta.color) + ',0.3)',
                          fontFamily: 'var(--font-mono), ui-monospace, monospace',
                        }}>{desg}</span>
                      )}
                      {hours && (
                        <span style={{ fontSize: BT.font.chipSub, opacity: 0.7, fontFamily: 'var(--font-mono), ui-monospace, monospace' }}>{hours.replace('hr', 'h')}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
