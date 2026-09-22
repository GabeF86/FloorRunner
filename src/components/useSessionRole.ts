'use client';

// Who is looking at this, for the navigation's benefit.
//
// ── THIS IS NOT A SECURITY BOUNDARY ────────────────────────────────────────
// It decides what to SHOW. Every route it hides is independently gated in
// routeAccess.ts, which is pure and unit-tested, and the middleware enforces
// that on the server. A link this hook withholds is still reachable by typing
// the URL — and must be, or the gate below it was never the real control.
//
// Use it to avoid offering somebody a door that will slam in their face, not
// to lock the door.
//
// One fetch of /api/auth/me, which returns 200-with-nulls for an anonymous
// caller rather than 401 (see that route) — so no console noise on the pages
// that are still used signed out.

import { useEffect, useState } from 'react';
import type { SessionRole } from '@/lib/auth/routeAccess';

export interface SessionInfo {
  role: SessionRole;
  providerId: string | null;
  /** False until the answer is back. Callers must not treat the pre-load state
   *  as "anonymous" and flash a reduced menu at an admin on every page load. */
  loaded: boolean;
}

export function useSessionRole(): SessionInfo {
  const [info, setInfo] = useState<SessionInfo>({
    role: 'anonymous', providerId: null, loaded: false,
  });

  useEffect(() => {
    let alive = true;
    fetch('/api/auth/me')
      .then(r => r.json())
      .then((d: { role?: string | null; providerId?: string | null }) => {
        if (!alive) return;
        // An unrecognised role is treated as anonymous, matching isAllowed's
        // rule that an unknown role is denied rather than assumed harmless.
        const role: SessionRole =
          d?.role === 'admin' || d?.role === 'staff' || d?.role === 'provider'
            ? d.role : 'anonymous';
        setInfo({ role, providerId: d?.providerId ?? null, loaded: true });
      })
      .catch(() => {
        // Offline or signed out. Loaded, so the menu settles rather than
        // spinning; anonymous, so it offers nothing it cannot deliver.
        if (alive) setInfo({ role: 'anonymous', providerId: null, loaded: true });
      });
    return () => { alive = false; };
  }, []);

  return info;
}
