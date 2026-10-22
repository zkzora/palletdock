# Consumer demo on live data, 2026-10-21 (UTC)

`consumer-walkthrough.mjs` drove `/consumer` on the local dev stack (web 3001, API 4101), whose indexer follows Portaldot V3 Testnet. Read-only: no transaction was sent and no key was used beyond a scoped, 7-day read key (`events:read`, `indexer:read`, `transactions:read`) kept in the gitignored `.data/consumer.json`. Only the key's public prefix appears in the screenshots. The script stopped and started the local worker and API; nothing on chain changed.

| Time (UTC) | Step | Consumer showed |
| --- | --- | --- |
| 18:05:24 | A. Normal (**live**) | *Up to date*, value **43** from `store(43)` at block 134261 (`0x701ec6b7…a869b`, tx `0x15f4a518…ffc1`, log 3); network `portaldot-v3-testnet`, chain 420420777, Portaldot V3 genesis; finality *Unknown: not confirmed*; rows: 43 *settled; finality unknown*, 42 *node history pruned* (**recorded**: pruned on 2026-10-21, inclusion kept from the earlier observation) |
| 18:05:25 | worker stopped | |
| 18:06:52 | C. Worker stopped (**live**) | *Possibly out of date*: "The indexer has not observed the chain for 2 min (checkpoint at block 134972) … the reported lag (0 blocks) dates from that last observation." Value 43 kept with the caveat |
| 18:07:06 | D. Worker back (**live**) | *Up to date*, still 2 events, no duplicates |
| 18:07:10 | API stopped (**live**) | *API unavailable* since 18:07:07, "Showing data last read at 18:07:03"; value 43 kept |
| 18:07:18 | API back (**live**) | *Up to date*, 2 events |

Not shown live in this run: a new event while the worker is stopped; it was recorded live later the same day in [../2026-10-21-consumer-new-event](../2026-10-21-consumer-new-event/). Also the fixture E2E (`apps/web/e2e/fixture-consumer.spec.ts`) covers it on a local Hardhat chain, and the 2026-10-21 restart run ([../2026-10-21-restart](../2026-10-21-restart/)) covers the indexer side live.

Files: `01-normal.png`, `02-worker-stopped.png`, `03-worker-back.png`, `04-api-down.png`, `05-api-back.png`, `walkthrough.json` (the step log above).
