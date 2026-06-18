'use client';

// Sites & Rooms panel — lives in the left config rail of the Grid Calculator.
// Lets the user add sites + add rooms within a site. Each mutation propagates
// up to GridCanvas, which re-derives the roster/edges/rules and re-solves.
//
// Visual language mirrors staffing-calculator's premium card pattern so the
// panel reads as native to the platform.

import { useState } from 'react';

import type { GridSite } from '@/lib/gridCalculator/types';

// Shared token object — mirrors the one in GridCanvas.tsx.
const tok = {
  card: 'var(--bg-surface)',
  surface: 'var(--bg-deep)',
  border: 'var(--border)',
  text: 'var(--text)',
  textMuted: 'var(--text-muted)',
  textDim: 'var(--text-dim)',
  mono: 'var(--font-mono), ui-monospace, monospace',
  accent: '#0284c7',
  radius: 14,
  shadow: '0 1px 2px rgba(15,23,42,0.05), 0 10px 28px -16px rgba(15,23,42,0.18)',
};

// Palette cycled through when adding sites — avoids the user having to pick.
const SITE_COLOR_PALETTE = [
  '#0ea5e9', // sky
  '#a855f7', // purple
  '#f59e0b', // amber
  '#10b981', // emerald
  '#f43f5e', // rose
  '#8b5cf6', // violet
  '#06b6d4', // cyan
  '#84cc16', // lime
];

const SITE_ICON_FALLBACK = '⬡';

export interface SitesPanelProps {
  sites: GridSite[];
  onAddSite: (name: string) => void;
  onAddRoom: (siteId: string, roomName: string) => void;
  onDeleteSite?: (siteId: string) => void;
  onDeleteRoom?: (siteId: string, roomId: string) => void;
}

export default function SitesPanel({
  sites,
  onAddSite,
  onAddRoom,
  onDeleteSite,
  onDeleteRoom,
}: SitesPanelProps) {
  const [addingSite, setAddingSite] = useState(false);
  const [newSiteName, setNewSiteName] = useState('');
  const [addingRoomFor, setAddingRoomFor] = useState<string | null>(null);
  const [newRoomName, setNewRoomName] = useState('');

  const totalRooms = sites.reduce((n, s) => n + s.rooms.length, 0);

  const submitSite = () => {
    const trimmed = newSiteName.trim();
    if (trimmed.length === 0) return;
    onAddSite(trimmed);
    setNewSiteName('');
    setAddingSite(false);
  };

  const submitRoom = (siteId: string) => {
    const trimmed = newRoomName.trim();
    if (trimmed.length === 0) return;
    onAddRoom(siteId, trimmed);
    setNewRoomName('');
    setAddingRoomFor(null);
  };

  return (
    <div
      style={{
        background: tok.card,
        border: '1px solid var(--border)',
        borderRadius: tok.radius,
        boxShadow: tok.shadow,
        padding: '18px 20px',
      }}
    >
      <div
        style={{
          fontSize: 13.5,
          fontWeight: 650,
          color: tok.text,
          letterSpacing: -0.15,
          paddingBottom: 10,
          marginBottom: 14,
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span>⬡ Sites &amp; rooms</span>
        <span
          style={{
            marginLeft: 'auto',
            fontSize: 9,
            fontFamily: tok.mono,
            color: tok.textDim,
            fontWeight: 600,
          }}
        >
          {sites.length}S · {totalRooms}R
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {sites
          .slice()
          .sort((a, b) => a.position - b.position)
          .map((site) => (
            <SiteRow
              key={site.id}
              site={site}
              adding={addingRoomFor === site.id}
              draft={newRoomName}
              onDraftChange={setNewRoomName}
              onStartAdd={() => {
                setAddingRoomFor(site.id);
                setNewRoomName('');
              }}
              onCancelAdd={() => {
                setAddingRoomFor(null);
                setNewRoomName('');
              }}
              onSubmit={() => submitRoom(site.id)}
              onDeleteRoom={onDeleteRoom}
              onDeleteSite={onDeleteSite}
            />
          ))}
      </div>

      <div style={{ marginTop: 14 }}>
        {addingSite ? (
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              autoFocus
              value={newSiteName}
              onChange={(e) => setNewSiteName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitSite();
                if (e.key === 'Escape') {
                  setAddingSite(false);
                  setNewSiteName('');
                }
              }}
              placeholder="Site name (e.g. Cath Lab)"
              style={{
                flex: 1,
                padding: '6px 10px',
                borderRadius: 8,
                border: `1px solid ${tok.accent}`,
                background: tok.surface,
                color: tok.text,
                fontSize: 12,
                outline: 'none',
              }}
            />
            <button
              type="button"
              onClick={submitSite}
              style={{
                padding: '6px 12px',
                borderRadius: 8,
                border: `1px solid ${tok.accent}`,
                background: tok.accent,
                color: '#fff',
                fontSize: 11,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              Add
            </button>
            <button
              type="button"
              onClick={() => {
                setAddingSite(false);
                setNewSiteName('');
              }}
              style={{
                padding: '6px 10px',
                borderRadius: 8,
                border: `1px solid ${tok.border}`,
                background: 'transparent',
                color: tok.textMuted,
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              ✕
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAddingSite(true)}
            style={{
              width: '100%',
              padding: '8px 12px',
              borderRadius: 8,
              border: `1px dashed ${tok.accent}`,
              background: 'rgba(2,132,199,0.06)',
              color: tok.accent,
              fontSize: 12,
              fontWeight: 700,
              cursor: 'pointer',
              transition: 'background 0.12s',
            }}
          >
            + Add site
          </button>
        )}
      </div>
    </div>
  );
}

interface SiteRowProps {
  site: GridSite;
  adding: boolean;
  draft: string;
  onDraftChange: (v: string) => void;
  onStartAdd: () => void;
  onCancelAdd: () => void;
  onSubmit: () => void;
  onDeleteRoom?: (siteId: string, roomId: string) => void;
  onDeleteSite?: (siteId: string) => void;
}

function SiteRow({
  site,
  adding,
  draft,
  onDraftChange,
  onStartAdd,
  onCancelAdd,
  onSubmit,
  onDeleteRoom,
  onDeleteSite,
}: SiteRowProps) {
  const accent = site.color || tok.accent;
  return (
    <div
      style={{
        borderLeft: `2px solid ${accent}`,
        paddingLeft: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 12 }}>{site.icon || SITE_ICON_FALLBACK}</span>
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: accent,
            letterSpacing: 0.1,
          }}
        >
          {site.name}
        </span>
        <span
          style={{
            fontSize: 9,
            fontFamily: tok.mono,
            color: tok.textDim,
            fontWeight: 600,
          }}
        >
          {site.rooms.length}R
        </span>
        {onDeleteSite && (
          <button
            type="button"
            onClick={() => onDeleteSite(site.id)}
            title={`Remove ${site.name}`}
            style={{
              marginLeft: 'auto',
              background: 'transparent',
              border: 'none',
              color: tok.textDim,
              fontSize: 12,
              cursor: 'pointer',
              padding: '0 4px',
              lineHeight: 1,
            }}
          >
            ×
          </button>
        )}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {site.rooms
          .slice()
          .sort((a, b) => a.position - b.position)
          .map((room) => (
            <span
              key={room.id}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '2px 8px',
                borderRadius: 999,
                background: tok.surface,
                border: `1px solid ${tok.border}`,
                fontSize: 10,
                color: tok.text,
                fontFamily: tok.mono,
              }}
            >
              {room.name}
              {onDeleteRoom && (
                <button
                  type="button"
                  onClick={() => onDeleteRoom(site.id, room.id)}
                  title={`Remove ${room.name}`}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: tok.textDim,
                    fontSize: 11,
                    cursor: 'pointer',
                    padding: 0,
                    lineHeight: 1,
                  }}
                >
                  ×
                </button>
              )}
            </span>
          ))}

        {adding ? (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <input
              autoFocus
              value={draft}
              onChange={(e) => onDraftChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onSubmit();
                if (e.key === 'Escape') onCancelAdd();
              }}
              placeholder="Room name"
              style={{
                width: 110,
                padding: '2px 8px',
                borderRadius: 999,
                border: `1px solid ${accent}`,
                background: tok.surface,
                color: tok.text,
                fontSize: 10,
                fontFamily: tok.mono,
                outline: 'none',
              }}
            />
            <button
              type="button"
              onClick={onSubmit}
              style={{
                background: accent,
                color: '#fff',
                border: 'none',
                padding: '2px 8px',
                borderRadius: 999,
                fontSize: 10,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              ↵
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={onStartAdd}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              padding: '2px 8px',
              borderRadius: 999,
              border: `1px dashed ${accent}`,
              background: 'transparent',
              color: accent,
              fontSize: 10,
              fontWeight: 700,
              cursor: 'pointer',
              fontFamily: tok.mono,
            }}
          >
            + Room
          </button>
        )}
      </div>
    </div>
  );
}

// Exported for GridCanvas to use when constructing a new site so the colors
// cycle deterministically rather than picking randomly per click.
export function pickSiteColor(index: number): string {
  return SITE_COLOR_PALETTE[index % SITE_COLOR_PALETTE.length];
}
