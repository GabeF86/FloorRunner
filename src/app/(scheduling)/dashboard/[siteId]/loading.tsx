// Route-level loading state for a site dashboard.
//
// This page is `force-dynamic` and issues three round trips before it can
// render anything — the site lookup, loadDashboardData, and the annual
// obligation simulation — so without this the sidebar sits over a blank pane
// for the whole wait. The shape below mirrors the real page (header, staffing,
// obligation, schedules, two panels) so nothing jumps when the data lands.

import { Card, Skeleton } from '@/components/ui';

function ChipRowSkeleton({ count }: { count: number }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} width={68 + (i % 4) * 22} height={22} style={{ borderRadius: 999 }} />
      ))}
    </div>
  );
}

function StaffSectionSkeleton({ chips }: { chips: number }) {
  return (
    <div style={{ marginBottom: 'var(--space-4)' }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)',
        paddingBottom: 6, marginBottom: 'var(--space-2)',
        borderBottom: '1px solid var(--border-faint)',
      }}>
        <Skeleton width={46} height={20} />
        <Skeleton width={110} height={12} />
      </div>
      <ChipRowSkeleton count={chips} />
    </div>
  );
}

export default function SiteDashboardLoading() {
  return (
    <div>
      {/* PageHeader mirror */}
      <div style={{ marginBottom: 'var(--space-5)' }}>
        <Skeleton width={220} height={24} style={{ marginBottom: 'var(--space-2)' }} />
        <Skeleton width={320} height={13} />
      </div>

      {/* Stat cards */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
        gap: 'var(--space-4)', marginBottom: 'var(--space-5)',
      }}>
        {Array.from({ length: 3 }, (_, i) => (
          <Card key={i}>
            <Skeleton width="55%" height={11} style={{ marginBottom: 'var(--space-3)' }} />
            <Skeleton width={64} height={28} />
          </Card>
        ))}
      </div>

      {/* Staffing */}
      <div style={{ marginBottom: 'var(--space-4)' }}>
        <Card title={<Skeleton width={90} height={14} />}>
          <StaffSectionSkeleton chips={9} />
          <StaffSectionSkeleton chips={12} />
          <StaffSectionSkeleton chips={7} />
        </Card>
      </div>

      {/* Annual call obligation */}
      <div style={{ marginBottom: 'var(--space-4)' }}>
        <Card title={<Skeleton width={190} height={14} />}>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
            gap: 'var(--space-4)',
          }}>
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i}>
                <Skeleton width={80} height={11} style={{ marginBottom: 'var(--space-2)' }} />
                <Skeleton width="100%" style={{ marginBottom: 6 }} />
                <Skeleton width="86%" style={{ marginBottom: 6 }} />
                <Skeleton width="72%" />
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Schedules + the two panels */}
      <div style={{ marginBottom: 'var(--space-4)' }}>
        <Card title={<Skeleton width={110} height={14} />}>
          <Skeleton width="70%" style={{ marginBottom: 'var(--space-2)' }} />
          <Skeleton width="55%" />
        </Card>
      </div>

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
        gap: 'var(--space-4)', alignItems: 'start',
      }}>
        {Array.from({ length: 2 }, (_, i) => (
          <Card key={i} title={<Skeleton width={120} height={14} />}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
              <Skeleton width="90%" />
              <Skeleton width="72%" />
              <Skeleton width="83%" />
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
