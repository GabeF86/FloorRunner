'use client';

import { useState, useEffect, useRef } from 'react';
import { Role, ROLE_META, HOUR_OPTIONS, ShiftHours, HOSPITALS } from '@/types';
import { hexToRgb } from './BoardClient';
import { Modal, Button } from '@/components/ui';
import { SITE_COLOR_CHOICES } from './boardTheme';

// ── Shared dialog shell — thin wrapper over the shared Modal so the three
// dialogs keep their (title, onClose, onConfirm, confirmLabel) call shape ────
function BoardModal({ title, children, onClose, onConfirm, confirmLabel }: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  onConfirm: () => void;
  confirmLabel: string;
}) {
  return (
    <Modal
      open
      title={title}
      onClose={onClose}
      width={400}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={onConfirm}>{confirmLabel}</Button>
        </>
      }
    >
      {children}
    </Modal>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px', borderRadius: 8,
  border: '1px solid var(--border)', background: 'var(--bg-deep)',
  color: 'var(--text)', fontSize: 14, marginBottom: 12,
  outline: 'none', boxSizing: 'border-box',
};

const labelStyle: React.CSSProperties = {
  fontSize: 11, color: 'var(--text-muted)', display: 'block',
  marginBottom: 6, fontWeight: 600, letterSpacing: 0.5,
};

// ── Add Site Modal ────────────────────────────────────────────────────────────
const SITE_ICONS = ['⚕', '◎', '⬡', '♥', '✦', '◈', '✚', '⬢', '⬟', '◆'];

export function AddSiteModal({ onClose, onConfirm }: {
  onClose: () => void;
  onConfirm: (name: string, color: string, icon: string) => void;
}) {
  const [name,  setName]  = useState('');
  const [color, setColor] = useState<string>(SITE_COLOR_CHOICES[0]);
  const [icon,  setIcon]  = useState('◈');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);

  const submit = () => { if (name.trim()) onConfirm(name.trim(), color, icon); };

  return (
    <BoardModal title="Add New Site" onClose={onClose} onConfirm={submit} confirmLabel="Add Site">
      <input ref={ref} style={inputStyle} placeholder="Site name (e.g. Cardiac OR, PACU)"
        value={name} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()} />

      <label style={labelStyle}>Icon</label>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        {SITE_ICONS.map((ic) => (
          <button key={ic} onClick={() => setIcon(ic)}
            style={{
              width: 36, height: 36, borderRadius: 8, fontSize: 17, cursor: 'pointer',
              border: `1px solid ${icon === ic ? color : 'var(--border)'}`,
              background: icon === ic ? `rgba(${hexToRgb(color)},0.18)` : 'var(--bg-deep)',
              color: icon === ic ? color : 'var(--text-muted)',
              transition: 'all 0.12s',
            }}>
            {ic}
          </button>
        ))}
      </div>

      <label style={labelStyle}>Accent Color</label>
      <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        {SITE_COLOR_CHOICES.map((c) => {
          const active = color.toLowerCase() === c.toLowerCase();
          return (
            <button key={c} type="button" onClick={() => setColor(c)} title={c} aria-label={`Color ${c}`} aria-pressed={active}
              style={{
                width: 28, height: 28, borderRadius: 7, padding: 0, cursor: 'pointer',
                background: c,
                border: active ? '2px solid #fff' : '1px solid var(--border)',
                boxShadow: active ? `0 0 0 2px ${c}` : 'none',
              }} />
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
        <input type="color" value={color} onChange={(e) => setColor(e.target.value)}
          style={{ width: 48, height: 38, border: 'none', borderRadius: 8, cursor: 'pointer', background: 'none' }} />
        <span style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'var(--font-mono), monospace' }}>{color}</span>
      </div>
    </BoardModal>
  );
}

// ── Add Room Modal ────────────────────────────────────────────────────────────
export function AddRoomModal({ onClose, onConfirm }: {
  onClose: () => void;
  onConfirm: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);

  const submit = () => { if (name.trim()) onConfirm(name.trim()); };

  return (
    <BoardModal title="Add Room" onClose={onClose} onConfirm={submit} confirmLabel="Add Room">
      <input ref={ref} style={inputStyle} placeholder="Room name (e.g. OR 7, Suite 4, Cath Lab 1)"
        value={name} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()} />
    </BoardModal>
  );
}

// ── Add Staff Modal ───────────────────────────────────────────────────────────
export function AddStaffModal({ onClose, onConfirm }: {
  onClose: () => void;
  onConfirm: (name: string, role: Role, hours: ShiftHours, homeHospital: string | null) => void;
}) {
  const [name,         setName]         = useState('');
  const [role,         setRole]         = useState<Role>('physician');
  const [hours,        setHours]        = useState<ShiftHours>('8hr');
  const [homeHospital, setHomeHospital] = useState<string>('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);

  const meta          = ROLE_META[role];
  const needsHospital = role === 'physician' || role === 'crna';
  const submit        = () => { if (name.trim()) onConfirm(name.trim(), role, hours, needsHospital && homeHospital ? homeHospital : null); };

  return (
    <BoardModal title="Add Staff Member" onClose={onClose} onConfirm={submit} confirmLabel="Add Staff">
      <input ref={ref} style={inputStyle} placeholder="Full name (e.g. Dr. Smith, Jane Doe CRNA)"
        value={name} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()} />

      <label style={labelStyle}>Role</label>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 14 }}>
        {(Object.entries(ROLE_META) as [Role, typeof ROLE_META[Role]][]).map(([r, m]) => (
          <button key={r} onClick={() => setRole(r)}
            style={{
              padding: '8px 10px', borderRadius: 8, cursor: 'pointer',
              border: `1px solid ${role === r ? m.color : 'var(--border)'}`,
              background: role === r ? m.bg : 'transparent',
              color: role === r ? m.color : 'var(--text-muted)',
              fontWeight: 700, fontSize: 12,
              display: 'flex', alignItems: 'center', gap: 6,
              transition: 'all 0.12s',
            }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: m.color, display: 'inline-block', flexShrink: 0 }} />
            {m.label}
          </button>
        ))}
      </div>

      {needsHospital && (
        <>
          <label style={labelStyle}>Home Hospital</label>
          <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
            {HOSPITALS.map((h) => {
              const active = homeHospital === h;
              return (
                <button key={h} onClick={() => setHomeHospital(active ? '' : h)}
                  style={{
                    padding: '7px 12px', borderRadius: 8, cursor: 'pointer',
                    border: `1px solid ${active ? meta.color : 'var(--border)'}`,
                    background: active ? meta.bg : 'transparent',
                    color: active ? meta.color : 'var(--text-muted)',
                    fontWeight: 700, fontSize: 12,
                    transition: 'all 0.12s',
                  }}>
                  {h}
                </button>
              );
            })}
          </div>
        </>
      )}

      {role !== 'surgeon' && (
        <>
          <label style={labelStyle}>Shift Length</label>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            {HOUR_OPTIONS.map((h) => {
              const active = hours === h;
              const is24   = h === '24hr';
              const c      = is24 && active ? '#f87171' : (active ? meta.color : 'var(--text-muted)');
              return (
                <button key={h} onClick={() => setHours(h as ShiftHours)}
                  style={{
                    flex: 1, padding: '9px 0', borderRadius: 8, fontWeight: 800,
                    fontSize: 13, cursor: 'pointer',
                    border: `1px solid ${active ? c : 'var(--border)'}`,
                    background: active ? `rgba(${hexToRgb(c)},0.15)` : 'transparent',
                    color: c,
                    transition: 'all 0.12s',
                  }}>
                  {h}
                </button>
              );
            })}
          </div>
        </>
      )}
    </BoardModal>
  );
}
