'use client';

// Step 1 — Hospital identity.
// Owned by agent A15 (Onboarding Wizard).
// PRD: docs/PRD-Grid-Calculator.md §14 (A15), §16 acceptance criterion 1.
//
// Fields:
//   - Hospital name (string, required).
//   - Contact email (string, required, basic regex validation).
//   - Timezone (IANA tz id, required — used by A7's calendar generator).
//
// Validation lives in `wizardState.isStepComplete`; this component is a pure
// input panel. It does NOT mutate the WizardState — every onChange dispatches
// a `setHospital` action and the reducer wins.

import type { Dispatch } from 'react';

import {
  TIMEZONE_OPTIONS,
  type HospitalIdentity,
  type WizardAction,
} from './wizardState';

const CYAN = '#0ea5e9';

export interface StepHospitalProps {
  hospital: HospitalIdentity;
  dispatch: Dispatch<WizardAction>;
}

export default function StepHospital({ hospital, dispatch }: StepHospitalProps) {
  return (
    <Panel>
      <Header
        title="Hospital identity"
        subtitle="Name the hospital, the scheduler we should ping with parse questions, and the timezone we'll use for the calendar generator."
      />

      <Field
        label="Hospital name"
        hint="Displayed in the grid header and every export."
        required
      >
        <input
          type="text"
          value={hospital.name}
          onChange={(e) =>
            dispatch({ type: 'setHospital', patch: { name: e.target.value } })
          }
          placeholder="e.g. Paoli Hospital, Mercy Northwest, …"
          style={inputStyle}
          autoFocus
        />
      </Field>

      <Field
        label="Contact email"
        hint="Where parse-failure clarifications and post-onboarding nudges land."
        required
        error={
          hospital.contactEmail.length > 0 && !isValidEmail(hospital.contactEmail)
            ? 'Looks malformed — double-check the @ and the domain.'
            : undefined
        }
      >
        <input
          type="email"
          value={hospital.contactEmail}
          onChange={(e) =>
            dispatch({
              type: 'setHospital',
              patch: { contactEmail: e.target.value },
            })
          }
          placeholder="scheduler@example-hospital.org"
          style={inputStyle}
          inputMode="email"
          autoComplete="email"
        />
      </Field>

      <Field
        label="Timezone"
        hint="IANA timezone id. The FTE simulator's calendar generator uses this to sample weekday vs. weekend distributions correctly."
        required
      >
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <select
            value={hospital.timezone}
            onChange={(e) =>
              dispatch({
                type: 'setHospital',
                patch: { timezone: e.target.value },
              })
            }
            style={{ ...inputStyle, flex: 1, minWidth: 220 }}
          >
            {TIMEZONE_OPTIONS.map((tz) => (
              <option key={tz.id} value={tz.id}>
                {tz.label}
              </option>
            ))}
            {/* Allow the user's saved tz to render even if it's not in the
                curated list — keeps non-US groups from losing their value. */}
            {!TIMEZONE_OPTIONS.some((tz) => tz.id === hospital.timezone) &&
              hospital.timezone.length > 0 && (
                <option value={hospital.timezone}>{hospital.timezone}</option>
              )}
          </select>
          <input
            type="text"
            value={hospital.timezone}
            onChange={(e) =>
              dispatch({
                type: 'setHospital',
                patch: { timezone: e.target.value },
              })
            }
            placeholder="or type a custom IANA tz id"
            style={{ ...inputStyle, flex: 1, minWidth: 200 }}
            aria-label="Custom timezone"
          />
        </div>
      </Field>

      <HelpBox>
        We never share the contact email with the hospital. It's used by
        the agent fleet to nudge you about ambiguous guidelines, parse
        failures, or simulator anomalies.
      </HelpBox>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Reusable bits — local to keep the wizard files self-contained.
// ---------------------------------------------------------------------------

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: 18,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      {children}
    </div>
  );
}

function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h2
        style={{
          fontSize: 14,
          fontWeight: 700,
          color: 'var(--text-strong)',
          letterSpacing: -0.1,
          marginBottom: 2,
        }}
      >
        {title}
      </h2>
      <p
        style={{
          fontSize: 11,
          color: 'var(--text-muted)',
          margin: 0,
          lineHeight: 1.5,
        }}
      >
        {subtitle}
      </p>
    </div>
  );
}

function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: 'var(--text-strong)',
          letterSpacing: 0.2,
          textTransform: 'uppercase',
          fontFamily: 'var(--font-mono), ui-monospace, monospace',
        }}
      >
        {label}
        {required && (
          <span style={{ color: '#ef4444', marginLeft: 4 }} aria-label="required">
            ●
          </span>
        )}
      </label>
      {children}
      {hint && !error && (
        <span style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.4 }}>
          {hint}
        </span>
      )}
      {error && (
        <span style={{ fontSize: 10, color: '#ef4444', lineHeight: 1.4 }}>
          {error}
        </span>
      )}
    </div>
  );
}

function HelpBox({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: 'rgba(14,165,233,0.06)',
        border: '1px solid rgba(14,165,233,0.25)',
        borderRadius: 8,
        padding: '8px 12px',
        fontSize: 11,
        color: CYAN,
        fontStyle: 'italic',
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  fontSize: 13,
  fontFamily: 'inherit',
  border: '1px solid var(--border)',
  borderRadius: 6,
  background: 'var(--bg-base)',
  color: 'var(--text)',
  outline: 'none',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}
