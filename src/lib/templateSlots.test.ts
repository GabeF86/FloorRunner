// lib/templateSlots — the slot-materialization semantics extracted from the
// schedules POST route. The route's own tests (schedules/route.test.ts) pin
// the end-to-end behavior through the route unmodified; these pin the helper
// contracts directly (the planner consumes them without the route).
import { describe, it, expect } from 'vitest';
import { derivedDayTypeFor, slateForDayType, templateSlotCount } from './templateSlots';

const t = (day_type: string, shift_type_id: string, extra: { required_count?: number | null } = {}) =>
  ({ day_type, shift_type_id, ...extra });

describe('slateForDayType — friday partial-override union', () => {
  it('friday rows override per shift type; other weekday rows still materialize', () => {
    const templates = [
      t('weekday', 'st-C1'),
      t('weekday', 'st-C2'),
      t('weekday', 'st-C3'), // shadowed by the friday-specific C3 row
      t('friday', 'st-C3'),
      t('friday', 'st-D4'),
    ];
    const slate = slateForDayType(templates, 'friday');
    expect(slate.map(x => `${x.day_type}|${x.shift_type_id}`).sort()).toEqual([
      'friday|st-C3', 'friday|st-D4', 'weekday|st-C1', 'weekday|st-C2',
    ]);
  });

  it('friday-specific rows come first, weekday fill after (route ordering preserved)', () => {
    const templates = [t('weekday', 'st-C1'), t('friday', 'st-D4')];
    const slate = slateForDayType(templates, 'friday');
    expect(slate.map(x => x.shift_type_id)).toEqual(['st-D4', 'st-C1']);
  });

  it('zero friday rows yields the pure weekday slate', () => {
    const templates = [t('weekday', 'st-C1'), t('weekday', 'st-D1'), t('saturday', 'st-C1sat')];
    const slate = slateForDayType(templates, 'friday');
    expect(slate.map(x => x.shift_type_id).sort()).toEqual(['st-C1', 'st-D1']);
  });

  it('a friday row is kept even with required_count 0 (suppression is templateSlotCount’s job)', () => {
    const templates = [t('weekday', 'st-C1'), t('friday', 'st-C1', { required_count: 0 })];
    const slate = slateForDayType(templates, 'friday');
    expect(slate).toHaveLength(1);
    expect(slate[0].day_type).toBe('friday');
    expect(templateSlotCount(slate[0])).toBe(0); // → zero slots on Fridays
  });

  it('saturday/sunday/weekday/holiday slates are NOT unioned (friday-only contract)', () => {
    const templates = [t('weekday', 'st-C1'), t('saturday', 'st-C1sat')];
    expect(slateForDayType(templates, 'saturday').map(x => x.shift_type_id)).toEqual(['st-C1sat']);
    expect(slateForDayType(templates, 'weekday').map(x => x.shift_type_id)).toEqual(['st-C1']);
    expect(slateForDayType(templates, 'major_holiday')).toEqual([]);
  });
});

describe('templateSlotCount — required_count semantics', () => {
  it('null/undefined default to 1; 0 and negatives yield 0; positives pass through', () => {
    expect(templateSlotCount({ required_count: null })).toBe(1);
    expect(templateSlotCount({})).toBe(1);
    expect(templateSlotCount({ required_count: 0 })).toBe(0);
    expect(templateSlotCount({ required_count: -2 })).toBe(0);
    expect(templateSlotCount({ required_count: 3 })).toBe(3);
  });
});

describe('derivedDayTypeFor — major/federal/DOW precedence', () => {
  it('major holiday wins over everything', () => {
    // 2026-07-03 is a Friday (observed July 4th) — major beats the friday DOW type.
    expect(derivedDayTypeFor('2026-07-03', { is_major_holiday: true })).toBe('major_holiday');
  });
  it('non-major holiday row → federal_holiday', () => {
    expect(derivedDayTypeFor('2026-06-19', { is_major_holiday: false })).toBe('federal_holiday');
  });
  it('no holiday row → single-homed DOW mapping', () => {
    expect(derivedDayTypeFor('2026-01-07', undefined)).toBe('weekday');   // Wed
    expect(derivedDayTypeFor('2026-01-09', undefined)).toBe('friday');
    expect(derivedDayTypeFor('2026-01-10', undefined)).toBe('saturday');
    expect(derivedDayTypeFor('2026-01-11', undefined)).toBe('sunday');
  });
});
