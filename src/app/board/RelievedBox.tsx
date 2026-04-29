'use client';

import { useState, useEffect } from 'react';
import { ReliefEntry, DraggedPerson, ROLE_META } from '@/types';
import { hexToRgb } from './BoardClient';

interface Props {
  reliefLog:      ReliefEntry[];
  today:          string;
  dragging:       DraggedPerson | null;
  onDropRelieved: (person: DraggedPerson) => void;
  onUndoRelief:   (id: string) => void;
}

export default function RelievedBox({ reliefLog, today, dragging, onDropRelieved, onUndoRelief }: Props) {
  const [collapsed,  setCollapsed]  = useState(true);
  const [tab,        setTab]        = useState<'today' | 'history'>('today');
  const [dragOver,   setDragOver]   = useState(false);
  const [history,    setHistory]    = useState<ReliefEntry[]>([]);
  const [historyDate, setHistoryDate] = useState(today);
  const [loading,    setLoading]    = useState(false);

  const canDrop = !!dragging && dragging.role !== 'surgeon';

  async function loadHistory(date: string) {
    setLoading(true);
    const res = await fetch('/api/relief?date=' + date);
    setHistory(await res.json());
    setLoading(false);
  }

  useEffect(() => {
    if (tab === 'history') loadHistory(historyDate);
  }, [tab, historyDate]);

  const fmt = (iso: string) =>
    new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  const roleColor = (role: string) => (ROLE_META as any)[role]?.color || '#94a3b8';

  return (
    <div
      style={{ flex: 1, background: 'var(--bg-surface)', border: '1px solid ' + (dragOver && canDrop ? 'rgba(16,185,129,0.5)' : 'var(--border)'), borderRadius: 12, overflow: 'hidden', boxShadow: dragOver && canDrop ? '0 0 20px rgba(16,185,129,0.15)' : 'none', transition: 'all 0.2s' }}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); if (dragging && canDrop) onDropRelieved(dragging); }}
    >
      {/* Header */}
      <div style={{ padding: '9px 13px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: collapsed ? 'none' : '1px solid var(--border)', background: dragOver && canDrop ? 'rgba(16,185,129,0.08)' : 'rgba(16,185,129,0.04)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ fontSize: 13 }}>{dragOver && canDrop ? '✅' : '🏁'}</span>
          <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1.5, textTransform: 'uppercase', color: '#10b981' }}>
            {dragOver && canDrop ? 'Release to Relieve' : 'Relieved'}
          </span>
          <span style={{ fontSize: 10, color: 'var(--text-dim)', background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.25)', borderRadius: 10, padding: '1px 6px', fontWeight: 700 }}>{reliefLog.length}</span>
        </div>
        <button onClick={() => setCollapsed((v) => !v)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim)', fontSize: 12 }}>
          {collapsed ? '▲' : '▼'}
        </button>
      </div>

      {!collapsed && (
        <>
          {/* Tabs */}
          <div style={{ display: 'flex', borderBottom: '1px solid var(--border)' }}>
            {(['today', 'history'] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)}
                style={{ flex: 1, padding: '6px 0', fontSize: 10, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase', cursor: 'pointer', background: 'none', border: 'none', color: tab === t ? '#10b981' : 'var(--text-dim)', borderBottom: '2px solid ' + (tab === t ? '#10b981' : 'transparent'), transition: 'all 0.15s' }}>
                {t === 'today' ? "Today's Log" : 'View History'}
              </button>
            ))}
          </div>

          {/* Today tab */}
          {tab === 'today' && (
            <div style={{ maxHeight: 220, overflowY: 'auto', padding: '8px 10px' }}>
              {canDrop && !dragging && reliefLog.length === 0 && (
                <div style={{ fontSize: 11, color: 'var(--text-dim)', fontStyle: 'italic', textAlign: 'center', padding: '14px 0' }}>
                  Drag staff here to mark relieved
                </div>
              )}
              {reliefLog.length === 0 && !canDrop && (
                <div style={{ fontSize: 11, color: 'var(--text-dim)', fontStyle: 'italic', textAlign: 'center', padding: '14px 0' }}>No reliefs logged yet</div>
              )}
              {reliefLog.map((entry) => (
                <div key={entry.id} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '5px 6px', borderRadius: 7, marginBottom: 3, background: 'rgba(16,185,129,0.04)', border: '1px solid rgba(16,185,129,0.1)' }}>
                  <div style={{ width: 24, height: 24, borderRadius: 6, background: 'rgba(' + hexToRgb(roleColor(entry.staff_role)) + ',0.15)', color: roleColor(entry.staff_role), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 800, flexShrink: 0 }}>
                    {entry.staff_initials}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.staff_name}</div>
                    <div style={{ fontSize: 9, color: 'var(--text-dim)', display: 'flex', gap: 5 }}>
                      <span>{fmt(entry.relieved_at)}</span>
                      {entry.designation && <span style={{ color: '#f59e0b' }}>{entry.designation}</span>}
                      {entry.shift_hours && <span>{entry.shift_hours}</span>}
                    </div>
                  </div>
                  <button onClick={() => onUndoRelief(entry.id)} title="Undo relief" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-dim)', fontSize: 13, padding: '2px 4px', borderRadius: 4 }}>↩</button>
                </div>
              ))}
            </div>
          )}

          {/* History tab */}
          {tab === 'history' && (
            <div style={{ maxHeight: 260, overflowY: 'auto', padding: '8px 10px' }}>
              <div style={{ marginBottom: 8 }}>
                <input type="date" value={historyDate} onChange={(e) => setHistoryDate(e.target.value)}
                  style={{ width: '100%', background: 'var(--bg-deep)', border: '1px solid var(--border)', borderRadius: 7, color: 'var(--text)', padding: '5px 8px', fontSize: 12 }} />
              </div>
              {loading && <div style={{ fontSize: 11, color: 'var(--text-dim)', textAlign: 'center', padding: 10 }}>Loading…</div>}
              {!loading && history.length === 0 && (
                <div style={{ fontSize: 11, color: 'var(--text-dim)', fontStyle: 'italic', textAlign: 'center', padding: '12px 0' }}>No records for this date</div>
              )}
              {!loading && history.map((entry) => (
                <div key={entry.id} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '5px 6px', borderRadius: 7, marginBottom: 3, background: 'var(--tint-surface-faint)', border: '1px solid var(--border)' }}>
                  <div style={{ width: 24, height: 24, borderRadius: 6, background: 'rgba(' + hexToRgb(roleColor(entry.staff_role)) + ',0.15)', color: roleColor(entry.staff_role), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 800, flexShrink: 0 }}>
                    {entry.staff_initials}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.staff_name}</div>
                    <div style={{ fontSize: 9, color: 'var(--text-dim)', display: 'flex', gap: 5 }}>
                      <span>{fmt(entry.relieved_at)}</span>
                      {entry.designation && <span style={{ color: '#f59e0b' }}>{entry.designation}</span>}
                      {entry.shift_hours && <span>{entry.shift_hours}</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
