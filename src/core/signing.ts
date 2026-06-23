/**
 * Standard Webhooks signing (per 01-core section 5, basic design section 11).
 *
 * Signed content is `{id}.{timestamp}.{body}`, HMAC-SHA256, Base64-encoded.
 * Implemented with the WebCrypto global (`crypto.subtle`) so core stays cross-runtime
 * and import-free; `node:crypto` and `Buffer` are intentionally not used. As a result
 * {@link sign} is async (delivery is already async, so the impact is minimal).
 */
import { base64ToBytes, bytesToBase64, utf8ToBytes } from "./encoding";

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
 * Sign a webhook per the Standard Webhooks convention.
 *
 * Per convention the secret is `"whsec_" + base64`; when prefixed with `whsec_` the
 * remainder is Base64-decoded for the HMAC key, otherwise the raw UTF-8 bytes are used.
 */
export async function sign(opts: {
  id: string;
  timestampSec: number;
  body: string;
  secret: string;
}): Promise<SignatureHeaders> {
  const keyBytes = opts.secret.startsWith(WHSEC_PREFIX)
    ? base64ToBytes(opts.secret.slice(WHSEC_PREFIX.length))
    : utf8ToBytes(opts.secret);
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
