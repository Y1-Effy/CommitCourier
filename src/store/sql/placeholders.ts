/**
 * Placeholder translation for adapters that bind positional `?` (qmark) rather than numbered `$n`.
 *
 * {@link createSqlStore} emits Postgres `$n` SQL with an ordered param array. The knex adapter binds
 * positional `?` via `knex.raw`, so it translates that SQL just before execution. Mirrors the
 * drizzle adapter's `toSql` (which scans `$n` for its own bind format).
 */

/**
 * Render numbered (`$n`) SQL plus its ordered params as positional qmark (`?`) SQL and bindings for
 * `knex.raw`. Each `$n` occurrence emits one `?` bound to `params[n-1]` in textual order, so a reused
 * placeholder (e.g. the claim CTE's `$1`, the breaker UPDATE's `$2`) binds the same value again —
 * which is exactly how positional `?` binding works. Safe for the store's SQL because it contains no
 * jsonb `?` operators and no `$` inside string literals (only `$n` placeholders and `::type` casts).
 *
 * @param sql - Numbered (`$1`, `$2`, …) SQL as built by the shared SQL plumbing.
 * @param params - Ordered params indexed by placeholder number (`$n` -> `params[n-1]`).
 * @returns The qmark SQL and the positional bindings in textual order.
 */
export function numberedToQmark(
  sql: string,
  params: readonly unknown[],
): { sql: string; bindings: unknown[] } {
  const bindings: unknown[] = [];
  const out = sql.replace(/\$(\d+)/g, (_m, n: string) => {
    bindings.push(params[Number(n) - 1]);
    return "?";
  });
  return { sql: out, bindings };
}
