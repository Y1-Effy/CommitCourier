import { describe, expect, it } from "vitest";
import { RelayError } from "../../src/core/errors";
import { sign } from "../../src/core/signing";
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
