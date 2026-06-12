import { describe, it, expect } from 'vitest';
import { partitionForWrite } from './commit';
import type { PlannedAssignment } from './genTypes';

function pa(over: Partial<PlannedAssignment>): PlannedAssignment {
  return {
    slot_id: 's', slot_date: '2026-01-07', shift_type_code: 'C1',
    shift_type_category: 'call', derived_day_type: 'weekday',
    provider_id: 'p1', provider_name: 'P1',
    existing_assignment_id: null, source: 'main-loop', ...over,
  };
}

describe('partitionForWrite', () => {
  it('splits assignments into updates (existing row) and inserts (new row)', () => {
    const plan = [
      pa({ slot_id: 'a', existing_assignment_id: 'row-a' }),
      pa({ slot_id: 'b', existing_assignment_id: null }),
    ];
    const { updates, inserts } = partitionForWrite(plan);
    expect(updates.map(u => u.id)).toEqual(['row-a']);
    expect(updates[0].provider_id).toBe('p1');
    expect(updates[0].assignment_status).toBe('assigned');
    expect(updates[0].source_type).toBe('auto_generated');
    expect(inserts.map(i => i.schedule_slot_id)).toEqual(['b']);
    expect(inserts[0].assignment_status).toBe('assigned');
    expect(inserts[0].source_type).toBe('auto_generated');
    expect(inserts[0].assigned_at).toBeDefined();
  });
});
