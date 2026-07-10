// Chainable call-recording fake supabase client for DB-coupled rulesEngine
// tests. Copies the idiom from genContext.test.ts and extends it with write
// methods (update/upsert/insert/delete) plus a recorded 'from' call so tests
// can count round-trips.
//
// Table config is either a canned {data,error} or a function of the recorded
// filters (lets one table serve multiple query shapes — e.g. serial
// loadContext hits schedule_slots twice with different filters).

export type Canned = { data?: unknown; error?: unknown };
export type Filter = { method: string; args: unknown[] };
export type TableCfg = Canned | ((filters: Filter[]) => Canned);
export interface RecordedCall { table?: string; fn?: string; method: string; args: unknown[] }

const CHAIN_METHODS = [
  'select', 'eq', 'neq', 'in', 'or', 'lt', 'lte', 'gte', 'gt', 'order', 'limit',
  'update', 'upsert', 'insert', 'delete',
] as const;

export function makeFakeSupabase(
  config: { tables?: Record<string, TableCfg>; rpc?: Record<string, Canned> } = {},
) {
  const calls: RecordedCall[] = [];
  const tables = config.tables ?? {};
  const rpcCfg = config.rpc ?? {};

  function makeBuilder(table: string) {
    const filters: Filter[] = [];
    const cfg = tables[table];
    const resolve = (): { data: unknown; error: unknown } => {
      const c: Canned = typeof cfg === 'function' ? cfg(filters) : (cfg ?? { data: [], error: null });
      return { data: c.data ?? null, error: c.error ?? null };
    };
    const rec = (method: string, args: unknown[]) => {
      filters.push({ method, args });
      calls.push({ table, method, args });
    };
    const builder: Record<string, unknown> = {};
    for (const m of CHAIN_METHODS) {
      builder[m] = (...args: unknown[]) => { rec(m, args); return builder; };
    }
    builder.single = (...args: unknown[]) => { rec('single', args); return Promise.resolve(resolve()); };
    builder.maybeSingle = (...args: unknown[]) => { rec('maybeSingle', args); return Promise.resolve(resolve()); };
    builder.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(resolve()).then(onF, onR);
    return builder;
  }

  const sb = {
    from: (table: string) => {
      calls.push({ table, method: 'from', args: [] });
      return makeBuilder(table);
    },
    rpc: (fn: string, params: unknown) => {
      calls.push({ fn, method: 'rpc', args: [params] });
      const c = rpcCfg[fn] ?? { data: [], error: null };
      return Promise.resolve({ data: c.data ?? null, error: c.error ?? null });
    },
  };
  return { sb, calls };
}

// Helpers for asserting against the flat call log.
export function fromCount(calls: RecordedCall[], table?: string): number {
  return calls.filter(c => c.method === 'from' && (!table || c.table === table)).length;
}
export function callsFor(calls: RecordedCall[], table: string, method: string): RecordedCall[] {
  return calls.filter(c => c.table === table && c.method === method);
}
