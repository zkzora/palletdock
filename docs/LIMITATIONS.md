# Limitations

- **No live acceptance yet.** Portaldot V3 RPCs were unavailable (HTTP 502) during development. Compatibility of the bundled EVM bytecode (solc 0.8.24, evmVersion paris) with the Revive runtime, `eth_getLogs` range limits, fee fields, and the dry-run API shape are unverified on the live network.
- **Finality is unknown** for every record. No verified finality adapter.
- **EVM units unverified.** Balances, values, gas prices, and fees are raw base units.
- **Storage deposit** comes only from a pre-signing dry run, when available. It is not read from receipts and is not reconciled after execution.
- **Mapping and native identity** need the Substrate endpoint; without it, mapping and dry runs are unavailable.
- **Indexer scope:** EVM logs of tracked contracts only, one contract per source. No full-chain indexing, no native events. Reorgs deeper than 512 retained headers need a manual reindex. Editing a source creates a new one, with fresh coverage.
- **Transactions:** only PalletDock-prepared or explicitly registered hashes. A replacement transaction (same nonce, new hash) is not linked automatically.
- **Artifacts:** no linked libraries, no source verification, no server-side compilation.
- **Access:** one owner per deployment; no teams, no SSO, no billing. Not security audited.
- **Ops:** Docker files are provided but were not run on the development machine (Docker unavailable). CI is defined but has not run yet.
- **Out of scope:** native signing, Assets/Uniques/Nfts management, ink!, bridges/iBridge, BEEFY/parachain controls, tracing/debugger, AI features.
