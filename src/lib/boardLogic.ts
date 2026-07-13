// Pure board logic shared between the board UI (BoardClient.tsx) and the
// (upcoming) board assistant tools. No 'use client' — a server route will
// import this module directly.
import { Assignment, SupervisionLoad, SUPERVISION_LIMITS } from '@/types';

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
