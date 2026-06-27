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
    async updateEndpoint(id, patch: EndpointPatch) {
      generation++; // invalidate any read currently in flight
      cache.delete(id);
      await inner.updateEndpoint(id, patch);
    },
    async disableEndpoint(id, now) {
      generation++;
      cache.delete(id);
      await inner.disableEndpoint(id, now);
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
    applyTransition: (id, t) => inner.applyTransition(id, t),
    reclaimStuck: (o) => inner.reclaimStuck(o),
    recordAttempt: (a) => inner.recordAttempt(a),
    completeAttempt: (a, t, expectedLockedBy) => inner.completeAttempt(a, t, expectedLockedBy),
    queryAttempts: (o) => inner.queryAttempts(o),
    stats: () => inner.stats(),
    diagnose: () => inner.diagnose(),
    migrate: () => inner.migrate(),
  };
}
