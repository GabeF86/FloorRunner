'use client';

// Employment & Scheduling tab of /providers/[id] — employment status, the two
// FTE contracts, partnership standing, call eligibility, and the Day Doc
// settings panel that appears with the Day Doc role.
//
// DYNAMICALLY IMPORTED by page.tsx. Only one of the eight tabs is on screen at
// a time, and this one carries both the employment-payload machinery and
// SiteShiftTypePicker (for preferred day-shift types) — neither of which the
// Profile tab, which is what the route opens on, has any use for.
//
// normalizeWeekdays travels WITH the tab rather than into a shared module: the
// available_weekdays array is edited here and nowhere else on this route.

import { useState, useEffect } from 'react';
import {
  FTE_MAX,
  FTE_MIN,
  WORK_DAYS_FTE_MAX,
  WORK_DAYS_FTE_MIN,
} from '@/lib/validation/providers';
import {
  employmentSavePayload,
  employmentStatusOptions,
  partnershipFromProfile,
  type EmploymentFormState,
  type Partnership,
} from '@/lib/providerEmploymentForm';
import { SiteShiftTypePicker } from '@/components/ShiftTypePicker';
import { Card } from '@/components/ui';
import type { EmploymentProfile } from './profileShared';
import {
  fieldLabelStyle, fieldInputStyle, textAreaStyle,
  SaveButton, Field, Toggle, SectionLabel,
  FormGrid, Hint, NoneYet, TabStack, SaveBar,
} from './ui';

// Coerce a loaded available_weekdays value (may be null on legacy rows, or
// a shorter array on malformed data) into a guaranteed 7-element boolean
// array indexed Sun..Sat. Missing entries are treated as available.
function normalizeWeekdays(v: boolean[] | null | undefined): boolean[] {
  const out = [true, true, true, true, true, true, true];
  if (Array.isArray(v)) {
    for (let i = 0; i < 7; i++) {
      if (typeof v[i] === 'boolean') out[i] = v[i];
    }
  }
  return out;
}

export function SchedulingTab({ profile, sites, saveState, onSave }: { profile: EmploymentProfile; sites: Array<{ id: string; name: string; short_name: string | null }>; saveState: 'idle' | 'saving' | 'saved'; onSave: (u: Record<string, unknown>) => void }) {
  const [empStatus, setEmpStatus] = useState(profile.employment_status);
  const [fte, setFte] = useState(String(profile.fte_value));
  // Blank string = "same as FTE" (stored NULL). Never pre-filled with the FTE:
  // the field must LOOK empty when nothing is stated, or a later FTE change
  // would silently leave a stale frozen copy behind.
  const [workDaysFte, setWorkDaysFte] = useState(
    profile.work_days_fte == null ? '' : String(profile.work_days_fte));
  // Blank means NOT STATED, 0 means a real zero (Gabriel 2026-09-06: "0 is a
  // real number for some of them"). Mirrors the work_days_fte field above.
  const [ptoWeeks, setPtoWeeks] = useState(
    profile.pto_weeks == null ? '' : String(profile.pto_weeks));
  // Column is still max_weekly_hours; the label is "Weekly Hours".
  const [weeklyHours, setWeeklyHours] = useState(profile.max_weekly_hours == null ? '' : String(profile.max_weekly_hours));
  // Per-diem contracted minimum. Blank = no minimum stated, which is NOT zero:
  // most of the bench has no such obligation, and the staffing board flags
  // nobody whose minimum is blank.
  const [minMonthlyShifts, setMinMonthlyShifts] = useState(
    profile.min_monthly_shifts == null ? '' : String(profile.min_monthly_shifts));
  // Partner / Partner Track / Employed Call Taker are mutually exclusive, so
  // this is ONE value rather than three booleans — no handler can leave two set.
  const [partnership, setPartnership] = useState<Partnership>(partnershipFromProfile(profile));
  const [isDayDoc, setIsDayDoc] = useState(profile.is_day_doc);
  const [isIcuDoc, setIsIcuDoc] = useState(profile.is_icu_doc);
  const [callTaker, setCallTaker] = useState(profile.call_taker);
  const [scheduleMaker, setScheduleMaker] = useState(profile.schedule_maker);
  const [partialCall, setPartialCall] = useState(profile.partial_call_taker);
  const [schedulingNotes, setSchedulingNotes] = useState(profile.scheduling_notes || '');
  const [homeSite, setHomeSite] = useState(profile.home_site_id || '');
  // 7 booleans indexed Sun..Sat. Null/missing from the DB is normalized to
  // all-true so legacy rows don't suddenly appear as "unavailable every day".
  const [availableWeekdays, setAvailableWeekdays] = useState<boolean[]>(
    normalizeWeekdays(profile.available_weekdays),
  );
  const [preferredDayShifts, setPreferredDayShifts] = useState<string[]>(profile.preferred_day_shift_types || []);
  const [daysPerWeek, setDaysPerWeek] = useState<string>(profile.days_per_week == null ? '' : String(profile.days_per_week));

  useEffect(() => {
    setEmpStatus(profile.employment_status);
    setFte(String(profile.fte_value));
    setWorkDaysFte(profile.work_days_fte == null ? '' : String(profile.work_days_fte));
    setPtoWeeks(profile.pto_weeks == null ? '' : String(profile.pto_weeks));
    setMinMonthlyShifts(
      profile.min_monthly_shifts == null ? '' : String(profile.min_monthly_shifts));
    setWeeklyHours(profile.max_weekly_hours == null ? '' : String(profile.max_weekly_hours));
    setPartnership(partnershipFromProfile(profile));
    setIsDayDoc(profile.is_day_doc);
    setIsIcuDoc(profile.is_icu_doc);
    setCallTaker(profile.call_taker);
    setScheduleMaker(profile.schedule_maker);
    setPartialCall(profile.partial_call_taker);
    setSchedulingNotes(profile.scheduling_notes || '');
    setHomeSite(profile.home_site_id || '');
    setAvailableWeekdays(normalizeWeekdays(profile.available_weekdays));
    setPreferredDayShifts(profile.preferred_day_shift_types || []);
    setDaysPerWeek(profile.days_per_week == null ? '' : String(profile.days_per_week));
  }, [profile]);

  const fteNum = Number(fte);
  const errors: Record<string, string> = {};
  if (fte.trim() === '' || !Number.isFinite(fteNum) || fteNum < FTE_MIN || fteNum > FTE_MAX) {
    errors.fte = `Must be between ${FTE_MIN} and ${FTE_MAX}`;
  }
  // Blank is VALID here — it is the "same as FTE" state, not a missing answer.
  const workDaysFteNum = Number(workDaysFte);
  if (workDaysFte.trim() !== ''
      && (!Number.isFinite(workDaysFteNum)
        || workDaysFteNum < WORK_DAYS_FTE_MIN || workDaysFteNum > WORK_DAYS_FTE_MAX)) {
    errors.workDaysFte = `Must be between ${WORK_DAYS_FTE_MIN} and ${WORK_DAYS_FTE_MAX}, or blank`;
  }
  const checkInt = (s: string, key: string) => {
    if (!s) return;
    const n = Number(s);
    if (!Number.isInteger(n) || n < 0) errors[key] = 'Must be a non-negative integer';
  };
  checkInt(ptoWeeks, 'ptoWeeks');
  checkInt(weeklyHours, 'weeklyHours');
  checkInt(minMonthlyShifts, 'minMonthlyShifts');

  const canSave = Object.keys(errors).length === 0;

  // The payload shape lives in @/lib/providerEmploymentForm so it can be
  // tested — in particular that the eighteen retired columns stay OUT of it.
  const formState: EmploymentFormState = {
    employmentStatus: empStatus,
    fte,
    workDaysFte,
    ptoWeeks,
    weeklyHours,
    minMonthlyShifts,
    partnership,
    isDayDoc,
    isIcuDoc,
    callTaker,
    scheduleMaker,
    partialCallTaker: partialCall,
    homeSiteId: homeSite,
    schedulingNotes,
    availableWeekdays,
    preferredDayShiftTypes: preferredDayShifts,
    daysPerWeek,
  };

  const handleSave = () => {
    if (!canSave) return;
    onSave(employmentSavePayload(formState));
  };

  return (
    <TabStack>
      <Card title="Employment">
        <FormGrid cols="1fr 1fr 1fr">
          <div style={{ minWidth: 0 }}>
            <label style={fieldLabelStyle}>Employment Status</label>
            {/* An off-list current value is offered as "(legacy)" rather than
                dropped — the DB enum carries `employed`, which the validator does
                not allow, and a select with no matching option would leave that
                provider permanently unsaveable. */}
            <select value={empStatus} onChange={e => setEmpStatus(e.target.value)} className="fr-field" style={fieldInputStyle}>
              {employmentStatusOptions(empStatus).map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <Field
            label="FTE (call share)"
            value={fte} onChange={setFte} error={errors.fte}
            hint={`${FTE_MIN}\u2013${FTE_MAX} \u00b7 pro-rates how much CALL they owe`}
          />
          {/* The second contract (patch43). Sits beside the call FTE because the
              pair is only comprehensible together: one pro-rates call, the other
              pro-rates the days they must be IN a room. Blank is the norm and
              means "same as FTE" \u2014 the blank-means-formula convention used by
              the Limits tab. Hussain is the case that forced the split: 0.66 for
              call (a third of his time is ICU), 1.0 for working days. */}
          <Field
            label="Working-Days FTE"
            value={workDaysFte} onChange={setWorkDaysFte} error={errors.workDaysFte}
            hint={'Blank = same as FTE \u00b7 share of working days they must be scheduled'}
          />
          <Field
            label="PTO Weeks"
            value={ptoWeeks} onChange={setPtoWeeks} error={errors.ptoWeeks}
            hint={'Blank = not stated · 0 = genuinely no allotment'}
          />
          <Field label="Weekly Hours" value={weeklyHours} onChange={setWeeklyHours} error={errors.weeklyHours} />
          {/* Per diems only. Shown for nobody else because nobody else has a
              monthly shift obligation — and a field that is meaningless for
              most of the roster trains people to skip past it. */}
          {empStatus === 'per_diem' && (
            <Field
              label="Min Shifts / Month"
              value={minMonthlyShifts}
              onChange={setMinMonthlyShifts}
              error={errors.minMonthlyShifts}
              hint={'Blank = no minimum · the staffing board flags anyone running under it'}
            />
          )}
          <div style={{ gridColumn: '1 / -1', minWidth: 0 }}>
            <label style={fieldLabelStyle}>Home Hospital / Surgery Center</label>
            <select value={homeSite} onChange={e => setHomeSite(e.target.value)} className="fr-field" style={fieldInputStyle}>
              <option value="">— None —</option>
              {sites.map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
        </FormGrid>
      </Card>

      {/* Standing and call eligibility were two runs of bare checkboxes, the
          first of them under no heading at all. They are one decision — what
          this provider IS to the group — so they are one card, split by a rule. */}
      <Card title="Role & call eligibility">
        <SectionLabel>Standing</SectionLabel>
        <div style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-4)', flexWrap: 'wrap' }}>
          {/* One value, three checkboxes: picking any clears the others, and
              unchecking the one that is set returns to "none stated". */}
          <Toggle
            label="Partner"
            checked={partnership === 'partner'}
            onChange={(v) => setPartnership(v ? 'partner' : null)}
          />
          <Toggle
            label="Partner Track"
            checked={partnership === 'partner_track'}
            onChange={(v) => setPartnership(v ? 'partner_track' : null)}
          />
          <Toggle
            label="Employed Call Taker"
            checked={partnership === 'employed_call_taker'}
            onChange={(v) => setPartnership(v ? 'employed_call_taker' : null)}
          />
          {/* Day Doc is mutually exclusive with the call-taker flags — you're
              either in the call rotation or you're a scheduled-shift day doc. */}
          <Toggle
            label="Day Doc"
            checked={isDayDoc}
            onChange={(v) => {
              setIsDayDoc(v);
              if (v) {
                setCallTaker(false);
                setPartialCall(false);
              }
            }}
          />
          {/* ICU Doc is orthogonal to the call/day-doc split — it only reveals
              the ICU Rotation entry section on the Availability tab. */}
          <Toggle label="ICU Doc" checked={isIcuDoc} onChange={setIsIcuDoc} />
        </div>

        {/* A job, not a grade of employment — which is why it sits on its own
            rather than among the call flags below. It confers the right to
            build and edit DRAFT schedules at every site, and to delete
            schedules; the rules are in lib/auth/schedulePermissions.ts. */}
        <SectionLabel>Scheduling duties</SectionLabel>
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <Toggle
            label="Schedule Maker"
            checked={scheduleMaker}
            onChange={setScheduleMaker}
          />
        </div>
        <p style={{
          margin: '4px 0 0', fontSize: 'var(--fs-xs)', color: 'var(--text-dim)',
          lineHeight: 1.5,
        }}>
          Builds and edits drafts at any site, and may delete schedules.
          Assigned by an admin or a site chief. Site chiefs already work drafts
          at their own hospital without this.
        </p>

        <SectionLabel>Call eligibility</SectionLabel>
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <Toggle
            label="Call Taker"
            checked={callTaker}
            onChange={(v) => { setCallTaker(v); if (v) setIsDayDoc(false); }}
          />
          <Toggle
            label="Partial Call Taker"
            checked={partialCall}
            onChange={(v) => { setPartialCall(v); if (v) setIsDayDoc(false); }}
          />
        </div>
      </Card>

      {/* Day Doc settings — show only when the provider is flagged Day Doc. */}
      {isDayDoc && (
        <Card title="Day doc settings">
          <Hint>
            Working days, shift preferences, and weekly-day cap for this Day Doc.
            Hidden until the Day Doc role is checked above.
          </Hint>

          {/* Working days */}
          <label style={fieldLabelStyle}>Available Weekdays</label>
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', marginBottom: 'var(--space-4)' }}>
            {/* Render Mon first for readability; storage order is Sun..Sat. */}
            {[1, 2, 3, 4, 5, 6, 0].map(idx => {
              const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
              const selected = availableWeekdays[idx];
              return (
                <button
                  key={idx}
                  type="button"
                  // .fr-btn = motion tokens + press nudge; .fr-btn-secondary is
                  // the hover contract for an OFF pill only. An ON pill gets no
                  // hover repaint, which is the same rule the kit's own .fr-toggle
                  // states ([data-on='false']:hover) — recolouring a pill that is
                  // already lit reads as a state change that isn't happening.
                  className={`fr-focus fr-btn${selected ? '' : ' fr-btn-secondary'}`}
                  aria-pressed={selected}
                  onClick={() => setAvailableWeekdays(prev => {
                    const next = [...prev];
                    next[idx] = !next[idx];
                    return next;
                  })}
                  style={{
                    padding: '7px 14px', borderRadius: 'var(--radius-sm)',
                    fontSize: 'var(--fs-sm)', fontWeight: selected ? 700 : 500,
                    fontFamily: 'inherit', cursor: 'pointer',
                    // An OFF pill declares no background and no border: those
                    // are the two properties .fr-btn-secondary:hover moves, and
                    // an inline value outranks the class, so stating them here
                    // (as this did) leaves the pill inert under the cursor. The
                    // class's resting values are the same transparent/--border
                    // this used to spell out. `color` is safe to keep inline —
                    // the secondary hover does not touch it, and OFF is
                    // deliberately quieter than the class's --text.
                    ...(selected ? {
                      background: 'var(--info-bg)',
                      border: '1px solid var(--blue)',
                    } : null),
                    color: selected ? 'var(--text-strong)' : 'var(--text-muted)',
                    minWidth: 58,
                  }}
                >
                  {labels[idx]}
                </button>
              );
            })}
          </div>

          {/* Days per week */}
          <FormGrid cols="1fr 1fr" style={{ marginBottom: 'var(--space-4)' }}>
            <div style={{ minWidth: 0 }}>
              <label style={fieldLabelStyle}>Days per Week</label>
              <select
                value={daysPerWeek}
                onChange={e => setDaysPerWeek(e.target.value)}
                className="fr-field"
                style={fieldInputStyle}
              >
                <option value="">— No cap —</option>
                {[1, 2, 3, 4, 5, 6, 7].map(n => (
                  <option key={n} value={String(n)}>{n} day{n === 1 ? '' : 's'} / week</option>
                ))}
              </select>
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 'var(--space-1)', lineHeight: 1.4 }}>
                How many days the scheduler should try to place them on each week,
                among the available weekdays above.
              </div>
            </div>
          </FormGrid>

          {/* Preferred day-shift types — scoped to the home site, category=regular,
              and D-prefixed codes are excluded because post-call D1..D9 relief
              shifts are call-taker territory (they chain off call placements).
              `accent` stays a literal hex: SiteShiftTypePicker is shared with
              other pages and concatenates an alpha onto it. */}
          {homeSite ? (
            <SiteShiftTypePicker
              siteId={homeSite}
              label="Preferred Day Shift Types"
              values={preferredDayShifts}
              onChange={setPreferredDayShifts}
              includeCategories={['regular']}
              filter={(st) => !/^D\d+$/i.test(st.code)}
              emptyHint="No day shift types configured at this provider's home site yet."
              accent="var(--blue)"
            />
          ) : (
            <NoneYet>Set a Home Hospital above to pick preferred day-shift types.</NoneYet>
          )}
        </Card>
      )}

      {/* Capabilities, Specialty Eligibility, Limits and Frequency Targets used
          to sit here (Gabriel 2026-09-09: "getting rid of the check boxes or
          sections that are not really necessary"). Eighteen controls, none of
          them read by anything: the frequency targets had no data and no
          reader, the specialty toggles no reader, and backup_call_eligible's
          only consumer hardcodes it true. The COLUMNS survive with their values
          — see providerEmploymentForm.RETIRED_PROFILE_FIELDS, which a test uses
          to assert they stay out of the save payload. */}

      <Card title="Scheduling notes">
        <textarea
          value={schedulingNotes}
          onChange={e => setSchedulingNotes(e.target.value)}
          placeholder="Scheduling-specific notes (e.g. 'Prefers no back-to-back weekend + Monday')..."
          aria-label="Scheduling notes"
          className="fr-field"
          style={textAreaStyle}
        />
      </Card>

      <SaveBar>
        <SaveButton onClick={handleSave} canSave={canSave} saveState={saveState} />
      </SaveBar>
    </TabStack>
  );
}
