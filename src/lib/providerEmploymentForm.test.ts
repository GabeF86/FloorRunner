import { describe, it, expect } from 'vitest';
import {
  employmentSavePayload,
  employmentStatusOptions,
  partnershipFlags,
  partnershipFromProfile,
  RETIRED_PROFILE_FIELDS,
  type EmploymentFormState,
} from './providerEmploymentForm';
import { EMPLOYMENT_STATUSES, PROFILE_COLUMNS } from './validation/providers';

function state(over: Partial<EmploymentFormState> = {}): EmploymentFormState {
  return {
    employmentStatus: 'full_time',
    fte: '1.0',
    workDaysFte: '',
    ptoWeeks: '',
    weeklyHours: '',
    partnership: null,
    isDayDoc: false,
    isIcuDoc: false,
    callTaker: true,
    partialCallTaker: false,
    homeSiteId: '',
    schedulingNotes: '',
    availableWeekdays: [true, true, true, true, true, true, true],
    preferredDayShiftTypes: [],
    daysPerWeek: '',
    ...over,
  };
}

describe('partnership — one value, three booleans', () => {
  it('maps each value to exactly one true flag', () => {
    expect(partnershipFlags('partner')).toEqual({
      is_shareholder: true, is_partner_track: false, is_employed_call_taker: false,
    });
    expect(partnershipFlags('partner_track')).toEqual({
      is_shareholder: false, is_partner_track: true, is_employed_call_taker: false,
    });
    expect(partnershipFlags('employed_call_taker')).toEqual({
      is_shareholder: false, is_partner_track: false, is_employed_call_taker: true,
    });
  });

  it('maps null to all three false', () => {
    expect(partnershipFlags(null)).toEqual({
      is_shareholder: false, is_partner_track: false, is_employed_call_taker: false,
    });
  });

  it('round-trips every value through the profile shape', () => {
    for (const v of ['partner', 'partner_track', 'employed_call_taker', null] as const) {
      expect(partnershipFromProfile(partnershipFlags(v))).toBe(v);
    }
  });

  it('resolves a profile with two flags set by fixed precedence', () => {
    // Should be unreachable, but a legacy row must display rather than crash.
    expect(partnershipFromProfile({
      is_shareholder: true, is_partner_track: true, is_employed_call_taker: true,
    })).toBe('partner');
    expect(partnershipFromProfile({
      is_shareholder: false, is_partner_track: true, is_employed_call_taker: true,
    })).toBe('partner_track');
  });

  it('cannot express two selections at once', () => {
    for (const v of ['partner', 'partner_track', 'employed_call_taker', null] as const) {
      const flags = partnershipFlags(v);
      const set = Object.values(flags).filter(Boolean).length;
      expect(set).toBeLessThanOrEqual(1);
    }
  });
});

describe('employmentSavePayload', () => {
  it('writes none of the retired fields', () => {
    const payload = employmentSavePayload(state());
    for (const key of RETIRED_PROFILE_FIELDS) {
      expect(payload, `retired field ${key} must not be written`).not.toHaveProperty(key);
    }
  });

  it('retires exactly the eighteen fields the cleanup removed', () => {
    expect([...RETIRED_PROFILE_FIELDS].sort()).toEqual([
      'backup_call_eligible', 'can_cover_offsite', 'can_supervise_crnas',
      'can_work_solo', 'cardiac_eligible', 'endo_eligible', 'ep_eligible',
      'friday_frequency_target', 'holiday_call_eligible',
      'holiday_frequency_target', 'late_shift_eligible', 'max_consecutive_calls',
      'max_monthly_calls', 'night_call_eligible', 'ob_eligible',
      'trauma_eligible', 'weekend_call_eligible', 'weekend_frequency_target',
    ]);
  });

  it('writes the three partnership booleans', () => {
    const payload = employmentSavePayload(state({ partnership: 'employed_call_taker' }));
    expect(payload.is_shareholder).toBe(false);
    expect(payload.is_partner_track).toBe(false);
    expect(payload.is_employed_call_taker).toBe(true);
  });

  it('sends every key it writes through the API allow-list', () => {
    // A key the validator drops is a field that silently never saves.
    const allowed = new Set<string>(PROFILE_COLUMNS as readonly string[]);
    for (const key of Object.keys(employmentSavePayload(state()))) {
      expect(allowed.has(key), `${key} is missing from PROFILE_COLUMNS`).toBe(true);
    }
  });

  it('blank numeric fields become null, never zero', () => {
    const payload = employmentSavePayload(state({
      workDaysFte: '', ptoWeeks: '', weeklyHours: '',
    }));
    expect(payload.work_days_fte).toBeNull();
    expect(payload.pto_weeks).toBeNull();
    expect(payload.max_weekly_hours).toBeNull();
  });

  it('keeps a stated zero as zero', () => {
    // Gabriel 2026-09-06: "0 is a real number for some of them".
    const payload = employmentSavePayload(state({ ptoWeeks: '0' }));
    expect(payload.pto_weeks).toBe(0);
  });

  it('resets day-doc-only fields when the role is not day doc', () => {
    const payload = employmentSavePayload(state({
      isDayDoc: false,
      availableWeekdays: [false, true, true, false, false, false, false],
      preferredDayShiftTypes: ['7-3'],
      daysPerWeek: '3',
    }));
    expect(payload.available_weekdays).toEqual([true, true, true, true, true, true, true]);
    expect(payload.preferred_day_shift_types).toEqual([]);
    expect(payload.days_per_week).toBeNull();
  });

  it('keeps day-doc fields when the role IS day doc', () => {
    const weekdays = [false, true, true, true, false, false, false];
    const payload = employmentSavePayload(state({
      isDayDoc: true,
      availableWeekdays: weekdays,
      preferredDayShiftTypes: ['7-3'],
      daysPerWeek: '3',
    }));
    expect(payload.available_weekdays).toEqual(weekdays);
    expect(payload.preferred_day_shift_types).toEqual(['7-3']);
    expect(payload.days_per_week).toBe(3);
  });

  it('trims scheduling notes to null when blank', () => {
    expect(employmentSavePayload(state({ schedulingNotes: '   ' })).scheduling_notes).toBeNull();
  });

  it('sends a blank home site as null, not an empty string', () => {
    expect(employmentSavePayload(state({ homeSiteId: '' })).home_site_id).toBeNull();
  });
});

describe('employmentStatusOptions', () => {
  it('offers every allowed status', () => {
    const values = employmentStatusOptions('full_time').map(o => o.value);
    expect(values).toEqual([...EMPLOYMENT_STATUSES]);
  });

  it('includes the new employed non-call status', () => {
    const opt = employmentStatusOptions('full_time')
      .find(o => o.value === 'employed_non_call_taker');
    expect(opt?.label).toBe('Employed (non-call)');
  });

  it('appends an off-list current value as legacy rather than dropping it', () => {
    // Without this the select shows no match, and saving the unchanged value is
    // REJECTED by the validator -- so no employment edit could ever persist.
    const opts = employmentStatusOptions('employed');
    const last = opts[opts.length - 1];
    expect(last.value).toBe('employed');
    expect(last.label).toContain('legacy');
  });

  it('does not duplicate a current value that is already on the list', () => {
    const opts = employmentStatusOptions('per_diem');
    expect(opts.filter(o => o.value === 'per_diem')).toHaveLength(1);
  });

  it('tolerates an empty current value', () => {
    expect(employmentStatusOptions('').map(o => o.value)).toEqual([...EMPLOYMENT_STATUSES]);
  });

  it('labels every allowed status with something other than its raw value', () => {
    // A status added to the allow-list without a label would render as
    // "employed_non_call_taker" in the picker.
    for (const v of EMPLOYMENT_STATUSES) {
      const opt = employmentStatusOptions(v).find(o => o.value === v)!;
      expect(opt.label, `${v} has no human label`).not.toBe(v);
    }
  });
});
