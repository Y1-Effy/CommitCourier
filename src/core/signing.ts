/**
 * Standard Webhooks signing (per 01-core section 5, basic design section 11).
 *
 * Signed content is `{id}.{timestamp}.{body}`, HMAC-SHA256, Base64-encoded.
 * Implemented with the WebCrypto global (`crypto.subtle`) so core stays cross-runtime
 * and import-free; `node:crypto` and `Buffer` are intentionally not used. As a result
 * {@link sign} is async (delivery is already async, so the impact is minimal).
 */
import { base64ToBytes, bytesToBase64, utf8ToBytes } from "./encoding";
import { RelayError } from "./errors";

/** Standard Webhooks signature headers. */
export interface SignatureHeaders {
  "webhook-id": string;
  /** Unix seconds, as a string. */
  "webhook-timestamp": string;
  /** One or more space-separated `"v1,<base64>"` signatures (more than one during key rotation). */
  "webhook-signature": string;
}

const WHSEC_PREFIX = "whsec_";

/**
 * Derive the raw HMAC key bytes from the secret. A `whsec_`-prefixed secret is Base64-decoded;
 * otherwise the raw UTF-8 bytes are used. A malformed Base64 key is a misconfiguration, so the
 * underlying decode error is normalised to a {@link RelayError} rather than a raw `DOMException`.
 */
function decodeSecret(secret: string): Uint8Array<ArrayBuffer> {
  if (!secret.startsWith(WHSEC_PREFIX)) {
    return utf8ToBytes(secret);
  }
  try {
    return base64ToBytes(secret.slice(WHSEC_PREFIX.length));
  } catch (cause) {
    throw new RelayError(
      "CONFIG_INVALID",
      "signing secret is not valid base64 (expected a whsec_-prefixed base64 key)",
      cause,
    );
  }
}

/**
 * Process-wide, bounded LRU memo of `secret -> Promise<CryptoKey>`. Importing the HMAC key is the
 * costly part of signing and is pure for a given secret, so caching it removes a `crypto.subtle.importKey`
 * from every delivery (and from each key during a dual-signing rotation) — a CPU win at high throughput.
 * This is a referentially-transparent memo, not behavioural state: the signature output is unchanged.
 * Keys are non-extractable (`extractable: false`), so the cache never exposes key material beyond what is
 * already in memory, and the size bound keeps it from growing without limit as endpoints/rotations churn.
 */
const KEY_CACHE_MAX = 1024;
const keyCache = new Map<string, Promise<CryptoKey>>();

/** Resolve the HMAC `CryptoKey` for a secret, importing once and memoising (LRU, rejection-safe). */
function importHmacKey(secret: string): Promise<CryptoKey> {
  const hit = keyCache.get(secret);
  if (hit) {
    // LRU touch: re-insert so this secret is the most-recently used (Map preserves insertion order).
    keyCache.delete(secret);
    keyCache.set(secret, hit);
    return hit;
  }
  // decodeSecret is synchronous and may throw CONFIG_INVALID for a malformed whsec_ key; let that
  // propagate before anything is cached (a bad secret is never memoised).
  const keyBytes = decodeSecret(secret);
  const promise = crypto.subtle
    .importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
    .catch((err: unknown) => {
      // Never poison the cache with a rejected import; a later call retries from scratch.
      keyCache.delete(secret);
      throw err;
    });
  keyCache.set(secret, promise);
  if (keyCache.size > KEY_CACHE_MAX) {
    const oldest = keyCache.keys().next().value;
    if (oldest !== undefined) keyCache.delete(oldest);
  }
  return promise;
}

/** Compute a single `v1,<base64>` HMAC-SHA256 signature over the signed content. */
async function signOne(secret: string, signedContent: Uint8Array<ArrayBuffer>): Promise<string> {
  const key = await importHmacKey(secret);
  const mac = await crypto.subtle.sign("HMAC", key, signedContent);
  return `v1,${bytesToBase64(new Uint8Array(mac))}`;
}

/**
 * Sign a webhook per the Standard Webhooks convention.
 *
 * `secrets` carries one or more keys (more than one during a key rotation): each produces a
 * `v1,<base64>` signature and they are joined with a space in `webhook-signature`, so a receiver
 * configured with any of the keys can verify. Order is preserved (the current key first).
 *
 * Per convention each secret is `"whsec_" + base64` (decoded by the internal `decodeSecret`).
 * Rejects with `RelayError("CONFIG_INVALID")` when `secrets` is empty or a `whsec_` secret is not
 * valid Base64.
 */
export async function sign(opts: {
  id: string;
  timestampSec: number;
  body: string;
  secrets: string[];
}): Promise<SignatureHeaders> {
  if (opts.secrets.length === 0) {
    throw new RelayError("CONFIG_INVALID", "sign requires at least one signing secret");
  }
  const signedContent = utf8ToBytes(`${opts.id}.${String(opts.timestampSec)}.${opts.body}`);
  const signatures = await Promise.all(opts.secrets.map((s) => signOne(s, signedContent)));
  return {
    "webhook-id": opts.id,
    "webhook-timestamp": String(opts.timestampSec),
    "webhook-signature": signatures.join(" "),
  };
}
