// Stateful in-memory supabase fake for board snapshot/revert round-trips.
//
// The call-recording fake (rulesEngine/__fixtures__/fakeSupabase.ts) records
// writes but never applies them — perfect for asserting query shapes, useless
// for "mutate → revert → deep-equals the seed". This fake actually APPLIES
// insert/upsert/update/delete to in-memory tables so the round-trip can compare
// real before/after state. It supports exactly the query shapes the board
// executors + snapshot module use: select (with eq/in/order + embed-string
// passthrough), single/maybeSingle, insert/upsert (onConflict), update, delete,
// and awaiting the builder directly (thenable). failNext(table, op) injects a
// one-shot error for partial-failure tests.
//
// Deliberately NOT modeled (kept dumb on purpose — assert around these):
// - PK/unique-constraint enforcement on plain insert: duplicate ids happily
//   coexist, so retry-idempotency tests must deep-equal full table state (a
//   duplicated row WOULD show up there) rather than trust the fake to reject it;
// - PostgREST embeds: select() args are ignored entirely, every row comes back
//   whole (no `staff(*)` joins);
// - order(): a no-op — sort in the assertion (dump() sorts by id).
type Row = Record<string, unknown>;
export type Op = 'select' | 'insert' | 'upsert' | 'update' | 'delete';
interface Filter {
  kind: 'eq' | 'in';
  col: string;
  val: unknown;
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

export function makeStatefulSupabase(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [k, v] of Object.entries(seed)) tables[k] = clone(v);
  let seq = 1;
  const genId = () => `gen-${seq++}`;

  // One-shot error injection: the NEXT operation matching (table, op) resolves
  // with an error (and applies nothing), then the trigger clears itself.
  let pendingFailure: { table: string; op: Op } | null = null;
  function failNext(table: string, op: Op): void {
    pendingFailure = { table, op };
  }

  const rowsOf = (t: string): Row[] => (tables[t] ??= []);

  function matches(row: Row, filters: Filter[]): boolean {
    return filters.every((f) =>
      f.kind === 'eq' ? row[f.col] === f.val : Array.isArray(f.val) && (f.val as unknown[]).includes(row[f.col]),
    );
  }

  function conflictKey(row: Row, cols: string[]): string {
    return cols.map((c) => String(row[c])).join('\x00');
  }

  function makeBuilder(table: string) {
    let op: Op = 'select';
    let payload: Row | Row[] | null = null;
    let onConflict: string[] = [];
    const filters: Filter[] = [];

    function resolve(): { data: unknown; error: unknown } {
      if (pendingFailure && pendingFailure.table === table && pendingFailure.op === op) {
        pendingFailure = null;
        return { data: null, error: { message: `injected ${op} failure on ${table}` } };
      }
      const rows = rowsOf(table);
      if (op === 'select') {
        return { data: clone(rows.filter((r) => matches(r, filters))), error: null };
      }
      if (op === 'delete') {
        const kept: Row[] = [];
        for (const r of rows) if (!matches(r, filters)) kept.push(r);
        tables[table] = kept;
        return { data: null, error: null };
      }
      if (op === 'update') {
        const patch = payload as Row;
        const updated: Row[] = [];
        for (const r of rows) {
          if (matches(r, filters)) {
            Object.assign(r, clone(patch));
            updated.push(r);
          }
        }
        return { data: clone(updated), error: null };
      }
      // insert / upsert
      const incoming = (Array.isArray(payload) ? payload : [payload]).filter(Boolean) as Row[];
      const written: Row[] = [];
      for (const raw of incoming) {
        const row = clone(raw);
        if (op === 'upsert' && onConflict.length > 0) {
          const key = conflictKey(row, onConflict);
          const existing = rows.find((r) => conflictKey(r, onConflict) === key);
          if (existing) {
            if (row.id == null && existing.id != null) row.id = existing.id;
            Object.assign(existing, row);
            written.push(existing);
            continue;
          }
        }
        if (row.id == null) row.id = genId();
        rows.push(row);
        written.push(row);
      }
      return { data: clone(written), error: null };
    }

    const builder: Record<string, unknown> = {};
    builder.select = () => builder; // op stays put; embed string ignored
    builder.order = () => builder;
    builder.eq = (col: string, val: unknown) => {
      filters.push({ kind: 'eq', col, val });
      return builder;
    };
    builder.in = (col: string, val: unknown) => {
      filters.push({ kind: 'in', col, val });
      return builder;
    };
    builder.insert = (p: Row | Row[]) => {
      op = 'insert';
      payload = p;
      return builder;
    };
    builder.upsert = (p: Row | Row[], opts?: { onConflict?: string }) => {
      op = 'upsert';
      payload = p;
      onConflict = opts?.onConflict ? opts.onConflict.split(',') : [];
      return builder;
    };
    builder.update = (p: Row) => {
      op = 'update';
      payload = p;
      return builder;
    };
    builder.delete = () => {
      op = 'delete';
      return builder;
    };
    builder.single = () => {
      const { data, error } = resolve();
      const one = Array.isArray(data) ? (data[0] ?? null) : data;
      return Promise.resolve({ data: one, error });
    };
    builder.maybeSingle = () => {
      const { data, error } = resolve();
      const one = Array.isArray(data) ? (data[0] ?? null) : data;
      return Promise.resolve({ data: one, error });
    };
    builder.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(resolve()).then(onF, onR);
    return builder;
  }

  const sb = {
    from: (table: string) => makeBuilder(table),
  };

  // Read a table's current in-memory rows (sorted by id) for assertions.
  function dump(table: string): Row[] {
    return clone(rowsOf(table)).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }

  return { sb, dump, tables, failNext };
}
