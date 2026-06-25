/**
 * SQL dialect seam for the relational store family (per the store-generalization design).
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
  /** Object-existence probe whose result row is consumed by the shared diagnose helpers. */
  readonly diagnoseSql: string;
  /** The idempotent DDL script applied by `migrate()`. */
  ddl(): string;
}
