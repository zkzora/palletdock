# Security and Integration Review (2026-10-09)

Internal review by the implementing developer. This is not an independent security audit.

## Fixed in this review

| Finding | Impact | Fix | Test |
| --- | --- | --- | --- |
| Receipt tracker applied whatever receipt the browser-reported hash returned | A wrong or substituted hash would be attributed to the reviewed request | Receipts must match the prepared sender and recipient (contract creation: no recipient); otherwise a `receipt_mismatch` observation is recorded and the receipt is not applied | `apps/worker/test/tx-tracker.test.ts` |
| Worker command logs (`reconnect`, dev controls) had no project id | Visible in every project's Monitoring log | Logs now take the source's project id | covered by code path; manual |
| Renaming a project to an existing name returned 500 | Error leaked as INTERNAL; inconsistent API | Returns 409 `CONFLICT` | `apps/api/test/api.test.ts` |
| Web responses had no anti-framing / nosniff headers | Clickjacking of the workspace | `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy: same-origin` | `next.config.ts` |
| RPC polled at a fixed cadence during outages | Continuous traffic to a failing endpoint; log noise | Identity probes back off 60 s → 30 min (jittered); receipt checks back off to 10 min; indexer per-source cap 10 min | `Backoff` unit test; worker log shows growing delays |
| Indexing status said "pending" when no source covered the emitting contract | Misleading status | `not_covered` unless an active source covers the log address | tracker test |

## Checked, no change needed

- SQL: all queries are parameterised; dynamic fragments are fixed strings or placeholders. Interval values come from a fixed map.
- Ownership: every workspace route resolves `(project_id, owner_id)`; child rows are fetched with `project_id`; malformed UUIDs → 404 (tested for all routes).
- CSRF: every mutating workspace route requires the session-bound token; read keys are rejected by workspace routes (tested).
- Keys: only SHA-256 of the full key is stored; timing-safe compare; scope, expiry, revocation, replacement tested; never accepted in URLs; Fastify log redaction for `authorization`, `cookie`, `x-csrf-token`; `request_logs` store route templates only.
- Sessions: random 32-byte tokens stored hashed; HttpOnly, SameSite=Strict; production start refuses non-secure cookies.
- Uploads: JSON only, 2 MB artifact limit (3 MB body limit); no compilation or execution server-side.
- RPC targets: allowlist only; loopback only for fixture tests outside production (tested).
- Dependencies: `pnpm audit --prod` reported no known vulnerabilities (2026-10-09).
- No `dangerouslySetInnerHTML`, `eval`, or `new Function` in application code.
- The network reset migration is never automatic and needs `--confirm`. It was not run in this review.

## Accepted risks / documented limits

- **Rate limiting behind the web proxy:** with `API_TRUST_PROXY` unset, all browser traffic through `/backend` shares the proxy's IP bucket. Set `API_TRUST_PROXY=1` only when the API is reachable exclusively through a trusted proxy.
- **Login lockout:** 10 failed attempts per email in 15 minutes temporarily block that email's sign-in (a deliberate brute-force control, which a third party could use to delay the owner).
- **Unauthenticated `/v1` errors** are recorded under the project id in the URL, so they show in that project's error counts. They are rate limited and contain no secrets.
- **Wallet network add:** `wallet_addEthereumChain` must declare `nativeCurrency.decimals = 18` (EVM wallet requirement). This is wallet metadata only; PalletDock still shows EVM amounts as raw base units.
- **Reorged deployments:** if a deployment receipt later disappears, the contract stays tracked with its history; the transaction shows `reorged_out`.
- **Single owner, no MFA, no audit by a third party.**
