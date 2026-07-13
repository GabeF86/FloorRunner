// Board assistant system-prompt loader. Mirrors scheduleAssistant/assistant.ts's
// loadSystemPrompt: read the frozen board.md at runtime via fs, trying __dirname
// first (bundled next to this module) then a cwd-relative fallback (dev/test).
// The .md is added to next.config.mjs outputFileTracingIncludes so Vercel keeps
// it in the serverless bundle — the same bundling trap the schedule assistant hit.
import fs from 'fs';
import path from 'path';

function candidatePromptPaths(): string[] {
  const candidates: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dirname: string | undefined = typeof __dirname === 'string' ? __dirname : undefined;
  if (dirname) candidates.push(path.join(dirname, 'prompts', 'board.md'));
  candidates.push(path.join(process.cwd(), 'src', 'lib', 'boardAssistant', 'prompts', 'board.md'));
  return candidates;
}

// Cached after the first successful read — the frozen prompt never changes at
// runtime, so a single read per process suffices (and keeps the cached system
// prefix byte-stable across requests, which prompt caching relies on).
let cachedSystemPrompt: string | null = null;
export function loadBoardSystemPrompt(): string {
  if (cachedSystemPrompt !== null) return cachedSystemPrompt;
  const paths = candidatePromptPaths();
  for (const p of paths) {
    try {
      cachedSystemPrompt = fs.readFileSync(p, 'utf8');
      return cachedSystemPrompt;
    } catch {
      // try next candidate
    }
  }
  throw new Error(`Could not locate board.md prompt file. Tried: ${paths.join(', ')}`);
}
