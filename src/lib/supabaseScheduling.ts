import { makeServerClient } from './supabaseServer';

// Server-side client for the scheduling-schema API routes.
// See supabaseServer.ts for the lazy-construction / env-var rationale.
export function sbSchedulingServer() {
  return makeServerClient('scheduling');
}
