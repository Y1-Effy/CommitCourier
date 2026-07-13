import { describe, expect, it } from "vitest";
import type { LookupOptions } from "node:dns";
import { resolveConfig } from "../../src/core/index";
import type { SsrfConfig } from "../../src/core/index";
import { makeGuardedLookup } from "../../src/delivery/http";
import type { ResolveAll } from "../../src/delivery/http";

type Addr = { address: string; family: number };

const ssrf = (over: Partial<SsrfConfig> = {}): SsrfConfig => ({
  ...resolveConfig({}).ssrf,
  ...over,
});

const fixed =
  (...addrs: Addr[]): ResolveAll =>
  (_host, cb) => {
    cb(null, addrs);
  };

interface CallbackResult {
  err: NodeJS.ErrnoException | null;
  address: string | Addr[];
  family: number | undefined;
}

/** Drive the guarded lookup once and capture the (synchronous) callback arguments. */
function invoke(cfg: SsrfConfig, resolveAll: ResolveAll, host: string, options: LookupOptions) {
  const lookup = makeGuardedLookup(cfg, resolveAll);
  let result: CallbackResult | undefined;
  lookup(host, options, (err, address, family) => {
    result = { err, address, family };
  });
  if (!result) throw new Error("lookup callback was not invoked synchronously");
  return result;
}

// Public addresses outside every blocked range (documentation/benchmark blocks excluded).
const PUB_V4: Addr = { address: "93.184.216.34", family: 4 };
const PUB_V6: Addr = { address: "2001:4860:4860::8888", family: 6 };

describe("makeGuardedLookup", () => {
  describe("all: true (network-family autoselection contract)", () => {
    it("returns an address array (not a single string) for a public IPv4", () => {
      const r = invoke(ssrf(), fixed(PUB_V4), "ok.test", { all: true });
      expect(r.err).toBeNull();
      expect(Array.isArray(r.address)).toBe(true);
      expect(r.address).toEqual([PUB_V4]);
    });

    it("returns both families when a host resolves to public IPv4 and IPv6", () => {
      const r = invoke(ssrf(), fixed(PUB_V4, PUB_V6), "dual.test", { all: true });
      expect(r.err).toBeNull();
      expect(r.address).toEqual([PUB_V4, PUB_V6]);
    });

    it("filters to the requested family when one is specified", () => {
      const r = invoke(ssrf(), fixed(PUB_V4, PUB_V6), "dual.test", { all: true, family: 6 });
      expect(r.err).toBeNull();
      expect(r.address).toEqual([PUB_V6]);
    });

    it("rejects the whole resolution when a private IP is present", () => {
      const r = invoke(ssrf(), fixed(PUB_V4, { address: "10.0.0.1", family: 4 }), "rebind.test", {
        all: true,
      });
      expect(r.err?.message).toBe("SSRF_BLOCKED:private");
    });

    it.each([
      ["loopback", "127.0.0.1"],
      ["link-local", "169.254.0.1"],
      ["metadata", "169.254.169.254"],
    ])("rejects a %s address in the resolution set", (reason, address) => {
      const r = invoke(ssrf(), fixed({ address, family: 4 }), "danger.test", { all: true });
      expect(r.err?.message).toBe(`SSRF_BLOCKED:${reason}`);
    });

    it("bypasses range checks for an allowlisted host", () => {
      const r = invoke(
        ssrf({ allowlist: ["vetted.test"] }),
        fixed({ address: "127.0.0.1", family: 4 }),
        "vetted.test",
        { all: true },
      );
      expect(r.err).toBeNull();
      expect(r.address).toEqual([{ address: "127.0.0.1", family: 4 }]);
    });
  });

  describe("all: false (legacy single-address contract)", () => {
    it("returns a single address and family for a public IPv4", () => {
      const r = invoke(ssrf(), fixed(PUB_V4), "ok.test", { all: false });
      expect(r.err).toBeNull();
      expect(r.address).toBe(PUB_V4.address);
      expect(r.family).toBe(4);
    });

    it("still rejects a private IP", () => {
      const r = invoke(ssrf(), fixed({ address: "10.0.0.1", family: 4 }), "rebind.test", {
        all: false,
      });
      expect(r.err?.message).toBe("SSRF_BLOCKED:private");
    });
  });
});
