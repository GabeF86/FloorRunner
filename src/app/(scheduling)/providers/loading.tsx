import { ListSkeleton } from '@/components/ui/ListSkeleton';

export default function Loading() {
  return <ListSkeleton title="Providers" filters={5} rows={12} />;
}
