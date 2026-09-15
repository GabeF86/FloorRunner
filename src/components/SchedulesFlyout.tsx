'use client';

// The Schedules nav item, with the site list revealed on hover.
//
// ── HOVER IS NOT THE ONLY TRIGGER, DELIBERATELY ────────────────────────────
// Gabriel asked for hover, and hover is what it does with a mouse. But a
// hover-only menu is unreachable by keyboard and unusable on a touch screen,
// where there is no hover state at all — and this app is used on an iPad at
// the OR desk. So the same panel opens on focus-within and on a click of the
// chevron, and closes on Escape. The mouse behaviour is unchanged by any of
// that.
//
// The parent item stays a real link: clicking "Schedules" goes to the list
// page as it always did. Only the chevron toggles.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useOrgAndSites } from '@/components/useOrgAndSites';

interface Props {
  collapsed: boolean;
  itemStyle: (active: boolean) => React.CSSProperties;
}

const HREF = '/schedules';

export function SchedulesFlyout({ collapsed, itemStyle }: Props) {
  const pathname = usePathname();
  const { sites, error, sitesLoaded } = useOrgAndSites();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);

  const active = pathname === HREF || pathname.startsWith(HREF + '/')
    || pathname.startsWith('/dashboard/');

  // A small close delay: without it, the few pixels between the nav item and
  // the panel count as a mouse-out and the panel vanishes mid-reach.
  const openNow = () => {
    if (closeTimer.current) { window.clearTimeout(closeTimer.current); closeTimer.current = null; }
    setOpen(true);
  };
  const closeSoon = () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), 180);
  };

  useEffect(() => () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
  }, []);

  // Close when focus or the pointer leaves the whole group, and on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  // Navigating closes it — otherwise the panel hangs over the page you just
  // asked for.
  useEffect(() => { setOpen(false); }, [pathname]);

  return (
    <div
      ref={wrap}
      style={{ position: 'relative' }}
      onMouseEnter={openNow}
      onMouseLeave={closeSoon}
      onFocus={openNow}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) closeSoon(); }}
    >
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <Link
          href={HREF}
          className="fr-focus"
          title={collapsed ? 'Schedules' : undefined}
          style={{ ...itemStyle(active), flex: 1, minWidth: 0 }}
        >
          <span style={{ fontSize: 16, width: 20, textAlign: 'center' }}>▦</span>
          {!collapsed && 'Schedules'}
        </Link>
        {!collapsed && (
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? 'Hide sites' : 'Show sites'}
            onClick={() => setOpen(o => !o)}
            className="fr-focus"
            style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: '4px 6px',
              color: active ? 'var(--blue)' : 'var(--text-dim)', fontSize: 11, lineHeight: 1,
              transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s',
            }}
          >
            ▸
          </button>
        )}
      </div>

      {open && (
        <div
          role="menu"
          aria-label="Site dashboards"
          style={{
            position: 'absolute',
            left: collapsed ? 'calc(100% + 6px)' : 'var(--space-2)',
            top: collapsed ? 0 : '100%',
            minWidth: 208,
            zIndex: 400,
            marginTop: collapsed ? 0 : 4,
            padding: 'var(--space-2)',
            background: 'var(--bg-popover)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-popover)',
          }}
        >
          <div style={{
            fontSize: 'var(--fs-xs)', textTransform: 'uppercase', letterSpacing: 1,
            color: 'var(--text-dim)', fontWeight: 700, padding: '2px var(--space-2) 6px',
          }}>
            Site dashboards
          </div>

          {/* Three distinguishable states. An outright failure must never read
              as "this group has no sites". */}
          {error ? (
            <div style={noteStyle}>Sites could not be loaded.</div>
          ) : !sitesLoaded ? (
            <div style={noteStyle}>Loading sites…</div>
          ) : sites.length === 0 ? (
            <div style={noteStyle}>No sites configured yet.</div>
          ) : (
            sites.map(s => {
              const href = `/dashboard/${s.id}`;
              const on = pathname === href;
              return (
                <Link
                  key={s.id}
                  href={href}
                  role="menuitem"
                  className="fr-focus"
                  style={{
                    display: 'block', padding: '7px var(--space-2)', borderRadius: 'var(--radius-sm)',
                    fontSize: 13, fontWeight: 600, textDecoration: 'none',
                    color: on ? 'var(--blue)' : 'var(--text-muted)',
                    background: on ? 'color-mix(in srgb, var(--blue) 10%, transparent)' : 'transparent',
                  }}
                >
                  {s.short_name ? `${s.short_name} — ${s.name}` : s.name}
                </Link>
              );
            })
          )}

          <div style={{ borderTop: '1px solid var(--border-faint)', marginTop: 6, paddingTop: 6 }}>
            <Link
              href="/dashboard"
              role="menuitem"
              className="fr-focus"
              style={{
                display: 'block', padding: '7px var(--space-2)', borderRadius: 'var(--radius-sm)',
                fontSize: 13, fontWeight: 600, textDecoration: 'none', color: 'var(--text-muted)',
              }}
            >
              All sites (UAS)
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

const noteStyle: React.CSSProperties = {
  padding: '7px var(--space-2)', fontSize: 'var(--fs-sm)', color: 'var(--text-dim)',
};
