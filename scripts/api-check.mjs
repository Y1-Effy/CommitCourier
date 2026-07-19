// Run API Extractor across every published entry point, not just the main one.
//
// API Extractor operates on a single entry point per invocation, so we drive it once per subpath
// export (index / core / store-* / otel / accelerator / forward*), reusing api-extractor.json as the
// shared base and overriding only the entry `.d.ts` and the per-entry report file. Each entry's public
// surface is recorded in etc/<name>.api.md; in CI (default) a drift from the committed report fails the
// build, so a breaking change to ANY subpath's types is caught. Pass --local to (re)write the reports.
//
// Usage: node scripts/api-check.mjs [--local]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Extractor, ExtractorConfig } from "@microsoft/api-extractor";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// loadFile parses the JSONC base config (comments allowed) without preparing/expanding it.
const base = ExtractorConfig.loadFile(path.join(root, "api-extractor.json"));

// Each published subpath export → its emitted .d.ts. `commitcourier` keeps the historical report name.
const entries = [
  { name: "commitcourier", dts: "dist/index.d.ts" },
  { name: "core", dts: "dist/core/index.d.ts" },
  { name: "store-pg", dts: "dist/store/pg.d.ts" },
  { name: "store-knex", dts: "dist/store/knex.d.ts" },
  { name: "store-drizzle", dts: "dist/store/drizzle.d.ts" },
  { name: "store-prisma", dts: "dist/store/prisma.d.ts" },
  { name: "otel", dts: "dist/otel/index.d.ts" },
  { name: "accelerator-pg", dts: "dist/accelerator/pg.d.ts" },
  { name: "forward", dts: "dist/forward/index.d.ts" },
  { name: "forward-svix", dts: "dist/forward/svix.d.ts" },
];

const localBuild = process.argv.includes("--local");
let failed = false;

for (const entry of entries) {
  const isMain = entry.name === "commitcourier";
  // A subpath's TSDoc legitimately `{@link}`s types that live in the main entry (e.g. store adapters
  // referencing `Store`); those cannot resolve when that subpath is analysed in isolation. Silence the
  // unresolved-link message for subpath entries only — the main entry keeps strict link checking.
  const messages = isMain
    ? base.messages
    : {
        ...base.messages,
        extractorMessageReporting: {
          ...base.messages?.extractorMessageReporting,
          "ae-unresolved-link": { logLevel: "none" },
        },
      };
  const configObject = {
    ...base,
    mainEntryPointFilePath: path.join(root, entry.dts),
    compiler: { tsconfigFilePath: path.join(root, "tsconfig.json") },
    apiReport: {
      ...base.apiReport,
      enabled: true,
      reportFileName: `${entry.name}.api.md`,
      reportFolder: path.join(root, "etc"),
    },
    messages,
  };
  const prepared = ExtractorConfig.prepare({
    configObject,
    configObjectFullPath: path.join(root, "api-extractor.json"),
    packageJsonFullPath: path.join(root, "package.json"),
  });
  const result = Extractor.invoke(prepared, { localBuild, showVerboseMessages: true });
  if (!result.succeeded) {
    failed = true;
    console.error(
      `api-extractor: ${entry.name} completed with ${String(result.errorCount)} error(s) and ${String(result.warningCount)} warning(s)`,
    );
  }
}

process.exit(failed ? 1 : 0);
