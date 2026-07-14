/**
 * Enqueue-time payload validation (pure, cross-runtime).
 *
 * `enqueue` rides the business transaction and is fail-closed, so an unserializable payload would
 * otherwise surface as a raw driver error from the jsonb serialization step rather than a typed
 * {@link RelayError}. This guard catches that case (and an optional size ceiling) up front and wraps
 * it in a stable `ENQUEUE_INVALID_PAYLOAD`, symmetric to how the endpoint shape is validated into
 * `ENQUEUE_NO_TARGET`. Uses only Web-standard globals (`JSON`, `TextEncoder`).
 */
import { utf8ToBytes } from "./encoding";
import { RelayError } from "./errors";

/**
 * Validate that `payload` can be stored as jsonb and, when `maxBytes` is set, that its serialized
 * byte length is within the limit. Throws `RelayError("ENQUEUE_INVALID_PAYLOAD")` otherwise; the
 * original serialization error (e.g. for a circular reference or a BigInt) is attached as `cause`.
 *
 * @param payload - The enqueue payload (stored as jsonb).
 * @param maxBytes - Optional ceiling on the UTF-8 byte length of the JSON serialization. Omitted/undefined = no limit.
 */
export function validatePayload(payload: unknown, maxBytes?: number): void {
  let json: string | undefined;
  try {
    json = JSON.stringify(payload);
  } catch (err) {
    // Circular reference, BigInt, or a custom toJSON that throws — none can be stored as jsonb.
    throw new RelayError(
      "ENQUEUE_INVALID_PAYLOAD",
      `payload is not JSON-serializable: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
  // The lib types `JSON.stringify` as returning `string`, but it returns `undefined` for a top-level
  // undefined/function/symbol, so this guard is real despite what the types imply.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (json === undefined) {
    // Top-level undefined, a function, or a symbol stringifies to undefined and cannot be stored in
    // the NOT NULL jsonb column.
    throw new RelayError(
      "ENQUEUE_INVALID_PAYLOAD",
      "payload is not JSON-serializable: value serializes to undefined (e.g. undefined, function, symbol)",
    );
  }
  if (maxBytes !== undefined) {
    // Reuse the shared module-level encoder (see ./encoding) instead of allocating a TextEncoder
    // per enqueue; the full byte array is still materialized because an exact UTF-8 byte count needs it.
    const bytes = utf8ToBytes(json).length;
    if (bytes > maxBytes) {
      throw new RelayError(
        "ENQUEUE_INVALID_PAYLOAD",
        `payload exceeds maxPayloadBytes: ${String(bytes)} > ${String(maxBytes)}`,
      );
    }
  }
}
