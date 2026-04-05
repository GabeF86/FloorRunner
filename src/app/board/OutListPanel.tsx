'use client';

import { useState } from 'react';
import { StaffMember, MDDesignation, DESIGNATION_OUT_ORDER } from '@/types';

interface Props {
  staff:        StaffMember[];
  designations: Record<string, MDDesignation>;
}

export default function OutListPanel({ staff, designations }: Props) {
  const [collapsed, setCollapsed] = useState(true);

  // Only physicians with D/C designations
  const physicians = staff.filter((p) => p.role === 'physician');

  // Build sorted out-list (D1→D8→C2)
  const outList = DESIGNATION_OUT_ORDER
    .map((d) => ({ desg: d, person: physicians.find((p) => designations[p.id] === d) }))
    .filter((row) => !!row.person);

  // C1 separately (overnight call)
  const c1Person = physicians.find((p) => designations[p.id] === 'C1');

  // Undesignated physicians
  const undesig = physicians.filter((p) => !designations[p.id]);

  const totalCount = outList.length + (c1Person ? 1 : 0);

  return (
    <div style={{ flex: 1, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', maxWidth: 240 }}>
      {/* Header */}
      <div
        onClick={() => setCollapsed((v) => !v)}
        style={{ padding: '9px 13px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', borderBottom: collapsed ? 'none' : '1px solid var(--border)', background: 'rgba(245,158,11,0.06)' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ fontSize: 13 }}>📋</span>
          <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1.5, textTransform: 'uppercase', color: '#f59e0b' }}>Out Order</span>
          <span style={{ fontSize: 10, color: 'var(--text-dim)', background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: 10, padding: '1px 6px', fontWeight: 700 }}>{totalCount}</span>
        </div>
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{collapsed ? '▲' : '▼'}</span>
      </div>

      {!collapsed && (
        <div style={{ padding: '8px 10px', maxHeight: 280, overflowY: 'auto' }}>
          {outList.length === 0 && !c1Person && (
            <div style={{ fontSize: 11, color: 'var(--text-dim)', fontStyle: 'italic', textAlign: 'center', padding: '12px 0' }}>
              No designations assigned yet
            </div>
          )}

          {outList.map(({ desg, person }, i) => {
            if (!person) return null;
            const isC2 = desg === 'C2';
            return (
              <div key={desg} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px', borderRadius: 7, marginBottom: 3, background: i === 0 ? 'rgba(16,185,129,0.07)' : 'transparent', border: i === 0 ? '1px solid rgba(16,185,129,0.2)' : '1px solid transparent' }}>
                <span style={{ fontSize: 10, fontWeight: 800, color: i === 0 ? '#10b981' : 'var(--text-dim)', width: 16, textAlign: 'center' }}>{i + 1}</span>
                <div style={{ width: 24, height: 24, borderRadius: 6, background: 'rgba(245,158,11,0.15)', color: '#f59e0b', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 800 }}>
                  {person.initials}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{person.name}</div>
                </div>
                <span style={{ fontSize: 10, fontWeight: 800, padding: '2px 6px', borderRadius: 5, background: isC2 ? 'rgba(251,113,133,0.15)' : 'rgba(245,158,11,0.13)', color: isC2 ? '#fb7185' : '#f59e0b', border: '1px solid ' + (isC2 ? 'rgba(251,113,133,0.3)' : 'rgba(245,158,11,0.3)'), whiteSpace: 'nowrap' }}>
                  {desg}
                </span>
              </div>
            );
          })}

          {/* Divider before C1 */}
          {c1Person && (
            <>
              {outList.length > 0 && <div style={{ borderTop: '1px solid var(--border)', margin: '6px 0' }} />}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px', borderRadius: 7, background: 'rgba(167,139,250,0.07)', border: '1px solid rgba(167,139,250,0.2)' }}>
                <span style={{ fontSize: 12 }}>☾</span>
                <div style={{ width: 24, height: 24, borderRadius: 6, background: 'rgba(167,139,250,0.15)', color: '#a78bfa', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 800 }}>
                  {c1Person.initials}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: '#a78bfa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c1Person.name}</div>
                  <div style={{ fontSize: 9, color: 'var(--text-dim)' }}>ON CALL OVERNIGHT</div>
                </div>
                <span style={{ fontSize: 10, fontWeight: 800, padding: '2px 6px', borderRadius: 5, background: 'rgba(167,139,250,0.15)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.3)' }}>C1</span>
              </div>
            </>
          )}

          {/* Undesignated */}
          {undesig.length > 0 && (
            <>
              <div style={{ borderTop: '1px solid var(--border)', margin: '6px 0' }} />
              <div style={{ fontSize: 9, color: 'var(--text-dim)', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 4 }}>No designation</div>
              {undesig.map((p) => (
                <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px', opacity: 0.5 }}>
                  <div style={{ width: 22, height: 22, borderRadius: 5, background: 'rgba(245,158,11,0.1)', color: '#f59e0b', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 800 }}>{p.initials}</div>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{p.name}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
