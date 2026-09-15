// Turning a sentence into named edits.
//
// ── THE MODEL'S JOB IS DELIBERATELY SMALL ──────────────────────────────────
// It does not write a call pattern. It reads one described in English, reads
// what the user asked for, and names edits from a closed list. Everything
// after that is deterministic: applyPatternEdits checks each target exists,
// the Zod schema checks the result, and the diff shows the consequence in the
// same English the page displays.
//
// That ordering is what makes this safe to ship. The riskiest step — a model
// producing structure — has been reduced to the least dangerous one, because
// nothing it says reaches the database without code applying it to a
// known-good document and the schema accepting the result.
//
// ── IT IS ALSO OPTIONAL ────────────────────────────────────────────────────
// The edit → validate → diff → apply pipeline has no model in it. A
// deployment without an Anthropic key loses the ability to TYPE a change; it
// does not lose the ability to make one. That matters for handing this to a
// group that has no LLM subscription: the feature degrades to a form, not to
// nothing.

import type { AssistantClientLike, AssistantToolDef } from './assistantCore/client';
import { DEFAULT_MODEL } from './assistantCore/client';
import { describeSchedulingLogic, type ShiftTypeFacts } from './schedulingLogic';
import type { CallPatternDoc, DayType } from './rulesEngine/callPattern';
import type { PatternEdit } from './patternEdit';

export const DAY_TYPE_VALUES: readonly DayType[] = [
  'weekday', 'friday', 'saturday', 'sunday', 'federal_holiday', 'major_holiday',
];

/**
 * One tool, one shot. No agentic loop: there is nothing to explore here, and a
 * loop would give the model room to "fix" a rejection by proposing something
 * further from what was asked.
 */
export const PROPOSE_EDITS_TOOL: AssistantToolDef = {
  name: 'propose_pattern_edits',
  description:
    'Propose changes to a site call pattern as a list of named edits. Never invent shift '
    + 'codes that are not already in use at the site. If the request is ambiguous or cannot '
    + 'be expressed with these operations, return an empty edits array and explain why in '
    + '`unsupported`.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['edits'],
    properties: {
      edits: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['op', 'anchorDayType', 'trigger'],
          properties: {
            op: {
              type: 'string',
              enum: [
                'add_block_link', 'remove_block_link', 'add_block_chain',
                'remove_block_chain', 'set_block_link_min_fte',
              ],
            },
            anchorDayType: { type: 'string', enum: DAY_TYPE_VALUES as unknown as string[] },
            trigger: { type: 'string', description: 'The shift code that starts the chain, e.g. C1.' },
            code: { type: 'string', description: 'The shift code being placed by the link.' },
            offset: {
              type: 'integer',
              description:
                'Days from the anchor. Saturday anchor: -1 is Friday, +1 is Sunday, +2 is Monday. '
                + 'Friday anchor: +1 is Saturday, +2 is Sunday.',
            },
            minFte: { type: ['number', 'null'], description: 'FTE floor for this link, or null to clear it.' },
            links: {
              type: 'array',
              description: 'Only for add_block_chain.',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['code', 'offset'],
                properties: {
                  code: { type: 'string' },
                  offset: { type: 'integer' },
                  minFte: { type: 'number' },
                },
              },
            },
          },
        },
      },
      unsupported: {
        type: 'string',
        description: 'Set when the request cannot be expressed. Explain in one sentence what is missing.',
      },
    },
  },
};

export interface InterpretInput {
  request: string;
  doc: CallPatternDoc;
  shiftTypes: readonly ShiftTypeFacts[];
  parLevel: number | null;
  siteName: string;
}

export type InterpretResult =
  | { ok: true; edits: PatternEdit[] }
  /** The model understood but the vocabulary cannot express it. */
  | { ok: false; kind: 'unsupported'; message: string }
  | { ok: false; kind: 'error'; message: string };

/**
 * The prompt is built from the SAME description the page shows.
 *
 * Feeding it the raw JSON would make it fluent in a representation the
 * reviewer never sees, and its proposals would drift toward shapes that read
 * well as JSON rather than as call structure. Describing the pattern the way
 * Gabriel reads it keeps the model and the reviewer looking at one thing.
 */
export function buildInterpreterPrompt(input: InterpretInput): string {
  const sections = describeSchedulingLogic({
    doc: input.doc, shiftTypes: input.shiftTypes, parLevel: input.parLevel,
  }).filter(s => s.kind === 'enforced' && s.key !== 'invariants');

  const described = sections
    .map(s => `${s.title}:\n${s.statements.map(st => `  - ${st.text}`).join('\n') || '  (none)'}`)
    .join('\n\n');

  // Codes WITH their names. Without the names a request phrased in service
  // terms cannot be translated: asked to give Friday C1 the weekend "neuro"
  // call, the interpreter declined because nothing connected that word to C3,
  // whose name is "Neuro Call". A scheduler describes a change the way the
  // service is spoken about, not in codes.
  const seen = new Map<string, string | null | undefined>();
  for (const t of input.shiftTypes) if (!seen.has(t.code)) seen.set(t.code, t.name);
  const codes = [...seen.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([code, name]) => (name ? `${code} (${name})` : code))
    .join(', ');

  return [
    `Site: ${input.siteName}`,
    '',
    'The call pattern currently in force, in plain English:',
    '',
    described,
    '',
    `Shift codes that exist at this site: ${codes || '(none recorded)'}`,
    '',
    'Raw structure, for resolving offsets precisely:',
    JSON.stringify({ blocks: input.doc.blocks }, null, 2),
    '',
    'The change requested:',
    input.request,
    '',
    'Rules:',
    '- Only use shift codes that already exist at this site.',
    '- An offset is relative to the anchor day. From a Saturday anchor, Friday is -1 and Sunday is +1.',
    '- Do not restate edits that are already true; if the pattern already does what was asked, return no edits.',
    '- Change only what was asked. Do not tidy, reorder or "improve" anything else.',
  ].join('\n');
}

const SYSTEM = [
  'You translate a physician scheduler\'s plain-English request into named edits to a call pattern.',
  '',
  'You are a translator, not a designer. You never decide what the schedule SHOULD be — you',
  'express what was asked, exactly, in the closed vocabulary of the tool. If the request is',
  'ambiguous, or needs an operation the vocabulary does not have, return no edits and say so in',
  '`unsupported` rather than guessing. A wrong guess here changes how a hospital staffs its call.',
].join('\n');

/**
 * Interpret a request. The client is injected so tests never reach the network.
 */
export async function interpretPatternRequest(
  client: AssistantClientLike,
  input: InterpretInput,
): Promise<InterpretResult> {
  if (!input.request.trim()) {
    return { ok: false, kind: 'error', message: 'Describe the change you want to make.' };
  }

  let final;
  try {
    const stream = client.stream({
      model: DEFAULT_MODEL,
      max_tokens: 4000,
      thinking: { type: 'adaptive' },
      system: [{ type: 'text', text: SYSTEM }],
      tools: [PROPOSE_EDITS_TOOL],
      messages: [{ role: 'user', content: buildInterpreterPrompt(input) }],
    });
    final = await stream.finalMessage();
  } catch (e) {
    return { ok: false, kind: 'error', message: e instanceof Error ? e.message : 'The interpreter could not be reached.' };
  }

  const call = final.content.find(
    (b): b is Extract<typeof b, { type: 'tool_use' }> =>
      b.type === 'tool_use' && b.name === PROPOSE_EDITS_TOOL.name,
  );
  if (!call) {
    // No tool call at all. Surface any prose it produced rather than a blank
    // failure — it usually explains what it could not do.
    const said = final.content.find((b): b is { type: 'text'; text: string } => b.type === 'text')?.text;
    return {
      ok: false,
      kind: 'unsupported',
      message: said?.trim() || 'That request could not be turned into a change to the call pattern.',
    };
  }

  const input_ = call.input as { edits?: unknown; unsupported?: unknown };
  const unsupported = typeof input_.unsupported === 'string' ? input_.unsupported.trim() : '';
  const edits = Array.isArray(input_.edits) ? (input_.edits as PatternEdit[]) : [];

  // An explicit refusal wins over an empty list, because it carries a reason.
  if (edits.length === 0) {
    return {
      ok: false,
      kind: 'unsupported',
      message: unsupported
        || 'That change is either already in effect or cannot be expressed as a pattern edit.',
    };
  }
  return { ok: true, edits };
}
