'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';

const NAV_ITEMS = [
  { href: '/dashboard',  label: 'Dashboard',    icon: '◎' },
  { href: '/providers',  label: 'Providers',    icon: '◆' },
  { href: '/sites',      label: 'Sites',        icon: '⬡' },
  { href: '/schedules',  label: 'Schedules',    icon: '▦' },
  { href: '/requests',   label: 'Requests',     icon: '✉' },
  { href: '/board',      label: 'Floor Runner', icon: '⚡' },
  { href: '/reports',    label: 'Reports',      icon: '▤' },
  { href: '/settings',   label: 'Settings',     icon: '⚙' },
];

export default function SchedulingLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      {/* Sidebar */}
      <nav style={{
        width: 220, flexShrink: 0, background: 'var(--bg-surface)',
        borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column',
        padding: '16px 0',
      }}>
        {/* Logo */}
        <div style={{ padding: '0 20px 20px', borderBottom: '1px solid var(--border)', marginBottom: 8 }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: '#0ea5e9', letterSpacing: -0.5 }}>FloorRunner</div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)', letterSpacing: 1, textTransform: 'uppercase', marginTop: 2 }}>Scheduling Platform</div>
        </div>

        {/* Nav items */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '4px 8px' }}>
          {NAV_ITEMS.map((item) => {
            const active = pathname === item.href || (item.href !== '/dashboard' && pathname.startsWith(item.href));
            return (
              <Link key={item.href} href={item.href} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 12px', borderRadius: 8, marginBottom: 2,
                textDecoration: 'none', fontSize: 13, fontWeight: 600,
                color: active ? '#0ea5e9' : 'var(--text-muted)',
                background: active ? 'rgba(14,165,233,0.1)' : 'transparent',
                border: '1px solid ' + (active ? 'rgba(14,165,233,0.25)' : 'transparent'),
                transition: 'all 0.15s',
              }}>
                <span style={{ fontSize: 16, width: 20, textAlign: 'center' }}>{item.icon}</span>
                {item.label}
              </Link>
            );
          })}
        </div>
      </nav>

      {/* Main content */}
      <main style={{ flex: 1, overflow: 'auto', background: 'var(--bg-base)' }}>
        {children}
      </main>
    </div>
  );
}
