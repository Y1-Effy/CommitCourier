import { describe, expect, it, vi } from "vitest";
import { RelayError } from "../../src/core/errors";
import { sign, verifySignature } from "../../src/core/signing";
import vectors from "../fixtures/standard-webhooks-vectors.json" with { type: "json" };

describe("signing.sign", () => {
  it.each(vectors.vectors)(
    "matches the reference signature: $name",
    async ({ secret, id, timestampSec, payload, expectedSignature }) => {
      const headers = await sign({ id, timestampSec, body: payload, secrets: [secret] });
      expect(headers["webhook-signature"]).toBe(expectedSignature);
    },
  );

  it("returns id and timestamp headers verbatim", async () => {
    const headers = await sign({
      id: "msg_x",
      timestampSec: 1614265330,
      body: "{}",
      secrets: ["whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"],
    });
    expect(headers["webhook-id"]).toBe("msg_x");
    expect(headers["webhook-timestamp"]).toBe("1614265330");
    expect(headers["webhook-signature"]).toMatch(/^v1,/);
  });

  it("decodes a whsec_ secret differently from treating it as raw bytes", async () => {
    const opts = { id: "msg_x", timestampSec: 1, body: "hello" };
    const decoded = await sign({ ...opts, secrets: ["whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"] });
    const raw = await sign({ ...opts, secrets: ["MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"] });
    expect(decoded["webhook-signature"]).not.toBe(raw["webhook-signature"]);
  });

  it("rejects a whsec_ secret that is not valid base64 with RelayError(CONFIG_INVALID)", async () => {
    const promise = sign({ id: "msg_x", timestampSec: 1, body: "hello", secrets: ["whsec_@@@"] });
    await expect(promise).rejects.toBeInstanceOf(RelayError);
    await expect(promise).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("treats a non-prefixed secret as raw bytes even if it is not base64", async () => {
    // Without the whsec_ prefix the secret is used verbatim, so "@@@" is a valid raw key.
    const headers = await sign({ id: "msg_x", timestampSec: 1, body: "hello", secrets: ["@@@"] });
    expect(headers["webhook-signature"]).toMatch(/^v1,/);
  });

  it("emits one space-separated v1 signature per secret during a key rotation", async () => {
    const opts = { id: "msg_x", timestampSec: 1, body: "hello" };
    const a = await sign({ ...opts, secrets: ["whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"] });
    const b = await sign({ ...opts, secrets: ["second-key"] });
    const both = await sign({
      ...opts,
      secrets: ["whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", "second-key"],
    });
    // Order preserved (current key first), each part is a standalone valid signature.
    expect(both["webhook-signature"]).toBe(`${a["webhook-signature"]} ${b["webhook-signature"]}`);
  });

  it("rejects an empty secrets list with RelayError(CONFIG_INVALID)", async () => {
    const promise = sign({ id: "msg_x", timestampSec: 1, body: "hello", secrets: [] });
    await expect(promise).rejects.toBeInstanceOf(RelayError);
    await expect(promise).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("signing.verifySignature", () => {
  const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
  const base = { id: "msg_x", timestampSec: 1614265330, body: '{"hello":"world"}' };

  const accept = async (over: Partial<Parameters<typeof verifySignature>[0]> = {}) => {
    const headers = await sign({ ...base, secrets: [secret] });
    return verifySignature({
      id: base.id,
      timestamp: headers["webhook-timestamp"],
      payload: base.body,
      header: headers["webhook-signature"],
      secrets: [secret],
      nowSec: base.timestampSec,
      ...over,
    });
  };

  it("accepts a signature produced by sign (round trip)", async () => {
    await expect(accept()).resolves.toBe(true);
  });

  it("rejects a tampered payload", async () => {
    await expect(accept({ payload: '{"hello":"WORLD"}' })).resolves.toBe(false);
  });

  it("rejects the wrong secret", async () => {
    await expect(accept({ secrets: ["whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"] })).resolves.toBe(
      false,
    );
  });

  it("rejects an expired timestamp beyond tolerance", async () => {
    await expect(accept({ nowSec: base.timestampSec + 301 })).resolves.toBe(false);
  });

  it("accepts within the tolerance window", async () => {
    await expect(accept({ nowSec: base.timestampSec + 299 })).resolves.toBe(true);
  });

  it("honours an explicit toleranceSec", async () => {
    await expect(accept({ nowSec: base.timestampSec + 50, toleranceSec: 10 })).resolves.toBe(false);
    await expect(accept({ nowSec: base.timestampSec + 5, toleranceSec: 10 })).resolves.toBe(true);
  });

  it("rejects a tampered id", async () => {
    await expect(accept({ id: "msg_y" })).resolves.toBe(false);
  });

  it("verifies either key when given a rotated header with multiple signatures", async () => {
    const newSecret = "whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const headers = await sign({ ...base, secrets: [secret, newSecret] });
    // A receiver that knows only the new key still verifies the dual-signed header.
    await expect(
      verifySignature({
        id: base.id,
        timestamp: headers["webhook-timestamp"],
        payload: base.body,
        header: headers["webhook-signature"],
        secrets: [newSecret],
        nowSec: base.timestampSec,
      }),
    ).resolves.toBe(true);
  });

  it("rejects an empty or garbled signature header", async () => {
    await expect(accept({ header: "" })).resolves.toBe(false);
    await expect(accept({ header: "   " })).resolves.toBe(false);
    await expect(accept({ header: "v1,not-base64" })).resolves.toBe(false);
  });

  it("rejects a non-numeric timestamp", async () => {
    await expect(accept({ timestamp: "not-a-number" })).resolves.toBe(false);
  });

  it("throws RelayError(CONFIG_INVALID) on an empty secrets list", async () => {
    const promise = verifySignature({
      id: base.id,
      timestamp: base.timestampSec,
      payload: base.body,
      header: "v1,whatever",
      secrets: [],
      nowSec: base.timestampSec,
    });
    await expect(promise).rejects.toBeInstanceOf(RelayError);
    await expect(promise).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("signing key cache", () => {
  let counter = 0;
  // A fresh secret per use so the assertion never depends on what earlier tests cached.
  const uniqueSecret = (): string => `cache-key-${String(Date.now())}-${String(counter++)}`;
  const sig = (secret: string): Promise<string> =>
    sign({ id: "m", timestampSec: 1, body: "hello", secrets: [secret] }).then(
      (h) => h["webhook-signature"],
    );

  it("imports the HMAC key once per distinct secret and returns identical signatures", async () => {
    const spy = vi.spyOn(crypto.subtle, "importKey");
    try {
      spy.mockClear();
      const s = uniqueSecret();
      const a = await sig(s);
      const b = await sig(s);
      expect(spy).toHaveBeenCalledTimes(1); // the repeat hit the cache, no second import
      expect(a).toBe(b); // memoisation never changes the output
      await sig(uniqueSecret());
      expect(spy).toHaveBeenCalledTimes(2); // a new secret imports again
    } finally {
      spy.mockRestore();
    }
  });

  it("never caches a malformed secret: a bad whsec_ key rejects every time", async () => {
    const spy = vi.spyOn(crypto.subtle, "importKey");
    try {
      spy.mockClear();
      const bad = "whsec_@@@";
      await expect(sig(bad)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      await expect(sig(bad)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      // decodeSecret throws before importKey, so the bad key is never imported or cached.
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
