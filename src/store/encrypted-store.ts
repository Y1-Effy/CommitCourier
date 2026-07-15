/**
 * Transparent at-rest encryption for signing secrets, as a {@link Store} decorator.
 *
 * Wrapping a store with {@link createEncryptedStore} encrypts the secret-bearing columns
 * (`secretSnapshot`, endpoint `secret`/`secretSecondary`, and each endpoint `customHeaders` value)
 * on the way to the backend and decrypts them on the way back, so every other layer (relay,
 * delivery, admin) keeps seeing plaintext while the value at rest is always ciphertext. All
 * encryption is confined to this one module — the underlying adapter and the rest of the codebase
 * are unchanged. Custom-header *names* stay plaintext (a header name is not a secret); only the
 * values are wrapped.
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
import { RelayError } from "../core/index";
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
 * Map each custom-header VALUE through the cipher, leaving the NAMES plaintext.
 *
 * Per value rather than over the serialized map because the decorator has to hand the backend the
 * same domain type it received (`Record<string, string>`), and there is no string field to park a
 * single ciphertext blob in. That is also the better shape: a header name is not a secret, so an
 * operator can still see which headers an endpoint sends, and it lines up with the ledger, which
 * keeps the names and redacts the values.
 */
async function mapHeaderValues(
  headers: Record<string, string>,
  fn: (v: string) => Promise<string>,
): Promise<Record<string, string>> {
  const entries = Object.entries(headers);
  const mapped = await Promise.all(entries.map(async ([k, v]) => [k, await fn(v)] as const));
  return Object.fromEntries(mapped);
}

/**
 * Data-loss sink for the claim-path quarantine. A quarantined row reaches the terminal `dead`
 * state (the DLQ), which is one of the two critical categories that must stay visible even with no
 * logger configured; `createRelay` wires its critical logger's `dataLoss` here. Optional so a
 * directly-constructed store degrades to plain `logger` output.
 */
export type DataLossSink = (msg: string, meta?: Record<string, unknown>) => void;

/**
 * Wrap a store so signing secrets are encrypted at rest with `cipher`. The returned store is a
 * drop-in `Store<TTx>`; secrets are plaintext at this boundary and ciphertext in the backend.
 */
export function createEncryptedStore<TTx>(
  inner: Store<TTx>,
  cipher: SecretCipher,
  logger: Logger = NO_OP_LOGGER,
  dataLoss?: DataLossSink,
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
      if (ep.customHeaders != null) {
        enc.customHeaders = await mapHeaderValues(ep.customHeaders, (v) => cipher.encrypt(v));
      }
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
      // `!= null` for the same reason the secrets use `typeof === "string"`: `customHeaders: null`
      // clears the map and must reach the backend untouched, and `undefined` means "not patched".
      if (patch.customHeaders != null) {
        enc.customHeaders = await mapHeaderValues(patch.customHeaders, (v) => cipher.encrypt(v));
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
          let quarantined = false;
          try {
            await inner.applyTransition(r.id, quarantineTransition(r));
            quarantined = true;
          } catch (qErr) {
            logger.error("encrypted-store: failed to quarantine undecryptable row", {
              id: r.id,
              error: String(qErr),
            });
          }
          // The row is now terminal `dead` (the DLQ): a data-loss event, surfaced through the
          // critical sink so it stays visible even when no logger is configured (mirrors the
          // delivery path's dead-letter alarm).
          if (quarantined) {
            dataLoss?.(
              "message moved to the DLQ and is permanently lost (secret decryption failed)",
              {
                id: r.id,
                endpointId: r.endpointId,
                eventType: r.eventType,
                attempts: r.attempts + 1,
                error: String(err),
              },
            );
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
      try {
        const decrypted: EndpointRow = {
          ...ep,
          secret: await cipher.decrypt(ep.secret),
          secretSecondary:
            ep.secretSecondary == null ? null : await cipher.decrypt(ep.secretSecondary),
          customHeaders:
            ep.customHeaders == null
              ? null
              : await mapHeaderValues(ep.customHeaders, (v) => cipher.decrypt(v)),
        };
        return decrypted;
      } catch (cause) {
        // Normalise to CONFIG_INVALID so the delivery path routes an undecryptable secret-bearing field
        // straight to `dead` (matching the inline `claimDue` quarantine), regardless of what a custom
        // SecretCipher throws — the built-in cipher already throws CONFIG_INVALID.
        //
        // The message names both candidates rather than just the secret: the fields are decrypted in
        // source order, so `secret` throws first on a wholly-unencrypted row and naming it alone would
        // be right there — but a row whose secret decrypts and whose headers do not (a partial
        // re-encryption, or a write through a store adapter) would otherwise send an operator to the
        // wrong column. This message is what `endpoints.get` surfaces; the delivery path only ever
        // reports the code (secretFreeSummary discards the message).
        throw new RelayError(
          "CONFIG_INVALID",
          "endpoint secret or custom-header decryption failed",
          cause,
        );
      }
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
    reactivateEndpoint: (id) => inner.reactivateEndpoint(id),
    prune: (opts) => inner.prune(opts),
    stats: () => inner.stats(),
    diagnose: () => inner.diagnose(),
    migrate: () => inner.migrate(),
  };
}
