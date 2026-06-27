import { describe, expect, it } from "vitest";
import { createAesGcmCipher, generateSecretKey } from "../../src/core/cipher";
import { createEncryptedStore } from "../../src/store/encrypted-store";
import type { OutboxRow, EndpointRow, Transition, SecretCipher } from "../../src/core/index";
import type { NewOutboxRow, NewEndpointRow, EndpointPatch, Store } from "../../src/store/store";

const PLAINTEXT = "whsec_topsecret";

function newOutbox(secretSnapshot: string | null): NewOutboxRow {
  return {
    id: "out-1",
    eventType: "order.created",
    payload: { a: 1 },
    endpointId: null,
    targetUrl: "https://example.test/hook",
    secretSnapshot,
    status: "pending",
    attempts: 0,
    availableAt: new Date(0),
    idempotencyKey: null,
  };
}

function outboxRow(secretSnapshot: string | null): OutboxRow {
  return {
    ...newOutbox(secretSnapshot),
    lockedAt: null,
    lockedBy: null,
    lastError: null,
    createdAt: new Date(0),
    dispatchedAt: null,
  };
}

function endpointRow(secret: string, secretSecondary: string | null = null): EndpointRow {
  return {
    id: "ep-1",
    url: "https://example.test/hook",
    secret,
    secretSecondary,
    status: "active",
    description: null,
    consecutiveFailures: 0,
    disabledAt: null,
    metadata: null,
    createdAt: new Date(0),
  };
}

/** A fake store that records writes and serves canned reads, so we can inspect at-rest values. */
interface Recorder {
  store: Store;
  written: { outbox: NewOutboxRow[]; endpoint: NewEndpointRow[]; patch: EndpointPatch[] };
  reads: { outbox: OutboxRow | null; endpoint: EndpointRow | null };
}

function recorder(): Recorder {
  const written: Recorder["written"] = { outbox: [], endpoint: [], patch: [] };
  const reads: Recorder["reads"] = { outbox: null, endpoint: null };
  const store: Store = {
    insertOutbox: (_trx, row) => Promise.resolve(void written.outbox.push(row)),
    insertOutboxMany: (_trx, rows) => Promise.resolve(void written.outbox.push(...rows)),
    insertOutboxAutonomous: (row) => Promise.resolve(void written.outbox.push(row)),
    insertReplayCopies: (rows) => {
      written.outbox.push(...rows);
      return Promise.resolve(rows.map((r) => r.id));
    },
    insertEndpoint: (ep) => Promise.resolve(void written.endpoint.push(ep)),
    updateEndpoint: (_id, patch) => Promise.resolve(void written.patch.push(patch)),
    claimDue: () => Promise.resolve(reads.outbox ? [reads.outbox] : []),
    selectForReplay: () => Promise.resolve(reads.outbox ? [reads.outbox] : []),
    findEndpoint: () => Promise.resolve(reads.endpoint),
    getOutbox: () => Promise.resolve(null),
    applyTransition: () => Promise.resolve(),
    cancel: () => Promise.resolve(false),
    prune: () => Promise.resolve({ deleted: 0 }),
    reclaimStuck: () => Promise.resolve(0),
    recordAttempt: () => Promise.resolve(),
    completeAttempt: () => Promise.resolve(),
    queryAttempts: () => Promise.resolve([]),
    listOutbox: () => Promise.resolve({ items: [], nextCursor: null }),
    listEndpoints: () => Promise.resolve({ items: [], nextCursor: null }),
    disableEndpoint: () => Promise.resolve(),
    noteEndpointSuccess: () => Promise.resolve(),
    noteEndpointFailure: () => Promise.resolve(),
    stats: () => Promise.resolve({ counts: {} as never, oldestPendingAt: null }),
    diagnose: () => Promise.resolve({ ok: true, missingTables: [] }),
    migrate: () => Promise.resolve(),
  };
  return { store, written, reads };
}

const cipher = createAesGcmCipher(generateSecretKey());

describe("createEncryptedStore", () => {
  it("encrypts secretSnapshot before it reaches the inner store", async () => {
    const rec = recorder();
    const enc = createEncryptedStore(rec.store, cipher);
    await enc.insertOutbox(undefined, newOutbox(PLAINTEXT));
    const stored = rec.written.outbox[0]!.secretSnapshot!;
    expect(stored.startsWith("ccsec.v1.")).toBe(true);
    expect(stored).not.toContain(PLAINTEXT);
    expect(await cipher.decrypt(stored)).toBe(PLAINTEXT);
  });

  it("leaves a null secretSnapshot untouched", async () => {
    const rec = recorder();
    const enc = createEncryptedStore(rec.store, cipher);
    await enc.insertOutbox(undefined, newOutbox(null));
    expect(rec.written.outbox[0]!.secretSnapshot).toBeNull();
  });

  it("decrypts secretSnapshot when claiming rows", async () => {
    const rec = recorder();
    rec.reads.outbox = outboxRow(await cipher.encrypt(PLAINTEXT));
    const enc = createEncryptedStore(rec.store, cipher);
    const [row] = await enc.claimDue({ limit: 1, lockedBy: "w", now: new Date() });
    expect(row!.secretSnapshot).toBe(PLAINTEXT);
  });

  it("encrypts the endpoint secret on insert and decrypts on findEndpoint", async () => {
    const rec = recorder();
    const enc = createEncryptedStore(rec.store, cipher);
    const ep: NewEndpointRow = { id: "ep-1", url: "https://x.test", secret: PLAINTEXT };
    await enc.insertEndpoint(ep);
    const stored = rec.written.endpoint[0]!.secret;
    expect(stored.startsWith("ccsec.v1.")).toBe(true);

    rec.reads.endpoint = endpointRow(stored);
    const found = await enc.findEndpoint("ep-1");
    expect(found!.secret).toBe(PLAINTEXT);
  });

  it("encrypts a secret supplied in an endpoint patch, leaving other fields intact", async () => {
    const rec = recorder();
    const enc = createEncryptedStore(rec.store, cipher);
    await enc.updateEndpoint("ep-1", { secret: PLAINTEXT, description: "d" });
    const patch = rec.written.patch[0]!;
    expect(patch.description).toBe("d");
    expect(patch.secret!.startsWith("ccsec.v1.")).toBe(true);
    expect(await cipher.decrypt(patch.secret!)).toBe(PLAINTEXT);
  });

  it("does not add a secret to a patch that has none", async () => {
    const rec = recorder();
    const enc = createEncryptedStore(rec.store, cipher);
    await enc.updateEndpoint("ep-1", { status: "disabled" });
    expect(rec.written.patch[0]!.secret).toBeUndefined();
  });

  it("round-trips through replay (decrypt on select, re-encrypt on insert)", async () => {
    const rec = recorder();
    rec.reads.outbox = outboxRow(await cipher.encrypt(PLAINTEXT));
    const enc = createEncryptedStore(rec.store, cipher);
    const selected = await enc.selectForReplay({});
    expect(selected[0]!.secretSnapshot).toBe(PLAINTEXT);
    await enc.insertReplayCopies(selected.map((r) => ({ ...newOutbox(r.secretSnapshot) })));
    const stored = rec.written.outbox[0]!.secretSnapshot!;
    expect(stored.startsWith("ccsec.v1.")).toBe(true);
    expect(await cipher.decrypt(stored)).toBe(PLAINTEXT);
  });
});

describe("createEncryptedStore decryption isolation", () => {
  // A second cipher with a different key: rows encrypted with it are valid `ccsec.v1.` envelopes that
  // fail to decrypt under `cipher` (an AES-GCM auth failure) — the realistic key-mismatch scenario.
  const otherCipher = createAesGcmCipher(generateSecretKey());

  function multiStore(rows: OutboxRow[]): {
    store: Store;
    transitions: { id: string; t: Transition }[];
  } {
    const transitions: { id: string; t: Transition }[] = [];
    const store: Store = {
      ...recorder().store,
      claimDue: () => Promise.resolve(rows),
      selectForReplay: () => Promise.resolve(rows),
      applyTransition: (id, t) => {
        transitions.push({ id, t });
        return Promise.resolve();
      },
    };
    return { store, transitions };
  }

  const withId = (row: OutboxRow, id: string): OutboxRow => ({ ...row, id });

  it("quarantines an undecryptable claimed row to dead and still returns the good rows", async () => {
    const good1 = withId(outboxRow(await cipher.encrypt("whsec_a")), "good-1");
    const bad = { ...withId(outboxRow(await otherCipher.encrypt("whsec_x")), "bad"), attempts: 3 };
    const good2 = withId(outboxRow(await cipher.encrypt("whsec_b")), "good-2");
    const { store, transitions } = multiStore([bad, good1, good2]);
    const enc = createEncryptedStore(store, cipher);

    const out = await enc.claimDue({ limit: 10, lockedBy: "w", now: new Date() });

    // The good rows are delivered (decrypted); the bad one is dropped from the batch — no throw.
    expect(out.map((r) => r.id)).toEqual(["good-1", "good-2"]);
    expect(out.map((r) => r.secretSnapshot)).toEqual(["whsec_a", "whsec_b"]);
    // The bad row is quarantined straight to the DLQ so it can never wedge the queue.
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      id: "bad",
      t: { status: "dead", attempts: 4, lockedAt: null, lockedBy: null },
    });
  });

  it("skips an undecryptable row during selectForReplay without quarantining it", async () => {
    const good = withId(outboxRow(await cipher.encrypt("whsec_a")), "good");
    const bad = withId(outboxRow(await otherCipher.encrypt("whsec_x")), "bad");
    const { store, transitions } = multiStore([bad, good]);
    const enc = createEncryptedStore(store, cipher);

    const out = await enc.selectForReplay({});

    expect(out.map((r) => r.id)).toEqual(["good"]);
    expect(transitions).toHaveLength(0);
  });

  it("normalises any findEndpoint decryption failure to CONFIG_INVALID (custom-cipher safe)", async () => {
    // A custom SecretCipher that throws a plain Error (not a RelayError). The delivery path keys its
    // permanent-vs-retryable decision on RelayError CONFIG_INVALID, so the decorator must normalise.
    const throwingCipher: SecretCipher = {
      encrypt: (s: string) => Promise.resolve(s),
      decrypt: () => Promise.reject(new Error("kms unreachable")),
    };
    const rec = recorder();
    rec.reads.endpoint = endpointRow("ciphertext");
    const enc = createEncryptedStore(rec.store, throwingCipher);

    await expect(enc.findEndpoint("ep-1")).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});
