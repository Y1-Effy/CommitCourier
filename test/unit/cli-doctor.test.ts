/**
 * Unit coverage for the `commitcourier doctor` CLI's pure pieces (no DB, no Docker): the config
 * readiness report (defaults vs overrides, the recommended-but-unset checklist, captured risk
 * warnings, invalid-config handling), secret redaction, output formatting, and argv dispatch with
 * --skip-db (which exercises main end-to-end without a database).
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { buildConfigReport, formatReport, main } from "../../src/cli";

describe("buildConfigReport", () => {
  it("reports defaults and flags the recommended-but-unset items when no config is given", () => {
    const r = buildConfigReport(undefined);
    expect(r.loaded).toBe(false);
    expect(r.error).toBeNull();
    expect(r.overridden).toEqual([]);
    // An unset logger is the headline production footgun (silent failures).
    expect(r.checklist.find((i) => i.key === "logger")?.status).toBe("warn");
    expect(r.warnings.some((w) => w.startsWith("logger:"))).toBe(true);
    // circuitBreaker defaults to off.
    expect(r.checklist.find((i) => i.key === "circuitBreaker.failureThreshold")?.status).toBe(
      "default",
    );
  });

  it("lists overridden fields and captures resolveConfig risk warnings", () => {
    const r = buildConfigReport({
      ssrf: { blockPrivateRanges: false },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      circuitBreaker: { failureThreshold: 5 },
    });
    expect(r.overridden).toContain("ssrf");
    expect(r.overridden).toContain("circuitBreaker");
    // The SSRF-disabled warning from resolveConfig's warnIfRisky is surfaced as data.
    expect(r.warnings.some((w) => w.toLowerCase().includes("ssrf"))).toBe(true);
    // A provided logger and an enabled breaker are no longer flagged.
    expect(r.checklist.find((i) => i.key === "logger")?.status).toBe("ok");
    expect(r.checklist.find((i) => i.key === "circuitBreaker.failureThreshold")?.status).toBe("ok");
  });

  it("captures an invalid config as an error rather than throwing", () => {
    const r = buildConfigReport({ retry: { maxAttempts: 0 } });
    expect(r.error).toMatch(/maxAttempts/);
    expect(r.loaded).toBe(false);
  });

  it("validates and reports maxPayloadBytes from the loaded config", () => {
    // An invalid value must fail the report (resolveConfig rejects it), not be silently dropped.
    const bad = buildConfigReport({ maxPayloadBytes: -5 });
    expect(bad.error).toMatch(/maxPayloadBytes/);
    expect(bad.loaded).toBe(false);
    // A valid value shows up as an override away from the default (unset).
    const good = buildConfigReport({ maxPayloadBytes: 65_536 });
    expect(good.error).toBeNull();
    expect(good.overridden).toContain("maxPayloadBytes");
  });
});

describe("formatReport", () => {
  const report = {
    config: buildConfigReport(undefined),
    db: null,
    ok: true,
  };

  it("emits valid JSON in --json mode with the real checklist item names intact", () => {
    const json = formatReport(report, { json: true });
    const parsed = JSON.parse(json) as {
      ok: boolean;
      config: { checklist: { key: string }[] };
    };
    expect(parsed.ok).toBe(true);
    // Regression: the checklist `key` field must survive serialisation (was clobbered by a
    // too-broad redaction that matched the field name "key").
    expect(parsed.config.checklist.map((i) => i.key)).toContain("logger");
    expect(parsed.config.checklist.every((i) => i.key !== "[redacted]")).toBe(true);
  });

  it("emits a human summary in text mode", () => {
    const text = formatReport(report, { json: false });
    expect(text).toContain("Configuration");
    expect(text).toContain("doctor: ready");
    expect(text).toContain("skipped (--skip-db)");
  });
});

describe("main (argv dispatch)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("runs doctor with --skip-db (config-only) and exits 0", async () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const code = await main(["doctor", "--skip-db"]);
    expect(code).toBe(0);
    expect(out).toHaveBeenCalled();
  });

  it("--help prints usage and exits 0", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(await main(["--help"])).toBe(0);
  });

  it("a bare invocation prints usage and exits non-zero", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(await main([])).toBe(1);
  });

  it("an unknown command errors with exit 1", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(await main(["bogus"])).toBe(1);
  });
});
