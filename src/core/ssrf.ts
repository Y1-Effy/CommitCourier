/**
 * SSRF range evaluation as pure matchers.
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
      reason:
        | "private"
        | "loopback"
        | "link-local"
        | "metadata"
        | "shared"
        | "multicast"
        | "reserved"
        | "blocklist";
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
 * reported as `loopback`, the closest category in {@link SsrfDecision}. Beyond loopback/private/
 * link-local/metadata, we also block the non-global ("not public unicast") ranges — shared/CGNAT,
 * multicast, broadcast, and the benchmark/documentation/reserved blocks — since none of them is a
 * legitimate public webhook target and several are routable into internal or carrier networks.
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
  // Shared Address Space / carrier-grade NAT (RFC 6598).
  ["100.64.0.0/10", "shared"],
  // Multicast (RFC 5771 / RFC 4291 §2.7).
  ["224.0.0.0/4", "multicast"],
  ["ff00::/8", "multicast"],
  // Limited broadcast; matched before the 240.0.0.0/4 reserved block for an accurate reason.
  ["255.255.255.255/32", "reserved"],
  // Benchmarking (RFC 2544).
  ["198.18.0.0/15", "reserved"],
  // Documentation/example ranges (RFC 5737 / RFC 3849) — must never carry real traffic.
  ["192.0.2.0/24", "reserved"],
  ["198.51.100.0/24", "reserved"],
  ["203.0.113.0/24", "reserved"],
  ["2001:db8::/32", "reserved"],
  // Reserved for future use (RFC 1112 §4); 255.255.255.255 already handled above.
  ["240.0.0.0/4", "reserved"],
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

/**
 * Rewrite a trailing dotted-quad (e.g. "::ffff:1.2.3.4") into two hex groups so the IPv6
 * group math stays purely 16-bit based. Returns the input unchanged when there is no
 * embedded IPv4, or `null` when the dotted-quad tail is malformed.
 */
function rewriteEmbeddedV4Tail(s: string): string | null {
  if (!s.includes(".")) {
    return s;
  }
  const lastColon = s.lastIndexOf(":");
  const v4 = parseIpv4(s.slice(lastColon + 1));
  if (v4 === null) {
    return null;
  }
  const hi = ((v4 >> 16n) & 0xffffn).toString(16);
  const lo = (v4 & 0xffffn).toString(16);
  return `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
}

/**
 * Parse an IPv6 literal into its 128-bit value, or `null` if malformed. Steps: (1) rewrite a
 * trailing embedded IPv4 (`::ffff:1.2.3.4`) into two hex groups; (2) split on `::` (at most one,
 * which stands in for a run of zero groups); (3) expand head/tail around `::` to exactly eight
 * 16-bit groups; (4) fold the hex groups into a single bigint.
 */
function parseIpv6(input: string): bigint | null {
  const s = rewriteEmbeddedV4Tail(input);
  if (s === null) {
    return null;
  }
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

/** IPv6 prefixes that embed an IPv4 destination in their low 32 bits. */
const V6_EMBEDDED_V4: ReadonlyArray<string> = [
  "::ffff:0:0/96", // IPv4-mapped (e.g. ::ffff:169.254.169.254)
  "64:ff9b::/96", // NAT64 well-known prefix
];

/**
 * A CIDR range folded into its masked base value and mask, so membership is a single BigInt
 * AND + compare with no per-call string parsing. {@link BLOCKED} and {@link V6_EMBEDDED_V4} are
 * module constants that were previously re-split/re-parsed on every {@link evaluateIp} call
 * (once per entry, per resolved IP, per delivery); precomputing them once at load removes that.
 */
interface CidrRange {
  version: 4 | 6;
  value: bigint; // base address already masked to the prefix
  mask: bigint;
}

/** Fold a constant CIDR string into a {@link CidrRange}. Only called on the trusted tables below. */
function parseCidr(cidr: string): CidrRange {
  const [addr, prefixStr] = cidr.split("/");
  const base = parseIp(addr ?? "");
  if (!base) {
    throw new Error(`invalid CIDR literal in SSRF table: "${cidr}"`);
  }
  const prefix = prefixStr === undefined ? base.bits : Number(prefixStr);
  const full = base.bits === 32 ? V4_MAX : V6_MAX;
  const mask = prefix === 0 ? 0n : (full << BigInt(base.bits - prefix)) & full;
  return { version: base.version, value: base.value & mask, mask };
}

/** Membership test against a precomputed {@link CidrRange} (fast path for the constant tables). */
function rangeContains(ip: ParsedIp, range: CidrRange): boolean {
  return ip.version === range.version && (ip.value & range.mask) === range.value;
}

/** {@link BLOCKED} folded once at module load (paired with its reason), removing per-call reparse. */
const BLOCKED_PARSED: ReadonlyArray<
  readonly [CidrRange, Exclude<SsrfDecision, { allowed: true }>["reason"]]
> = BLOCKED.map(([cidr, reason]) => [parseCidr(cidr), reason] as const);

/** {@link V6_EMBEDDED_V4} folded once at module load. */
const V6_EMBEDDED_V4_PARSED: ReadonlyArray<CidrRange> = V6_EMBEDDED_V4.map(parseCidr);

/**
 * If `parsed` is an IPv4-mapped or NAT64-translated IPv6 address, return the embedded
 * IPv4 so the SSRF range rules apply to the real destination; otherwise return `parsed`
 * unchanged. Without this, `::ffff:127.0.0.1` / `64:ff9b::a9fe:a9fe` would slip past the
 * IPv4 blocked ranges and reach loopback / metadata endpoints.
 */
function unwrapEmbeddedV4(parsed: ParsedIp): ParsedIp {
  if (parsed.version !== 6) {
    return parsed;
  }
  for (const range of V6_EMBEDDED_V4_PARSED) {
    if (rangeContains(parsed, range)) {
      return { version: 4, value: parsed.value & V4_MAX, bits: 32 };
    }
  }
  return parsed;
}

function cidrContains(ip: ParsedIp, cidr: string): boolean {
  const [addr, prefixStr] = cidr.split("/");
  const base = parseIp(addr ?? "");
  if (!base || base.version !== ip.version) {
    return false;
  }
  if (prefixStr === "") {
    return false; // malformed "addr/" with an empty prefix must not match everything
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
export function matchHostList(host: string, list: readonly string[]): boolean {
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
      const effective = unwrapEmbeddedV4(parsed);
      for (const [range, reason] of BLOCKED_PARSED) {
        if (rangeContains(effective, range)) {
          return { allowed: false, reason };
        }
      }
    }
  }
  return { allowed: true };
}
