// POST /api/grid-calculator/normalize-rules
// Owned by agent A4 (Rules Normalizer).
//
// Accepts:
//   { rawText: string; sites: GridSite[]; model?: string }
// Returns:
//   200 { rules, unmapped, promptCacheHit, modelId }
//   400 { error, span?: string }      — validation errors (caller fault)
//   500 { error }                     — missing ANTHROPIC_API_KEY
//   502 { error, raw?: string }       — LLM returned an unparseable payload
//
// Persistence is intentionally out of scope here. A1/A2 own
// `grid_calculator_guidelines` writes; this PR is the wrapper only (PRD §14).

import { NextRequest, NextResponse } from 'next/server';

import {
  KNOWN_MODELS,
  MissingApiKeyError,
  NormalizerResponseError,
  normalizeRules,
} from '@/lib/gridCalculator/rulesNormalizer';
import type { GridSite } from '@/lib/gridCalculator/types';

// Hits Anthropic per request — must never be statically prerendered.
export const dynamic = 'force-dynamic';

interface PostBody {
  rawText: unknown;
  sites: unknown;
  model?: unknown;
}

export async function POST(req: NextRequest) {
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json(
      { error: 'Request body must be valid JSON.' },
      { status: 400 },
    );
  }

  const validation = validate(body);
  if ('error' in validation) {
    return NextResponse.json(validation, { status: 400 });
  }

  try {
    const result = await normalizeRules({
      rawText: validation.rawText,
      sites: validation.sites,
      model: validation.model,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof MissingApiKeyError) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
    if (err instanceof NormalizerResponseError) {
      return NextResponse.json(
        { error: err.message, raw: err.raw },
        { status: 502 },
      );
    }
    const message =
      err instanceof Error ? err.message : 'Unknown normalizer error.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface ValidationOk {
  rawText: string;
  sites: GridSite[];
  model?: string;
}

interface ValidationErr {
  error: string;
  span?: string;
}

function validate(body: PostBody): ValidationOk | ValidationErr {
  if (typeof body.rawText !== 'string') {
    return { error: 'Field `rawText` is required and must be a string.', span: 'rawText' };
  }
  if (!Array.isArray(body.sites)) {
    return { error: 'Field `sites` is required and must be an array.', span: 'sites' };
  }

  const sites: GridSite[] = [];
  for (let i = 0; i < body.sites.length; i++) {
    const s = body.sites[i];
    if (typeof s !== 'object' || s === null) {
      return {
        error: `sites[${i}] must be an object.`,
        span: `sites[${i}]`,
      };
    }
    const obj = s as Record<string, unknown>;
    if (typeof obj.id !== 'string' || obj.id.length === 0) {
      return { error: `sites[${i}].id must be a non-empty string.`, span: `sites[${i}].id` };
    }
    if (typeof obj.name !== 'string' || obj.name.length === 0) {
      return { error: `sites[${i}].name must be a non-empty string.`, span: `sites[${i}].name` };
    }
    // We only structurally need {id, name} for the normalizer, but accept the
    // full GridSite shape if provided. Cast through unknown to satisfy strict
    // structural typing without forcing the caller to send rooms here.
    sites.push(s as unknown as GridSite);
  }

  let model: string | undefined;
  if (typeof body.model === 'string') {
    if (!KNOWN_MODELS.has(body.model)) {
      return {
        error: `model must be one of: ${[...KNOWN_MODELS].join(', ')}.`,
        span: 'model',
      };
    }
    model = body.model;
  } else if (body.model !== undefined && body.model !== null) {
    return { error: '`model` must be a string when provided.', span: 'model' };
  }

  return { rawText: body.rawText, sites, model };
}
