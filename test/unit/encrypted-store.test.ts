import { describe, expect, it, vi, type Mock } from "vitest";
import { createAesGcmCipher, generateSecretKey } from "../../src/core/cipher";
import { createEncryptedStore } from "../../src/store/encrypted-store";
import type {
  OutboxRow,
  EndpointRow,
  Transition,
  SecretCipher,
  Logger,
} from "../../src/core/index";
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
    customHeaders: null,
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
    completeAttempt: () => Promise.resolve({ transitionApplied: true }),
    queryAttempts: () => Promise.resolve([]),
    listOutbox: () => Promise.resolve({ items: [], nextCursor: null }),
    listEndpoints: () => Promise.resolve({ items: [], nextCursor: null }),
    disableEndpoint: () => Promise.resolve(),
    noteEndpointSuccess: () => Promise.resolve(),
    noteEndpointFailure: () => Promise.resolve(),
    reactivateEndpoint: () => Promise.resolve(),
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

describe("createEncryptedStore custom headers", () => {
  const TOKEN = "Bearer topsecret-token";

  it("encrypts each header value on insert but leaves the names plaintext", async () => {
    const rec = recorder();
    const enc = createEncryptedStore(rec.store, cipher);
    await enc.insertEndpoint({
      id: "ep-1",
      url: "https://x.test",
      secret: PLAINTEXT,
      customHeaders: { authorization: TOKEN, "x-api-key": "k1" },
    });
    const stored = rec.written.endpoint[0]!.customHeaders!;
    // Names readable (a header name is not a secret, and the operator needs to see them)...
    expect(Object.keys(stored).sort()).toEqual(["authorization", "x-api-key"]);
    // ...values are ciphertext.
    expect(stored["authorization"]!.startsWith("ccsec.v1.")).toBe(true);
    expect(stored["x-api-key"]!.startsWith("ccsec.v1.")).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(TOKEN);
    expect(await cipher.decrypt(stored["authorization"]!)).toBe(TOKEN);
  });

  it("decrypts header values on findEndpoint", async () => {
    const rec = recorder();
    const enc = createEncryptedStore(rec.store, cipher);
    rec.reads.endpoint = {
      ...endpointRow(await cipher.encrypt(PLAINTEXT)),
      customHeaders: { authorization: await cipher.encrypt(TOKEN) },
    };
    const found = await enc.findEndpoint("ep-1");
    expect(found!.customHeaders).toEqual({ authorization: TOKEN });
  });

  it("leaves null customHeaders untouched on insert and read", async () => {
    const rec = recorder();
    const enc = createEncryptedStore(rec.store, cipher);
    await enc.insertEndpoint({
      id: "ep-1",
      url: "https://x.test",
      secret: PLAINTEXT,
      customHeaders: null,
    });
    expect(rec.written.endpoint[0]!.customHeaders).toBeNull();

    rec.reads.endpoint = endpointRow(await cipher.encrypt(PLAINTEXT));
    expect((await enc.findEndpoint("ep-1"))!.customHeaders).toBeNull();
  });

  it("encrypts header values supplied in a patch", async () => {
    const rec = recorder();
    const enc = createEncryptedStore(rec.store, cipher);
    await enc.updateEndpoint("ep-1", { customHeaders: { authorization: TOKEN } });
    const patched = rec.written.patch[0]!.customHeaders!;
    expect(patched["authorization"]!.startsWith("ccsec.v1.")).toBe(true);
    expect(await cipher.decrypt(patched["authorization"]!)).toBe(TOKEN);
  });

  it("passes a null customHeaders patch through unencrypted (it clears the map)", async () => {
    const rec = recorder();
    const enc = createEncryptedStore(rec.store, cipher);
    await enc.updateEndpoint("ep-1", { customHeaders: null });
    expect(rec.written.patch[0]!.customHeaders).toBeNull();
  });

  it("does not add customHeaders to a patch that has none", async () => {
    const rec = recorder();
    const enc = createEncryptedStore(rec.store, cipher);
    await enc.updateEndpoint("ep-1", { status: "disabled" });
    expect(rec.written.patch[0]!.customHeaders).toBeUndefined();
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

  it("reports a claim-path quarantine through the data-loss sink (DLQ = data loss)", async () => {
    const good = withId(outboxRow(await cipher.encrypt("whsec_a")), "good");
    const bad = withId(outboxRow(await otherCipher.encrypt("whsec_x")), "bad");
    const { store } = multiStore([bad, good]);
    const dataLoss = vi.fn();
    const enc = createEncryptedStore(store, cipher, undefined, dataLoss);

    await enc.claimDue({ limit: 10, lockedBy: "w", now: new Date() });

    // Exactly one event, for the quarantined row only, with secret-free meta.
    expect(dataLoss).toHaveBeenCalledTimes(1);
    expect(dataLoss.mock.calls[0]![1]).toMatchObject({ id: "bad", attempts: 1 });
  });

  it("does not fire the data-loss sink when the quarantine write itself fails", async () => {
    const bad = withId(outboxRow(await otherCipher.encrypt("whsec_x")), "bad");
    const store: Store = {
      ...multiStore([bad]).store,
      applyTransition: () => Promise.reject(new Error("db down")),
    };
    const dataLoss = vi.fn();
    const enc = createEncryptedStore(store, cipher, undefined, dataLoss);

    await enc.claimDue({ limit: 10, lockedBy: "w", now: new Date() });

    // The row never reached `dead`, so no data-loss event (the failed quarantine is logged instead).
    expect(dataLoss).not.toHaveBeenCalled();
  });

  it("does not fire the data-loss sink for a replay-path skip (no DLQ transition)", async () => {
    const bad = withId(outboxRow(await otherCipher.encrypt("whsec_x")), "bad");
    const { store } = multiStore([bad]);
    const dataLoss = vi.fn();
    const enc = createEncryptedStore(store, cipher, undefined, dataLoss);

    await enc.selectForReplay({});

    expect(dataLoss).not.toHaveBeenCalled();
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

describe("createEncryptedStore pass-through delegation", () => {
  it("delegates secret-free methods straight through to the inner store", async () => {
    const make = (ret: unknown): Mock => vi.fn(() => Promise.resolve(ret));
    const inner = {
      insertOutbox: make(undefined),
      insertOutboxMany: make(undefined),
      insertOutboxAutonomous: make(undefined),
      insertReplayCopies: make(["id1"]),
      insertEndpoint: make(undefined),
      updateEndpoint: make(undefined),
      claimDue: make([]),
      selectForReplay: make([]),
      findEndpoint: make(null),
      applyTransition: make(undefined),
      cancel: make(false),
      reclaimStuck: make(0),
      recordAttempt: make(undefined),
      completeAttempt: make(undefined),
      queryAttempts: make([]),
      getOutbox: make(null),
      listOutbox: make({ items: [], nextCursor: null }),
      listEndpoints: make({ items: [], nextCursor: null }),
      disableEndpoint: make(undefined),
      noteEndpointSuccess: make(undefined),
      noteEndpointFailure: make(undefined),
      reactivateEndpoint: make(undefined),
      prune: make({ deleted: 0 }),
      stats: make({ counts: {}, oldestPendingAt: null }),
      diagnose: make({ ok: true, missingTables: [] }),
      migrate: make(undefined),
    };
    const enc = createEncryptedStore(inner as unknown as Store, cipher);

    // Secret-bearing writes with a null secret exercise the encrypt wrappers without touching the cipher.
    await enc.insertOutboxMany("trx", [newOutbox(null)]);
    await enc.insertOutboxAutonomous(newOutbox(null));
    // Pure pass-throughs.
    await enc.applyTransition("o1", {} as never);
    await enc.cancel("o1");
    await enc.reclaimStuck({} as never);
    await enc.recordAttempt({} as never);
    await enc.completeAttempt({} as never, {} as never, "w");
    await enc.queryAttempts({ outboxId: "o1" });
    await enc.getOutbox("o1");
    await enc.listOutbox({});
    await enc.listEndpoints({});
    await enc.disableEndpoint("e1", new Date());
    await enc.noteEndpointSuccess("e1");
    await enc.noteEndpointFailure("e1", new Date(), 3);
    await enc.reactivateEndpoint("e1");
    await enc.prune({} as never);
    await enc.stats();
    await enc.diagnose();
    await enc.migrate();

    const delegated = [
      "insertOutboxMany",
      "insertOutboxAutonomous",
      "applyTransition",
      "cancel",
      "reclaimStuck",
      "recordAttempt",
      "completeAttempt",
      "queryAttempts",
      "getOutbox",
      "listOutbox",
      "listEndpoints",
      "disableEndpoint",
      "noteEndpointSuccess",
      "noteEndpointFailure",
      "reactivateEndpoint",
      "prune",
      "stats",
      "diagnose",
      "migrate",
    ] as const;
    for (const name of delegated) {
      expect(inner[name]).toHaveBeenCalledTimes(1);
    }
  });

  it("logs an error when quarantining an undecryptable claimed row itself fails (no throw)", async () => {
    // decrypt always fails, so the claimed row is undecryptable; applyTransition (the quarantine)
    // then also fails, exercising the inner catch that logs an error and drops the row.
    const failingCipher: SecretCipher = {
      encrypt: (s: string) => Promise.resolve(s),
      decrypt: () => Promise.reject(new Error("bad key")),
    };
    const errors: { msg: string }[] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn() {},
      error: (msg) => void errors.push({ msg }),
    };
    const inner: Store = {
      ...recorder().store,
      claimDue: () => Promise.resolve([outboxRow("ciphertext")]),
      applyTransition: () => Promise.reject(new Error("db down")),
    };
    const enc = createEncryptedStore(inner, failingCipher, logger);

    const out = await enc.claimDue({ limit: 1, lockedBy: "w", now: new Date() });

    expect(out).toEqual([]); // the bad row is dropped, not thrown
    expect(errors).toHaveLength(1); // logger.error on the failed quarantine
  });
});
