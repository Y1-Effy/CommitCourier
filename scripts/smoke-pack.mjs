// Pack-and-install smoke test: prove that what `npm publish` would ship actually resolves from a
// clean, separate project — across ESM and CJS, for the package root, `./core`, and `./store/pg`.
// Repository builds can pass while the *published* surface is broken (missing files, wrong exports,
// an optional peer turned mandatory), so this packs a real tarball, installs it into a throwaway
// project, and imports it the way a consumer would. Run `npm run build` first.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = process.cwd();
const work = mkdtempSync(join(tmpdir(), "cc-smoke-"));

/** Run a command, inheriting stdio so failures are visible, and throw on a non-zero exit. */
function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
}

try {
  // 1. Pack the tarball straight into the work dir (no repo-root pollution).
  run("npm", ["pack", "--pack-destination", work], repoRoot);
  const tarball = readdirSync(work).find((f) => f.endsWith(".tgz"));
  if (!tarball) throw new Error("npm pack produced no .tgz");

  // 2. A throwaway consumer project. Install the packed tarball plus `pg` (the peer the `./store/pg`
  //    subpath needs). The other peers stay absent, proving they are genuinely optional.
  const proj = join(work, "consumer");
  mkdirSync(proj);
  run("npm", ["init", "-y"], proj);
  run("npm", ["install", "--no-audit", "--no-fund", join(work, tarball), "pg"], proj);

  // 3. Import the package the way a consumer would, in both module systems. Use namespace imports
  //    and assert on key exports so the smoke does not hard-code the full surface.
  const esm = [
    `import assert from "node:assert/strict";`,
    `import * as cc from "commitcourier";`,
    `import * as core from "commitcourier/core";`,
    `import * as pg from "commitcourier/store/pg";`,
    `assert.equal(typeof cc.createRelay, "function", "root createRelay");`,
    `assert.equal(typeof pg.postgresStore, "function", "store/pg postgresStore");`,
    `assert.ok(Object.keys(core).length > 0, "core has exports");`,
    `console.log("  ESM import OK");`,
  ].join("\n");

  const cjs = [
    `const assert = require("node:assert/strict");`,
    `const cc = require("commitcourier");`,
    `const core = require("commitcourier/core");`,
    `const pg = require("commitcourier/store/pg");`,
    `assert.equal(typeof cc.createRelay, "function", "root createRelay");`,
    `assert.equal(typeof pg.postgresStore, "function", "store/pg postgresStore");`,
    `assert.ok(Object.keys(core).length > 0, "core has exports");`,
    `console.log("  CJS require OK");`,
  ].join("\n");

  writeFileSync(join(proj, "smoke.mjs"), esm);
  writeFileSync(join(proj, "smoke.cjs"), cjs);
  run("node", ["smoke.mjs"], proj);
  run("node", ["smoke.cjs"], proj);

  console.log("pack-install smoke test passed");
} finally {
  rmSync(work, { recursive: true, force: true });
}
