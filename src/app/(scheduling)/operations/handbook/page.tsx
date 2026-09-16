// The group handbook — rules, rates, minutes, hiring and documents.
//
// Server component, same shape as the staffing board beside it: the reads
// happen on the request so the page arrives with its numbers in it.

import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { loadHandbookData, type HandbookData } from './queries';
import { HandbookView } from './HandbookView';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function today(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

export default async function HandbookPage() {
  let data: HandbookData | null = null;
  let fatal: string | null = null;
  try {
    data = await loadHandbookData(sbSchedulingServer(), { today: today() });
  } catch (e) {
    fatal = e instanceof Error ? e.message : 'The handbook could not be loaded.';
  }
  return <HandbookView data={data} fatal={fatal} />;
}
