/**
 * At-rest secret encryption (per the at-rest encryption design).
 *
 * Signing secrets (`webhook_outbox.secret_snapshot`, `webhook_endpoints.secret`) are encrypted
 * before they reach the store and decrypted at the point of use, so the value at rest in the DB
 * is always ciphertext. Like {@link "./signing"}, this is implemented with the WebCrypto global
 * (`crypto.subtle` / `crypto.getRandomValues`) so core stays cross-runtime and import-free;
 * `node:crypto` and `Buffer` are intentionally not used.
 *
 * The cipher is injected at the store boundary (see {@link "../store/encrypted-store"}); a
 * {@link SecretCipher} can also be implemented over an external KMS/Vault instead of the built-in
 * AES-GCM helper.
 */
import { base64ToBytes, bytesToBase64, bytesToUtf8, utf8ToBytes } from "./encoding";
import { RelayError } from "./errors";

/**
 * Reversible string cipher for secrets at rest. Implementations must round-trip
 * (`decrypt(encrypt(x)) === x`) and should be authenticated so tampering is detectable.
 */
export interface SecretCipher {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

/** Envelope tag prefixing every ciphertext: versioned so a future key rotation can coexist. */
const ENVELOPE_PREFIX = "ccsec.v1.";
/** AES-GCM nonce length in bytes (96-bit, the recommended size). */
const IV_BYTES = 12;
/** AES-256 key length in bytes. */
const KEY_BYTES = 32;

/** Accept a raw 32-byte key or a base64 string that decodes to 32 bytes. */
function coerceKey(key: Uint8Array | string): Uint8Array {
  let bytes: Uint8Array;
  if (typeof key === "string") {
    try {
      bytes = base64ToBytes(key);
    } catch (cause) {
      throw new RelayError("CONFIG_INVALID", "cipher key string must be valid base64", cause);
    }
  } else {
    bytes = key;
  }
  if (bytes.length !== KEY_BYTES) {
    throw new RelayError(
      "CONFIG_INVALID",
      `cipher key must be ${String(KEY_BYTES)} bytes (AES-256), got ${String(bytes.length)}`,
    );
  }
  return bytes;
}

/**
 * Build an AES-256-GCM {@link SecretCipher} from a 32-byte key (raw bytes or base64 string).
 *
 * Each {@link SecretCipher.encrypt} draws a fresh random 96-bit IV; the output is
 * `"ccsec.v1." + base64(iv ‖ ciphertext+tag)`. Decryption is authenticated, so a tampered or
 * wrong-key ciphertext rejects with `RelayError("CONFIG_INVALID")` rather than returning garbage.
 *
 * @throws RelayError CONFIG_INVALID when the key is not 32 bytes (or not valid base64).
 */
export function createAesGcmCipher(key: Uint8Array | string): SecretCipher {
  const keyBytes = coerceKey(key);
  // Import once and reuse; the CryptoKey is non-extractable.
  const cryptoKey = crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);

  return {
    async encrypt(plaintext) {
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const ct = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        await cryptoKey,
        utf8ToBytes(plaintext),
      );
      const ctBytes = new Uint8Array(ct);
      const envelope = new Uint8Array(IV_BYTES + ctBytes.length);
      envelope.set(iv, 0);
      envelope.set(ctBytes, IV_BYTES);
      return ENVELOPE_PREFIX + bytesToBase64(envelope);
    },
    async decrypt(ciphertext) {
      if (!ciphertext.startsWith(ENVELOPE_PREFIX)) {
        throw new RelayError("CONFIG_INVALID", `ciphertext is not a ${ENVELOPE_PREFIX} envelope`);
      }
      let envelope: Uint8Array;
      try {
        envelope = base64ToBytes(ciphertext.slice(ENVELOPE_PREFIX.length));
      } catch (cause) {
        throw new RelayError("CONFIG_INVALID", "ciphertext envelope is not valid base64", cause);
      }
      if (envelope.length <= IV_BYTES) {
        throw new RelayError("CONFIG_INVALID", "ciphertext envelope is truncated");
      }
      const iv = envelope.subarray(0, IV_BYTES);
      const body = envelope.subarray(IV_BYTES);
      let plain: ArrayBuffer;
      try {
        plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await cryptoKey, body);
      } catch (cause) {
        // Authentication failure: tampered ciphertext or a wrong key.
        throw new RelayError(
          "CONFIG_INVALID",
          "secret decryption failed (bad key or tampering)",
          cause,
        );
      }
      return bytesToUtf8(new Uint8Array(plain));
    },
  };
}

/** Generate a fresh random AES-256 key as a base64 string, for {@link createAesGcmCipher}. */
export function generateSecretKey(): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}
