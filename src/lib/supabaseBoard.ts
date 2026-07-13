import { makeServerClient } from './supabaseServer';

// Server-side client for the public-schema (board) API routes.
// See supabaseServer.ts for the lazy-construction / env-var rationale.
export function sbBoardServer() {
  return makeServerClient('public');
}
