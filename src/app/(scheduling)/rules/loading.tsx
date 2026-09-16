import { ListSkeleton } from '@/components/ui/ListSkeleton';

export default function Loading() {
  return <ListSkeleton title="Scheduling Logic" filters={1} rows={4} />;
}
