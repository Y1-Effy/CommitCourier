/**
 * Single source for application-assigned uuids.
 *
 * Outbox rows, replay copies, and delivery-ledger rows get their ids here so the generation
 * strategy lives in one place. Lives outside `core/` because it uses the `node:crypto` builtin,
 * which the dependency-free, cross-runtime core must not import.
 */
import { randomUUID } from "node:crypto";

/** Generate a fresh uuid for an application-assigned id. */
export function newId(): string {
  return randomUUID();
}
