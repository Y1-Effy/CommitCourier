import { defineConfig } from "tsup";

export default defineConfig({
  // Multiple entries matching the subpath exports (00-overview section 3).
  // src/core/index.ts is the third-party-dependency-free, cross-runtime pure domain layer.
  entry: ["src/index.ts", "src/core/index.ts", "src/store/pg.ts", "src/store/knex.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node18",
  // SQL files must be copied into dist (migrate() reads them). Adjust publicDir/loader during implementation.
});
