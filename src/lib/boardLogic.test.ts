// boardLogic.test.ts — written against the pre-move export to pin behavior,
// then the import is flipped to './boardLogic' in Step 1.3 (tests unchanged).
import { describe, it, expect } from 'vitest';
import { computeSupervisionLoads } from './boardLogic';
import type { Assignment } from '@/types';

const asg = (id: string, room_id: string, staff_id: string, role: string): Assignment =>
  ({ id, room_id, staff_id, board_date: '2026-07-12',
     staff: { id: staff_id, name: staff_id, initials: staff_id.slice(0, 2), role, hours: '8hr' } } as unknown as Assignment);

const byRoom = (rows: Assignment[]) => {
  const m: Record<string, Assignment[]> = {};
  for (const r of rows) (m[r.room_id] ??= []).push(r);
  return m;
};

describe('computeSupervisionLoads', () => {
  it('counts one crna-room and one resident-room per supervising MD', () => {
    const rows = [
      asg('a1', 'r1', 'md1', 'physician'), asg('a2', 'r1', 'c1', 'crna'),
      asg('a3', 'r2', 'md1', 'physician'), asg('a4', 'r2', 'res1', 'resident'),
    ];
    const loads = computeSupervisionLoads(rows, byRoom(rows));
    expect(loads['md1']).toMatchObject({ crnaCount: 1, residentCount: 1, overCrna: false, overResident: false });
  });
  it('flags at-limit (4 crna rooms) and over-limit (5) correctly', () => {
    const at = Array.from({ length: 4 }, (_, i) => [
      asg(`p${i}`, `r${i}`, 'md1', 'physician'), asg(`c${i}`, `r${i}`, `c${i}`, 'crna'),
    ]).flat();
    expect(computeSupervisionLoads(at, byRoom(at))['md1']).toMatchObject({ atCrna: true, overCrna: false });
    const over = [...at, asg('p4', 'r4', 'md1', 'physician'), asg('c4', 'r4', 'c9', 'crna')];
    expect(computeSupervisionLoads(over, byRoom(over))['md1']).toMatchObject({ overCrna: true });
  });
  it('srna counts toward the crna limit; an MD alone in a room counts nothing', () => {
    const rows = [asg('a1', 'r1', 'md1', 'physician'), asg('a2', 'r1', 's1', 'srna'),
                  asg('a3', 'r2', 'md1', 'physician')];
    expect(computeSupervisionLoads(rows, byRoom(rows))['md1']).toMatchObject({ crnaCount: 1, residentCount: 0 });
  });
  it('resident-over-limit at 3 (limit 2)', () => {
    const rows = Array.from({ length: 3 }, (_, i) => [
      asg(`p${i}`, `r${i}`, 'md1', 'physician'), asg(`x${i}`, `r${i}`, `x${i}`, 'resident'),
    ]).flat();
    expect(computeSupervisionLoads(rows, byRoom(rows))['md1']).toMatchObject({ overResident: true });
  });
});
