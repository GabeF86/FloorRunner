// POST /api/grid-calculator/configs
// Owned by agent A15 (Onboarding Wizard).
// PRD: docs/PRD-Grid-Calculator.md §14 (A14 will replace this stub with the
// real Supabase wiring during Tier-5 post-MVP work).
//
// Why a stub: A15's charter ships the visual onboarding flow before A14's
// persistence pass lands. The wizard's Review step needs SOMETHING to POST
// against so the "Save & finish" button can show a real success state and
// localStorage can be cleared.
//
// This route:
//   - Accepts any JSON payload (we don't pin a schema yet — A14 will own
//     server-side validation when the migration drops).
//   - Echoes the payload back inside `{ configId, savedAt, body }`.
//   - configId is a synthesized "stub-<random>" string so the UI can render
//     it without believing the row hit Supabase. A14 swaps in a real UUID.
//
// Accepts: any JSON body.
// Returns:
//   200 { configId, savedAt, persisted: false, body }
//   400 { error } — body was not JSON

import { NextRequest, NextResponse } from 'next/server';

// Never prerender — this route is the persistence sink for the wizard's
// Review step and must always read the live body.
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'Request body must be valid JSON.' },
      { status: 400 },
    );
  }

  // A14 will replace this synthesized id with the real `id` returned by the
  // `scheduling.grid_calculator_configs` insert. Until then we mark the
  // response with `persisted: false` so the client can stash a banner.
  const configId = `stub-${randomToken()}`;
  const savedAt = new Date().toISOString();

  return NextResponse.json({
    configId,
    savedAt,
    persisted: false,
    body,
  });
}

/**
 * Short hex-ish token. Uses `crypto.randomUUID()` when the runtime exposes it
 * (Node 19+ / modern browsers). Falls back to Math.random for the very small
 * chance we're running on a runtime without crypto. The wizard never calls
 * this from the client — only on the server during the POST.
 */
function randomToken(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Math.random().toString(16).slice(2, 14);
}
