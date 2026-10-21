# UI fixes, 2026-10-21

Screenshots of the transaction details page after two fixes, taken with `ui-check.mjs` (read-only: signs in and navigates, sends no transactions). The acceptance artifacts in `../2026-10-21-live/` are unchanged.

## 1. Observed timeline no longer collapses

Removing the status dots left `.timeline` rows (and overview `.activity-row`s) with a grid column reserved for the dot, so the text landed in a 14 px column and wrapped one character per line (visible in `../2026-10-21-live/acceptance/main-05-write-details.png`). Rows are now two columns (text, time) and stack on narrow screens.

Measured by `ui-check.mjs`: timeline text width 413 px at 1440 px, 320 px at 390 px; no horizontal overflow at either width.

## 2. EVM units: verified only from verified runtime metadata

The Units row used to state "denomination unverified" unconditionally. It now comes from `evmUnitPolicyFromFingerprint`: *verified* only when the active, verified network fingerprint records native `tokenDecimals` and the runtime constant `revive.nativeToEthRatio` (a power of ten). Otherwise it stays *unverified* with the reason, and no decimal amount is shown.

| File | Condition |
| --- | --- |
| `live-tx-details-desktop.png`, `live-tx-details-mobile.png` | Portaldot V3 Testnet, fingerprint `3fc49db4` with `revive.nativeToEthRatio` 10000 read at 2026-10-21T15:42:18Z → "EVM base units with 18 decimals (tPOT)"; actual fee `3,856,912,452,799,144,200` raw = `3.8569124527991442 tPOT` |
| `fixture-tx-details-desktop.png`, `fixture-tx-details-mobile.png` | Local fixture chain (Hardhat, no Revive metadata) → "Denomination unverified: The verified runtime metadata does not record revive.nativeToEthRatio."; no decimal amount |

The live screenshots also show a separate defect found while taking them: after the node pruned the receipt (~258 blocks), the receipt tracker reported "Receipt disappeared (possible reorganization)" for the store(42) transaction although its effect is still on chain (`retrieve()` returns 42). That is tracked as its own fix; it is not part of this change.
