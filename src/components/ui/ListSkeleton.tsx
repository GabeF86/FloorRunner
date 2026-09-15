// The route-level loading state shared by the list pages.
//
// These pages became server components, which means a click now waits on the
// server's database read before ANY new markup arrives. Without a loading
// boundary the browser sits on the previous page for that whole time and the
// click reads as dead — the one way server rendering can feel WORSE than the
// client fetching it did, because at least that painted a shell immediately.
//
// A loading.tsx is a Suspense boundary: Next sends this instantly, then streams
// the real page in when the query resolves. One component rather than five
// near-identical files, because the shape of every list page here is the same —
// a header, a row of filters, a table.

import { Card, Skeleton } from '@/components/ui';

export function ListSkeleton({
  title,
  filters = 3,
  rows = 8,
}: {
  /** Shown for real — the title is known before the data is. */
  title: string;
  filters?: number;
  rows?: number;
}) {
  return (
    <div>
      <div style={{ marginBottom: 'var(--space-5)' }}>
        <div style={{ fontSize: 'var(--fs-xl)', fontWeight: 800, color: 'var(--text-strong)', letterSpacing: -0.4 }}>
          {title}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-4)', flexWrap: 'wrap' }}>
        {Array.from({ length: filters }, (_, i) => (
          <Skeleton key={i} width={130} height={32} />
        ))}
      </div>

      <Card>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          {/* Widths vary so the block reads as rows of text rather than as a
              solid grey slab, which is what makes a skeleton legible as
              "content is coming" instead of "something is broken". */}
          {Array.from({ length: rows }, (_, i) => (
            <Skeleton key={i} width={`${92 - (i % 4) * 11}%`} />
          ))}
        </div>
      </Card>
    </div>
  );
}
