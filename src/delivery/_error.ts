/**
 * Shared, secret-free error reduction for the delivery path.
 *
 * Thrown values from undici / DNS / signing may carry secrets in their messages, so the ledger
 * and logs only ever store a short, stable summary. Both the per-row orchestrator
 * ({@link "./deliver"}) and the HTTP client ({@link "./http"}) reduce errors the same way; the
 * HTTP client layers SSRF/timeout specialisation on top of {@link secretFreeSummary}.
 */

/** Extract a string `code` property (e.g. undici/Node system errors) if present. */
export function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

/** Reduce a thrown value to a short, secret-free summary: error code, else message, else String. */
export function secretFreeSummary(err: unknown): string {
  if (err instanceof Error) {
    return errorCode(err) ?? err.message;
  }
  return String(err);
}
