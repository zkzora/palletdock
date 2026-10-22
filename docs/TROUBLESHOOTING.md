# Troubleshooting

| Symptom | Cause / action |
| --- | --- |
| Chain-bound buttons fail with "network identity has not been verified" | No active fingerprint. Run `pnpm network:verify`; check Monitoring probes. During the 2026-10-08 outage both Portaldot RPCs returned HTTP 502. |
| Worker logs `network mismatch` | Genesis or chain ID changed (testnet reset). Review, then `pnpm network:accept-reset --confirm`. |
| Indexer *Needs attention* | RPC errors; the worker retries with backoff from the checkpoint. **Reconnect** retries immediately. |
| Indexer *Recovery required* | The source needs a range the RPC no longer retains, the reorg is deeper than retained headers, or the source belongs to a superseded network. Use **Edit configuration** to choose a retained start block and create fresh coverage, or re-import on the new network. Stored records remain as non-canonical history. |
| Wallet shows the wrong network | Use **Switch to Portaldot V3** in the signer dialog. Writes are blocked unless the chain is 0x190f1ca9 at signing time. |
| "Submission could not be confirmed" | The wallet timed out or returned an ambiguous error. Use **Check account activity** (receipt lookup or nonce) before retrying. Never resubmit blindly. |
| Native account is funded but the EVM deployer is not | Resolve the mapping again for the exact EVM address; fund the returned SS58 account. |
| Fee estimate failed / simulated revert | The call would revert (decoded custom error shown) or the RPC is down. Raw revert data is kept. |
| Deployment reverts on Portaldot | The bundled EVM bytecode may be incompatible with the Revive runtime. Record the error in TESTNET_EVIDENCE.md. |
| API 409 `CURSOR_RESTART_REQUIRED` | Data was rolled back, reindexed, or the network reset after the first page. Restart without a cursor. |
| API 401 | Key missing, malformed, expired, or revoked. Keys are never accepted in URLs. |
| API 403 `FORBIDDEN_SCOPE` | The key lacks the endpoint's scope. Create or replace the key with that scope. |
| `pnpm db:start` fails on Windows with an encoding error | Delete `.data/postgres` (local data) and restart; the launcher initialises UTF-8. |
| Port already in use | Set `API_PORT`, `WEB_PORT` (dev-services script), or `E2E_*_PORT` for the fixture stack. |
| Vitest finishes but waits ~10 s before exiting | Embedded PostgreSQL leaves file handles open on Windows; the exit code is still correct. |
| Tests fail with `extension "plpgsql" is not available` on Windows | The clone path is too long: embedded PostgreSQL's extension files exceed MAX_PATH (260). Clone to a short path such as `C:\src\palletdock`, or set `TEST_DATABASE_URL`. The test setup now reports this explicitly. |
