# Contributing to CommitCourier

🇯🇵 日本語版: **[CONTRIBUTING.ja.md](./CONTRIBUTING.ja.md)**

Thanks for your interest in improving CommitCourier! This document explains how to set up the
project, the conventions we follow, and how to get a change merged.

## Prerequisites

- Node.js **20.18.1+**
- npm (the repository ships a `package-lock.json`)
- Docker — only required to run the integration / concurrency / fault / perf suites
  (`testcontainers` spins up a real PostgreSQL). Unit tests need no Docker.

## Getting started

```bash
npm ci
npm run check   # typecheck + lint + lint:lang + unit tests
```

## Useful scripts

| Script                                    | What it does                                                     |
| ----------------------------------------- | ---------------------------------------------------------------- |
| `npm run typecheck`                       | `tsc --noEmit`                                                   |
| `npm run lint` / `npm run lint:fix`       | ESLint (correctness only)                                        |
| `npm run lint:lang`                       | Fails if CJK characters appear in `src/**` or `test/**`          |
| `npm run format` / `npm run format:check` | Prettier                                                         |
| `npm run test:unit`                       | Fast unit tests (no Docker)                                      |
| `npm test`                                | Full suite (integration needs Docker)                            |
| `npm run test:coverage`                   | Coverage with thresholds enforced                                |
| `npm run build`                           | Build with tsup (ESM + CJS + d.ts)                               |
| `npm run api:check`                       | Verify the public API surface against `etc/commitcourier.api.md` |

Please make sure `npm run check` is green before opening a pull request.

## Project conventions

- **Language split.** Code — identifiers, comments, TSDoc, user-facing strings, and **git commit
  messages** — is written in **English**. Non-English test data must live in
  `test/fixtures/*.json` or be written with `\uXXXX` escapes; `npm run lint:lang` enforces this.
- **`core/` is dependency-free and cross-runtime.** Files under `src/core/` must not import any
  third-party package or `node:*` builtin, and may only use web-standard globals
  (`crypto.subtle`, `TextEncoder`, `atob`/`btoa`, …) — never `Buffer`/`process`. ESLint enforces
  this. I/O (DNS/HTTP/DB) belongs in `delivery/` and `store/`.
- **TypeScript strict**, `import type` for type-only imports (`verbatimModuleSyntax`).
- **Formatting** is Prettier (2-space, double quotes, semicolons, trailing commas, width 100).
- State columns use `text + CHECK` (not Postgres enums); times are `timestamptz` in the DB and
  millisecond `number`s at the API boundary.

The detailed design lives in `docs/` (not shipped to npm). The `README` is the source of truth
for consumers.

## Public API changes

The public type surface is tracked in `etc/commitcourier.api.md` via API Extractor. If your
change intentionally alters the public API, regenerate the report and commit it:

```bash
npm run build
npm run api:update
```

CI runs `npm run api:check` to catch unintended breaking changes.

## Pull requests

1. Fork and branch from `main`.
2. Keep commits focused; write commit messages in English (imperative mood).
3. Add or update tests for behavioural changes; update the `README` (and `README.ja.md`) and
   `CHANGELOG.md` (`Unreleased`) when relevant.
4. Ensure `npm run check` passes (and `npm test` if you touched I/O paths).
5. Open the PR and fill in the template.

By contributing, you agree that your contributions are licensed under the project's
[MIT License](./LICENSE).
