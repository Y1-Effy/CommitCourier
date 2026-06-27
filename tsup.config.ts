import { defineConfig } from "tsup";

// The DDL (src/store/sql/001_init.sql) is imported as a string and embedded into the bundle via
// esbuild's `text` loader, so migrate() needs no runtime file I/O and the dist stays self-contained.
const sqlLoader = (options: { loader?: Record<string, string> }): void => {
  options.loader = { ...options.loader, ".sql": "text" };
};

export default defineConfig([
  {
    // Library: multiple entries matching the subpath exports (00-overview section 3).
    // src/core/index.ts is the third-party-dependency-free, cross-runtime pure domain layer.
    entry: [
      "src/index.ts",
      "src/core/index.ts",
      "src/store/pg.ts",
      "src/store/knex.ts",
      "src/store/drizzle.ts",
      "src/store/prisma.ts",
      "src/otel/index.ts",
      // Optional Postgres LISTEN/NOTIFY accelerator (07-accelerator). A future BullMQ accelerator would
      // add `src/accelerator/bullmq.ts` here under the same `Accelerator` seam.
      "src/accelerator/pg.ts",
    ],
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    sourcemap: true,
    target: "node20",
    shims: true,
    esbuildOptions: sqlLoader,
  },
  {
    // CLI bin (`commitcourier`): ESM only, with a shebang so it is directly executable. No types.
    entry: ["src/cli.ts"],
    format: ["esm"],
    dts: false,
    sourcemap: true,
    target: "node20",
    shims: true,
    banner: { js: "#!/usr/bin/env node" },
    esbuildOptions: sqlLoader,
  },
]);
