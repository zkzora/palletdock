/**
 * Explicit operator migration after a Portaldot testnet reset (changed genesis).
 *
 *   pnpm network:accept-reset            # dry run: shows what would change
 *   pnpm network:accept-reset --confirm  # applies it
 *
 * Requires a 'mismatch' fingerprint recorded by the worker. In one transaction
 * it supersedes the old fingerprint, activates the observed one, stops sources
 * bound to the old identity (fencing workers and invalidating API cursors), and
 * invalidates account mappings. Old records are kept for history; contracts
 * must be re-imported or redeployed on the new network.
 */
import { createPool, loadEnv } from '@palletdock/db';
import { acceptNetworkReset } from './network.js';

loadEnv();
const confirm = process.argv.includes('--confirm');
const pool = createPool(undefined, 2);
try {
  const plan = await acceptNetworkReset(pool, confirm);
  if (!plan.next) {
    console.log('No mismatched network identity has been observed. Nothing to migrate.');
  } else {
    console.log(`Current active fingerprint: ${plan.previous ? `${plan.previous.genesis_hash} (chain ${plan.previous.evm_chain_id})` : 'none'}`);
    console.log(`Observed new fingerprint:   ${plan.next.genesis_hash} (chain ${plan.next.evm_chain_id})`);
    console.log(`Indexer sources to stop:    ${plan.sourcesToStop}`);
    console.log(plan.applied ? 'Network reset applied.' : 'Dry run. Re-run with --confirm to apply.');
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
