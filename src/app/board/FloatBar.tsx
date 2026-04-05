'use client';

import { useState } from 'react';
import { StaffMember, ROLE_META, Role, ShiftHours, DraggedPerson, MDDesignation } from '@/types';
import { hexToRgb } from './BoardClient';

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
      border: '1px solid var(--border)',
      borderRadius: 12,
      marginBottom: 14,
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div
        onClick={() => setCollapsed(v => !v)}
        style={{
          padding: '9px 14px',
          display: 'flex', alignItems: 'center', gap: 10,
          cursor: 'pointer',
          borderBottom: collapsed ? 'none' : '1px solid var(--border)',
          background: 'rgba(16,185,129,0.04)',
        }}
      >
        <span style={{ fontSize: 13 }}>🟢</span>
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1.5, textTransform: 'uppercase', color: '#10b981' }}>
          Available
        </span>
        <span style={{
          fontSize: 10, fontWeight: 700, color: 'var(--text-dim)',
          background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.25)',
          borderRadius: 10, padding: '1px 7px',
        }}>
          {available.length} available
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-dim)' }}>
          {collapsed ? '▲' : '▼'}
        </span>
      </div>

      {!collapsed && (
        <div style={{ padding: '10px 14px', display: 'flex', flexWrap: 'wrap', gap: '10px 18px' }}>
          {available.length === 0 && (
            <span style={{ fontSize: 11, color: 'var(--text-dim)', fontStyle: 'italic' }}>
              All staff are currently assigned
            </span>
          )}

          {(Object.keys(ROLE_META) as Role[]).map((role) => {
            const members = byRole(role);
            if (!members.length) return null;
            const meta = ROLE_META[role];
            return (
              <div key={role} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{
                  fontSize: 9, fontWeight: 800, letterSpacing: 1.2, textTransform: 'uppercase',
                  color: meta.color, minWidth: 44,
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
                        display: 'flex', alignItems: 'center', gap: 5,
                        padding: '4px 8px', borderRadius: 7, cursor: 'grab',
                        background: isFloat ? 'rgba(16,185,129,0.1)' : meta.bg,
                        border: '1px solid ' + (isFloat ? 'rgba(16,185,129,0.35)' : meta.border),
                        color: isFloat ? '#10b981' : meta.color,
                        fontSize: 11, fontWeight: 600,
                        transition: 'all 0.14s',
                        userSelect: 'none',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.opacity = '0.75')}
                      onMouseLeave={(e) => (e.currentTarget.style.opacity = '1')}
                    >
                      <span style={{ fontWeight: 800, fontSize: 10 }}>{person.initials}</span>
                      <span>{person.name.split(' ').pop()}</span>
                      {isFloat && <span style={{ fontSize: 9, opacity: 0.7 }}>🔄</span>}
                      {desg && (
                        <span style={{
                          fontSize: 9, fontWeight: 800, padding: '1px 4px', borderRadius: 3,
                          background: 'rgba(' + hexToRgb(meta.color) + ',0.15)',
                          border: '1px solid rgba(' + hexToRgb(meta.color) + ',0.3)',
                        }}>{desg}</span>
                      )}
                      {hours && (
                        <span style={{ fontSize: 9, opacity: 0.7 }}>{hours}</span>
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
