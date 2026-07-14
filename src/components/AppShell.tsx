'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui';

interface NavItem { href: string; label: string; icon: string }
interface NavSection { label: string; items: NavItem[] }

const NAV_SECTIONS: NavSection[] = [
  {
    label: 'Overview',
    items: [{ href: '/dashboard', label: 'Dashboard', icon: '◎' }],
  },
  {
    label: 'Scheduling',
    items: [
      { href: '/schedules', label: 'Schedules', icon: '▦' },
      { href: '/providers', label: 'Providers', icon: '◆' },
      { href: '/sites',     label: 'Sites',     icon: '⬡' },
      { href: '/rules',     label: 'Rules',     icon: '⚖' },
      { href: '/requests',  label: 'Requests',  icon: '✉' },
    ],
  },
  {
    label: 'Staffing',
    items: [
      { href: '/staffing-calculator', label: 'Staffing Calculator', icon: '∑' },
      { href: '/grid-calculator',     label: 'Grid Calculator',     icon: '⊞' },
    ],
  },
  {
    label: 'Operations',
    items: [{ href: '/board', label: 'Floor Runner', icon: '⚡' }],
  },
  {
    label: 'Admin',
    items: [{ href: '/settings', label: 'Settings', icon: '⚙' }],
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

export default function AppShell({ fullBleed, children }: { fullBleed?: boolean; children: React.ReactNode }) {
  const pathname = usePathname();
  const { theme, toggle } = useTheme();

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: 'var(--bg-base)', color: 'var(--text)' }}>
      {/* Sidebar */}
      <nav style={{
        width: 220, flexShrink: 0, background: 'var(--bg-sidebar)',
        borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column',
        padding: 'var(--space-4) 0',
      }}>
        {/* Logo */}
        <div style={{ padding: '0 var(--space-5) var(--space-5)', borderBottom: '1px solid var(--border)', marginBottom: 'var(--space-2)' }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--blue)', letterSpacing: -0.5 }}>FloorRunner</div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)', letterSpacing: 1, textTransform: 'uppercase', marginTop: 2 }}>Anesthesia Platform</div>
        </div>

        {/* Nav sections */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--space-1) var(--space-2)' }}>
          {NAV_SECTIONS.map((section) => (
            <div key={section.label} style={{ marginBottom: 'var(--space-3)' }}>
              <div style={{
                fontSize: 'var(--fs-xs)', textTransform: 'uppercase', letterSpacing: 1,
                color: 'var(--text-dim)', fontWeight: 700, padding: 'var(--space-2) var(--space-3) var(--space-1)',
              }}>
                {section.label}
              </div>
              {section.items.map((item) => {
                const active = pathname === item.href || pathname.startsWith(item.href + '/');
                return (
                  <Link key={item.href} href={item.href} className="fr-focus" style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '8px var(--space-3)', borderRadius: 'var(--radius-sm)', marginBottom: 2,
                    textDecoration: 'none', fontSize: 13, fontWeight: 600,
                    color: active ? 'var(--blue)' : 'var(--text-muted)',
                    background: active ? 'color-mix(in srgb, var(--blue) 10%, transparent)' : 'transparent',
                    border: '1px solid ' + (active ? 'color-mix(in srgb, var(--blue) 25%, transparent)' : 'transparent'),
                    transition: 'all 0.15s',
                  }}>
                    <span style={{ fontSize: 16, width: 20, textAlign: 'center' }}>{item.icon}</span>
                    {item.label}
                  </Link>
                );
              })}
            </div>
          ))}
        </div>

        {/* Footer — theme toggle */}
        <div style={{ padding: 'var(--space-3) var(--space-3) 0', borderTop: '1px solid var(--border)' }}>
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
        </div>
      </nav>

      {/* Content */}
      <main style={{ flex: 1, minWidth: 0, overflow: 'auto', background: 'var(--bg-base)', color: 'var(--text)' }}>
        {fullBleed
          ? children
          : <div style={{ padding: 'var(--space-6)', maxWidth: 1280, margin: '0 auto' }}>{children}</div>}
      </main>
    </div>
  );
}
