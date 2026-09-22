'use client';

// The Dashboard nav row and the panel of dashboards it opens.
//
// ── WHY THIS EXISTS (Gabriel 2026-09-22) ───────────────────────────────────
// The per-site dashboards used to live under SCHEDULES, because that row was
// already a flyout and this one was a plain link. That put every dashboard one
// menu away from the word that does not describe it — you opened "Schedules"
// to reach Paoli's dashboard. They now sit under Dashboard, where they are
// named, and Schedules is left holding schedules.
//
// ── UAS MASTER IS ADMIN-ONLY, AND THAT IS ENFORCED ELSEWHERE ───────────────
// The whole-group roll-up is hidden here for anyone who is not an admin. That
// is a courtesy, not a control: the URL is guessable. The real gate is
// ADMIN_EXACT in routeAccess.ts — '/dashboard' exactly is admin, while
// '/dashboard/<siteId>' stays on the staff list.
//
// Behaviour copied deliberately from SchedulesFlyout so the two rows are one
// control with two labels: CLICK not hover (a hover menu on the primary nav
// opens itself on the way past, and there is no hover state at all on the iPad
// at the OR desk). Escape closes it, a click outside closes it, navigating
// closes it.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useOrgAndSites } from '@/components/useOrgAndSites';
import { useSessionRole } from '@/components/useSessionRole';

interface Props {
  collapsed: boolean;
}

const HREF = '/dashboard';

export function DashboardFlyout({ collapsed }: Props) {
  const pathname = usePathname();
  const { sites, error, sitesLoaded } = useOrgAndSites();
  const { role, loaded: roleLoaded } = useSessionRole();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

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
        title={collapsed ? 'Dashboard' : undefined}
      >
        {collapsed ? 'DASH' : 'Dashboard'}
        {!collapsed && <span aria-hidden="true" className="fr-nav-caret">▸</span>}
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Dashboards"
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
          {/* Admins only. Withheld until the role is known rather than shown
              optimistically — offering a link and then 403-ing is worse than
              a menu that settles a moment later. */}
          {roleLoaded && role === 'admin' && (
            <>
              <Link href={HREF} role="menuitem" className="fr-nav-sub fr-focus"
                    data-active={pathname === HREF}>
                UAS Master — all sites
              </Link>
              <div style={{
                borderTop: '1px solid var(--border-faint)',
                marginTop: 6, paddingTop: 6,
              }} />
            </>
          )}

          <div style={{
            fontSize: 'var(--fs-xs)', textTransform: 'uppercase', letterSpacing: 1,
            color: 'var(--text-dim)', fontWeight: 700,
            padding: '4px var(--space-2) 6px',
          }}>
            Sites
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
              const href = `${HREF}/${s.id}`;
              return (
                <Link
                  key={s.id}
                  href={href}
                  role="menuitem"
                  className="fr-nav-sub fr-focus"
                  data-active={pathname === href}
                >
                  {s.short_name ? `${s.short_name} — ${s.name}` : s.name}
                </Link>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

const noteStyle: React.CSSProperties = {
  padding: '7px var(--space-2)', fontSize: 'var(--fs-sm)', color: 'var(--text-dim)',
};
