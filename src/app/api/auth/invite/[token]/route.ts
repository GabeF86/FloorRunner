import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { resolveInvitation } from '@/lib/auth/inviteService';
import { invitationStateMessage } from '@/lib/auth/invitations';

export const dynamic = 'force-dynamic';

// GET /api/auth/invite/:token
//
// What the /join page shows before anyone types a password. Public by
// necessity — the visitor has no session, that is the whole point.
//
// The token never reaches the database: resolveInvitation looks up its SHA-256.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const r = await resolveInvitation(sbSchedulingServer(), token, new Date());

  if (r.state !== 'valid') {
    // 200, not 4xx: this is a page telling someone their link is stale, not an
    // API error. The message is uniform across failure modes so probing tokens
    // reveals nothing about which ones exist.
    return NextResponse.json(
      { valid: false, message: invitationStateMessage(r.state) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  return NextResponse.json(
    { valid: true, email: r.email, providerName: r.providerName },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
