# Security Policy

🇯🇵 日本語版: **[SECURITY.ja.md](./SECURITY.ja.md)**

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues, pull requests, or discussions.**

Instead, report them privately through GitHub's built-in advisory flow:

1. Open a new advisory: **https://github.com/Y1-Effy/CommitCourier/security/advisories/new** (or go to the repository's **Security** tab → **Report a vulnerability**).
2. Provide a clear description, affected version(s), and — if possible — a minimal reproduction and the impact you observed.

> Maintainers: this requires **Private vulnerability reporting** to be enabled for the repository (Settings → Code security and analysis).

We will coordinate a fix and a [coordinated disclosure](https://www.cisa.gov/coordinated-vulnerability-disclosure-process) with you, and credit you in the advisory unless you prefer to remain anonymous.

## Supported Versions

CommitCourier is pre-release. Until `1.0.0`, only the latest `0.x` release receives security fixes.

| Version      | Supported |
| ------------ | --------- |
| latest `0.x` | ✅        |
| older `0.x`  | ❌        |

## Response Expectations

This is a small open-source project maintained on a best-effort basis. We aim to acknowledge a report within a few business days and to keep you updated as we investigate and fix. We do not offer a formal SLA or a bug bounty.

## Security Model & Scope

CommitCourier handles security-sensitive concerns, so it helps to be explicit about what the library protects and what remains the integrator's responsibility.

### What CommitCourier protects

- **Outbound SSRF.** The SSRF guard is on by default and blocks private, loopback, link-local, and cloud-metadata destinations. The destination is re-validated against the _resolved_ IP to defend against DNS rebinding.
- **Tamper / spoof detection.** Deliveries are signed with Standard Webhooks (HMAC-SHA256 over `{id}.{timestamp}.{body}`), so receivers can verify authenticity and integrity.
- **Secret hygiene in the ledger.** The delivery ledger records request headers but **never stores the signing secret itself**; response bodies are truncated to a configurable snippet size.
- **Fail-closed enqueue.** The outbox row is written inside your transaction, so a webhook can never be emitted for a business write that rolled back.

### Integrator responsibilities (out of scope for the library)

- **Secret at-rest encryption.** Signing secrets (`webhook_outbox.secret_snapshot` and `webhook_endpoints.secret`) are stored as written by your application. Encrypting them at rest is your database's responsibility; optional encrypted-column support is future work.
- **Receiver-side verification and idempotency.** CommitCourier provides at-least-once delivery plus an idempotency key, but verifying the signature and de-duplicating events is the receiver's responsibility.
- **Disabling the SSRF guard.** Setting `ssrf.blockPrivateRanges: false` (or adding hosts to the allowlist) re-enables reachability of internal destinations. This is an explicit, warned opt-in; the resulting exposure is your decision.
- **Transport security and credentials.** Use HTTPS endpoints and keep your database credentials and signing secrets out of source control.

## Not a Vulnerability

The following are documented design decisions, not security flaws (see the **Guarantees & non-goals** section of the [README](./README.md)):

- The absence of exactly-once _effects_ at the receiver (delivery is at-least-once by design).
- The absence of cross-endpoint total ordering (delivery is unordered by default).
- Internal destinations being reachable after you explicitly disable the SSRF guard.
- Behavior under loads beyond the small-to-medium scale this library targets.
