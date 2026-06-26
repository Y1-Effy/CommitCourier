/**
 * Transparent at-rest encryption for signing secrets, as a {@link Store} decorator.
 *
 * Wrapping a store with {@link createEncryptedStore} encrypts the secret columns
 * (`secretSnapshot`, endpoint `secret`) on the way to the backend and decrypts them on the way
 * back, so every other layer (relay, delivery, admin) keeps seeing plaintext while the value at
 * rest is always ciphertext. All encryption is confined to this one module — the underlying
 * adapter and the rest of the codebase are unchanged.
 *
 * Only the secret-bearing methods carry logic; everything else passes straight through.
 *
 * Decryption happens at the store boundary (`claimDue` / `selectForReplay` / `findEndpoint`), so a
 * bad key or corrupted ciphertext surfaces as a thrown error there. On the dispatch path that stays
 * fail-open: the dispatcher wraps `claimDue` in try/catch and keeps looping. Note this is a
 * batch-level failure — a single undecryptable row rejects the whole claim batch (those rows remain
 * `in_flight` until the visibility-timeout reclaim, then retry), which only arises under genuine
 * key misconfiguration or data corruption, never in normal operation.
 */
import type { SecretCipher } from "../core/index";
import type { OutboxRow, EndpointRow } from "../core/index";
import type { NewOutboxRow, NewEndpointRow, EndpointPatch, Store } from "./store";

/** Encrypt the `secretSnapshot` of a new outbox row (null is left as-is). */
async function encryptOutbox(row: NewOutboxRow, cipher: SecretCipher): Promise<NewOutboxRow> {
  if (row.secretSnapshot == null) return row;
  return { ...row, secretSnapshot: await cipher.encrypt(row.secretSnapshot) };
}

/** Decrypt the `secretSnapshot` of a fetched outbox row (null is left as-is). */
async function decryptOutbox(row: OutboxRow, cipher: SecretCipher): Promise<OutboxRow> {
  if (row.secretSnapshot == null) return row;
  return { ...row, secretSnapshot: await cipher.decrypt(row.secretSnapshot) };
}

/**
 * Wrap a store so signing secrets are encrypted at rest with `cipher`. The returned store is a
 * drop-in `Store<TTx>`; secrets are plaintext at this boundary and ciphertext in the backend.
 */
export function createEncryptedStore<TTx>(inner: Store<TTx>, cipher: SecretCipher): Store<TTx> {
  return {
    // --- writes: encrypt secrets before they reach the backend ---
    async insertOutbox(trx, row) {
      await inner.insertOutbox(trx, await encryptOutbox(row, cipher));
    },
    async insertOutboxMany(trx, rows) {
      await inner.insertOutboxMany(
        trx,
        await Promise.all(rows.map((r) => encryptOutbox(r, cipher))),
      );
    },
    async insertOutboxAutonomous(row) {
      await inner.insertOutboxAutonomous(await encryptOutbox(row, cipher));
    },
    async insertReplayCopies(rows) {
      return inner.insertReplayCopies(await Promise.all(rows.map((r) => encryptOutbox(r, cipher))));
    },
    async insertEndpoint(ep) {
      const enc: NewEndpointRow = { ...ep, secret: await cipher.encrypt(ep.secret) };
      await inner.insertEndpoint(enc);
    },
    async updateEndpoint(id, patch) {
      // Encrypt whichever secret column the patch sets. `secretSecondary: null` (rotation finalize)
      // is left as-is; only a string value is encrypted.
      const enc: EndpointPatch = { ...patch };
      if (typeof patch.secret === "string") enc.secret = await cipher.encrypt(patch.secret);
      if (typeof patch.secretSecondary === "string") {
        enc.secretSecondary = await cipher.encrypt(patch.secretSecondary);
      }
      await inner.updateEndpoint(id, enc);
    },

    // --- reads: decrypt secrets coming back from the backend ---
    async claimDue(opts) {
      const rows = await inner.claimDue(opts);
      return Promise.all(rows.map((r) => decryptOutbox(r, cipher)));
    },
    async selectForReplay(filter) {
      const rows = await inner.selectForReplay(filter);
      return Promise.all(rows.map((r) => decryptOutbox(r, cipher)));
    },
    async findEndpoint(id) {
      const ep = await inner.findEndpoint(id);
      if (!ep) return ep;
      const decrypted: EndpointRow = {
        ...ep,
        secret: await cipher.decrypt(ep.secret),
        secretSecondary:
          ep.secretSecondary == null ? null : await cipher.decrypt(ep.secretSecondary),
      };
      return decrypted;
    },

    // --- pass-through: no secret columns involved ---
    applyTransition: (id, t) => inner.applyTransition(id, t),
    reclaimStuck: (opts) => inner.reclaimStuck(opts),
    recordAttempt: (attempt) => inner.recordAttempt(attempt),
    completeAttempt: (attempt, transition) => inner.completeAttempt(attempt, transition),
    queryAttempts: (opts) => inner.queryAttempts(opts),
    disableEndpoint: (id, now) => inner.disableEndpoint(id, now),
    stats: () => inner.stats(),
    diagnose: () => inner.diagnose(),
    migrate: () => inner.migrate(),
  };
}
