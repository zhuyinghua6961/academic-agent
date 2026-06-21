import type {Pool, QueryResult} from "pg";
import deasync from "deasync";

export function querySync(pool: Pool, text: string, values: unknown[] = []): QueryResult {
  let done = false;
  let result!: QueryResult;
  let error: Error | undefined;
  void pool.query(text, values).then(
    (res) => {
      result = res;
      done = true;
    },
    (err: Error) => {
      error = err;
      done = true;
    },
  );
  deasync.loopWhile(() => !done);
  if (error) {
    throw error;
  }
  return result;
}

export function queryRows(pool: Pool, text: string, values: unknown[] = []): Record<string, unknown>[] {
  return querySync(pool, text, values).rows as Record<string, unknown>[];
}

export function queryOne(
  pool: Pool,
  text: string,
  values: unknown[] = [],
): Record<string, unknown> | undefined {
  const rows = queryRows(pool, text, values);
  return rows[0];
}
