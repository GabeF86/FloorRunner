import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { sbSession } from '@/lib/auth/session';
import { acceptInvitation, type AuthAdmin } from '@/lib/auth/inviteService';

export const dynamic = 'force-dynamic';

/** The Admin API slice acceptInvitation needs, bound to the real service key. */
function authAdmin(): AuthAdmin {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required to accept invitations.');
  const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  return {
    createUser: (args) => admin.auth.admin.createUser(args) as ReturnType<AuthAdmin['createUser']>,
    deleteUser: (id) => admin.auth.admin.deleteUser(id) as ReturnType<AuthAdmin['deleteUser']>,
  };
}

// POST /api/auth/accept-invite  { token, password }
//
// Redeems an invitation: creates the login, binds it to the provider the
// INVITATION names, and signs the new user in. Public by necessity.
//
// The provider is never taken from the request body. It comes from the
// invitation row the token resolves to, which is the entire reason this app
// uses invitations rather than self-registration.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }
  const { token, password } = body as { token?: unknown; password?: unknown };
  if (typeof token !== 'string' || typeof password !== 'string') {
    return NextResponse.json({ error: 'Token and password are required.' }, { status: 400 });
  }

  let admin: AuthAdmin;
  try {
    admin = authAdmin();
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Server is not configured for invitations.' },
      { status: 500 },
    );
  }

  const res = await acceptInvitation(sbSchedulingServer(), admin, {
    token, password, now: new Date(),
  });
  if (!res.ok) {
    return NextResponse.json({ error: res.error }, { status: res.status });
  }

  // Sign them straight in, so acceptance lands them in the app rather than at
  // a login form asking for the password they just chose.
  const { error: signInError } = await sbSession().auth.signInWithPassword({
    email: res.data!.email,
    password,
  });
  if (signInError) {
    // The account exists and is correctly bound; only the convenience step
    // failed. Say so rather than implying acceptance did not work.
    return NextResponse.json(
      { ok: true, signedIn: false, message: 'Your account is ready. Please sign in.' },
    );
  }

  return NextResponse.json({ ok: true, signedIn: true });
}
