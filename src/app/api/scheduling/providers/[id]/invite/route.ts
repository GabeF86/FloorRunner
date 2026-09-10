import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { createInvitation } from '@/lib/auth/inviteService';
import { currentSession } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

// POST /api/scheduling/providers/:id/invite   { email }
//
// Chief-only. It is under /api/scheduling/ and NOT under /me, so the
// deny-by-default middleware classifies it 'admin' with no entry anywhere —
// that is the whole point of the classifier. The session lookup below is only
// to stamp `invited_by`, not to authorize; authorization already happened.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: providerId } = await params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }
  const { email } = body as { email?: unknown };
  if (typeof email !== 'string') {
    return NextResponse.json({ error: 'An email address is required.' }, { status: 400 });
  }

  const session = await currentSession();

  const res = await createInvitation(sbSchedulingServer(), session.userId, {
    providerId,
    email,
    origin: new URL(req.url).origin,
    now: new Date(),
  });

  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });

  // The link is returned so the chief can copy it. That is the shipped
  // delivery mechanism until an SMTP sender is configured — see the spec.
  // It is also the permanent fallback for a bounced address.
  return NextResponse.json(res.data, { headers: { 'Cache-Control': 'no-store' } });
}

// GET — the invitation state for this provider, so the profile can show
// "invited 3 days ago" rather than offering to invite someone twice.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: providerId } = await params;
  const sb = sbSchedulingServer();

  const [prov, inv] = await Promise.all([
    sb.from('providers').select('linked_user_id, email').eq('id', providerId).maybeSingle(),
    sb.from('provider_invitations')
      .select('email, status, expires_at, created_at')
      .eq('provider_id', providerId)
      .order('created_at', { ascending: false })
      .limit(1),
  ]);

  if (prov.error) return NextResponse.json({ error: prov.error.message }, { status: 500 });
  if (inv.error) return NextResponse.json({ error: inv.error.message }, { status: 500 });

  const latest = (inv.data ?? [])[0] ?? null;
  return NextResponse.json(
    {
      hasLogin: !!prov.data?.linked_user_id,
      suggestedEmail: prov.data?.email ?? null,
      latestInvitation: latest,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
