import { describe, expect, it } from "vitest";
import { sign } from "../../src/core/signing";
import vectors from "../fixtures/standard-webhooks-vectors.json" with { type: "json" };

describe("signing.sign", () => {
  it.each(vectors.vectors)(
    "matches the reference signature: $name",
    async ({ secret, id, timestampSec, payload, expectedSignature }) => {
      const headers = await sign({ id, timestampSec, body: payload, secret });
      expect(headers["webhook-signature"]).toBe(expectedSignature);
    },
  );

  it("returns id and timestamp headers verbatim", async () => {
    const headers = await sign({
      id: "msg_x",
      timestampSec: 1614265330,
      body: "{}",
      secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
    });
    expect(headers["webhook-id"]).toBe("msg_x");
    expect(headers["webhook-timestamp"]).toBe("1614265330");
    expect(headers["webhook-signature"]).toMatch(/^v1,/);
  });

  it("decodes a whsec_ secret differently from treating it as raw bytes", async () => {
    const opts = { id: "msg_x", timestampSec: 1, body: "hello" };
    const decoded = await sign({ ...opts, secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw" });
    const raw = await sign({ ...opts, secret: "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw" });
    expect(decoded["webhook-signature"]).not.toBe(raw["webhook-signature"]);
  });
});
