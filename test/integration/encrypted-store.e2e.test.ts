/**
 * Decryption isolation end-to-end (failure-path hardening): with a real Postgres and a real AES-GCM
 * cipher, an undecryptable row (encrypted under a different key) sitting at the HEAD of the queue must
 * NOT wedge delivery. `claimDue` returns the good rows decrypted and quarantines the bad row straight
 * to `dead`, so the queue keeps draining. Requires Docker; skips cleanly without one.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { postgresStore } from "../../src/store/pg";
import { createEncryptedStore } from "../../src/store/encrypted-store";
import { createAesGcmCipher, generateSecretKey } from "../../src/core/cipher";
import { dockerAvailable, startPostgres, type PgConn } from "./_helpers";

describe.skipIf(!dockerAvailable())("encrypted-store decryption isolation (integration)", () => {
  let stop: () => Promise<void>;
  let conn: PgConn;
  let pool: Pool;

  const cipher = createAesGcmCipher(generateSecretKey());
  const otherCipher = createAesGcmCipher(generateSecretKey()); // different key -> auth failure

  beforeAll(async () => {
    const started = await startPostgres();
    conn = started.conn;
    stop = started.stop;
    pool = new Pool(conn);
    await postgresStore({ pool }).migrate();
  });

  afterAll(async () => {
    await pool.end();
    await stop();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE webhook_delivery_attempts, webhook_outbox, webhook_endpoints");
  });

  /** Insert one pending outbox row with a given (already-encrypted) secret_snapshot and due time. */
  async function insertRow(secretSnapshot: string, availableAt: Date): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO webhook_outbox (id, event_type, payload, target_url, secret_snapshot, status, attempts, available_at)
       VALUES ($1, 'order.created', '{"a":1}'::jsonb, 'https://x.test/hook', $2, 'pending', 0, $3)`,
      [id, secretSnapshot, availableAt],
    );
    return id;
  }

  it("returns good rows decrypted and quarantines an undecryptable head row to dead", async () => {
    const enc = createEncryptedStore(postgresStore({ pool }), cipher);
    // Bad row is oldest (claim is available_at-ordered), so it would be claimed first every cycle.
    const badId = await insertRow(await otherCipher.encrypt("whsec_x"), new Date(1_000));
    const good1 = await insertRow(await cipher.encrypt("whsec_a"), new Date(2_000));
    const good2 = await insertRow(await cipher.encrypt("whsec_b"), new Date(3_000));

    const claimed = await enc.claimDue({ limit: 10, lockedBy: "w", now: new Date() });

    // The good rows come back decrypted; the bad row is dropped from the batch (no throw).
    expect(claimed.map((r) => r.id).sort()).toEqual([good1, good2].sort());
    expect(claimed.map((r) => r.secretSnapshot).sort()).toEqual(["whsec_a", "whsec_b"].sort());

    // The bad row is quarantined to the DLQ and will never be claimed again.
    const badStatus = await pool.query("SELECT status FROM webhook_outbox WHERE id = $1", [badId]);
    expect((badStatus.rows[0] as { status: string }).status).toBe("dead");

    // The good rows are now in_flight (claimed), proving the batch was not poisoned.
    const inflight = await pool.query(
      "SELECT count(*)::int AS n FROM webhook_outbox WHERE status = 'in_flight'",
    );
    expect((inflight.rows[0] as { n: number }).n).toBe(2);
  });
});
