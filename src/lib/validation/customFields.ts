// Validation for provider custom-field definitions and values.

export const CUSTOM_FIELD_TYPES = ['text', 'number', 'boolean', 'select', 'multiselect', 'date'] as const;
export type CustomFieldType = typeof CUSTOM_FIELD_TYPES[number];

// field_name is used as a stable key and can be referenced by rules, so we
// restrict it to a slug-like format rather than an arbitrary string.
const FIELD_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

export interface CustomFieldDefinitionInput {
  organization_id?: unknown;
  field_name?: unknown;
  display_label?: unknown;
  field_type?: unknown;
  options?: unknown;
  required?: unknown;
  applies_to_provider_types?: unknown;
  applies_to_sites?: unknown;
  is_active?: unknown;
  display_order?: unknown;
  admin_only?: unknown;
}

export type DefinitionValidation =
  | { ok: true; row: Record<string, unknown> }
  | { ok: false; error: string };

export function validateDefinition(
  body: CustomFieldDefinitionInput,
  { partial = false }: { partial?: boolean } = {},
): DefinitionValidation {
  const row: Record<string, unknown> = {};

  if (!partial) {
    if (typeof body.organization_id !== 'string' || !body.organization_id) {
      return { ok: false, error: 'organization_id is required' };
    }
    row.organization_id = body.organization_id;
  }

  if (body.field_name !== undefined) {
    if (typeof body.field_name !== 'string' || !FIELD_NAME_RE.test(body.field_name)) {
      return { ok: false, error: 'field_name must be a slug: lowercase letters, digits, underscores; start with a letter; max 64 chars' };
    }
    row.field_name = body.field_name;
  } else if (!partial) {
    return { ok: false, error: 'field_name is required' };
  }

  if (body.display_label !== undefined) {
    if (typeof body.display_label !== 'string' || !body.display_label.trim()) {
      return { ok: false, error: 'display_label is required' };
    }
    row.display_label = body.display_label.trim();
  } else if (!partial) {
    return { ok: false, error: 'display_label is required' };
  }

  if (body.field_type !== undefined) {
    if (typeof body.field_type !== 'string' || !(CUSTOM_FIELD_TYPES as readonly string[]).includes(body.field_type)) {
      return { ok: false, error: `field_type must be one of: ${CUSTOM_FIELD_TYPES.join(', ')}` };
    }
    row.field_type = body.field_type;
  }

  if (body.options !== undefined) {
    if (!Array.isArray(body.options)) {
      return { ok: false, error: 'options must be an array of strings' };
    }
    const clean = body.options.filter((o): o is string => typeof o === 'string' && o.trim() !== '').map(s => s.trim());
    row.options = clean;
  }

  if (body.required !== undefined) {
    if (typeof body.required !== 'boolean') return { ok: false, error: 'required must be a boolean' };
    row.required = body.required;
  }
  if (body.is_active !== undefined) {
    if (typeof body.is_active !== 'boolean') return { ok: false, error: 'is_active must be a boolean' };
    row.is_active = body.is_active;
  }
  if (body.admin_only !== undefined) {
    if (typeof body.admin_only !== 'boolean') return { ok: false, error: 'admin_only must be a boolean' };
    row.admin_only = body.admin_only;
  }
  if (body.display_order !== undefined) {
    const n = Number(body.display_order);
    if (!Number.isInteger(n) || n < 0) return { ok: false, error: 'display_order must be a non-negative integer' };
    row.display_order = n;
  }

  if (body.applies_to_provider_types !== undefined) {
    if (!Array.isArray(body.applies_to_provider_types)) {
      return { ok: false, error: 'applies_to_provider_types must be an array' };
    }
    row.applies_to_provider_types = body.applies_to_provider_types.filter((x): x is string => typeof x === 'string');
  }
  if (body.applies_to_sites !== undefined) {
    if (!Array.isArray(body.applies_to_sites)) {
      return { ok: false, error: 'applies_to_sites must be an array' };
    }
    row.applies_to_sites = body.applies_to_sites.filter((x): x is string => typeof x === 'string');
  }

  // select/multiselect must have options.
  const finalType = (row.field_type ?? body.field_type) as string | undefined;
  if ((finalType === 'select' || finalType === 'multiselect') && Array.isArray(row.options) && row.options.length === 0) {
    return { ok: false, error: 'select and multiselect fields require at least one option' };
  }

  return { ok: true, row };
}

// Cast an incoming JSON value to match the definition's field_type. Returns
// the normalized jsonb-friendly value or an error string.
export function coerceValue(fieldType: string, value: unknown, options: string[] = []): { ok: true; value: unknown } | { ok: false; error: string } {
  if (value === null || value === undefined || value === '') return { ok: true, value: null };

  switch (fieldType) {
    case 'text':
      if (typeof value !== 'string') return { ok: false, error: 'expected a string' };
      return { ok: true, value };
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) return { ok: false, error: 'expected a number' };
      return { ok: true, value: n };
    }
    case 'boolean':
      if (typeof value !== 'boolean') return { ok: false, error: 'expected a boolean' };
      return { ok: true, value };
    case 'date': {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return { ok: false, error: 'expected YYYY-MM-DD' };
      }
      return { ok: true, value };
    }
    case 'select':
      if (typeof value !== 'string') return { ok: false, error: 'expected a string' };
      if (options.length && !options.includes(value)) return { ok: false, error: `must be one of: ${options.join(', ')}` };
      return { ok: true, value };
    case 'multiselect':
      if (!Array.isArray(value)) return { ok: false, error: 'expected an array' };
      for (const v of value) {
        if (typeof v !== 'string') return { ok: false, error: 'expected an array of strings' };
        if (options.length && !options.includes(v)) return { ok: false, error: `values must be from: ${options.join(', ')}` };
      }
      return { ok: true, value };
    default:
      return { ok: false, error: `unknown field_type: ${fieldType}` };
  }
}
