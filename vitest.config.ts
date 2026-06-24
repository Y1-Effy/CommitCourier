import { defineConfig } from "vitest/config";

export default defineConfig({
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
