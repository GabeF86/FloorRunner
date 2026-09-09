'use client';

// Local primitives for the provider profile page.
//
// These used to live at the bottom of page.tsx, ~145 call sites below the code
// that uses them. They are lifted out here so the profile's visual layer is a
// bounded module, and so page.tsx holds data flow and layout rather than button
// styling.
//
// This module is a normal module, not a route file, so it may export freely —
// page.tsx must never grow an export beyond `default` (Next only allows a fixed
// set of page exports, and breaking that fails `next build` while both
// `tsc --noEmit` and vitest stay green).
//
// ── The type system this page runs on ──────────────────────────────────────
// Three registers, each with exactly one job. The page's old problem was that
// it had ONE texture — 9–10px uppercase letterspaced mono — doing all three
// jobs across ~145 labels, so nothing had hierarchy and the dominant surface
// of the page was its least readable typeface.
//
//   1. STRUCTURE  uppercase DM Mono, --fs-xs, tracking 0.6, --text-muted.
//      Card eyebrows, SectionLabel rules, table columns, badges. Roughly 20
//      instances — it reads as instrument labelling because it is rationed.
//      This is the kit's existing voice (Table's TH, Badge); not invented here.
//   2. LABELS     sentence case, --fs-sm, weight 600, --text-muted.
//      Every field label. A label is read once and understood; uppercase and
//      letterspacing both cost reading speed, and at 145 repetitions that cost
//      was the page's whole character.
//   3. VALUES     --fs-md, --text. Input text and row content — the thing the
//      user is actually here to read and type, so it is the biggest of the three.
//
// Nothing here may fall below --fs-xs (11px), the bottom of the scale in
// globals.css. Colours are tokens only: every literal hex the page used
// (#0ea5e9, #6366f1, #10b981, #f87171, #BA7517 …) was a DARK-theme value being
// rendered on a LIGHT default, where the token deliberately differs (light
// --blue is #0284c7, deepened so small accent text clears AA).
//
// Hover and focus states live in globals.css (.fr-field / .fr-toggle) because
// inline styles cannot express a pseudo-class — the same split the kit already
// uses for .fr-focus and .fr-row.

import { useState, type CSSProperties, type ReactNode } from 'react';
import { BADGE_TONES, Button, type BadgeTone } from '@/components/ui';

const MONO = 'var(--font-mono), ui-monospace, monospace';

/** Register 1 — uppercase mono micro-type. The kit's Table/Badge voice. */
export const structureType: CSSProperties = {
  fontSize: 'var(--fs-xs)',
  fontWeight: 500,
  fontFamily: MONO,
  letterSpacing: 0.6,
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
};

/** Register 2 — the field label. Sentence case, read once, gone. */
export const fieldLabelStyle: CSSProperties = {
  display: 'block',
  marginBottom: 'var(--space-1)',
  fontSize: 'var(--fs-sm)',
  fontWeight: 600,
  color: 'var(--text-muted)',
  lineHeight: 1.4,
};

/** Register 3 — the value. Pair with className="fr-field" for hover/focus. */
export const fieldInputStyle: CSSProperties = {
  width: '100%',
  padding: '7px 10px',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border-input)',
  background: 'var(--bg-deep)',
  color: 'var(--text)',
  fontSize: 'var(--fs-md)',
  fontFamily: 'inherit',
  lineHeight: 1.4,
};

export const textAreaStyle: CSSProperties = {
  ...fieldInputStyle,
  minHeight: 76,
  resize: 'vertical',
};

/**
 * The "add a row" tray inside an availability Card. Deliberately NOT another
 * bordered card — a card inside a card is the pattern that made this page read
 * as boxes all the way down. A recessed tint plus a hairline reads as part of
 * the card it sits in.
 */
export const addFormBoxStyle: CSSProperties = {
  background: 'var(--tint-surface-faint)',
  border: '1px solid var(--border-faint)',
  borderRadius: 'var(--radius-md)',
  padding: 'var(--space-3)',
  marginBottom: 'var(--space-3)',
};

/**
 * A tab body: a vertical stack of Cards at one rhythm.
 *
 * This is the change that does the most work on this page. Every tab used to
 * be one undifferentiated column — SectionLabel, grid, SectionLabel, grid —
 * printed straight onto the page background, so eight tabs of very different
 * content all read as the same flat run of fields with no landing points.
 */
export function TabStack({ children, maxWidth = 880 }: { children: ReactNode; maxWidth?: number }) {
  return <div style={{ display: 'grid', gap: 'var(--space-4)', maxWidth }}>{children}</div>;
}

/** Vertical run of controls at the standard rhythm. Gap, not trailing margin,
 *  so the last child never leaves dead space against a Card's own padding. */
export function Stack({ children }: { children: ReactNode }) {
  return <div style={{ display: 'grid', gap: 'var(--space-4)' }}>{children}</div>;
}

/** The commit row under a tab's cards. */
export function SaveBar({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
      {children}
    </div>
  );
}

/** Uniform form grid — one gap for every field row on the page. */
export function FormGrid({ cols, children, style }: { cols: string; children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 'var(--space-4)', alignItems: 'start', ...style }}>
      {children}
    </div>
  );
}

/** The explanatory line under a card title or above a control group. */
export function Hint({ children }: { children: ReactNode }) {
  return (
    <div style={{
      fontSize: 'var(--fs-sm)',
      color: 'var(--text-muted)',
      lineHeight: 1.5,
      marginBottom: 'var(--space-3)',
    }}>
      {children}
    </div>
  );
}

/** "No PTO entries yet." — the quiet in-card nothing-here line. */
export function NoneYet({ children }: { children: ReactNode }) {
  return (
    <div style={{
      fontSize: 'var(--fs-sm)',
      color: 'var(--text-dim)',
      padding: 'var(--space-2) 0',
    }}>
      {children}
    </div>
  );
}

/**
 * Save button for the profile tabs. Built on the kit Button so it inherits the
 * house hover and the .fr-focus ring; the old build was a bespoke
 * `linear-gradient(135deg,#0ea5e9,#6366f1)` pill, the single most off-brand
 * element on the page (the kit's primary is one flat saturated fill, and its
 * two gradient stops were both dark-theme hexes).
 *
 * The transient "Saved ✓" turns the same button --ok rather than swapping in a
 * second gradient, so the confirmation reads as a state of the action, not a
 * different control.
 */
export function SaveButton({
  onClick,
  canSave,
  saveState,
  idleLabel = 'Save Changes',
}: {
  onClick: () => void;
  canSave: boolean;
  saveState: 'idle' | 'saving' | 'saved';
  idleLabel?: string;
}) {
  const isSaving = saveState === 'saving';
  const isSaved = saveState === 'saved';
  const disabled = !canSave || isSaving;
  return (
    <Button
      variant="primary"
      onClick={onClick}
      disabled={disabled}
      style={{
        minWidth: 128,
        ...(isSaved ? { background: 'var(--ok)' } : null),
        transition: 'background .2s',
      }}
    >
      {isSaving ? 'Saving…' : isSaved ? 'Saved ✓' : idleLabel}
    </Button>
  );
}

export function Field({ label, value, onChange, type, error, hint }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  error?: string;
  hint?: string;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <label style={fieldLabelStyle}>{label}</label>
      <input
        type={type || 'text'}
        value={value}
        onChange={e => onChange(e.target.value)}
        className="fr-field"
        aria-invalid={error ? true : undefined}
        style={{
          ...fieldInputStyle,
          ...(error ? { borderColor: 'var(--danger)' } : null),
        }}
      />
      {error ? (
        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--danger)', marginTop: 'var(--space-1)', lineHeight: 1.4 }}>
          {error}
        </div>
      ) : hint ? (
        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 'var(--space-1)', lineHeight: 1.4 }}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A checkbox as a selectable pill. The native input keeps every bit of the
 * semantics and keyboard behaviour — only the label around it is drawn — so
 * this is a paint change, not an a11y experiment. Fourteen bare checkboxes in
 * a grid were unscannable; fourteen pills tell you which are on from across
 * the room. The focus ring comes from :focus-within in globals.css, since the
 * thing that draws focus is the wrapper, not the input.
 */
export function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label
      className="fr-toggle"
      data-on={checked ? 'true' : 'false'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
        padding: '6px 10px',
        borderRadius: 'var(--radius-sm)',
        border: `1px solid ${checked ? 'var(--blue)' : 'var(--border)'}`,
        background: checked ? 'var(--info-bg)' : 'transparent',
        fontSize: 'var(--fs-sm)',
        fontWeight: checked ? 600 : 500,
        color: checked ? 'var(--text-strong)' : 'var(--text-muted)',
        cursor: 'pointer',
        lineHeight: 1.4,
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        style={{ accentColor: 'var(--blue)', width: 14, height: 14, margin: 0, cursor: 'pointer', flexShrink: 0 }}
      />
      {label}
    </label>
  );
}

/**
 * Hover/click help bubble. The popover used to hardcode a dark slate palette
 * (#1e293b on #e2e8f0) regardless of theme, so on the LIGHT default — the
 * product default — it was a dark box floating in a light page. It is now the
 * kit's popover surface and inverts correctly.
 */
export function InfoTip({ text }: { text: string }) {
  const [show, setShow] = useState(false);
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}
      onClick={(e) => { e.stopPropagation(); setShow(v => !v); }}>
      <span
        aria-hidden="true"
        style={{
          width: 14, height: 14, borderRadius: '50%',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 'var(--fs-xs)', fontWeight: 700, lineHeight: 1, cursor: 'pointer',
          background: 'var(--info-bg)', color: 'var(--info)',
          border: '1px solid transparent',
          flexShrink: 0, fontFamily: MONO,
        }}
      >i</span>
      {show && (
        <div
          role="tooltip"
          style={{
            position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)',
            marginTop: 'var(--space-2)', padding: 'var(--space-3)',
            borderRadius: 'var(--radius-md)',
            fontSize: 'var(--fs-sm)', lineHeight: 1.5, fontWeight: 400,
            background: 'var(--bg-popover)', color: 'var(--text)',
            border: '1px solid var(--border)',
            boxShadow: 'var(--shadow-popover)',
            width: 280, zIndex: 300,
            whiteSpace: 'normal', textTransform: 'none', letterSpacing: 0,
          }}
        >
          {text}
        </div>
      )}
    </span>
  );
}

/**
 * Sub-section rule INSIDE a card (Register 1). Most of the page's old
 * SectionLabels became Card titles; the handful that remain mark a second
 * level within one card, which is why this keeps the hairline rule.
 */
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div style={{
      ...structureType,
      display: 'flex',
      alignItems: 'center',
      marginBottom: 'var(--space-3)',
      paddingBottom: 'var(--space-2)',
      borderBottom: '1px solid var(--border-faint)',
    }}>
      {children}
    </div>
  );
}

/**
 * Identity chip carrying a caller-supplied hue. Only used for provider TYPE,
 * whose seven-colour map is shared verbatim with the providers list page — a
 * cross-page identity that must not be forked here (see the note in page.tsx).
 * Everything else on this page uses the kit Badge and its five semantic tones.
 */
export function ChipPill({ text, fg, bg }: { text: string; fg: string; bg: string }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      fontSize: 'var(--fs-xs)', fontWeight: 600, lineHeight: 1.6,
      padding: '2px 9px', borderRadius: 999,
      background: bg, color: fg, textTransform: 'capitalize',
      border: `1px solid ${fg}33`,
      whiteSpace: 'nowrap',
    }}>
      {text}
    </span>
  );
}

/** Header save state. Idle renders nothing, so the header doesn't jitter. */
export function SaveIndicator({ state }: { state: 'idle' | 'saving' | 'saved' }) {
  if (state === 'idle') return null;
  const isSaving = state === 'saving';
  return (
    <span
      role="status"
      style={{
        ...structureType,
        color: isSaving ? 'var(--info)' : 'var(--ok)',
        display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)',
        padding: '3px 9px', borderRadius: 999,
        background: isSaving ? 'var(--info-bg)' : 'var(--ok-bg)',
      }}
    >
      {isSaving ? '⋯ saving' : '✓ saved'}
    </span>
  );
}

/**
 * "Here is what pressing Add will actually do" — the live preview under a date
 * entry form. Four of these existed inline, each with its own hand-mixed tint
 * (rgba(14,165,233,.06), rgba(139,92,246,.06), `${accent}0f` …). One component,
 * one --info tint, correct in both themes.
 */
export function PreviewNote({ children }: { children: ReactNode }) {
  return (
    <div style={{
      marginTop: 'var(--space-2)',
      padding: 'var(--space-2) var(--space-3)',
      borderRadius: 'var(--radius-sm)',
      background: 'var(--info-bg)',
      border: '1px solid var(--border-faint)',
      fontSize: 'var(--fs-sm)', color: 'var(--text)', lineHeight: 1.5,
    }}>
      {children}
    </div>
  );
}

/** Wrapper for a run of selected-value chips under a picker. */
export function ChipRow({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', marginTop: 'var(--space-2)' }}>
      {children}
    </div>
  );
}

/**
 * A selected value with a remove affordance — a site, an assignment, a skill.
 *
 * Sentence case at --fs-sm rather than a kit Badge, deliberately: these carry a
 * NAME the user typed or picked ("General Surgery", "Paoli Hospital"), which is
 * content, and Badge's uppercase mono is the instrument-label voice reserved for
 * statuses. The COLOURS still come from the kit's exported BADGE_TONES, so the
 * two can't drift. This replaces four call sites that each built their own tint
 * by string-concatenating an alpha onto a dark-theme hex (`${accent}20`).
 */
export function RemovableChip({ label, tone = 'info', onRemove, note }: {
  label: string;
  tone?: BadgeTone;
  onRemove: () => void;
  /** e.g. "(legacy)" for a value no longer in the canonical option list. */
  note?: string;
}) {
  const t = BADGE_TONES[tone];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)',
      padding: '3px 4px 3px 10px', borderRadius: 999,
      background: t.bg, color: t.fg,
      fontSize: 'var(--fs-sm)', fontWeight: 600, lineHeight: 1.5,
    }}>
      {label}
      {note && <span style={{ fontStyle: 'italic', fontWeight: 400, opacity: 0.8 }}>{note}</span>}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${label}`}
        title={`Remove ${label}`}
        className="fr-focus"
        style={{
          display: 'grid', placeItems: 'center',
          width: 18, height: 18, borderRadius: 999,
          background: 'none', border: 'none', color: 'inherit',
          fontFamily: 'inherit', fontSize: 'var(--fs-md)', lineHeight: 1,
          cursor: 'pointer', opacity: 0.75, padding: 0,
        }}
      >×</button>
    </span>
  );
}

/**
 * One number from the burden summary. The figure is set in mono so a column of
 * them aligns on the digit rather than drifting with proportional widths, and
 * `emphasis` marks the two TOTALS apart from the four buckets that decompose
 * one of them — the six tiles used to carry six unrelated hues, which encoded
 * nothing (they aren't a scale and they aren't statuses).
 */
export function StatTile({ value, label, detail, emphasis }: {
  value: ReactNode;
  label: string;
  detail?: string;
  emphasis?: boolean;
}) {
  return (
    <div style={{
      padding: 'var(--space-3)',
      borderRadius: 'var(--radius-md)',
      border: '1px solid var(--border-faint)',
      background: emphasis ? 'var(--tint-surface-faint)' : 'transparent',
    }}>
      <div style={{
        fontSize: 'var(--fs-xl)',
        fontWeight: 700,
        fontFamily: MONO,
        lineHeight: 1.1,
        letterSpacing: -0.5,
        color: emphasis ? 'var(--text-strong)' : 'var(--text)',
      }}>
        {value}
      </div>
      <div style={{ ...structureType, marginTop: 'var(--space-2)' }}>{label}</div>
      {detail && (
        <div style={{
          fontSize: 'var(--fs-xs)', color: 'var(--text-dim)',
          marginTop: 'var(--space-1)', lineHeight: 1.5, wordBreak: 'break-word',
        }}>
          {detail}
        </div>
      )}
    </div>
  );
}
