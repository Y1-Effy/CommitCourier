/**
 * Prisma adapter. `prismaStore({ prisma })`.
 *
 * `TTx = PrismaTx` (a Prisma interactive-transaction client): `insertOutbox` runs on the caller's
 * `prisma.$transaction(async (tx) => …)` client and joins the user's TX (fail-closed); dispatch/admin
 * methods use the injected client directly. Prisma speaks Postgres, so the adapter reuses the exact
 * Postgres dialect SQL and the shared Store semantics ({@link createSqlStore}) — only the execution
 * seam differs: raw SQL runs via `$queryRawUnsafe` / `$executeRawUnsafe` (which keep the `$n`
 * placeholders, so the dialect SQL is passed verbatim with positional values).
 *
 * Prisma is typed structurally here (no `@prisma/client` import) so this module builds without Prisma
 * installed; `@prisma/client` is an optional peer dependency. jsonb params are stringified (Prisma
 * binds them as text and the `::jsonb` cast in the SQL converts them) via the executor's `jsonAsText`.
 */
import type { Store } from "./store";
import { createSqlStore, type SqlExecutor } from "./sql-store";
import {
  applyMigrations,
  migrationScript,
  splitStatements,
  ADVISORY_LOCK_SQL,
  MIGRATIONS_TABLE_DDL,
  SELECT_APPLIED_MIGRATIONS_SQL,
} from "./_shared";

/** The Prisma raw-query surface the adapter uses (a `PrismaClient` or its transaction client). */
export interface PrismaRaw {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T[]>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

/** A Prisma client: raw queries plus interactive transactions. */
export interface PrismaClientLike extends PrismaRaw {
  $transaction<T>(fn: (tx: PrismaRaw) => Promise<T>): Promise<T>;
}

/** The interactive-transaction client Prisma passes to `$transaction` (the `enqueue` TTx). */
export type PrismaTx = PrismaRaw;

/**
 * Build a {@link Store} backed by Prisma. `enqueue(trx, …)` takes a Prisma interactive-transaction
 * client so the outbox write rides the caller's transaction (fail-closed); dispatch/admin methods
 * use the injected client. Semantics match the `pg` adapter (same dialect SQL).
 *
 * @param opts - Holds the `PrismaClient` (the `@prisma/client` peer dependency must be installed).
 * @returns A `Store<PrismaTx>` to pass to `createRelay`.
 */
export function prismaStore(opts: { prisma: PrismaClientLike }): Store<PrismaTx> {
  const { prisma } = opts;

  // Prisma binds jsonb params as text against the SQL's `::jsonb` cast (jsonAsText), runs reads via
  // `$queryRawUnsafe` and writes via `$executeRawUnsafe` (both keep `$n` placeholders, spread values).
  const exec: SqlExecutor<PrismaTx> = {
    jsonAsText: true,
    query<R>(text: string, params: readonly unknown[]) {
      return prisma.$queryRawUnsafe<R>(text, ...params);
    },
    execute(text, params) {
      return prisma.$executeRawUnsafe(text, ...params);
    },
    async insertOnTx(trx, text, params) {
      await trx.$executeRawUnsafe(text, ...params);
    },
    withTx(fn) {
      return prisma.$transaction(fn);
    },
  };

  return createSqlStore(exec, async () => {
    await applyMigrations({
      // Prisma cannot run a multi-statement string, so take the advisory lock and create the table
      // as two statements inside one interactive transaction (lock held through the CREATE), which
      // serialises concurrent migrators.
      ensureTable: () =>
        prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(ADVISORY_LOCK_SQL);
          await tx.$executeRawUnsafe(MIGRATIONS_TABLE_DDL);
        }),
      appliedNames: async () => {
        const rows = await prisma.$queryRawUnsafe<{ name: string }>(SELECT_APPLIED_MIGRATIONS_SQL);
        return new Set(rows.map((r) => r.name));
      },
      // Prisma runs one statement per raw call, so split the script (advisory lock + DDL + record
      // INSERT) and apply it in order inside one interactive transaction (the lock lands first).
      apply: (m) =>
        prisma.$transaction(async (tx) => {
          for (const statement of splitStatements(migrationScript(m))) {
            await tx.$executeRawUnsafe(statement);
          }
        }),
    });
  });
}
