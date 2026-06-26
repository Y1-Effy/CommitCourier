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
function decodeSecret(secret: string): Uint8Array {
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

/** Compute a single `v1,<base64>` HMAC-SHA256 signature over the signed content. */
async function signOne(secret: string, signedContent: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    decodeSecret(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
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
