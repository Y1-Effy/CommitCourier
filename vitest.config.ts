import { defineConfig, type Plugin } from "vitest/config";

// Load `.sql` files as a default-export string, mirroring the esbuild `text` loader used by the
// tsup build, so source/tests resolve the embedded DDL the same way the bundle does. Declared per
// project because `test.projects` entries do not inherit the root-level `plugins`.
export const rawSql: Plugin = {
  name: "raw-sql",
  // Run before vite's import-analysis so the `.sql` content is turned into JS first.
  enforce: "pre",
  transform(code: string, id: string) {
    if (id.endsWith(".sql")) {
      return { code: `export default ${JSON.stringify(code)};`, map: null };
    }
    return undefined;
  },
};

export default defineConfig({
  plugins: [rawSql],
  test: {
    // Staged coverage thresholds: require thorough coverage for the pure core, moderate overall.
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**"],
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 80,
        // core is I/O-independent pure functions, so require high coverage.
        "src/core/**": {
          lines: 95,
          statements: 95,
          functions: 95,
          branches: 90,
        },
      },
    },
    // Per 06-testing: run the pure core fast in "unit" (no Docker); isolate real
    // Postgres / real HTTP tests into "integration".
    projects: [
      {
        plugins: [rawSql],
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
          environment: "node",
          // Type-level tests (expectTypeOf): check *.test-d.ts with tsc to pin the public types.
          typecheck: {
            enabled: true,
            include: ["test/**/*.test-d.ts"],
            tsconfig: "./tsconfig.json",
          },
        },
      },
      {
        plugins: [rawSql],
        test: {
          name: "integration",
          include: [
            "test/integration/**/*.test.ts",
            "test/concurrency/**/*.test.ts",
            "test/fault/**/*.test.ts",
            "test/perf/**/*.test.ts",
          ],
          environment: "node",
          // Longer timeouts to account for testcontainers startup.
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
