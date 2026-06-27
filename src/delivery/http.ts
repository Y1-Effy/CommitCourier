/**
 * HTTP client with SSRF-pinned connections (per 03-delivery section 2).
 *
 * native `fetch` cannot control the connected IP, so a DNS-rebinding window stays open between
 * resolution and connection. Instead an undici `Agent` is given a custom `connect.lookup` that
 * resolves every candidate IP, validates each with the pure `core/ssrf` matchers, and only lets
 * undici connect to a vetted address — while the `Host` header and TLS SNI keep the original
 * hostname (so virtual hosting and certificate validation are unaffected).
 */
import { Agent, request } from "undici";
import { lookup as dnsLookup } from "node:dns";
import type { LookupFunction } from "node:net";
import { evaluateIp, matchHostList } from "../core/index";
import type { SsrfConfig, DeliveryConfig } from "../core/index";
import { errorCode, secretFreeSummary } from "./_error";

/** Outcome of one POST attempt. `status === null` means no response (network/timeout/SSRF). */
export interface HttpResult {
  status: number | null;
  /** Response body up to `bodySnippetBytes`, trimmed at a UTF-8 code-point boundary. */
  bodySnippet: string | null;
  durationMs: number;
  /** Exception summary, if any (e.g. `"SSRF_BLOCKED:metadata"`, `"TIMEOUT"`). */
  error: string | null;
  /** Raw `Retry-After` response header (null when absent); parsed by the caller via `parseRetryAfter`. */
  retryAfter: string | null;
}

/** Resolve a hostname to all candidate addresses. Injectable so tests can simulate rebinding. */
export type ResolveAll = (
  hostname: string,
  callback: (
    err: NodeJS.ErrnoException | null,
    addresses: { address: string; family: number }[],
  ) => void,
) => void;

/** Thrown from the guarded lookup when a resolved IP is in a blocked range. */
class SsrfBlockedError extends Error {
  constructor(readonly reason: string) {
    super(`SSRF_BLOCKED:${reason}`);
    this.name = "SsrfBlockedError";
  }
}

const defaultResolveAll: ResolveAll = (hostname, callback) => {
  dnsLookup(hostname, { all: true }, callback);
};

/** Normalise an undici header value (string | string[] | undefined) to a single string or null. */
function headerValue(value: string | string[] | undefined): string | null {
  if (value == null) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

/** Drop the surrounding brackets of an IPv6 literal host (`[::1]` becomes `::1`). */
function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/**
 * Trim `bytes` to at most `maxBytes`, cutting on a UTF-8 code-point boundary so a multi-byte
 * sequence is never split. Trailing continuation bytes (0x80-0xBF) at the cut are rewound.
 */
export function truncateUtf8(bytes: Uint8Array, maxBytes: number): string {
  if (bytes.length <= maxBytes) {
    return new TextDecoder().decode(bytes);
  }
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
    end--;
  }
  return new TextDecoder().decode(bytes.subarray(0, end));
}

/** Pick the address matching the requested family, else the first candidate. */
function chooseAddress(
  addresses: { address: string; family: number }[],
  family: number,
): { address: string; family: number } | undefined {
  if (family === 4 || family === 6) {
    const match = addresses.find((a) => a.family === family);
    if (match) return match;
  }
  return addresses[0];
}

/** Walk the error and its `cause` chain looking for an {@link SsrfBlockedError}. */
function findSsrf(err: unknown): SsrfBlockedError | null {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur != null; i++) {
    if (cur instanceof SsrfBlockedError) return cur;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Reduce a thrown value to a stable, secret-free summary. SSRF blocks and timeouts get specific
 * labels; everything else falls back to the shared {@link secretFreeSummary}.
 */
function summarize(err: unknown): string {
  const ssrf = findSsrf(err);
  if (ssrf) return ssrf.message;
  if (err instanceof Error) {
    const code = errorCode(err);
    if (err.name === "AbortError" || code === "UND_ERR_ABORTED" || code?.includes("TIMEOUT")) {
      return "TIMEOUT";
    }
  }
  return secretFreeSummary(err);
}

/** Read up to `maxBytes` of the response body, discarding the rest, trimmed UTF-8-safe. */
async function readSnippet(
  body: AsyncIterable<unknown> & { destroy?: () => void },
  maxBytes: number,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    const buf = chunk as Uint8Array;
    chunks.push(buf);
    total += buf.length;
    if (total >= maxBytes) break;
  }
  // Free the socket: if we stopped early, the remaining body must be discarded.
  body.destroy?.();
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    joined.set(c, offset);
    offset += c.length;
  }
  return truncateUtf8(joined, maxBytes);
}

/**
 * Build the SSRF-validating `connect.lookup`: resolve all candidate IPs, reject any blocked range
 * (unless the host is allowlisted), then hand undici a single vetted address (family-matched).
 */
function makeGuardedLookup(ssrf: SsrfConfig, resolveAll: ResolveAll): LookupFunction {
  return (hostname, options, callback) => {
    resolveAll(hostname, (err, addresses) => {
      if (err) {
        callback(err, "", 0);
        return;
      }
      // A host-level allowlist match is a full bypass (internal/self-host delivery).
      if (!matchHostList(hostname, ssrf.allowlist)) {
        for (const a of addresses) {
          const decision = evaluateIp(a.address, ssrf);
          if (!decision.allowed) {
            callback(new SsrfBlockedError(decision.reason), "", 0);
            return;
          }
        }
      }
      const family = typeof options.family === "number" ? options.family : 0;
      const chosen = chooseAddress(addresses, family);
      if (!chosen) {
        callback(new Error("ENOTFOUND"), "", 0);
        return;
      }
      callback(null, chosen.address, chosen.family);
    });
  };
}

/**
 * POST with SSRF validation. Never throws: any failure (blocked range, network error, timeout)
 * is captured in {@link HttpResult}. A single shared {@link Agent} pins connections per request.
 */
export function createHttpClient(
  cfg: { ssrf: SsrfConfig; delivery: DeliveryConfig },
  deps: { resolveAll?: ResolveAll } = {},
): {
  post(opts: { url: string; headers: Record<string, string>; body: string }): Promise<HttpResult>;
} {
  const { ssrf, delivery } = cfg;
  const resolveAll = deps.resolveAll ?? defaultResolveAll;

  const connect: { lookup: LookupFunction } = { lookup: makeGuardedLookup(ssrf, resolveAll) };
  // Tune connection reuse for delivery throughput: a longer keep-alive window reuses TCP/TLS across
  // bursts to the same host; `connections` (when set) caps per-origin sockets. `pipelining` stays at
  // the undici default (1) since POST is not safe to pipeline.
  const agent = new Agent({
    connect,
    keepAliveTimeout: delivery.keepAliveTimeoutMs,
    ...(delivery.connections != null ? { connections: delivery.connections } : {}),
  });

  return {
    async post({ url, headers, body }) {
      const start = Date.now();
      const fail = (error: string): HttpResult => ({
        status: null,
        bodySnippet: null,
        durationMs: Date.now() - start,
        error,
        retryAfter: null,
      });

      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return fail("INVALID_URL");
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return fail("SSRF_BLOCKED:scheme");
      }
      // Early reject: IP-literal ranges, blocklisted hosts (allowlist wins inside evaluateIp).
      const decision = evaluateIp(stripBrackets(parsed.hostname), ssrf);
      if (!decision.allowed) {
        return fail(`SSRF_BLOCKED:${decision.reason}`);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, delivery.timeoutMs);
      try {
        const res = await request(url, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
          dispatcher: agent,
        });
        // The status is authoritative once the response headers arrive: a slow/stalled body (or the
        // timeout firing mid-stream) must not discard a known 2xx and force a needless redelivery.
        // Read the snippet best-effort; on failure keep the status and drop the body.
        let bodySnippet: string | null = null;
        try {
          bodySnippet = await readSnippet(res.body, delivery.bodySnippetBytes);
        } catch {
          res.body.destroy();
        }
        return {
          status: res.statusCode,
          bodySnippet,
          durationMs: Date.now() - start,
          error: null,
          retryAfter: headerValue(res.headers["retry-after"]),
        };
      } catch (err) {
        return fail(summarize(err));
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
