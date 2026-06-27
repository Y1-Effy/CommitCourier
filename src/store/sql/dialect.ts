/**
 * SQL dialect seam for the relational store family.
 *
 * The Postgres-specific SQL — the claim CTE, the existence probe used by `diagnose()`, and the
 * DDL — lives behind this interface so the dialect can be swapped without touching the shared
 * relational plumbing in `../_shared` or the driver adapters (`pg`, `knex`). Adding a new SQL
 * engine (MySQL, SQLite, …) means adding one more {@link SqlDialect} implementation.
 *
 * NoSQL stores (e.g. MongoDB) do NOT use this seam: they implement the `Store` port in
 * `../store` directly, without any SQL.
 */

/** The Postgres-family SQL a store adapter needs, isolated from the shared row/column plumbing. */
export interface SqlDialect {
  /** Human-readable dialect name (e.g. `"postgres"`). */
  readonly name: string;
  /**
   * The claim statement (atomic `SELECT ... FOR UPDATE SKIP LOCKED` then `UPDATE ... RETURNING`),
   * rendered for each driver's placeholder convention:
   * - `numbered`: `$1, $2, …` (node-postgres), bindings `[now, limit, lockedBy]` ($1 reused).
   * - `qmark`: positional `?` (knex.raw), bindings `[now, limit, now, lockedBy]`.
   */
  readonly claimSql: { readonly numbered: string; readonly qmark: string };
  /**
   * Opt-in per-endpoint FIFO claim (v1.1). Same atomic shape as {@link claimSql}, but claims at most
   * the single oldest due row per registered endpoint and only when that endpoint has no earlier
   * non-terminal row in flight or awaiting retry — so deliveries to one endpoint stay strictly
   * ordered. Inline (null-endpoint) rows are unaffected (claimed as in {@link claimSql}). Bindings:
   * - `numbered`: `[now, limit, lockedBy]` ($1 reused for every `now` slot).
   * - `qmark`: `[now, now, limit, now, lockedBy]` (`now` appears in two filters and the SET).
   */
  readonly claimSqlPerEndpoint: { readonly numbered: string; readonly qmark: string };
  /** Object-existence probe whose result row is consumed by the shared diagnose helpers. */
  readonly diagnoseSql: string;
}
