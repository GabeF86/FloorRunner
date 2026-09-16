// GET /api/scheduling/me/overview — the signed-in clinician's own overview.
//
// The provider id comes from the SESSION and never from the URL. That is the
// whole reason this route exists separately from the [id] one next to it:
// routeAccess opens the /api/scheduling/me namespace to any signed-in
// provider, so a route here that accepted an id would let any physician read
// any colleague's record. There is no id to pass.

import { NextResponse } from 'next/server';
import { currentSession } from '@/lib/auth/session';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { loadProviderOverview } from '@/lib/queries/providerOverviewQuery';
import { todayIso } from '@/lib/queries/today';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await currentSession();
  if (!session.userId) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }
  if (!session.providerId) {
    // An admin who is not a physician has no overview of their own. Said
    // plainly rather than returning an empty one, which would read as "you
    // have no schedule".
    return NextResponse.json(
      { error: 'This login is not linked to a provider record.' }, { status: 404 });
  }

  try {
    const result = await loadProviderOverview(
      sbSchedulingServer(), { providerId: session.providerId, today: todayIso() });
    if (!result) return NextResponse.json({ error: 'Provider not found.' }, { status: 404 });
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Overview could not be loaded.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
