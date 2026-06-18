'use client';

// Step 2 — Sites + rooms.
// Owned by agent A15 (Onboarding Wizard).
// PRD: docs/PRD-Grid-Calculator.md §14 (A15), §16 acceptance criterion 1.
//
// What the user does here:
//   - Quick-add buttons for the "common five" sites (Main OR, Endoscopy, Neuro
//     Lab, EP Lab, OB) — each populates sensible defaults including room count.
//   - "+ Add custom site" form for hospital-specific anesthetizing locations
//     (Cath, IR, Robotics, Pre-Op, PACU, etc.). Each: name, icon, color, rooms.
//   - List of added sites with inline edit (name, room count add/remove).
//
// Visual model: matches the locked Sidebar density — small fonts, tight rows,
// 3px color accent on the left edge. We're using inline styles here so the
// wizard chrome is independent of any sidebar refactor.

import { useState } from 'react';
import type { Dispatch } from 'react';

import type { GridSite } from '@/lib/gridCalculator/types';

import {
  SITE_COLOR_PALETTE,
  SITE_PRESETS,
  buildCustomSite,
  buildSiteFromPreset,
  type SitePreset,
  type WizardAction,
} from './wizardState';

const CYAN = '#0ea5e9';
const SLATE = '#64748b';

export interface StepSitesProps {
  sites: GridSite[];
  dispatch: Dispatch<WizardAction>;
}

export default function StepSites({ sites, dispatch }: StepSitesProps) {
  const usedPresetKeys = new Set(
    sites.map((s) => s.name.toLowerCase().replace(/\s+/g, '')),
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* ── Quick add presets ──────────────────────────────────────────── */}
      <Panel>
        <Header
          title="Quick-add common sites"
          subtitle="Click any preset to drop it in with sensible defaults — name, icon, color, and room count are all editable below."
        />
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
            gap: 10,
          }}
        >
          {SITE_PRESETS.map((preset) => {
            const alreadyAdded = usedPresetKeys.has(
              preset.name.toLowerCase().replace(/\s+/g, ''),
            );
            return (
              <PresetButton
                key={preset.key}
                preset={preset}
                disabled={alreadyAdded}
                onClick={() => {
                  const site = buildSiteFromPreset(preset, sites.length);
                  dispatch({ type: 'addSite', site });
                }}
              />
            );
          })}
        </div>
      </Panel>

      {/* ── Custom site form ──────────────────────────────────────────── */}
      <Panel>
        <Header
          title="Add a custom site"
          subtitle="For anything not in the preset list (Cath, IR, Robotics, Pre-Op, PACU, etc.). The icon may be an emoji or a lucide-react icon name."
        />
        <CustomSiteForm
          onAdd={(init) => {
            const site = buildCustomSite(sites.length, init);
            dispatch({ type: 'addSite', site });
          }}
        />
      </Panel>

      {/* ── Added sites list ─────────────────────────────────────────── */}
      <Panel>
        <Header
          title={`Sites added (${sites.length})`}
          subtitle="Add at least one room per site to advance. You can rename, swap colors, and reorder rooms inline."
        />
        {sites.length === 0 && (
          <div
            style={{
              padding: '20px 12px',
              color: SLATE,
              fontStyle: 'italic',
              fontSize: 12,
              textAlign: 'center',
            }}
          >
            No sites yet. Pick a preset above or add a custom site to start.
          </div>
        )}
        {sites
          .slice()
          .sort((a, b) => a.position - b.position)
          .map((site) => (
            <SiteRow key={site.id} site={site} dispatch={dispatch} />
          ))}
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preset button — square tile with icon + name + default room count.
// ---------------------------------------------------------------------------

function PresetButton({
  preset,
  disabled,
  onClick,
}: {
  preset: SitePreset;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? 'Already added' : `Quick-add ${preset.name}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 4,
        padding: '10px 12px',
        background: disabled ? 'var(--bg-surface)' : 'var(--bg-base)',
        border: `1px solid ${hexA(preset.color, 0.35)}`,
        borderLeft: `3px solid ${preset.color}`,
        borderRadius: 8,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        textAlign: 'left',
        fontFamily: 'inherit',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span
          style={{
            display: 'inline-flex',
            width: 22,
            height: 22,
            borderRadius: 5,
            background: hexA(preset.color, 0.14),
            color: preset.color,
            border: `1px solid ${hexA(preset.color, 0.35)}`,
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 12,
            fontWeight: 700,
          }}
        >
          {preset.icon}
        </span>
        <span
          style={{
            fontSize: 12,
            fontWeight: 700,
            color: 'var(--text-strong)',
          }}
        >
          {preset.name}
        </span>
      </div>
      <span
        style={{
          fontSize: 10,
          color: SLATE,
          fontFamily: 'var(--font-mono), ui-monospace, monospace',
        }}
      >
        {preset.defaultRoomCount} room
        {preset.defaultRoomCount === 1 ? '' : 's'}
        {preset.caption ? ` · ${preset.caption}` : ''}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Custom site form — small inline form. Local state only; on submit it
// dispatches and resets.
// ---------------------------------------------------------------------------

function CustomSiteForm({
  onAdd,
}: {
  onAdd: (init: { name: string; icon: string; color: string; roomCount: number }) => void;
}) {
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('◈');
  const [color, setColor] = useState(SITE_COLOR_PALETTE[0]?.hex ?? '#0ea5e9');
  const [roomCount, setRoomCount] = useState(1);

  function reset() {
    setName('');
    setIcon('◈');
    setColor(SITE_COLOR_PALETTE[0]?.hex ?? '#0ea5e9');
    setRoomCount(1);
  }

  function submit() {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    onAdd({ name: trimmed, icon: icon.trim() || '◈', color, roomCount });
    reset();
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '2fr 1fr 1fr 1fr auto',
        gap: 8,
        alignItems: 'end',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <FieldLabel>Site name</FieldLabel>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Cath Lab"
          style={inputStyle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <FieldLabel>Icon</FieldLabel>
        <input
          type="text"
          value={icon}
          onChange={(e) => setIcon(e.target.value)}
          placeholder="🩺 / HeartPulse"
          style={inputStyle}
          maxLength={32}
        />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <FieldLabel>Color</FieldLabel>
        <ColorPicker value={color} onChange={setColor} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <FieldLabel>Rooms</FieldLabel>
        <input
          type="number"
          min={0}
          max={32}
          value={roomCount}
          onChange={(e) => setRoomCount(Math.max(0, Number(e.target.value) || 0))}
          style={inputStyle}
        />
      </div>
      <button
        type="button"
        onClick={submit}
        disabled={name.trim().length === 0}
        style={primaryButtonStyle(name.trim().length === 0)}
      >
        + Add site
      </button>
    </div>
  );
}

function ColorPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
      {SITE_COLOR_PALETTE.map((c) => {
        const active = c.hex.toLowerCase() === value.toLowerCase();
        return (
          <button
            key={c.hex}
            type="button"
            onClick={() => onChange(c.hex)}
            title={c.name}
            aria-label={`Color ${c.name}`}
            aria-pressed={active}
            style={{
              width: 20,
              height: 20,
              borderRadius: '50%',
              background: c.hex,
              border: active ? `2px solid var(--text-strong)` : '1px solid var(--border)',
              cursor: 'pointer',
              padding: 0,
            }}
          />
        );
      })}
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        title="Custom color"
        style={{
          width: 24,
          height: 24,
          padding: 0,
          border: '1px solid var(--border)',
          borderRadius: 4,
          background: 'transparent',
          cursor: 'pointer',
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Added site row — inline edit (name + room manager).
// ---------------------------------------------------------------------------

function SiteRow({ site, dispatch }: { site: GridSite; dispatch: Dispatch<WizardAction> }) {
  const [expanded, setExpanded] = useState(false);
  const [newRoomName, setNewRoomName] = useState('');

  function commitNewRoom() {
    const trimmed = newRoomName.trim();
    if (trimmed.length === 0) return;
    dispatch({ type: 'addRoom', siteId: site.id, name: trimmed });
    setNewRoomName('');
  }

  return (
    <div
      style={{
        marginBottom: 8,
        border: '1px solid var(--border)',
        borderLeft: `3px solid ${site.color}`,
        borderRadius: 8,
        background: 'var(--bg-surface)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 10 }}>
        <span
          style={{
            display: 'inline-flex',
            width: 26,
            height: 26,
            borderRadius: 6,
            background: hexA(site.color, 0.14),
            color: site.color,
            border: `1px solid ${hexA(site.color, 0.35)}`,
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 13,
            fontWeight: 700,
          }}
        >
          {site.icon}
        </span>
        <input
          type="text"
          value={site.name}
          onChange={(e) =>
            dispatch({ type: 'updateSite', siteId: site.id, patch: { name: e.target.value } })
          }
          style={{
            ...inputStyle,
            flex: 1,
            fontSize: 13,
            fontWeight: 700,
            padding: '4px 8px',
          }}
        />
        <ColorPicker
          value={site.color}
          onChange={(hex) =>
            dispatch({ type: 'updateSite', siteId: site.id, patch: { color: hex } })
          }
        />
        <span
          style={{
            fontSize: 10,
            color: SLATE,
            fontFamily: 'var(--font-mono), ui-monospace, monospace',
            minWidth: 50,
            textAlign: 'right',
          }}
        >
          {site.rooms.length} room{site.rooms.length === 1 ? '' : 's'}
        </span>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={ghostButtonStyle()}
          aria-expanded={expanded}
        >
          {expanded ? 'Collapse' : 'Edit rooms'}
        </button>
        <button
          type="button"
          onClick={() => {
            if (
              typeof window !== 'undefined' &&
              !window.confirm(`Remove "${site.name}" and its rooms?`)
            ) {
              return;
            }
            dispatch({ type: 'removeSite', siteId: site.id });
          }}
          style={{
            ...ghostButtonStyle(),
            color: '#ef4444',
            borderColor: 'rgba(239,68,68,0.35)',
          }}
          title="Remove site"
        >
          Remove
        </button>
      </div>

      {expanded && (
        <div
          style={{
            padding: '0 12px 12px 48px',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          {site.rooms
            .slice()
            .sort((a, b) => a.position - b.position)
            .map((room) => (
              <div
                key={room.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: site.color,
                  }}
                />
                <input
                  type="text"
                  value={room.name}
                  onChange={(e) =>
                    dispatch({
                      type: 'renameRoom',
                      siteId: site.id,
                      roomId: room.id,
                      name: e.target.value,
                    })
                  }
                  style={{
                    ...inputStyle,
                    flex: 1,
                    fontSize: 12,
                    padding: '4px 8px',
                  }}
                />
                <button
                  type="button"
                  onClick={() =>
                    dispatch({ type: 'removeRoom', siteId: site.id, roomId: room.id })
                  }
                  style={{
                    ...ghostButtonStyle(),
                    color: '#ef4444',
                    borderColor: 'rgba(239,68,68,0.35)',
                  }}
                  title="Remove room"
                >
                  ×
                </button>
              </div>
            ))}
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <input
              type="text"
              value={newRoomName}
              onChange={(e) => setNewRoomName(e.target.value)}
              placeholder={`e.g. ${site.shortName ?? site.name} ${site.rooms.length + 1}`}
              style={{ ...inputStyle, flex: 1, padding: '4px 8px', fontSize: 12 }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitNewRoom();
              }}
            />
            <button
              type="button"
              onClick={commitNewRoom}
              disabled={newRoomName.trim().length === 0}
              style={primaryButtonStyle(newRoomName.trim().length === 0)}
            >
              + Room
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Local UI helpers — kept inline so the file stays self-contained.
// ---------------------------------------------------------------------------

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
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
          fontSize: 13,
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

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        color: 'var(--text-strong)',
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        fontFamily: 'var(--font-mono), ui-monospace, monospace',
      }}
    >
      {children}
    </span>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 10px',
  fontSize: 12,
  fontFamily: 'inherit',
  border: '1px solid var(--border)',
  borderRadius: 6,
  background: 'var(--bg-base)',
  color: 'var(--text)',
  outline: 'none',
};

function primaryButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    height: 32,
    padding: '0 12px',
    fontSize: 11,
    fontWeight: 700,
    borderRadius: 6,
    background: disabled ? '#cbd5e1' : CYAN,
    color: 'white',
    border: `1px solid ${disabled ? '#cbd5e1' : CYAN}`,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.6 : 1,
    fontFamily: 'inherit',
  };
}

function ghostButtonStyle(): React.CSSProperties {
  return {
    height: 28,
    padding: '0 10px',
    fontSize: 10,
    fontWeight: 700,
    borderRadius: 6,
    background: 'transparent',
    color: SLATE,
    border: '1px solid var(--border)',
    cursor: 'pointer',
    fontFamily: 'inherit',
  };
}

function hexA(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(100,116,139,${alpha})`;
  const v = parseInt(m[1], 16);
  const r = (v >> 16) & 0xff;
  const g = (v >> 8) & 0xff;
  const b = v & 0xff;
  return `rgba(${r},${g},${b},${alpha})`;
}
