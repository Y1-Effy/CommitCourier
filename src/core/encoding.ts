/**
 * Pure UTF-8 / Base64 conversion (per 01-core section 5.1).
 *
 * Uses only Web standard globals (`TextEncoder` / `atob` / `btoa`) so that core stays
 * cross-runtime and import-free. `Buffer` is intentionally not used.
 */

const _enc = /* @__PURE__ */ new TextEncoder();

/** Encode a string to its UTF-8 bytes. */
export function utf8ToBytes(s: string): Uint8Array {
  return _enc.encode(s);
}

/** Decode a standard (non-URL-safe) Base64 string to bytes. */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

/** Encode bytes to a standard (non-URL-safe) Base64 string. */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) {
    bin += String.fromCharCode(b);
  }
  return btoa(bin);
}
