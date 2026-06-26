// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import importPlugin from "eslint-plugin-import";
import tsdoc from "eslint-plugin-tsdoc";
import prettier from "eslint-config-prettier";

// Formatting is delegated to Prettier (eslint-config-prettier disables stylistic rules).
// ESLint focuses on mechanically enforcing correctness, separation of concerns, and readability.
export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "coverage/**",
      "etc/**",
      ".claude/**",
      ".vscode/**",
      "docs/**",
      ".stryker-tmp/**",
      "reports/**",
      // Generated Prisma client for the Prisma adapter test (gitignored, produced by codegen).
      "test/integration/.prisma-client/**",
    ],
  },

  js.configs.recommended,
  // Type-aware strict rules. projectService resolves type information per file.
  ...tseslint.configs.strictTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      import: importPlugin,
      tsdoc,
    },
    settings: {
      "import/resolver": {
        typescript: { project: "./tsconfig.json" },
      },
    },
    rules: {
      // --- Correctness ---
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "warn",
      // Public API stability/readability: require explicit param/return types on exported functions.
      "@typescript-eslint/explicit-module-boundary-types": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": "error",

      // --- Separation of concerns: no cycles, and layer direction (core <- store <- delivery <- dispatcher <- admin) ---
      "import/no-cycle": ["error", { maxDepth: Infinity }],
      "import/no-restricted-paths": [
        "error",
        {
          zones: [
            {
              target: "./src/core",
              from: ["./src/store", "./src/delivery", "./src/dispatcher", "./src/admin"],
              message: "core is I/O-independent. It must not import upper layers.",
            },
            {
              target: "./src/store",
              from: ["./src/delivery", "./src/dispatcher", "./src/admin"],
            },
            {
              target: "./src/delivery",
              from: ["./src/dispatcher", "./src/admin"],
            },
            {
              target: "./src/dispatcher",
              from: ["./src/admin"],
            },
          ],
        },
      ],

      // --- Readability: complexity and size limits ---
      complexity: ["warn", 12],
      "max-depth": ["warn", 4],
      "max-params": ["warn", 4],
      "max-lines-per-function": ["warn", { max: 80, skipBlankLines: true, skipComments: true }],
      "max-lines": ["warn", { max: 400, skipBlankLines: true, skipComments: true }],

      // --- Public docs (TSDoc syntax, consistent with api-extractor) ---
      "tsdoc/syntax": "warn",

      "no-console": "off",
    },
  },

  // Enforce "zero-import, cross-runtime" for core.
  // No third-party and no node: namespace imports (signing uses the WebCrypto global).
  // Node-specific globals (Buffer/process, etc.) are forbidden; only Web standard globals are allowed.
  {
    files: ["src/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "pg", message: "core is import-free. Put DB deps in the store layer." },
            { name: "knex", message: "core is import-free. Put DB deps in the store layer." },
            { name: "undici", message: "core is import-free. Put HTTP in the delivery layer." },
            {
              name: "p-limit",
              message: "core is import-free. Put concurrency in the dispatcher layer.",
            },
            {
              name: "node:crypto",
              message: "core is cross-runtime. Use WebCrypto (globalThis.crypto.subtle) for HMAC.",
            },
            {
              name: "node:dns",
              message: "core is import-free. Put DNS resolution in the delivery layer.",
            },
            { name: "node:net", message: "core is import-free." },
            { name: "node:tls", message: "core is import-free." },
            { name: "node:http", message: "core is import-free. Put HTTP in the delivery layer." },
            { name: "node:https", message: "core is import-free. Put HTTP in the delivery layer." },
            { name: "node:fs", message: "core is import-free. Do not bring in file I/O." },
          ],
          patterns: [
            {
              group: ["node:*"],
              message: "core is cross-runtime. Use Web standard globals instead of Node builtins.",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        {
          name: "Buffer",
          message: "core is cross-runtime. Use Uint8Array / TextEncoder / atob / btoa.",
        },
        { name: "process", message: "core is cross-runtime. Do not depend on process." },
        { name: "global", message: "core is cross-runtime. Use globalThis." },
        { name: "__dirname", message: "core is cross-runtime." },
        { name: "__filename", message: "core is cross-runtime." },
        { name: "setImmediate", message: "core is cross-runtime. Use setTimeout." },
        { name: "clearImmediate", message: "core is cross-runtime." },
      ],
    },
  },

  // Tests tend to be long and loosely typed, so relax size/complexity and strict-only noise.
  {
    files: ["test/**/*.ts", "test/**/*.test-d.ts"],
    rules: {
      "max-lines-per-function": "off",
      "max-lines": "off",
      complexity: "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/explicit-module-boundary-types": "off",
    },
  },

  // Config-style and script JS/TS is excluded from type-aware rules (so files outside the type project don't break).
  {
    files: ["**/*.js", "**/*.mjs", "*.config.ts", "scripts/**"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
      },
    },
    rules: {
      "tsdoc/syntax": "off",
    },
  },

  prettier,
);
