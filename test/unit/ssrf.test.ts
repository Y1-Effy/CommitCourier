import { describe, expect, it } from "vitest";
import { evaluateIp, matchHostList } from "../../src/core/ssrf";
import type { SsrfConfig } from "../../src/core/types";

const base: SsrfConfig = { blockPrivateRanges: true, allowlist: [], blocklist: [] };

describe("ssrf.evaluateIp blocked ranges", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["127.255.255.255", "loopback"],
    ["10.0.0.5", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.1", "private"],
    ["169.254.10.10", "link-local"],
    ["169.254.169.254", "metadata"],
    ["0.0.0.0", "loopback"],
    ["::1", "loopback"],
    ["fe80::1", "link-local"],
    ["fc00::1", "private"],
    ["fd00:ec2::254", "metadata"],
  ])("blocks %s as %s", (ip, reason) => {
    const d = evaluateIp(ip, base);
    if (d.allowed) {
      expect.unreachable(`${ip} should be blocked`);
    } else {
      expect(d.reason).toBe(reason);
    }
  });

  it("allows a public IPv4 and IPv6", () => {
    expect(evaluateIp("93.184.216.34", base).allowed).toBe(true);
    expect(evaluateIp("2606:2800:220:1:248:1893:25c8:1946", base).allowed).toBe(true);
  });

  it("allows an unparseable host rather than crashing the range scan", () => {
    expect(evaluateIp("not-an-ip", base).allowed).toBe(true);
  });

  it("blocks the IPv6 unspecified address ::", () => {
    const d = evaluateIp("::", base);
    expect(d).toEqual({ allowed: false, reason: "loopback" });
  });

  it("does not block private ranges when the guard is off", () => {
    expect(evaluateIp("10.0.0.5", { ...base, blockPrivateRanges: false }).allowed).toBe(true);
  });

  it("172.15 and 172.32 are public (boundary of the /12)", () => {
    expect(evaluateIp("172.15.255.255", base).allowed).toBe(true);
    expect(evaluateIp("172.32.0.0", base).allowed).toBe(true);
  });
});

describe("ssrf precedence", () => {
  it("allowlist wins over a blocked private range", () => {
    const cfg: SsrfConfig = { ...base, allowlist: ["10.0.0.0/8"] };
    expect(evaluateIp("10.1.2.3", cfg).allowed).toBe(true);
  });

  it("blocklist blocks an otherwise-public IP", () => {
    const cfg: SsrfConfig = { ...base, blocklist: ["93.184.216.0/24"] };
    const d = evaluateIp("93.184.216.34", cfg);
    expect(d).toEqual({ allowed: false, reason: "blocklist" });
  });

  it("allowlist takes precedence over blocklist", () => {
    const cfg: SsrfConfig = { ...base, allowlist: ["8.8.8.8"], blocklist: ["8.8.8.8"] };
    expect(evaluateIp("8.8.8.8", cfg).allowed).toBe(true);
  });
});

describe("ssrf.matchHostList", () => {
  it("matches exact host case-insensitively", () => {
    expect(matchHostList("API.Example.com", ["api.example.com"])).toBe(true);
  });

  it("matches a leading-dot domain suffix and the apex", () => {
    expect(matchHostList("a.internal", [".internal"])).toBe(true);
    expect(matchHostList("internal", [".internal"])).toBe(true);
    expect(matchHostList("notinternal", [".internal"])).toBe(false);
  });

  it("matches an IP inside a CIDR", () => {
    expect(matchHostList("192.168.5.5", ["192.168.0.0/16"])).toBe(true);
    expect(matchHostList("192.169.0.1", ["192.168.0.0/16"])).toBe(false);
  });

  it("matches IPv6 numerically regardless of formatting", () => {
    expect(matchHostList("::1", ["0:0:0:0:0:0:0:1"])).toBe(true);
  });

  it("does not match across address families even with equal numeric value", () => {
    // ::1 and 0.0.0.1 both have numeric value 1 but are different families.
    expect(matchHostList("::1", ["0.0.0.1"])).toBe(false);
  });

  it("returns false for an empty list and for non-matching entries", () => {
    expect(matchHostList("example.com", [])).toBe(false);
    expect(matchHostList("example.com", ["other.com"])).toBe(false);
  });

  it("ignores a CIDR entry when the host is not an IP", () => {
    expect(matchHostList("example.com", ["10.0.0.0/8"])).toBe(false);
  });

  it("rejects malformed addresses", () => {
    expect(matchHostList("999.1.1.1", ["999.1.1.1/8"])).toBe(false);
    expect(matchHostList("1.2.3.4", ["1.2.3.4/40"])).toBe(false);
  });

  it.each([
    ["1:2:3::4::5", "more than one :: group"],
    ["gggg::1", "non-hex group"],
    ["1:2:3:4:5:6:7:8:9", "too many groups (no ::)"],
    ["1::2::3", "double ::"],
    ["1:2:3:4:5:6:7:8::9", ":: with no room left to expand"],
  ])("treats %s as a non-IP (%s)", (host) => {
    // Not parseable as an IP, so a CIDR entry cannot match it.
    expect(matchHostList(host, ["fc00::/7"])).toBe(false);
  });

  it("rejects an IPv4 with a non-numeric octet", () => {
    expect(matchHostList("1.2.3.x", ["1.2.3.4"])).toBe(false);
  });

  it("a full 8-group IPv6 without :: is parsed", () => {
    expect(matchHostList("0:0:0:0:0:0:0:1", ["::1/128"])).toBe(true);
  });
});
