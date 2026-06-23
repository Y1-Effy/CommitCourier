/**
 * SSRF range evaluation as pure matchers (per 01-core section 6, basic design section 12).
 *
 * Real DNS resolution happens in the delivery layer; core only decides whether a given
 * IP / host is allowed. Allowlist has top priority, then blocklist, then private ranges.
 * CIDR comparison is done with BigInt for both IPv4 (32-bit) and IPv6 (128-bit) so no
 * third-party dependency is needed.
 */
import type { SsrfConfig } from "./types";

/** Result of an SSRF evaluation. */
export type SsrfDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: "private" | "loopback" | "link-local" | "metadata" | "blocklist";
    };

interface ParsedIp {
  version: 4 | 6;
  value: bigint;
  bits: 32 | 128;
}

const V4_MAX = (1n << 32n) - 1n;
const V6_MAX = (1n << 128n) - 1n;

/**
 * Blocked CIDR ranges with their reason, in priority order (most specific first).
 * Unspecified/reserved addresses (`0.0.0.0/8`, `::/128`) route to the local host and are
 * reported as `loopback`, the closest category in {@link SsrfDecision}.
 */
const BLOCKED: ReadonlyArray<
  readonly [string, Exclude<SsrfDecision, { allowed: true }>["reason"]]
> = [
  ["169.254.169.254/32", "metadata"],
  ["fd00:ec2::254/128", "metadata"],
  ["127.0.0.0/8", "loopback"],
  ["::1/128", "loopback"],
  ["169.254.0.0/16", "link-local"],
  ["fe80::/10", "link-local"],
  ["10.0.0.0/8", "private"],
  ["172.16.0.0/12", "private"],
  ["192.168.0.0/16", "private"],
  ["fc00::/7", "private"],
  ["0.0.0.0/8", "loopback"],
  ["::/128", "loopback"],
];

function parseIpv4(s: string): bigint | null {
  const parts = s.split(".");
  if (parts.length !== 4) {
    return null;
  }
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const n = Number(part);
    if (n > 255) {
      return null;
    }
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

function parseIpv6(s: string): bigint | null {
  const halves = s.split("::");
  if (halves.length > 2) {
    return null;
  }
  const head = halves[0] === "" ? [] : (halves[0] ?? "").split(":");
  const tail = halves.length === 2 ? (halves[1] === "" ? [] : (halves[1] ?? "").split(":")) : null;
  const groups = expandV6Groups(head, tail);
  if (!groups || groups.length !== 8) {
    return null;
  }
  let value = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) {
      return null;
    }
    value = (value << 16n) | BigInt(parseInt(g, 16));
  }
  return value;
}

/** Combine head/tail groups around `::`, filling the gap with zero groups. */
function expandV6Groups(head: string[], tail: string[] | null): string[] | null {
  if (tail === null) {
    return head.length === 8 ? head : null;
  }
  const missing = 8 - head.length - tail.length;
  if (missing < 1) {
    return null;
  }
  return [...head, ...Array<string>(missing).fill("0"), ...tail];
}

function parseIp(s: string): ParsedIp | null {
  const v4 = parseIpv4(s);
  if (v4 !== null) {
    return { version: 4, value: v4, bits: 32 };
  }
  const v6 = parseIpv6(s);
  if (v6 !== null) {
    return { version: 6, value: v6, bits: 128 };
  }
  return null;
}

function cidrContains(ip: ParsedIp, cidr: string): boolean {
  const [addr, prefixStr] = cidr.split("/");
  const base = parseIp(addr ?? "");
  if (!base || base.version !== ip.version) {
    return false;
  }
  const prefix = prefixStr === undefined ? base.bits : Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > base.bits) {
    return false;
  }
  const full = ip.bits === 32 ? V4_MAX : V6_MAX;
  const mask = prefix === 0 ? 0n : (full << BigInt(base.bits - prefix)) & full;
  return (ip.value & mask) === (base.value & mask);
}

function matchEntry(host: string, entry: string): boolean {
  if (entry.includes("/")) {
    const ip = parseIp(host);
    return ip ? cidrContains(ip, entry) : false;
  }
  const h = host.toLowerCase();
  const e = entry.toLowerCase();
  if (h === e) {
    return true;
  }
  if (e.startsWith(".")) {
    return h === e.slice(1) || h.endsWith(e);
  }
  const hi = parseIp(host);
  const ei = parseIp(entry);
  return hi !== null && ei !== null && hi.version === ei.version && hi.value === ei.value;
}

/**
 * Host-level allowlist/blocklist match. Entries may be exact hosts/IPs, CIDR ranges, or
 * leading-dot domain suffixes (e.g. `".example.com"`). Also used for early pre-resolution
 * checks before DNS in the delivery layer.
 */
export function matchHostList(host: string, list: string[]): boolean {
  return list.some((entry) => matchEntry(host, entry));
}

/** Evaluate an IP against the SSRF policy. Allowlist wins, then blocklist, then ranges. */
export function evaluateIp(ip: string, cfg: SsrfConfig): SsrfDecision {
  if (matchHostList(ip, cfg.allowlist)) {
    return { allowed: true };
  }
  if (matchHostList(ip, cfg.blocklist)) {
    return { allowed: false, reason: "blocklist" };
  }
  if (cfg.blockPrivateRanges) {
    const parsed = parseIp(ip);
    if (parsed) {
      for (const [cidr, reason] of BLOCKED) {
        if (cidrContains(parsed, cidr)) {
          return { allowed: false, reason };
        }
      }
    }
  }
  return { allowed: true };
}
