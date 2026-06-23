// Language guard: source code must be English-only.
// Fails if any CJK character appears in src/**/*.ts or test/**/*.ts so that
// comments, identifiers, and string literals stay English for an international audience.
// If a test genuinely needs non-English data, put it in test/fixtures/*.json or use \uXXXX escapes.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["src", "test"];

// CJK codepoint ranges (numeric only, so this script stays ASCII): Hiragana/Katakana,
// CJK ideographs (and ext A), compatibility ideographs, and full-width/half-width forms.
const RANGES = [
  [0x3000, 0x30ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
  [0xff00, 0xffef],
];

/** Return the 0-based index of the first CJK character in a line, or -1 if none. */
function firstCjkIndex(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.codePointAt(i);
    for (const [lo, hi] of RANGES) {
      if (c >= lo && c <= hi) {
        return i;
      }
    }
  }
  return -1;
}

/** Recursively collect .ts files under a directory (skips .json fixtures). */
function collect(dir) {
  let out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // directory may not exist yet
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out = out.concat(collect(full));
    } else if (full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const violations = [];
for (const root of ROOTS) {
  for (const file of collect(root)) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      const col = firstCjkIndex(line);
      if (col !== -1) {
        violations.push(`${file}:${i + 1}:${col + 1}  ${line.trim()}`);
      }
    });
  }
}

if (violations.length > 0) {
  console.error("Non-English (CJK) characters found in source. Keep code English-only:");
  for (const v of violations) {
    console.error("  " + v);
  }
  console.error(
    "\nUse English for comments/messages. For non-English test data, use test/fixtures/*.json or \\uXXXX escapes.",
  );
  process.exit(1);
}

console.log("check-no-cjk: OK (no CJK characters in src/test).");
