# Limitations

- **Live acceptance partly done.** Network identity and capabilities are live-verified on the new Portaldot endpoints (2026-10-17) and a read-only deploy simulation succeeded. A wallet-signed deployment, write, indexed event, and restart run on the live testnet are still pending.
- **Short node history.** The Portaldot V3 RPC node keeps block state for ~258 blocks (~26 min). Indexer start blocks must be recent and the worker must keep running; otherwise the source needs a reindex.
- **Finality is unknown** for every record. No verified finality adapter.
- **EVM units are derived, not configured.** Raw base units are always shown; a decimal amount is added only while the active fingerprint's runtime metadata (`revive.nativeToEthRatio`) verifies the denomination. Otherwise the amount is labelled unverified.
- **Storage deposit** comes only from a pre-signing dry run, when available. It is not read from receipts and is not reconciled after execution.
- **Mapping and native identity** need the Substrate endpoint; without it, mapping and dry runs are unavailable.
- **Indexer scope:** EVM logs of tracked contracts only, one contract per source. No full-chain indexing, no native events. Reorgs deeper than 512 retained headers need a manual reindex. Editing a source creates a new one, with fresh coverage.
- **Transactions:** only PalletDock-prepared or explicitly registered hashes. A replacement transaction (same nonce, new hash) is not linked automatically.
- **Artifacts:** no linked libraries, no source verification, no server-side compilation.
- **Access:** one owner per deployment; no teams, no SSO, no billing. Not security audited.
- **Ops:** Docker is verified only in CI (GitHub ubuntu runner: build and compose boot); no Docker on the development machine. CI runs on pull requests and manual dispatch. On Windows, embedded PostgreSQL for tests needs a clone path short enough for MAX_PATH.
- **Out of scope:** native signing, Assets/Uniques/Nfts management, ink!, bridges/iBridge, BEEFY/parachain controls, tracing/debugger, AI features.
