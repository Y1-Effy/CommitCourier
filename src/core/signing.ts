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
  /** `"v1,<base64>"`. */
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

/**
 * Sign a webhook per the Standard Webhooks convention.
 *
 * Per convention the secret is `"whsec_" + base64` (decoded by the internal `decodeSecret`).
 * Rejects
 * with `RelayError("CONFIG_INVALID")` when a `whsec_` secret is not valid Base64.
 */
export async function sign(opts: {
  id: string;
  timestampSec: number;
  body: string;
  secret: string;
}): Promise<SignatureHeaders> {
  const keyBytes = decodeSecret(opts.secret);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signedContent = `${opts.id}.${String(opts.timestampSec)}.${opts.body}`;
  const mac = await crypto.subtle.sign("HMAC", key, utf8ToBytes(signedContent));
  return {
    "webhook-id": opts.id,
    "webhook-timestamp": String(opts.timestampSec),
    "webhook-signature": `v1,${bytesToBase64(new Uint8Array(mac))}`,
  };
}
