import { ListSkeleton } from '@/components/ui/ListSkeleton';

export default function Loading() {
  return <ListSkeleton title="Schedules" filters={4} rows={6} />;
}
