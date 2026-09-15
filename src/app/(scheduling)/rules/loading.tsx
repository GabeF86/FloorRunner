import { ListSkeleton } from '@/components/ui/ListSkeleton';

export default function Loading() {
  return <ListSkeleton title="Rules" filters={4} rows={4} />;
}
