'use client';

// The Schedules nav row and the panel of locations it opens.
//
// ── WHAT THIS PANEL HOLDS (Gabriel 2026-09-22) ─────────────────────────────
// The per-site entries here used to link to each site's DASHBOARD, because
// this row was a flyout and Dashboard was a plain link — so reaching Paoli's
// dashboard meant opening a menu called Schedules. The dashboards now live
// under DashboardFlyout, where they are named, and the site list here stayed:
// it points at each site's SCHEDULES, which is what the row says.
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
import { useOrgAndSites } from '@/components/useOrgAndSites';

interface Props {
  collapsed: boolean;
}

const HREF = '/schedules';

export function SchedulesFlyout({ collapsed }: Props) {
  const pathname = usePathname();
  const { sites, error, sitesLoaded } = useOrgAndSites();
  // Which site the page is currently filtered to, for the highlight.
  //
  // NOT useSearchParams: this component sits inside AppShell, so it renders on
  // EVERY page, and that hook opts every static page out of prerendering —
  // /requests, /reports, /staffing-calculator and /grid-calculator/print all
  // failed to prerender when it was used here. The build still reported
  // "compiled successfully", which is exactly how it would have shipped.
  //
  // Read from the address bar instead, when the panel opens. It is only needed
  // to bold one row, it costs no hook, and a stale value between renders is
  // invisible because the panel closes on navigation anyway.
  const [activeSite, setActiveSite] = useState('');
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

  // Refreshed each time the panel opens, which is the only moment it is read.
  useEffect(() => {
    if (!open) return;
    setActiveSite(new URLSearchParams(window.location.search).get('site_id') ?? '');
  }, [open]);

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

          <div style={{
            fontSize: 'var(--fs-xs)', textTransform: 'uppercase', letterSpacing: 1,
            color: 'var(--text-dim)', fontWeight: 700,
            padding: '10px var(--space-2) 6px',
          }}>
            Master
          </div>

          {/* Every site's published assignments in one document, one per
              discipline. Open to everybody signed in: they are built from
              published schedules only, which is exactly what a provider may
              already see. */}
          {([['physician', 'Physicians'], ['crna', 'CRNAs']] as const).map(([g, label]) => {
            const href = `/schedules/master/${g}`;
            return (
              <Link key={g} href={href} role="menuitem" className="fr-nav-sub fr-focus"
                    data-active={pathname === href}>
                {label}
              </Link>
            );
          })}

          <div style={{
            fontSize: 'var(--fs-xs)', textTransform: 'uppercase', letterSpacing: 1,
            color: 'var(--text-dim)', fontWeight: 700,
            padding: '10px var(--space-2) 6px',
          }}>
            By site
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
              const href = `${HREF}?site_id=${s.id}`;
              return (
                <Link
                  key={s.id}
                  href={href}
                  role="menuitem"
                  className="fr-nav-sub fr-focus"
                  data-active={pathname === HREF && activeSite === s.id}
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
