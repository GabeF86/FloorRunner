// Zod request-body schemas for scheduling mutation routes (Task 13).
// The POST-payload fixtures below are copied from the actual UI senders
// (sites/[id]/page.tsx ShiftTypeModal, rules/[id]/page.tsx rule modal) —
// if a schema change would reject one of these, the UI breaks.
import { describe, it, expect } from 'vitest';
import {
  ShiftTypeUpsertSchema,
  ShiftTypePatchSchema,
  RuleDefinitionUpsertSchema,
  RuleDefinitionPatchSchema,
  formatZodIssues,
} from './scheduling';

// Exact body shape the ShiftTypeModal sends on POST and PATCH.
const UI_SHIFT_TYPE_BODY = {
  site_id: 'site-1',
  name: 'Call - Weekday',
  code: 'C1',
  category: 'call',
  call_type: 'weekday',
  call_coverage_type: null,
  early_out_post_call: false,
  provider_group: 'physician',
  start_time: '07:00',
  end_time: null,
  duration_hours: 24,
  color_hex: '#0ea5e9',
  display_order: 1,
  counts_toward_hours: true,
  counts_toward_call_burden: true,
  counts_as_weekend_burden: false,
  counts_as_holiday_burden: false,
  requires_post_call_rule: true,
  requires_backup_pairing: false,
  can_auto_assign: true,
  manual_only: false,
};

// Exact body shape the rules/[id] modal sends (empty applies_to_* become null).
const UI_RULE_DEFINITION_BODY = {
  rule_set_id: 'rs-1',
  rule_name: 'Post-call day off',
  rule_category: 'rest',
  hard_constraint: true,
  priority_rank: 10,
  applies_to_provider_group: 'physician',
  applies_to_shift_types: null,
  applies_to_day_types: ['weekday', 'friday'],
  condition: { after_shift: 'C1' },
  action: { block_next_day: true },
  explanation_text: null,
  is_active: true,
};

describe('ShiftTypeUpsertSchema', () => {
  it('accepts the exact UI POST payload', () => {
    const r = ShiftTypeUpsertSchema.safeParse(UI_SHIFT_TYPE_BODY);
    expect(r.success).toBe(true);
  });

  it('accepts the patch18 engine columns', () => {
    const r = ShiftTypeUpsertSchema.safeParse({
      ...UI_SHIFT_TYPE_BODY,
      call_rank: 0,
      relief_rank: null,
      is_overlay: false,
      generation_engine: 'call',
    });
    expect(r.success).toBe(true);
  });

  it('rejects unknown keys', () => {
    const r = ShiftTypeUpsertSchema.safeParse({ ...UI_SHIFT_TYPE_BODY, bogus_column: 1 });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].code).toBe('unrecognized_keys');
      expect(r.error.issues[0].message).toContain('bogus_column');
    }
  });

  it('rejects a wrong enum for generation_engine', () => {
    const r = ShiftTypeUpsertSchema.safeParse({ ...UI_SHIFT_TYPE_BODY, generation_engine: 'magic' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map(i => i.path.join('.'))).toContain('generation_engine');
    }
  });

  it('requires site_id, name and code', () => {
    for (const key of ['site_id', 'name', 'code'] as const) {
      const body: Record<string, unknown> = { ...UI_SHIFT_TYPE_BODY };
      delete body[key];
      const r = ShiftTypeUpsertSchema.safeParse(body);
      expect(r.success, `missing ${key} must fail`).toBe(false);
    }
  });

  it('rejects a wrong enum for category', () => {
    const r = ShiftTypeUpsertSchema.safeParse({ ...UI_SHIFT_TYPE_BODY, category: 'night' });
    expect(r.success).toBe(false);
  });
});

describe('ShiftTypePatchSchema', () => {
  it('accepts a partial update (single field)', () => {
    expect(ShiftTypePatchSchema.safeParse({ is_active: false }).success).toBe(true);
  });

  it('accepts the full UI body (modal PATCHes the whole form)', () => {
    expect(ShiftTypePatchSchema.safeParse(UI_SHIFT_TYPE_BODY).success).toBe(true);
  });

  it('still rejects unknown keys', () => {
    expect(ShiftTypePatchSchema.safeParse({ bogus_column: 1 }).success).toBe(false);
  });

  it('still rejects wrong enums', () => {
    expect(ShiftTypePatchSchema.safeParse({ generation_engine: 'magic' }).success).toBe(false);
  });
});

describe('RuleDefinitionUpsertSchema', () => {
  it('accepts the exact UI POST payload', () => {
    const r = RuleDefinitionUpsertSchema.safeParse(UI_RULE_DEFINITION_BODY);
    expect(r.success).toBe(true);
  });

  it('requires rule_set_id, rule_name and rule_category', () => {
    for (const key of ['rule_set_id', 'rule_name', 'rule_category'] as const) {
      const body: Record<string, unknown> = { ...UI_RULE_DEFINITION_BODY };
      delete body[key];
      const r = RuleDefinitionUpsertSchema.safeParse(body);
      expect(r.success, `missing ${key} must fail`).toBe(false);
    }
  });

  it('rejects unknown top-level keys', () => {
    const r = RuleDefinitionUpsertSchema.safeParse({ ...UI_RULE_DEFINITION_BODY, sneaky: true });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].code).toBe('unrecognized_keys');
      expect(r.error.issues[0].message).toContain('sneaky');
    }
  });

  it('rejects an invalid rule_category', () => {
    const r = RuleDefinitionUpsertSchema.safeParse({ ...UI_RULE_DEFINITION_BODY, rule_category: 'vibes' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map(i => i.path.join('.'))).toContain('rule_category');
    }
  });
});

describe('RuleDefinitionPatchSchema', () => {
  it('accepts the is_active toggle the rules page sends', () => {
    expect(RuleDefinitionPatchSchema.safeParse({ is_active: false }).success).toBe(true);
  });

  it('accepts the full UI body (modal PATCHes the whole form)', () => {
    expect(RuleDefinitionPatchSchema.safeParse(UI_RULE_DEFINITION_BODY).success).toBe(true);
  });

  it('still rejects unknown keys', () => {
    expect(RuleDefinitionPatchSchema.safeParse({ sneaky: true }).success).toBe(false);
  });
});

describe('formatZodIssues', () => {
  it('produces the {error, issues:[{path,message,code}]} 400 envelope', () => {
    const r = ShiftTypeUpsertSchema.safeParse({ ...UI_SHIFT_TYPE_BODY, generation_engine: 'magic' });
    expect(r.success).toBe(false);
    if (r.success) return;
    const env = formatZodIssues(r.error);
    expect(typeof env.error).toBe('string');
    expect(env.error.length).toBeGreaterThan(0);
    expect(Array.isArray(env.issues)).toBe(true);
    expect(env.issues[0]).toEqual({
      path: 'generation_engine',
      message: expect.any(String),
      code: expect.any(String),
    });
  });
});
