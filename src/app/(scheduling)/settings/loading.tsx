import { ListSkeleton } from '@/components/ui/ListSkeleton';

export default function Loading() {
  return <ListSkeleton title="Settings" filters={2} rows={6} />;
}
