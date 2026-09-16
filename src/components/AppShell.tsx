'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui';
import { SignOutButton } from '@/components/SignOutButton';
import { SchedulesFlyout } from '@/components/SchedulesFlyout';

interface NavItem {
  href: string;
  label: string;
  /** Shown in the collapsed rail in place of the label. A short mono
   *  abbreviation of the word itself — readable without a legend, unlike the
   *  glyphs it replaced (2026-09-16). */
  abbr: string;
}
interface NavSection { label: string; items: NavItem[] }

const NAV_SECTIONS: NavSection[] = [
  {
    label: 'Overview',
    items: [{ href: '/dashboard', label: 'Dashboard', abbr: 'DASH' }],
  },
  {
    label: 'Scheduling',
    items: [
      { href: '/schedules', label: 'Schedules', abbr: 'SCHD' },
      { href: '/providers', label: 'Providers', abbr: 'PROV' },
      { href: '/sites',     label: 'Sites',     abbr: 'SITE' },
    ],
  },
  {
    label: 'Staffing',
    items: [
      { href: '/staffing-calculator', label: 'Staffing Calculator', abbr: 'STAF' },
      { href: '/grid-calculator',     label: 'Grid Calculator',     abbr: 'GRID' },
    ],
  },
  {
    label: 'Operations',
    items: [
      // Ahead of the board deliberately: the staffing picture is the thing
      // back office opens first, and the board is what the runner opens.
      { href: '/operations', label: 'Staffing Board', abbr: 'BOARD' },
      { href: '/operations/handbook', label: 'Group Handbook', abbr: 'HAND' },
      { href: '/board', label: 'Floor Runner', abbr: 'RUN' },
    ],
  },
  {
    // Block Prep, Rules and Requests moved here from Scheduling (Gabriel
    // 2026-09-15). They are the things you configure AROUND a generation
    // cycle rather than the schedule itself, which leaves Scheduling as the
    // three nouns you actually work in day to day.
    label: 'Settings',
    items: [
      { href: '/settings',   label: 'Settings',   abbr: 'SET' },
      { href: '/block-prep', label: 'Block Prep', abbr: 'PREP' },
      // Renamed from "Rules" 2026-09-15. The page now leads with the live
      // generation contract — what the engine actually obeys — and the
      // validation rule sets sit below it. Calling it Rules pointed at the one
      // thing on the page the engine never reads.
      { href: '/rules',      label: 'Scheduling Logic', abbr: 'LOGIC' },
      { href: '/requests',   label: 'Requests',   abbr: 'REQ' },
    ],
  },
];

/**
 * Theme contract — mirrors the root layout's pre-hydration init script:
 *   localStorage key 'theme', values 'light' | 'dark',
 *   applied as data-theme on document.documentElement.
 * No attribute (and no stored value) means the :root default (light), so the
 * initial state below is 'light' to match SSR / the pre-paint script and avoid
 * a hydration mismatch on the footer toggle label.
 */
function useTheme() {
  const [theme, setTheme] = useState<'dark' | 'light'>('light');

  useEffect(() => {
    try {
      const t = localStorage.getItem('theme');
      if (t === 'light' || t === 'dark') setTheme(t);
    } catch {}
  }, []);

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('theme', next); } catch {}
      document.documentElement.setAttribute('data-theme', next);
      return next;
    });
  }, []);

  return { theme, toggle };
}

/**
 * Sidebar collapse → slim icon rail, persisted under localStorage
 * 'appSidebarCollapsed'. Initial state is expanded (false) and the saved value
 * is read in a mount effect — this mirrors the /board sidebar so the server and
 * first client render agree (no hydration mismatch); a saved-collapsed user sees
 * one expand→collapse settle on load, same as the board.
 *
 * Deliberately NO keyboard shortcut. The /board page binds ⌘B to its OWN
 * sidebar, and this app shell is on screen at the same time there, so a shared
 * ⌘B would toggle both rails at once. Button-only avoids the clash.
 */
function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try { const v = localStorage.getItem('appSidebarCollapsed'); if (v) setCollapsed(v === 'true'); } catch {}
  }, []);

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem('appSidebarCollapsed', String(next)); } catch {}
      return next;
    });
  }, []);

  return { collapsed, toggle };
}

const FULL_W = 220;
const RAIL_W = 60;

// Square utility button used for the ≡ collapse control and the collapsed
// theme toggle — visible on both themes (surface fill + border over the sidebar).
const railBtnStyle: React.CSSProperties = {
  width: 32, height: 32, borderRadius: 8, flexShrink: 0,
  background: 'var(--bg-surface)', border: '1px solid var(--border)',
  color: 'var(--text-muted)', cursor: 'pointer', fontSize: 15, lineHeight: 1,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};
const RAIL_BTN_CLASS = 'fr-focus fr-btn fr-btn-secondary';

export default function AppShell({ fullBleed, children }: { fullBleed?: boolean; children: React.ReactNode }) {
  const pathname = usePathname();
  const { theme, toggle } = useTheme();
  const { collapsed, toggle: toggleCollapsed } = useSidebarCollapsed();

  // The schedule detail route (`/schedules/<id>`) renders full-bleed so the grid
  // gets the full viewport width and a clean height:100% chain. The `/schedules`
  // list (no trailing slash) stays boxed. An explicit `fullBleed` from a
  // consumer (e.g. /board's layout) still wins over this default.
  const effectiveFullBleed = fullBleed ?? pathname.startsWith('/schedules/');

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: 'var(--bg-base)', color: 'var(--text)' }}>
      {/* Sidebar — full pane or slim icon rail when collapsed */}
      <nav style={{
        width: collapsed ? RAIL_W : FULL_W, flexShrink: 0, background: 'var(--bg-sidebar)',
        borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column',
        padding: 'var(--space-4) 0', overflowX: 'hidden',
        transition: 'width var(--dur-slow) var(--ease-out)',
      }}>
        {/* Logo / collapse control */}
        <div style={{
          padding: collapsed ? '0 0 var(--space-4)' : '0 var(--space-5) var(--space-5)',
          borderBottom: '1px solid var(--border)', marginBottom: 'var(--space-2)',
          display: 'flex', alignItems: collapsed ? 'center' : 'flex-start',
          justifyContent: collapsed ? 'center' : 'space-between', gap: 'var(--space-2)',
        }}>
          {collapsed ? (
            <button onClick={toggleCollapsed} title="Expand sidebar" className={RAIL_BTN_CLASS} style={railBtnStyle}>≡</button>
          ) : (
            <>
              <div style={{ minWidth: 0 }}>
                <div style={{
                  fontSize: 18, fontWeight: 800, color: 'var(--text-strong)',
                  letterSpacing: -0.6, lineHeight: 1.1,
                }}>
                  Floor<span style={{ color: 'var(--blue)' }}>Runner</span>
                </div>
                <div style={{
                  fontSize: 9, color: 'var(--text-faint)', letterSpacing: 1.4,
                  textTransform: 'uppercase', marginTop: 3, fontWeight: 600,
                }}>
                  Anesthesia Platform
                </div>
              </div>
              <button onClick={toggleCollapsed} title="Collapse sidebar" className={RAIL_BTN_CLASS} style={railBtnStyle}>≡</button>
            </>
          )}
        </div>

        {/* Nav sections */}
        <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: collapsed ? 'var(--space-1) 0' : 'var(--space-1) var(--space-2)' }}>
          {NAV_SECTIONS.map((section, si) => (
            <div key={section.label} style={{
              marginBottom: 'var(--space-3)',
              // In the rail there are no section labels, so add a hairline
              // between groups to keep the visual grouping.
              ...(collapsed && si > 0 ? { borderTop: '1px solid var(--border-muted)', paddingTop: 'var(--space-2)' } : null),
            }}>
              {!collapsed && (
                <div style={{
                  fontSize: 'var(--fs-xs)', textTransform: 'uppercase', letterSpacing: 1,
                  color: 'var(--text-dim)', fontWeight: 700, padding: 'var(--space-2) var(--space-3) var(--space-1)',
                }}>
                  {section.label}
                </div>
              )}
              {section.items.map((item) => {
                const active = pathname === item.href || pathname.startsWith(item.href + '/');

                // Styling lives entirely in the .fr-nav-item class (globals.css).
                // Nothing is passed inline, deliberately: an inline background
                // outranks the class's :hover rule, so the hover highlight
                // would silently never appear.
                if (item.href === '/schedules') {
                  return <SchedulesFlyout key={item.href} collapsed={collapsed} />;
                }

                return (
                  <Link key={item.href} href={item.href}
                    className="fr-nav-item fr-focus"
                    data-active={active}
                    data-collapsed={collapsed}
                    title={collapsed ? item.label : undefined}>
                    {collapsed ? item.abbr : item.label}
                  </Link>
                );
              })}
            </div>
          ))}
        </div>

        {/* Footer — theme toggle and, when signed in, sign out. SignOutButton
            renders nothing for an anonymous session, so this row is unchanged
            for anyone who has not been invited yet. */}
        <div style={{
          padding: collapsed ? 'var(--space-3) 0 0' : 'var(--space-3) var(--space-3) 0',
          borderTop: '1px solid var(--border)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-2)',
        }}>
          {collapsed ? (
            <button
              onClick={toggle}
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              className="fr-focus"
              style={railBtnStyle}
            >
              {theme === 'dark' ? '☀' : '☾'}
            </button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={toggle}
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              style={{ width: '100%', justifyContent: 'flex-start', gap: 10 }}
            >
              <span style={{ fontSize: 14, width: 20, textAlign: 'center' }}>{theme === 'dark' ? '☀' : '☾'}</span>
              {theme === 'dark' ? 'Light mode' : 'Dark mode'}
            </Button>
          )}
          <SignOutButton compact={collapsed} />
        </div>
      </nav>

      {/* Content */}
      <main style={{ flex: 1, minWidth: 0, overflow: 'auto', background: 'var(--bg-base)', color: 'var(--text)' }}>
        {effectiveFullBleed
          ? children
          : <div style={{ padding: 'var(--space-6)', maxWidth: 1280, margin: '0 auto' }}>{children}</div>}
      </main>
    </div>
  );
}
