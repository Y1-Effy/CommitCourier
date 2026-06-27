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
 * Decryption happens at the store boundary (`claimDue` / `selectForReplay` / `findEndpoint`). A bad
 * key or corrupted ciphertext is isolated per row, never batch-wide: on the dispatch path
 * (`claimDue`) an undecryptable row is quarantined straight to `dead` (the DLQ) and dropped from the
 * batch, so one bad row can never wedge the queue — the remaining rows deliver normally and the bad
 * one is visible in the DLQ (replayable once the key is fixed). `selectForReplay` skips undecryptable
 * rows (logging each) so an admin replay is not aborted by a single bad row. `findEndpoint` still
 * throws on decryption failure, which the delivery path catches and routes to a failure for that one
 * row. This only arises under genuine key misconfiguration or data corruption, never in normal use.
 */
import type { SecretCipher, Logger, Transition } from "../core/index";
import type { OutboxRow, EndpointRow } from "../core/index";
import type { NewOutboxRow, NewEndpointRow, EndpointPatch, Store } from "./store";

const NO_OP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/** Transition that quarantines an undecryptable row to the DLQ (matches `core/state.onPermanentFailure`). */
function quarantineTransition(row: OutboxRow): Transition {
  return {
    status: "dead",
    attempts: row.attempts + 1,
    lastError: "secret decryption failed",
    lockedAt: null,
    lockedBy: null,
  };
}

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
export function createEncryptedStore<TTx>(
  inner: Store<TTx>,
  cipher: SecretCipher,
  logger: Logger = NO_OP_LOGGER,
): Store<TTx> {
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

    // --- reads: decrypt secrets coming back from the backend (per-row isolation) ---
    async claimDue(opts) {
      const rows = await inner.claimDue(opts);
      const out: OutboxRow[] = [];
      for (const r of rows) {
        try {
          out.push(await decryptOutbox(r, cipher));
        } catch (err) {
          // Isolate the failure: quarantine just this row to the DLQ so one bad ciphertext can never
          // poison the batch and wedge the (oldest-first) queue. The row is still `in_flight` here,
          // so applyTransition's guard applies; it then leaves the claimable set for good.
          logger.warn("encrypted-store: quarantining undecryptable outbox row to dead", {
            id: r.id,
            error: String(err),
          });
          try {
            await inner.applyTransition(r.id, quarantineTransition(r));
          } catch (qErr) {
            logger.error("encrypted-store: failed to quarantine undecryptable row", {
              id: r.id,
              error: String(qErr),
            });
          }
        }
      }
      return out;
    },
    async selectForReplay(filter) {
      const rows = await inner.selectForReplay(filter);
      const out: OutboxRow[] = [];
      for (const r of rows) {
        try {
          out.push(await decryptOutbox(r, cipher));
        } catch (err) {
          // Skip undecryptable rows so a single bad row does not abort the whole admin replay.
          logger.warn("encrypted-store: skipping undecryptable row during replay", {
            id: r.id,
            error: String(err),
          });
        }
      }
      return out;
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
    // listOutbox/listEndpoints/getOutbox are secret-free by construction (the store never selects the
    // secret columns), so they pass straight through with no decryption. cancel and the circuit-breaker
    // counters touch no secret column either.
    applyTransition: (id, t) => inner.applyTransition(id, t),
    cancel: (id) => inner.cancel(id),
    reclaimStuck: (opts) => inner.reclaimStuck(opts),
    recordAttempt: (attempt) => inner.recordAttempt(attempt),
    completeAttempt: (attempt, transition, expectedLockedBy) =>
      inner.completeAttempt(attempt, transition, expectedLockedBy),
    queryAttempts: (opts) => inner.queryAttempts(opts),
    getOutbox: (id) => inner.getOutbox(id),
    listOutbox: (filter) => inner.listOutbox(filter),
    listEndpoints: (filter) => inner.listEndpoints(filter),
    disableEndpoint: (id, now) => inner.disableEndpoint(id, now),
    noteEndpointSuccess: (id) => inner.noteEndpointSuccess(id),
    noteEndpointFailure: (id, now, threshold) => inner.noteEndpointFailure(id, now, threshold),
    prune: (opts) => inner.prune(opts),
    stats: () => inner.stats(),
    diagnose: () => inner.diagnose(),
    migrate: () => inner.migrate(),
  };
}
