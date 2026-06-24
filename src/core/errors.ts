/**
 * Error model (per 00-overview section 5).
 *
 * Every error thrown by the library extends {@link RelayError} and carries a stable,
 * machine-readable {@link RelayErrorCode}.
 */

/** Stable, machine-readable error codes. */
export type RelayErrorCode =
  | "CONFIG_INVALID" // config validation failed (fail-fast at startup)
  | "MISSING_TABLES" // tables missing per diagnose
  | "SSRF_BLOCKED" // destination is in a blocked range
  | "ENDPOINT_NOT_FOUND" // endpointId not registered
  | "ENDPOINT_DISABLED" // endpoint is disabled
  | "MISSING_SECRET" // inline target has no secret snapshot to sign with
  | "ENQUEUE_NO_TARGET"; // neither url nor endpointId provided

/** Base error for all library failures. */
export class RelayError extends Error {
  constructor(
    readonly code: RelayErrorCode,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "RelayError";
  }
}
