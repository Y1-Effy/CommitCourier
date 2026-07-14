/**
 * Shared plumbing for the relational (SQL) store family — a barrel over the focused `./sql/*`
 * modules. The Postgres-specific SQL (claim CTE, `to_regclass` probe, DDL script) lives behind the
 * dialect seam in {@link "./sql/dialect"} / {@link "./sql/postgres"}; this surface holds only the
 * driver- and dialect-agnostic plumbing, split by concern:
 *
 * - `./sql/constants`      — table/status names, list limits and their clamps
 * - `./sql/migrations`     — the migration version table and apply protocol
 * - `./sql/row-mappers`    — snake_case driver rows ↔ camelCase domain objects
 * - `./sql/columns`        — column lists and INSERT/patch/transition value flattening
 * - `./sql/query-builders` — SQL string builders/constants, list queries, and result folders
 * - `./sql/placeholders`   — numbered (`$n`) to positional (`?`) translation for the knex adapter
 *
 * Adapters and the admin/cli/test layers import from here so they keep a single store-local entry
 * point; new code may import the focused module directly.
 */
export * from "./sql/constants";
export * from "./sql/migrations";
export * from "./sql/row-mappers";
export * from "./sql/columns";
export * from "./sql/query-builders";
export * from "./sql/placeholders";

/** Re-exported so the store adapters keep importing `newId` from a single store-local module. */
export { newId } from "../id";
