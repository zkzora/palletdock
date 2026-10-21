/**
 * Rebuild inclusion snapshots that an earlier tracker cleared when the node
 * pruned a receipt. Dry run by default; writes only with --apply.
 *   pnpm --filter @palletdock/worker tx:restore-pruned [--apply]
 * Read-only towards the chain (eth_getBlockByNumber); nothing is signed.
 */
import { EvmAdapter, JsonRpcClient } from '@palletdock/chain';
import { createPool, loadEnv } from '@palletdock/db';
import { resolveNetwork } from '@palletdock/shared';
import { restorePrunedFromObservations } from './restore-pruned.js';

loadEnv();
const apply = process.argv.includes('--apply');
const network = resolveNetwork();
const evm = new EvmAdapter(network, new JsonRpcClient(network.evmRpcUrl, { timeoutMs: 20_000 }));
const pool = createPool();
try {
  const results = await restorePrunedFromObservations(pool, evm, { apply });
  console.log(JSON.stringify({ apply, results }, null, 2));
  if (!apply && results.some((r) => r.action === 'restore')) console.log('Dry run. Re-run with --apply to write these restorations.');
} finally {
  await pool.end();
}
