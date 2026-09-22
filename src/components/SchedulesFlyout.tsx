'use client';

// The Schedules nav row and the panel of locations it opens.
//
// ── THE SITE DASHBOARDS MOVED OUT (Gabriel 2026-09-22) ─────────────────────
// This panel used to carry every per-site dashboard, because this row was a
// flyout and Dashboard was a plain link — so reaching Paoli's dashboard meant
// opening a menu called Schedules. They now live under DashboardFlyout, where
// they are named. This row holds schedules.
//
// ── CLICK, NOT HOVER (Gabriel 2026-09-16) ──────────────────────────────────
// It used to open on hover. It no longer does: the row is a BUTTON and the
// panel opens only when you click it. A hover menu on the primary nav opens
// itself while you are on the way somewhere else, and it is unreachable on the
// iPad at the OR desk, where there is no hover state at all.
//
// The consequence of making the row a button is that it can no longer navigate
// — so the schedules list page moved INTO the panel, as its first entry. Every
// destination that used to be reachable from this row still is; it now takes
// one deliberate click rather than an accidental one.
//
// Escape closes it, a click outside closes it, and navigating closes it.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface Props {
  collapsed: boolean;
}

const HREF = '/schedules';

export function SchedulesFlyout({ collapsed }: Props) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  // No longer claims /dashboard: that row is its own flyout now, and two nav
  // rows lit at once says the page belongs to both.
  const active = pathname === HREF || pathname.startsWith(HREF + '/');

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
    <div ref={wrap} style={{ position: 'relative' }}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen(o => !o)}
        className="fr-nav-item fr-focus"
        data-active={active}
        data-collapsed={collapsed}
        title={collapsed ? 'Schedules' : undefined}
      >
        {collapsed ? 'SCHD' : 'Schedules'}
        {!collapsed && <span aria-hidden="true" className="fr-nav-caret">▸</span>}
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Schedules and site dashboards"
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
          {/* The row is no longer a link, so the list page lives here. First,
              because it is what "Schedules" meant before. */}
          <Link href={HREF} role="menuitem" className="fr-nav-sub fr-focus"
                data-active={pathname === HREF}>
            All schedules
          </Link>

        </div>
      )}
    </div>
  );
}

