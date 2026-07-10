// Replace-active core for call_patterns, kept free of HTTP concerns (Next.js
// route files may only export HTTP verbs). Task 14 extracts/reuses this from
// src/lib/scheduleAssistant/mutations.ts as a shared mutation.
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import type { CallPatternDoc } from '@/lib/rulesEngine/callPattern';

type SchedulingClient = ReturnType<typeof sbSchedulingServer>;
type PatternRow = Record<string, unknown>;
type SbError = { message: string; code?: string };

// Replaces the site's active call pattern. "Transaction" is approximated:
// archive the current active row, insert the new one as active. The partial
// unique index call_patterns_one_active makes a concurrent writer surface as
// a 23505 on insert, in which case we re-archive and retry exactly once.
export async function replaceActivePattern(
  sb: SchedulingClient,
  siteId: string,
  definition: CallPatternDoc,
  opts: { name?: string; source?: 'manual' | 'assistant' | 'seed' } = {},
): Promise<{ data: PatternRow | null; error: SbError | null }> {
  const name = opts.name ?? 'Custom pattern';
  const source = opts.source ?? 'manual';

  const archiveActive = () => sb.from('call_patterns')
    .update({ status: 'archived' })
    .eq('site_id', siteId)
    .eq('status', 'active');
  const insertActive = () => sb.from('call_patterns')
    .insert({ site_id: siteId, name, status: 'active', source, definition })
    .select()
    .single();

  const { error: archiveErr } = await archiveActive();
  if (archiveErr) return { data: null, error: archiveErr as SbError };

  let { data, error } = await insertActive();
  if (error && (error as SbError).code === '23505') {
    const { error: rearchiveErr } = await archiveActive();
    if (rearchiveErr) return { data: null, error: rearchiveErr as SbError };
    ({ data, error } = await insertActive());
  }
  if (error) return { data: null, error: error as SbError };
  return { data: data as PatternRow, error: null };
}
