import { ListSkeleton } from '@/components/ui/ListSkeleton';

export default function Loading() {
  return <ListSkeleton title="Sites" filters={1} rows={8} />;
}
