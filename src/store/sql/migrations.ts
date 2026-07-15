/**
 * Migration tracking. A lightweight version table records which migration scripts have been applied,
 * so `migrate()` applies only the not-yet-applied ones in order. v1's whole schema is `001_init`;
 * future schema changes append `00N_*` entries to {@link MIGRATIONS}. Every migration's DDL is itself
 * idempotent (IF NOT EXISTS), so an existing deployment that pre-dates the tracking table is brought
 * into line safely: the table is created, `001_init` is seen as unapplied and re-run (a no-op against
 * the existing schema), then recorded.
 */
import initSql from "./001_init.sql";
import sinkTargetlessSql from "./002_sink_targetless.sql";
import listPruneIndexesSql from "./003_list_prune_indexes.sql";
import endpointCustomHeadersSql from "./004_endpoint_custom_headers.sql";

export const MIGRATIONS_TABLE = "commitcourier_migrations";

/** Tracking table DDL (idempotent), created before any migration is applied. */
export const MIGRATIONS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

/**
 * Fixed advisory-lock key (a 32-bit int, "cmig") serialising concurrent `migrate()` calls. Postgres
 * `IF NOT EXISTS` DDL is NOT concurrency-safe — N replicas migrating a fresh schema at once can hit
 * `tuple concurrently updated` / a `pg_type` unique violation / a deadlock. Acquiring this transaction
 * lock first makes the schema-changing statements run one transaction at a time; the loser then finds
 * everything already created/recorded and no-ops.
 */
export const MIGRATION_LOCK_KEY = 0x636d6967;

/**
 * Acquire the migration advisory lock for the current transaction (released on commit/rollback).
 * Run as the first statement of every transaction that creates schema (the tracking table and each
 * migration's apply), so concurrent migrators serialise.
 */
export const ADVISORY_LOCK_SQL = `SELECT pg_advisory_xact_lock(${String(MIGRATION_LOCK_KEY)})`;

/** Read the applied migration names. */
export const SELECT_APPLIED_MIGRATIONS_SQL = `SELECT name FROM ${MIGRATIONS_TABLE}`;

/** One ordered migration: a name plus its idempotent DDL script. */
export interface Migration {
  name: string;
  sql: string;
}

/** A safe migration name (used inline in the record statement); guards against future foot-guns. */
const MIGRATION_NAME_RE = /^[0-9a-z_]+$/;

/** The ordered migration list. Append `00N_*` entries here for future schema changes. */
export const MIGRATIONS: readonly Migration[] = [
  { name: "001_init", sql: initSql },
  // 002: drop the target CHECK so the `sink` transport can enqueue target-less rows.
  { name: "002_sink_targetless", sql: sinkTargetlessSql },
  // 003: partial indexes over terminal rows for the admin list (listOutbox) and retention prune.
  { name: "003_list_prune_indexes", sql: listPruneIndexesSql },
  // 004: per-endpoint custom HTTP headers (webhook_endpoints.custom_headers).
  { name: "004_endpoint_custom_headers", sql: endpointCustomHeadersSql },
];

/**
 * The tracking-table create as a single multi-statement script that first takes the advisory lock,
 * so concurrent `ensureTable` calls serialise (the multi-statement adapters run this as one implicit
 * transaction). Prisma cannot run a multi-statement string, so it runs the lock + DDL itself inside a
 * `$transaction` (see the prisma adapter); this script is for the pg/knex/drizzle adapters.
 */
export function migrationsTableScript(): string {
  return `${ADVISORY_LOCK_SQL};\n${MIGRATIONS_TABLE_DDL}`;
}

/**
 * Build the apply script for one migration: the advisory lock, then its DDL, then the record INSERT,
 * as a single multi-statement script. Postgres runs a multi-statement simple query as one implicit
 * transaction, so the lock is held through the schema change and the bookkeeping commits atomically
 * (the pg/knex/drizzle adapters run this verbatim; Prisma splits it into per-statement calls inside an
 * explicit transaction, where the lock statement lands first). The name is an internal constant
 * matching {@link MIGRATION_NAME_RE}, so inlining it as a literal is safe.
 */
export function migrationScript(m: Migration): string {
  if (!MIGRATION_NAME_RE.test(m.name)) {
    throw new Error(`invalid migration name: "${m.name}"`);
  }
  const ddl = m.sql.trim().replace(/;\s*$/, "");
  return `${ADVISORY_LOCK_SQL};\n${ddl};\nINSERT INTO ${MIGRATIONS_TABLE} (name) VALUES ('${m.name}') ON CONFLICT (name) DO NOTHING`;
}

/**
 * Split an idempotent DDL/migration script into individual statements for adapters that run one
 * statement per call (Prisma). Line comments (`-- …`) are stripped first so a comment preceding a
 * statement is not mistaken for it (the scripts have no `--`/`;` inside string literals).
 */
export function splitStatements(script: string): string[] {
  const noComments = script
    .split("\n")
    .map((line) => {
      const i = line.indexOf("--");
      return i >= 0 ? line.slice(0, i) : line;
    })
    .join("\n");
  return noComments
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Run the migration protocol against an adapter's primitives: ensure the tracking table, read the
 * applied set, then apply each not-yet-applied migration in order. Idempotent and safe to re-run:
 * each migration's DDL is idempotent, the apply is atomic, and the record uses ON CONFLICT DO NOTHING.
 */
export async function applyMigrations(deps: {
  ensureTable: () => Promise<void>;
  appliedNames: () => Promise<Set<string>>;
  apply: (m: Migration) => Promise<void>;
}): Promise<void> {
  await deps.ensureTable();
  const applied = await deps.appliedNames();
  for (const m of MIGRATIONS) {
    if (!applied.has(m.name)) await deps.apply(m);
  }
}
