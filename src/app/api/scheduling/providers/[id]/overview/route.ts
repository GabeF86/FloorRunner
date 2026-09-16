// GET /api/scheduling/providers/:id/overview — back office reading a
// clinician's overview.
//
// Admin-only, by the deny-by-default rule in routeAccess: this path is in no
// allow-list, so it classifies 'admin'. A physician reading their OWN overview
// uses /api/scheduling/me/overview, which takes no id.

import { NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { loadProviderOverview } from '@/lib/queries/providerOverviewQuery';
import { todayIso } from '@/lib/queries/today';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const result = await loadProviderOverview(
      sbSchedulingServer(), { providerId: params.id, today: todayIso() });
    if (!result) return NextResponse.json({ error: 'Provider not found.' }, { status: 404 });
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Overview could not be loaded.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
