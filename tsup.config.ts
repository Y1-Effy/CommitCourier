import { defineConfig } from "tsup";
import { copyFileSync, mkdirSync } from "node:fs";

export default defineConfig({
  // Multiple entries matching the subpath exports (00-overview section 3).
  // src/core/index.ts is the third-party-dependency-free, cross-runtime pure domain layer.
  entry: ["src/index.ts", "src/core/index.ts", "src/store/pg.ts", "src/store/knex.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
  // Provide a real `import.meta.url` in the CJS output so _shared.ts can resolve the DDL file
  // (and a `__dirname` shim in ESM). Without this, the CJS build's import.meta.url is undefined.
  shims: true,
  // migrate() reads sql/001_init.sql at runtime relative to the bundled module, so copy the
  // DDL alongside the store output (dist/store/sql/001_init.sql).
  onSuccess: async () => {
    mkdirSync("dist/store/sql", { recursive: true });
    copyFileSync("src/store/sql/001_init.sql", "dist/store/sql/001_init.sql");
  },
});
