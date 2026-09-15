// The profile page became a server component, so a click on a provider chip
// now waits on the database read before any markup arrives. This is what fills
// that gap — the tab strip and a form's worth of rows, which is the shape of
// every tab.
import { Card, Skeleton } from '@/components/ui';

export default function Loading() {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-4)' }}>
        <Skeleton width={44} height={44} style={{ borderRadius: 999 }} />
        <div style={{ flex: 1 }}>
          <Skeleton width={220} height={20} style={{ marginBottom: 6 }} />
          <Skeleton width={140} height={12} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-4)', flexWrap: 'wrap' }}>
        {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} width={96} height={30} />)}
      </div>
      <Card>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          {Array.from({ length: 7 }, (_, i) => (
            <div key={i} style={{ display: 'flex', gap: 'var(--space-4)', alignItems: 'center' }}>
              <Skeleton width={150} height={12} />
              <Skeleton width={`${46 - (i % 3) * 8}%`} height={32} />
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
