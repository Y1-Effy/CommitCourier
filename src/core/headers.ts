/**
 * Per-endpoint custom header validation and normalisation (pure, cross-runtime).
 *
 * A registered endpoint may carry extra HTTP headers that are sent on every delivery to it, for
 * receivers that need their own auth (an API gateway wanting `x-api-key`, an ingress wanting
 * `authorization`) on top of the Standard Webhooks signature. Header values are treated as
 * secret-bearing throughout: encrypted at rest when a `cipher` is configured, and redacted from the
 * delivery-attempt ledger (see {@link REDACTED_HEADER_VALUE}).
 *
 * Custom headers are NOT covered by the signature — `sign()` covers `id.timestamp.body` only
 * (Standard Webhooks), so a receiver cannot infer a header's authenticity from the signature.
 *
 * Two entry points share one rule set ({@link classifyHeader}):
 * - {@link validateCustomHeaders} is fail-closed and runs at registration, where a rejection is
 *   visible to the caller as an `INVALID_ARGUMENT`.
 * - {@link sanitizeCustomHeaders} never throws and runs on the delivery path as defence in depth,
 *   because the store adapters are public API and can be driven around the admin surface.
 *
 * **Internal to the package.** Everything here is deliberately NOT re-exported by `./index` — the
 * pure core's *public* API — so it stays off the published surface: the feature is reached entirely
 * through `endpoints.register` / `update` / `get`, and callers never need these helpers. `delivery`
 * and `admin` import this module directly instead, the way `delivery/_error.ts` is used by its
 * siblings. Note this is the first such module inside `core/`, where the barrel has so far mirrored
 * every export — the omission is intentional, not an oversight. (Adding a symbol to the barrel later
 * is non-breaking; removing one is not, so this starts minimal.)
 *
 * Uses only Web-standard globals (`JSON`, `TextEncoder` via ./encoding).
 */
import { utf8ToBytes } from "./encoding";
import { RelayError } from "./errors";

/** The placeholder written to the ledger in place of every custom-header value. */
export const REDACTED_HEADER_VALUE = "[redacted]";

/** Max number of custom headers on one endpoint. */
export const MAX_CUSTOM_HEADERS = 16;

/** Max UTF-8 byte length of the JSON-serialized custom-header map. */
export const MAX_CUSTOM_HEADERS_BYTES = 8192;

/**
 * Header names the caller may not set, checked after lowercasing.
 *
 * The `webhook-` namespace is reserved by prefix rather than by listing the three current signature
 * headers, so any header Standard Webhooks adds later is covered without a code change.
 */
const RESERVED_PREFIX = "webhook-";

const RESERVED_NAMES: ReadonlySet<string> = new Set([
  // Set by the delivery path itself.
  "content-type",
  "idempotency-key",
  // The body representation is this library's responsibility.
  "content-length",
  "content-encoding",
  // Hop-by-hop / framing headers (RFC 7230 6.1); undici owns these.
  "host",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "proxy-authenticate",
  "proxy-authorization",
  "expect",
]);

/** RFC 7230 `token`, already lowercased. */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/;

/**
 * Printable US-ASCII plus tab. Deliberately stricter than RFC 7230 `field-value`, which also allows
 * obs-text (0x80-0xFF): those bytes are latin-1 on the wire and would silently mangle a UTF-8 value,
 * so they are rejected rather than corrupted. Rejecting CR/LF/NUL is what blocks header injection.
 */
const HEADER_VALUE_RE = /^[\t\x20-\x7e]+$/;

/** A rejected header, with the reason phrase used in the `INVALID_ARGUMENT` message. */
interface Rejected {
  ok: false;
  reason: string;
}

type Classified = { ok: true; name: string; value: string } | Rejected;

/**
 * Apply the shared rule set to one header, returning its normalised (lowercased) form or a reason.
 * Both entry points route through here so the fail-closed and defence-in-depth paths cannot drift.
 */
function classifyHeader(rawName: string, rawValue: unknown): Classified {
  if (typeof rawValue !== "string") {
    return { ok: false, reason: `value must be a string, got ${typeof rawValue}` };
  }
  // HTTP header names are case-insensitive and HTTP/2+ requires lowercase on the wire (undici
  // lowercases regardless). Normalising here makes the reserved-name check and the delivery-path
  // precedence an exact-match comparison, and keeps the jsonb key set canonical.
  const name = rawName.toLowerCase();
  if (!HEADER_NAME_RE.test(name)) {
    return { ok: false, reason: "name is not a valid HTTP header name (RFC 7230 token)" };
  }
  if (name.startsWith(RESERVED_PREFIX)) {
    return {
      ok: false,
      reason: `the \`${RESERVED_PREFIX}\` namespace is reserved for the signature`,
    };
  }
  if (RESERVED_NAMES.has(name)) {
    return { ok: false, reason: "name is reserved and set by the delivery path" };
  }
  if (rawValue === "") {
    // Almost always an interpolation bug (`Bearer ${undefined}`), and an empty value carries no
    // meaning a receiver can act on.
    return { ok: false, reason: "value is empty" };
  }
  if (!HEADER_VALUE_RE.test(rawValue)) {
    return {
      ok: false,
      reason: "value contains a CR, LF, NUL, control or non-ASCII character",
    };
  }
  if (rawValue !== rawValue.trim()) {
    // Rejected rather than trimmed: silently rewriting a credential is worse than refusing it.
    return { ok: false, reason: "value has leading or trailing whitespace" };
  }
  return { ok: true, name, value: rawValue };
}

/** A prototype-free map, so a `__proto__` key from JSON.parse cannot reach Object.prototype. */
function emptyMap(): Record<string, string> {
  return Object.create(null) as Record<string, string>;
}

/**
 * Validate and normalise a custom-header map for storage on an endpoint. Header names are lowercased;
 * everything else is rejected rather than repaired.
 *
 * Throws `RelayError("INVALID_ARGUMENT")` when the shape is wrong, a name is malformed or reserved
 * (the `webhook-*` signature namespace, `content-type`, `idempotency-key`, or a hop-by-hop header),
 * a value contains CR/LF/control/non-ASCII characters or surrounding whitespace, two names collide
 * once lowercased, or the map exceeds {@link MAX_CUSTOM_HEADERS} entries /
 * {@link MAX_CUSTOM_HEADERS_BYTES} bytes.
 *
 * @param input - The caller-supplied header map. Typed as `unknown` because it crosses the public
 * API boundary and may be untyped at runtime.
 * @returns The normalised map, safe to store.
 */
export function validateCustomHeaders(input: unknown): Record<string, string> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new RelayError(
      "INVALID_ARGUMENT",
      "customHeaders must be an object mapping header names to string values",
    );
  }
  const entries = Object.entries(input);
  if (entries.length > MAX_CUSTOM_HEADERS) {
    throw new RelayError(
      "INVALID_ARGUMENT",
      `customHeaders has too many entries: ${String(entries.length)} > ${String(MAX_CUSTOM_HEADERS)}`,
    );
  }
  const out = emptyMap();
  for (const [rawName, rawValue] of entries) {
    const c = classifyHeader(rawName, rawValue);
    if (!c.ok) {
      throw new RelayError("INVALID_ARGUMENT", `customHeaders["${rawName}"]: ${c.reason}`);
    }
    if (c.name in out) {
      // Two spellings of one header (e.g. `X-Foo` and `x-foo`). Last-wins would silently drop one of
      // the caller's values, so this is a rejection.
      throw new RelayError(
        "INVALID_ARGUMENT",
        `customHeaders has duplicate header "${c.name}" (names are case-insensitive)`,
      );
    }
    out[c.name] = c.value;
  }
  const bytes = utf8ToBytes(JSON.stringify(out)).length;
  if (bytes > MAX_CUSTOM_HEADERS_BYTES) {
    throw new RelayError(
      "INVALID_ARGUMENT",
      `customHeaders exceeds the size limit: ${String(bytes)} > ${String(MAX_CUSTOM_HEADERS_BYTES)} bytes`,
    );
  }
  return out;
}

/**
 * Filter a stored custom-header map down to what is safe to send, dropping anything that fails the
 * rule set. Never throws.
 *
 * This is the delivery path's second line of defence, not the primary check: {@link validateCustomHeaders}
 * already rejected these at registration with a visible error. It matters because the store adapters
 * (`commitcourier/store/pg` and friends) are public API, so a caller can write an endpoint row without
 * going through the admin surface — and a spelling like `Webhook-Signature` would otherwise reach the
 * wire as a *second* signature header once undici lowercases it, leaving the receiver's verification
 * undefined. Drops are deliberately silent: threading a logger in would cost this module its purity.
 *
 * @param input - The stored map (plaintext at this point), or null when the endpoint has none.
 */
export function sanitizeCustomHeaders(
  input: Record<string, string> | null,
): Record<string, string> {
  const out = emptyMap();
  if (input == null) return out;
  let count = 0;
  for (const [rawName, rawValue] of Object.entries(input)) {
    if (count >= MAX_CUSTOM_HEADERS) break;
    const c = classifyHeader(rawName, rawValue);
    if (!c.ok || c.name in out) continue;
    out[c.name] = c.value;
    count++;
  }
  return out;
}
