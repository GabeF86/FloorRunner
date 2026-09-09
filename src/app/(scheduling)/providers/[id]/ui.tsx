'use client';

// Local primitives for the provider profile page.
//
// These used to live at the bottom of page.tsx, ~145 call sites above them in
// a single 4,100-line file. They are lifted out verbatim here so the profile's
// visual layer is a bounded module you can design in, and so page.tsx is left
// holding data flow and layout rather than button styling.
//
// This module is a normal module, not a route file, so it may export freely —
// page.tsx must never grow an export beyond `default` (Next only allows a
// fixed set of page exports, and violating it fails `next build` while both
// `tsc --noEmit` and vitest stay green).

import { useState, type CSSProperties, type ReactNode } from 'react';

export const addFormBoxStyle: CSSProperties = {
  background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10,
  padding: 12, marginBottom: 12,
};
export const addFormErrorStyle: CSSProperties = {
  color: '#f87171', fontSize: 12, marginBottom: 10,
  padding: '6px 10px', background: 'rgba(248,113,113,0.1)',
  border: '1px solid rgba(248,113,113,0.3)', borderRadius: 6,
};

export const yearBtnStyle: CSSProperties = {
  width: 28, height: 28, borderRadius: 6, border: '1px solid var(--border)',
  background: 'var(--bg-surface)', color: 'var(--text-muted)', cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14,
};

export const fieldLabelStyle: CSSProperties = {
  fontSize: 10, color: 'var(--text-muted)', display: 'block',
  marginBottom: 4, fontWeight: 600, letterSpacing: 0.5,
  textTransform: 'uppercase',
};
export const fieldInputStyle: CSSProperties = {
  width: '100%', padding: '6px 10px', borderRadius: 5, border: '0.5px solid var(--border)',
  background: 'var(--bg-deep)', color: 'var(--text)', fontSize: 12,
  outline: 'none',
};
export const saveBtnStyle: CSSProperties = {
  padding: '7px 18px', borderRadius: 5, cursor: 'pointer', fontWeight: 700, fontSize: 12,
  background: 'linear-gradient(135deg,#0ea5e9,#6366f1)', color: '#fff', border: 'none',
  letterSpacing: 0.2,
};

// Unified save button for profile tabs. Shows an in-flight "Saving..." and a
// transient green "Saved ✓" so the click visibly registers — the previous
// button had no feedback and users thought it wasn't wired up.
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
  const label = isSaving ? 'Saving...' : isSaved ? 'Saved ✓' : idleLabel;
  const style: CSSProperties = {
    ...saveBtnStyle,
    background: isSaved ? 'linear-gradient(135deg,#10b981,#059669)' : saveBtnStyle.background,
    opacity: disabled && !isSaving ? 0.5 : 1,
    cursor: disabled ? 'not-allowed' : 'pointer',
    minWidth: 120,
    transition: 'background 0.2s',
  };
  return (
    <button onClick={onClick} disabled={disabled} style={style}>
      {label}
    </button>
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
  const borderColor = error ? 'rgba(248,113,113,0.6)' : 'var(--border)';
  return (
    <div>
      <label style={fieldLabelStyle}>{label}</label>
      <input
        type={type || 'text'}
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{ ...fieldInputStyle, border: `0.5px solid ${borderColor}` }}
      />
      {error ? (
        <div style={{ fontSize: 10, color: '#dc2626', marginTop: 2 }}>{error}</div>
      ) : hint ? (
        <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>{hint}</div>
      ) : null}
    </div>
  );
}

export function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer', padding: '2px 0' }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} style={{ accentColor: '#0ea5e9', width: 13, height: 13 }} />
      {label}
    </label>
  );
}

export function InfoTip({ text }: { text: string }) {
  const [show, setShow] = useState(false);
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}
      onClick={(e) => { e.stopPropagation(); setShow(v => !v); }}>
      <span style={{
        width: 13, height: 13, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 9, fontWeight: 800, cursor: 'pointer',
        background: 'rgba(14,165,233,0.12)', color: '#0ea5e9', border: '0.5px solid rgba(14,165,233,0.3)',
        flexShrink: 0, fontFamily: 'var(--font-mono), ui-monospace, monospace',
      }}>i</span>
      {show && (
        <div style={{
          position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)',
          marginTop: 6, padding: '8px 12px', borderRadius: 6, fontSize: 11, lineHeight: 1.5,
          background: '#1e293b', color: '#e2e8f0', border: '0.5px solid #334155',
          boxShadow: '0 4px 16px rgba(15,23,42,0.18)', width: 260, zIndex: 300,
          fontWeight: 500, whiteSpace: 'normal',
        }}>
          {text}
        </div>
      )}
    </span>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div style={{
      fontSize: 9, fontWeight: 700, color: 'var(--text-muted)',
      letterSpacing: 1, textTransform: 'uppercase',
      marginBottom: 8, marginTop: 4,
      paddingBottom: 4, borderBottom: '0.5px solid var(--border)',
      fontFamily: 'var(--font-mono), ui-monospace, monospace',
    }}>
      {children}
    </div>
  );
}

export function ChipPill({ text, fg, bg }: { text: string; fg: string; bg: string }) {
  return (
    <span style={{
      fontSize: 10, fontWeight: 600, padding: '1px 7px', borderRadius: 999,
      background: bg, color: fg, textTransform: 'capitalize',
      border: `0.5px solid ${fg}30`,
    }}>
      {text}
    </span>
  );
}

export function SaveIndicator({ state }: { state: 'idle' | 'saving' | 'saved' }) {
  if (state === 'idle') return null;
  const isSaving = state === 'saving';
  return (
    <span style={{
      fontSize: 10, fontFamily: 'var(--font-mono), ui-monospace, monospace',
      color: isSaving ? '#0ea5e9' : '#10b981',
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px', borderRadius: 4,
      background: isSaving ? 'rgba(14,165,233,0.08)' : 'rgba(16,185,129,0.08)',
      border: `0.5px solid ${isSaving ? 'rgba(14,165,233,0.25)' : 'rgba(16,185,129,0.25)'}`,
    }}>
      {isSaving ? '⋯ saving' : '✓ saved'}
    </span>
  );
}
