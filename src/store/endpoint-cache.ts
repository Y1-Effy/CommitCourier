/**
 * In-process TTL cache for registered-endpoint lookups, as a {@link Store} decorator.
 *
 * The registered-endpoint workflow calls {@link Store.findEndpoint} once per delivery (see
 * `resolveTarget` in `../delivery/deliver`), which is a DB round trip for data that changes only
 * on an admin action. Wrapping the store memoises found rows for a short TTL, cutting the per-
 * delivery round trips on the hot path. v1 has no auto-disable, so an endpoint only changes via
 * `updateEndpoint` / `disableEndpoint`; those invalidate the entry immediately within the process,
 * and the TTL bounds staleness from changes made by other processes.
 *
 * Only the endpoint methods carry logic; everything else passes straight through. Place this OUTSIDE
 * the encrypted-store decorator so it caches already-decrypted {@link EndpointRow}s.
 */
import type { EndpointRow } from "../core/index";
import type { EndpointPatch, Store } from "./store";

interface Entry {
  row: EndpointRow;
  expiresAt: number;
}

/**
 * Wrap a store so {@link Store.findEndpoint} results are cached for `ttlMs`. Found rows are cached;
 * misses are not (so a later `insertEndpoint` is visible at once). `updateEndpoint` /
 * `disableEndpoint` evict the affected id.
 */
export function createEndpointCache<TTx>(inner: Store<TTx>, opts: { ttlMs: number }): Store<TTx> {
  const { ttlMs } = opts;
  const cache = new Map<string, Entry>();
  // Bumped on every write; a read captures it before fetching and only caches if it is unchanged
  // afterwards, so a value read concurrently with an update/disable is never cached (stale-read guard).
  let generation = 0;

  /**
   * Run an endpoint write with the stale-read guard on BOTH sides. The bump+evict before the write
   * invalidates reads already in flight; the bump+evict after it covers reads that STARTED during the
   * write — those captured the already-bumped generation, may have fetched the pre-commit row, and
   * would otherwise cache it for the full TTL. The trailing pair runs in `finally` because a failed
   * write may still have been applied (e.g. a timeout after commit).
   */
  const invalidating = async (id: string, write: () => Promise<void>): Promise<void> => {
    generation++;
    cache.delete(id);
    try {
      await write();
    } finally {
      generation++;
      cache.delete(id);
    }
  };

  return {
    async findEndpoint(id) {
      const hit = cache.get(id);
      if (hit && hit.expiresAt > Date.now()) return hit.row;
      const gen = generation;
      const row = await inner.findEndpoint(id);
      // Only cache hits (caching a miss would hide a subsequent register), and only when no write
      // raced during the read — otherwise this fetch may have seen the pre-write row.
      if (row && gen === generation) cache.set(id, { row, expiresAt: Date.now() + ttlMs });
      return row;
    },
    updateEndpoint(id, patch: EndpointPatch) {
      return invalidating(id, () => inner.updateEndpoint(id, patch));
    },
    disableEndpoint(id, now) {
      return invalidating(id, () => inner.disableEndpoint(id, now));
    },

    noteEndpointFailure(id, now, threshold) {
      // A failure may trip the circuit breaker and flip the endpoint to `disabled`, which the
      // per-delivery resolveTarget reads — so evict so the next findEndpoint reflects it promptly.
      return invalidating(id, () => inner.noteEndpointFailure(id, now, threshold));
    },
    // noteEndpointSuccess runs on every successful delivery and only resets the failure counter
    // (status unchanged); evicting here would defeat the cache, and the stale counter is never read
    // on the hot path, so pass it straight through without invalidating.
    noteEndpointSuccess: (id) => inner.noteEndpointSuccess(id),

    reactivateEndpoint(id) {
      // Half-open recovery flips the endpoint back to `active` and clears disabled_at, which the
      // per-delivery resolveTarget reads — evict so the next findEndpoint reflects it promptly.
      return invalidating(id, () => inner.reactivateEndpoint(id));
    },

    // --- pass-through ---
    insertOutbox: (trx, row) => inner.insertOutbox(trx, row),
    insertOutboxMany: (trx, rows) => inner.insertOutboxMany(trx, rows),
    insertOutboxAutonomous: (row) => inner.insertOutboxAutonomous(row),
    insertReplayCopies: (rows) => inner.insertReplayCopies(rows),
    insertEndpoint: (ep) => inner.insertEndpoint(ep),
    claimDue: (o) => inner.claimDue(o),
    selectForReplay: (f) => inner.selectForReplay(f),
    // List surfaces are not cached (they are admin/monitoring reads, not the per-delivery hot path).
    listOutbox: (f) => inner.listOutbox(f),
    listEndpoints: (f) => inner.listEndpoints(f),
    getOutbox: (id) => inner.getOutbox(id),
    applyTransition: (id, t) => inner.applyTransition(id, t),
    cancel: (id) => inner.cancel(id),
    reclaimStuck: (o) => inner.reclaimStuck(o),
    recordAttempt: (a) => inner.recordAttempt(a),
    completeAttempt: (a, t, expectedLockedBy) => inner.completeAttempt(a, t, expectedLockedBy),
    queryAttempts: (o) => inner.queryAttempts(o),
    prune: (o) => inner.prune(o),
    stats: () => inner.stats(),
    diagnose: () => inner.diagnose(),
    migrate: () => inner.migrate(),
  };
}
