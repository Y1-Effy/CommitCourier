/**
 * `commitcourier/core` — the I/O-independent, cross-runtime, dependency-free domain layer.
 *
 * Aggregated public API of the pure core (per 01-core section 1). Importing this entry
 * never pulls in `undici` / `p-limit` or any `node:*` builtin.
 */
export type { Clock, Logger, Status, Mode } from "./shared";
export type {
  OutboxRow,
  EnqueueInput,
  DeliveryAttempt,
  EndpointRow,
  RetryConfig,
  DeliveryConfig,
  SsrfConfig,
  SigningConfig,
  RelayConfig,
} from "./types";

export { RelayError } from "./errors";
export type { RelayErrorCode } from "./errors";

export { utf8ToBytes, base64ToBytes, bytesToBase64, bytesToUtf8 } from "./encoding";

export { sign } from "./signing";
export type { SignatureHeaders } from "./signing";

export { createAesGcmCipher, generateSecretKey } from "./cipher";
export type { SecretCipher } from "./cipher";

export { backoffMs, parseRetryAfter } from "./retry";

export {
  initialState,
  onClaim,
  onSuccess,
  onFailure,
  onPermanentFailure,
  onReclaim,
} from "./state";
export type { Transition } from "./state";

export { evaluateIp, matchHostList } from "./ssrf";
export type { SsrfDecision } from "./ssrf";

export { resolveConfig } from "./config";
export type { DeepPartial } from "./config";
