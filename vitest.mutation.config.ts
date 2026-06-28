import { defineConfig } from "vitest/config";

import { rawSql } from "./vitest.config";

// Dedicated vitest config for Stryker mutation testing. Stryker's vitest-runner executes *every*
// project found in the resolved config, so reusing vitest.config.ts would spin up the Docker-backed
// `integration` project (testcontainers / real Postgres) and re-run the `unit` typecheck (tsc) on
// every mutant — both irrelevant to the pure `src/core/**` mutants and ruinously slow. This is a
// single flat project: just the Docker-free unit suite, no typecheck, no coverage.
export default defineConfig({
  plugins: [rawSql],
  test: {
    name: "mutation",
    include: ["test/unit/**/*.test.ts"],
    environment: "node",
    // No `typecheck`, no `coverage`, no `integration` project: none help detect core mutants.
  },
});
