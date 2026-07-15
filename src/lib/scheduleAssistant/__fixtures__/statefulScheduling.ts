// Stateful in-memory supabase fake for scheduleAssistant snapshot/revert
// round-trips (assistant-intake). The call-recording fake
// (rulesEngine/__fixtures__/fakeSupabase.ts) records writes but never APPLIES
// them — right for asserting query shapes, useless for "mutate → revert →
// deep-equals the seed". This fake actually applies insert/upsert/update/delete
// to in-memory tables and supports the query shapes the intake executors +
// snapshot module use: select (embed string ignored), eq / in / gte / lte
// filters, order (no-op), single/maybeSingle, insert, upsert(onConflict),
// update, delete, and awaiting the builder directly (thenable).
//
// Modeled on boardAssistant/__fixtures__/statefulBoard.ts; adds gte/lte range
// filters (ISO date strings compare lexicographically) for the availability
// window. Deliberately dumb (assert AROUND these): no PK enforcement on plain
// insert (a duplicated id would show up in a full-table deep-equal), no
// PostgREST embeds, order() is a no-op.
type Row = Record<string, unknown>;
type Op = 'select' | 'insert' | 'upsert' | 'update' | 'delete';
interface Filter {
  kind: 'eq' | 'in' | 'gte' | 'lte';
  col: string;
  val: unknown;
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

export function makeStatefulSupabase(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [k, v] of Object.entries(seed)) tables[k] = clone(v);
  let seq = 1;
  const genId = () => `gen-${seq++}`;

  const rowsOf = (t: string): Row[] => (tables[t] ??= []);

  function matches(row: Row, filters: Filter[]): boolean {
    return filters.every((f) => {
      const cell = row[f.col];
      if (f.kind === 'eq') return cell === f.val;
      if (f.kind === 'in') return Array.isArray(f.val) && (f.val as unknown[]).includes(cell);
      if (f.kind === 'gte') return String(cell) >= String(f.val);
      return String(cell) <= String(f.val); // lte
    });
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
      const rows = rowsOf(table);
      if (op === 'select') {
        return { data: clone(rows.filter((r) => matches(r, filters))), error: null };
      }
      if (op === 'delete') {
        tables[table] = rows.filter((r) => !matches(r, filters));
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
    builder.eq = (col: string, val: unknown) => { filters.push({ kind: 'eq', col, val }); return builder; };
    builder.in = (col: string, val: unknown) => { filters.push({ kind: 'in', col, val }); return builder; };
    builder.gte = (col: string, val: unknown) => { filters.push({ kind: 'gte', col, val }); return builder; };
    builder.lte = (col: string, val: unknown) => { filters.push({ kind: 'lte', col, val }); return builder; };
    builder.insert = (p: Row | Row[]) => { op = 'insert'; payload = p; return builder; };
    builder.upsert = (p: Row | Row[], opts?: { onConflict?: string }) => {
      op = 'upsert'; payload = p; onConflict = opts?.onConflict ? opts.onConflict.split(',') : [];
      return builder;
    };
    builder.update = (p: Row) => { op = 'update'; payload = p; return builder; };
    builder.delete = () => { op = 'delete'; return builder; };
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

  const sb = { from: (table: string) => makeBuilder(table) };

  // Read a table's current in-memory rows (sorted by id) for assertions.
  function dump(table: string): Row[] {
    return clone(rowsOf(table)).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }

  return { sb, dump, tables };
}
