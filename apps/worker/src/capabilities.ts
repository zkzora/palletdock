/**
 * Read-only capability probe for the configured Portaldot network.
 *   pnpm network:capabilities
 * Nothing is signed or broadcast. Deployment compatibility is checked by
 * simulating the bundled PalletDockStorage creation code with eth_call and
 * eth_estimateGas from an unfunded address.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { EvmAdapter, JsonRpcClient, RpcResponseError, SubstrateAdapter } from '@palletdock/chain';
import { loadEnv } from '@palletdock/db';
import { resolveNetwork } from '@palletdock/shared';

loadEnv();
const network = resolveNetwork();
const rpc = new JsonRpcClient(network.evmRpcUrl, { timeoutMs: 20_000 });
const evm = new EvmAdapter(network, rpc);
const PROBE_FROM = '0x000000000000000000000000000000000000dEaD';
const storage = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../packages/contracts/artifacts/PalletDockStorage.json'), 'utf8'));

type Result = { ok: boolean; value?: unknown; error?: string };
async function attempt(fn: () => Promise<unknown>): Promise<Result> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    const err = e as Error & { code?: number; data?: unknown };
    return { ok: false, error: `${err instanceof RpcResponseError ? `rpc ${err.code}: ` : ''}${err.message.split('\n')[0].slice(0, 240)}` };
  }
}

const out: Record<string, unknown> = { network: network.networkId, evmRpcUrl: network.evmRpcUrl, observedAt: new Date().toISOString() };
const head = BigInt(await evm.blockNumber());
out.headBlock = head.toString();
out.feeHistory = await attempt(() => rpc.call('eth_feeHistory', ['0x2', 'latest', [50]]));
out.maxPriorityFeePerGas = await attempt(() => rpc.call('eth_maxPriorityFeePerGas'));
out.gasPrice = await attempt(() => evm.gasPrice());
for (const tag of ['finalized', 'safe'] as const) {
  out[`tag_${tag}`] = await attempt(async () => {
    const b = await evm.blockHeader(tag);
    return b ? { number: b.number, behindHead: (head - BigInt(b.number)).toString() } : null;
  });
}
out.oldestServedBlock = await attempt(async () => {
  for (const n of [1n, 1000n, 10_000n, head - 5000n, head - 1000n, head - 100n]) {
    if (n < 1n) continue;
    const r = await attempt(() => evm.blockHeader(n));
    if (r.ok && r.value) return { firstServedProbe: n.toString() };
  }
  return null;
});
const logRanges: Record<string, Result> = {};
for (const span of [10n, 100n, 1000n, 5000n, 20_000n]) {
  const from = head - span + 1n > 0n ? head - span + 1n : 1n;
  logRanges[span.toString()] = await attempt(async () => (await evm.logs({ address: PROBE_FROM, fromBlock: from, toBlock: head })).length);
}
out.getLogsBySpan = logRanges;
out.deploySimulation_eth_call = await attempt(async () => {
  const code = (await rpc.call<string>('eth_call', [{ from: PROBE_FROM, data: storage.bytecode }, 'latest'])) ?? '';
  return { returnedBytes: (code.length - 2) / 2, matchesDeployedBytecode: code.toLowerCase() === String(storage.deployedBytecode).toLowerCase() };
});
out.deploySimulation_eth_estimateGas = await attempt(() => evm.estimateGas({ from: PROBE_FROM, data: storage.bytecode }));

let sub: SubstrateAdapter | null = null;
try {
  sub = await SubstrateAdapter.connect(network, {}, 20_000);
  out.mapping = await attempt(() => sub!.mapEvmAccount(PROBE_FROM));
  const m = out.mapping as Result;
  if (m.ok) {
    const acct = (m.value as { nativeAccountHex: string }).nativeAccountHex;
    out.storageDepositDryRun_instantiate = await sub.dryRunStorageDeposit({ kind: 'instantiate', originAccountHex: acct, input: '0x', code: storage.bytecode });
  }
} catch (e) {
  out.native = { ok: false, error: (e as Error).message };
} finally {
  await sub?.disconnect().catch(() => {});
}
console.log(JSON.stringify(out, null, 2));
