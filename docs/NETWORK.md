# Network, Units, Mapping

## Configuration

`packages/shared/src/network.ts` holds the only network PalletDock supports, **Portaldot V3 Testnet**:

| Field | Value |
| --- | --- |
| networkId | portaldot-v3-testnet |
| EVM RPC | https://testnetv3-eth-rpc.feso-apps.xyz |
| Substrate RPC | wss://testnetv3-node.feso-apps.xyz |
| EVM chain ID | 420420777 (0x190f1ca9) |
| Native token | tPOTv3, 14 decimals |
| SS58 | 42 |

Overrides (`PORTALDOT_EVM_RPC_URL`, `PORTALDOT_SUBSTRATE_RPC_URL`) must match the host allowlist (`*.feso-apps.xyz`, HTTPS/WSS, no credentials). Loopback is accepted only with `PALLETDOCK_ALLOW_LOOPBACK_RPC=1` outside production (fixture E2E).

## Identity verification

`pnpm network:verify` (and the worker: every 60 s while healthy, with jittered exponential backoff up to 30 min while probes fail, so an outage is not polled continuously) runs:

- EVM: `eth_chainId` (must be 0x190f1ca9), `eth_getBlockByNumber(0x0)`, `eth_getBlockByNumber(latest)`, `web3_clientVersion`.
- Native: genesis hash, best and finalized heads, runtime version, `system_properties` (SS58 42, tPOTv3, 14 decimals must match).

Every attempt is stored in `rpc_probes`. A fingerprint becomes `active` only when both sides succeed. Later runs update `last_verified_at`. A different genesis or chain ID is stored as `mismatch` and halts indexing and tracking.

### After a testnet reset

```bash
pnpm network:accept-reset            # dry run
pnpm network:accept-reset --confirm  # apply
```

This supersedes the old fingerprint, activates the observed one, pauses old sources as `recovery_required`, fences workers, invalidates API cursors (reorg epoch), and invalidates account mappings. Old records stay as history. Re-import or redeploy contracts on the new network.

## Units

- Native balances: 14 decimals (runtime properties).
- EVM facade (balances, `value`, gas price, fees): **denomination not verified**. Shown as raw base units with an explicit note. The native 14-decimal scale is never applied automatically. `describeEvmAmount` has a `verified` policy branch for when evidence exists.
- Gas is not Weight. Fee = `gasUsed × effectiveGasPrice` (raw) only when the receipt provides both.
- Storage deposit: from a `reviveApi.call` / `reviveApi.instantiate` dry run through current metadata when its parameter names are recognised; otherwise "unavailable" with the reason. Charge and refund are distinguished. A non-zero `value` makes the dry run unavailable, because value units are unverified.

## Account mapping

`SubstrateAdapter.mapEvmAccount` calls `reviveApi.accountId(h160)` through metadata at the latest finalized block and stores direction, H160, AccountId32 hex, SS58 (prefix 42), block number and hash, runtime spec version, and time in `account_mappings`. Cached results are reused for 10 minutes only on the same fingerprint and spec version. A reset migration invalidates them.

## Finality

Always `unknown`. No adapter proves the relationship between an EVM block and a finalized native block, and confirmation depth is never labelled finality. BABE, GRANDPA, BEEFY, and tracing are not assumed.
