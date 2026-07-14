// Pure board logic shared between the board UI (BoardClient.tsx) and the
// (upcoming) board assistant tools. No 'use client' — a server route will
// import this module directly.
import {
  AlertLevel, Assignment, MDDesignation, ShiftHours, StaffMember,
  SupervisionLoad, SUPERVISION_LIMITS, getAlertLevel, getMinutesToRelief,
} from '@/types';

export function computeSupervisionLoads(
  assignments: Assignment[],
  roomAssignments: Record<string, Assignment[]>
): Record<string, SupervisionLoad> {
  const loads: Record<string, SupervisionLoad> = {};
  assignments.filter((a) => a.staff?.role === 'physician').forEach((pa) => {
    const room        = roomAssignments[pa.room_id] || [];
    const hasCrna     = room.some((a) => a.staff?.role === 'crna' || a.staff?.role === 'srna');
    const hasResident = room.some((a) => a.staff?.role === 'resident');
    if (!loads[pa.staff_id]) loads[pa.staff_id] = { crnaCount: 0, residentCount: 0, overCrna: false, overResident: false, atCrna: false, atResident: false };
    if (hasCrna)     loads[pa.staff_id].crnaCount++;
    if (hasResident) loads[pa.staff_id].residentCount++;
  });
  Object.values(loads).forEach((l) => {
    l.overCrna     = l.crnaCount > SUPERVISION_LIMITS.crna;
    l.atCrna       = l.crnaCount === SUPERVISION_LIMITS.crna;
    l.overResident = l.residentCount > SUPERVISION_LIMITS.resident;
    l.atResident   = l.residentCount === SUPERVISION_LIMITS.resident;
  });
  return loads;
}

// Relief-alert level per staff member — the single implementation consumed by
// BOTH BoardClient and WallClient (they previously carried drift-prone copies).
// Physicians alert only on a per-diem 8hr/10hr designation (C1/no-designation/
// D-codes never count down); CRNAs/SRNAs/residents/fellows count down from
// their daily shift override (falling back to their default hours); surgeons
// never alert.
export function computeAlertLevels(
  staff: StaffMember[],
  designations: Record<string, MDDesignation>,
  dailyShifts: Record<string, ShiftHours>
): Record<string, AlertLevel> {
  const alertLevels: Record<string, AlertLevel> = {};
  staff.forEach((p) => {
    if (p.role === 'physician') {
      const desg = designations[p.id];
      alertLevels[p.id] = (!desg || desg === 'C1' || (desg !== '8hr' && desg !== '10hr')) ? 'none' : getAlertLevel(getMinutesToRelief(desg as ShiftHours));
    } else if (['crna', 'srna', 'resident', 'fellow'].includes(p.role)) {
      // fellow included: fellows are shift-workers (hours + break tracking in
      // the sidebar, shift badges on their chips), so their end-of-shift
      // relief countdown must surface like SRNAs/residents.
      alertLevels[p.id] = getAlertLevel(getMinutesToRelief(dailyShifts[p.id] || p.hours));
    } else {
      alertLevels[p.id] = 'none';
    }
  });
  return alertLevels;
}
