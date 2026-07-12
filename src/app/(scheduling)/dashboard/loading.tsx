// Route-level loading state — mirrors the dashboard layout (header, four
// stat cards, two panels) with Skeleton placeholders while the server
// component's queries run.

import { Card, Skeleton } from '@/components/ui';

function StatSkeleton() {
  return (
    <Card>
      <Skeleton width="55%" height={11} style={{ marginBottom: 'var(--space-3)' }} />
      <Skeleton width={64} height={28} />
    </Card>
  );
}

function PanelSkeleton() {
  return (
    <Card title={<Skeleton width={120} height={14} />}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        <Skeleton width="90%" />
        <Skeleton width="72%" />
        <Skeleton width="83%" />
        <Skeleton width="60%" />
      </div>
    </Card>
  );
}

export default function DashboardLoading() {
  return (
    <div>
      {/* PageHeader mirror */}
      <div style={{ marginBottom: 'var(--space-5)' }}>
        <Skeleton width={180} height={24} style={{ marginBottom: 'var(--space-2)' }} />
        <Skeleton width={300} height={13} />
      </div>

      {/* Stat cards row */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
          gap: 'var(--space-4)',
          marginBottom: 'var(--space-5)',
        }}
      >
        <StatSkeleton />
        <StatSkeleton />
        <StatSkeleton />
        <StatSkeleton />
      </div>

      {/* Panels row */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
          gap: 'var(--space-4)',
          alignItems: 'start',
        }}
      >
        <PanelSkeleton />
        <PanelSkeleton />
      </div>
    </div>
  );
}
