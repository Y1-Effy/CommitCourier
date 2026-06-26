import { describe, expect, it } from "vitest";
import { RelayError } from "../../src/core/errors";
import { base64ToBytes, bytesToBase64 } from "../../src/core/encoding";
import { createAesGcmCipher, generateSecretKey } from "../../src/core/cipher";

const KEY = generateSecretKey();

describe("createAesGcmCipher", () => {
  it("round-trips a plaintext secret", async () => {
    const cipher = createAesGcmCipher(KEY);
    const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
    const ct = await cipher.encrypt(secret);
    expect(await cipher.decrypt(ct)).toBe(secret);
  });

  it("emits a versioned ccsec.v1 envelope, not the plaintext", async () => {
    const cipher = createAesGcmCipher(KEY);
    const ct = await cipher.encrypt("super-secret");
    expect(ct.startsWith("ccsec.v1.")).toBe(true);
    expect(ct).not.toContain("super-secret");
  });

  it("uses a fresh IV so the same plaintext encrypts to different ciphertexts", async () => {
    const cipher = createAesGcmCipher(KEY);
    const a = await cipher.encrypt("same");
    const b = await cipher.encrypt("same");
    expect(a).not.toBe(b);
    expect(await cipher.decrypt(a)).toBe("same");
    expect(await cipher.decrypt(b)).toBe("same");
  });

  it("round-trips non-ASCII secrets (U+1F510 lock emoji, U+3042 hiragana)", async () => {
    const cipher = createAesGcmCipher(KEY);
    const secret = `\u{1F510}-key-${String.fromCharCode(0x3042)}`;
    expect(await cipher.decrypt(await cipher.encrypt(secret))).toBe(secret);
  });

  it("accepts a raw 32-byte key", async () => {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const cipher = createAesGcmCipher(raw);
    expect(await cipher.decrypt(await cipher.encrypt("x"))).toBe("x");
  });

  it("rejects a key of the wrong length with RelayError(CONFIG_INVALID)", () => {
    expect(() => createAesGcmCipher(new Uint8Array(16))).toThrow(RelayError);
    try {
      createAesGcmCipher(new Uint8Array(16));
    } catch (e) {
      expect((e as RelayError).code).toBe("CONFIG_INVALID");
    }
  });

  it("rejects a non-base64 key string", () => {
    expect(() => createAesGcmCipher("@@@not-base64@@@")).toThrow(RelayError);
  });

  it("fails to decrypt with a different key (authentication failure)", async () => {
    const ct = await createAesGcmCipher(KEY).encrypt("secret");
    const other = createAesGcmCipher(generateSecretKey());
    await expect(other.decrypt(ct)).rejects.toBeInstanceOf(RelayError);
    await expect(other.decrypt(ct)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("detects tampering (a flipped ciphertext byte fails GCM authentication)", async () => {
    const cipher = createAesGcmCipher(KEY);
    const ct = await cipher.encrypt("secret");
    // Decode the envelope, flip a byte inside the ciphertext+tag region (the last byte is part of
    // the GCM tag), then re-encode. The result is still structurally valid base64, so decryption
    // reaches — and is rejected by — the GCM authentication check rather than a decode error.
    const body = base64ToBytes(ct.slice("ccsec.v1.".length));
    const i = body.length - 1;
    body[i] = (body[i] ?? 0) ^ 0xff;
    const tampered = "ccsec.v1." + bytesToBase64(body);
    await expect(cipher.decrypt(tampered)).rejects.toBeInstanceOf(RelayError);
    await expect(cipher.decrypt(tampered)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("rejects a ciphertext without the envelope prefix", async () => {
    const cipher = createAesGcmCipher(KEY);
    await expect(cipher.decrypt("not-an-envelope")).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
  });
});
