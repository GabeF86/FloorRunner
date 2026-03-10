'use client';

import { Site, StaffMember, Assignment, DailyDesignation, DailyShift, MDDesignation, ShiftHours, ROLE_META } from '@/types';

interface Props {
  date:         string;
  sites:        Site[];
  staff:        StaffMember[];
  assignments:  Assignment[];
  designations: Record<string, MDDesignation>;
  dailyShifts:  Record<string, ShiftHours>;
  onClose:      () => void;
}

export default function PrintView({ date, sites, staff, assignments, designations, dailyShifts, onClose }: Props) {
  const dateLabel = new Date(date + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  // Build room → staff map
  const roomStaff: Record<string, StaffMember[]> = {};
  assignments.forEach((a) => {
    if (!a.staff) return;
    if (!roomStaff[a.room_id]) roomStaff[a.room_id] = [];
    roomStaff[a.room_id].push(a.staff);
  });

  // Unassigned staff
  const assignedIds = new Set(assignments.map((a) => a.staff_id));
  const unassigned  = staff.filter((p) => !assignedIds.has(p.id) && p.role !== 'surgeon');

  const roleOrder = ['physician', 'crna', 'srna', 'resident', 'surgeon'];
  const sortByRole = (a: StaffMember, b: StaffMember) =>
    roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role) || a.name.localeCompare(b.name);

  function staffLabel(p: StaffMember): string {
    const parts = [p.name];
    if (p.role === 'physician') {
      const d = designations[p.id];
      if (d) parts.push('(' + d + ')');
    } else {
      const h = dailyShifts[p.id] || p.hours;
      parts.push('[' + h + ']');
    }
    return parts.join(' ');
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 200,
      background: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {/* Controls — hidden on print */}
      <div className="no-print" style={{
        position: 'absolute', top: 20, right: 20,
        display: 'flex', gap: 10,
      }}>
        <button
          onClick={() => window.print()}
          style={{
            padding: '10px 22px', borderRadius: 8, cursor: 'pointer',
            background: '#0ea5e9', border: 'none', color: '#fff',
            fontWeight: 800, fontSize: 13,
          }}
        >
          🖨️ Print
        </button>
        <button
          onClick={onClose}
          style={{
            padding: '10px 22px', borderRadius: 8, cursor: 'pointer',
            background: '#1e293b', border: '1px solid #475569', color: '#94a3b8',
            fontWeight: 700, fontSize: 13,
          }}
        >
          Close
        </button>
      </div>

      {/* Print content */}
      <div id="print-content" style={{
        background: '#fff', color: '#111',
        width: '8.5in', maxHeight: '90vh', overflowY: 'auto',
        padding: '0.5in', borderRadius: 8,
        fontFamily: 'Georgia, serif',
      }}>
        <style>{`
          @media print {
            body * { visibility: hidden !important; }
            #print-content, #print-content * { visibility: visible !important; }
            #print-content { position: fixed; left: 0; top: 0; width: 100%; padding: 0.4in; }
            .no-print { display: none !important; }
          }
        `}</style>

        {/* Header */}
        <div style={{ borderBottom: '2px solid #111', paddingBottom: 10, marginBottom: 18 }}>
          <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: -0.5 }}>OR Assignment Sheet</div>
          <div style={{ fontSize: 14, color: '#444', marginTop: 3 }}>{dateLabel}</div>
          <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>Shift start: 7:30 AM · Generated {new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</div>
        </div>

        {/* Sites */}
        {sites
          .filter((s) => !s.is_float)
          .map((site) => {
            const siteRooms = site.rooms.filter((r) => roomStaff[r.id]?.length > 0);
            if (siteRooms.length === 0) return null;
            return (
              <div key={site.id} style={{ marginBottom: 20, breakInside: 'avoid' }}>
                <div style={{
                  fontSize: 14, fontWeight: 700, letterSpacing: 0.5,
                  textTransform: 'uppercase', color: '#111',
                  borderBottom: '1px solid #ccc', paddingBottom: 4, marginBottom: 8,
                }}>
                  {site.icon} {site.name}
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: '#f1f5f9' }}>
                      <th style={{ textAlign: 'left', padding: '5px 8px', border: '1px solid #cbd5e1', width: '22%', fontWeight: 700 }}>Room</th>
                      <th style={{ textAlign: 'left', padding: '5px 8px', border: '1px solid #cbd5e1', fontWeight: 700 }}>Assigned Staff</th>
                    </tr>
                  </thead>
                  <tbody>
                    {site.rooms.map((room, i) => {
                      const people = (roomStaff[room.id] || []).slice().sort(sortByRole);
                      return (
                        <tr key={room.id} style={{ background: i % 2 === 0 ? '#fff' : '#f8fafc' }}>
                          <td style={{ padding: '6px 8px', border: '1px solid #cbd5e1', fontWeight: 600, verticalAlign: 'top' }}>
                            {room.name}
                          </td>
                          <td style={{ padding: '6px 8px', border: '1px solid #cbd5e1' }}>
                            {people.length === 0 ? (
                              <span style={{ color: '#aaa', fontStyle: 'italic' }}>Unassigned</span>
                            ) : (
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 14px' }}>
                                {people.map((p) => (
                                  <span key={p.id} style={{ display: 'inline-block' }}>
                                    <span style={{
                                      fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
                                      color: '#888', marginRight: 3,
                                    }}>
                                      {p.role === 'physician' ? 'MD' : p.role.toUpperCase()}
                                    </span>
                                    {staffLabel(p)}
                                  </span>
                                ))}
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          })}

        {/* Float zone */}
        {(() => {
          const floatSite = sites.find((s) => s.is_float);
          if (!floatSite) return null;
          const floatPeople = assignments
            .filter((a) => a.room_id === floatSite.id && a.staff)
            .map((a) => a.staff!)
            .sort(sortByRole);
          if (floatPeople.length === 0) return null;
          return (
            <div style={{ marginBottom: 20, breakInside: 'avoid' }}>
              <div style={{ fontSize: 14, fontWeight: 700, textTransform: 'uppercase', color: '#111', borderBottom: '1px solid #ccc', paddingBottom: 4, marginBottom: 8 }}>
                🔄 Float / Breaks
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', fontSize: 12 }}>
                {floatPeople.map((p) => (
                  <span key={p.id}>
                    <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', color: '#888', marginRight: 3 }}>
                      {p.role === 'physician' ? 'MD' : p.role.toUpperCase()}
                    </span>
                    {staffLabel(p)}
                  </span>
                ))}
              </div>
            </div>
          );
        })()}

        {/* Unassigned */}
        {unassigned.length > 0 && (
          <div style={{ marginBottom: 20, breakInside: 'avoid' }}>
            <div style={{ fontSize: 14, fontWeight: 700, textTransform: 'uppercase', color: '#111', borderBottom: '1px solid #ccc', paddingBottom: 4, marginBottom: 8 }}>
              Unassigned Staff
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', fontSize: 12 }}>
              {unassigned.sort(sortByRole).map((p) => (
                <span key={p.id}>
                  <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', color: '#888', marginRight: 3 }}>
                    {p.role === 'physician' ? 'MD' : p.role.toUpperCase()}
                  </span>
                  {staffLabel(p)}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Footer */}
        <div style={{ borderTop: '1px solid #ccc', paddingTop: 8, marginTop: 24, fontSize: 10, color: '#999', display: 'flex', justifyContent: 'space-between' }}>
          <span>ORBoard — Anesthesia Command Center</span>
          <span>Printed {new Date().toLocaleDateString()}</span>
        </div>
      </div>
    </div>
  );
}
