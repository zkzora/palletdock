// Live worker-restart check on Portaldot V3 Testnet, run by the owner.
// 1. record the indexer state, 2. stop the worker, 3. send store(43) through the
// PalletDock UI with the scripted EIP-1193 signer (same as live-run.mjs),
// 4. confirm inclusion directly from the RPC, 5. wait ~60 s with the worker down,
// 6. start the worker, 7. verify exactly one new canonical record and no duplicates.
// The burner key is read from the session transcript, checked against the
// expected address, kept in memory only, and never printed, written, or sent to the page.
//
//   $env:PALLETDOCK_OWNER_PASSWORD = '<owner password>'
//   node --env-file=C:\PalletDock\palletdock\.env C:\PalletDock\live-kit\live-restart.mjs C:\PalletDock\live-kit\run-restart storage-demo-live
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { chromium } = createRequire('C:/PalletDock/palletdock/apps/web/package.json')('@playwright/test');
const chainReq = createRequire('C:/PalletDock/palletdock/packages/chain/package.json');
const { createWalletClient, defineChain, http } = chainReq('viem');
const { privateKeyToAccount } = chainReq('viem/accounts');
const pg = createRequire('C:/PalletDock/palletdock/packages/db/package.json')('pg');

const OUT = process.argv[2];
const PROJECT = process.argv[3] ?? 'storage-demo-live';
const DOWN_MS = Number(process.env.RESTART_DOWN_MS ?? 60_000);
const TRANSCRIPT = 'C:/Users/Pongo/.claude/projects/c--PalletDock/dd24ec76-565d-4e4f-a0b8-1784d33b81c6.jsonl';
const EXPECTED = '0xfa02532d22cb7e9ef572751be928efcd2ac4fa8f';
const RPC = 'https://test-evm-rpc-v3.portaldot.dev';
const WEB = 'http://127.0.0.1:3001';
const REPO = 'C:/PalletDock/palletdock';
const PASSWORD = process.env.PALLETDOCK_OWNER_PASSWORD ?? '';
if (!PASSWORD) throw new Error('Set PALLETDOCK_OWNER_PASSWORD first.');
if (!process.env.DATABASE_URL) throw new Error('Run with --env-file pointing at the PalletDock .env.');
mkdirSync(OUT, { recursive: true });

const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const result = { stage: 'restart', project: PROJECT, startedAt: new Date().toISOString(), steps: [] };
const step = (name, data = {}) => {
  result.steps.push({ at: new Date().toISOString(), name, ...data });
  log(`${name}${Object.keys(data).length ? ' ' + JSON.stringify(data) : ''}`);
  writeFileSync(`${OUT}/result-restart.json`, JSON.stringify(result, null, 2));
};
const servicesArgs = (action) => ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `${REPO}/scripts/dev-services.ps1`, action, '-Only', 'worker'];
/**
 * Stop/start the worker through scripts/dev-services.ps1. `start` launches the
 * worker with Start-Process, which inherits any pipe handles of this call; if
 * output were captured here, the call would wait for the long-running worker.
 * So start runs without pipes, and the result is read back with `status`.
 */
function services(action) {
  if (action === 'start') {
    execFileSync('powershell', servicesArgs('start'), { stdio: 'ignore', timeout: 60_000 });
    return execFileSync('powershell', servicesArgs('status'), { encoding: 'utf8', timeout: 60_000 }).trim();
  }
  return execFileSync('powershell', servicesArgs(action), { encoding: 'utf8', timeout: 60_000 }).trim();
}

function loadAccount() {
  for (const line of readFileSync(TRANSCRIPT, 'utf8').split('\n')) {
    if (!line.includes('pake wallet ini aja')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== 'user') continue;
    for (const m of JSON.stringify(entry.message?.content ?? '').matchAll(/(?:0x)?([0-9a-fA-F]{64})/g)) {
      const acct = privateKeyToAccount(`0x${m[1]}`);
      if (acct.address.toLowerCase() === EXPECTED) return acct;
    }
  }
  throw new Error('Burner key not found, or it does not derive the expected address. Nothing was signed.');
}

let rpcId = 0;
async function rpc(method, params) {
  const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }), signal: AbortSignal.timeout(30_000) });
  const body = await res.json();
  if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code });
  return body.result;
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const q = async (sql, params) => (await db.query(sql, params)).rows;
const [src] = await q(
  `SELECT s.id, s.project_id, s.contract_address FROM indexer_sources s JOIN projects p ON p.id = s.project_id WHERE p.name = $1 AND s.desired_state = 'running' ORDER BY s.created_at DESC LIMIT 1`,
  [PROJECT],
);
if (!src) throw new Error(`No running indexer source in project ${PROJECT}`);
const indexState = async () => {
  const [s] = await q(`SELECT s.status, k.block_number::text AS checkpoint, k.block_hash FROM indexer_sources s LEFT JOIN indexer_checkpoints k ON k.source_id = s.id WHERE s.id = $1`, [src.id]);
  const [{ n }] = await q(`SELECT count(*)::int AS n FROM raw_logs WHERE source_id = $1 AND canonical`, [src.id]);
  const [{ d }] = await q(
    `SELECT count(*)::int AS d FROM (SELECT block_hash, transaction_hash, log_index FROM raw_logs WHERE source_id = $1 AND canonical GROUP BY 1, 2, 3 HAVING count(*) > 1) x`,
    [src.id],
  );
  return { ...s, canonicalRecords: n, duplicateIdentities: d };
};

const account = loadAccount();
log(`signer ready for ${account.address}`);
const chain = defineChain({ id: 420420777, name: 'Portaldot V3 Testnet', nativeCurrency: { name: 'tPOT', symbol: 'tPOT', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const wallet = createWalletClient({ account, chain, transport: http(RPC) });
let sentHash = null;

async function handle(method, params) {
  switch (method) {
    case 'eth_requestAccounts':
    case 'eth_accounts':
      return [account.address];
    case 'eth_chainId':
      return '0x190f1ca9';
    case 'wallet_switchEthereumChain':
    case 'wallet_addEthereumChain':
      return null;
    case 'eth_sendTransaction': {
      const tx = params[0] ?? {};
      if (tx.from && tx.from.toLowerCase() !== EXPECTED) throw Object.assign(new Error(`Unexpected sender ${tx.from}`), { code: 4100 });
      if (sentHash) throw Object.assign(new Error('This run sends one transaction only.'), { code: 4001 });
      const req = { account, chain, to: tx.to ?? undefined, data: tx.data ?? tx.input, value: tx.value ? BigInt(tx.value) : undefined, gas: tx.gas ? BigInt(tx.gas) : undefined };
      if (tx.gasPrice) req.gasPrice = BigInt(tx.gasPrice);
      else if (tx.maxFeePerGas) Object.assign(req, { maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas ?? 0) });
      sentHash = await wallet.sendTransaction(req);
      step('signed and broadcast store(43)', { hash: sentHash });
      return sentHash;
    }
    default:
      return rpc(method, params);
  }
}

const browser = await chromium.launch({ channel: 'chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.exposeFunction('__pdWalletRequest', async (method, params) => {
  try {
    return { result: await handle(method, params) };
  } catch (e) {
    return { error: { code: e.code ?? -32000, message: String(e.shortMessage ?? e.message) } };
  }
});
await context.addInitScript(() => {
  const listeners = {};
  window.ethereum = {
    isPalletDockLiveSigner: true,
    on(e, f) {
      (listeners[e] ??= []).push(f);
    },
    removeListener(e, f) {
      listeners[e] = (listeners[e] ?? []).filter((x) => x !== f);
    },
    async request({ method, params }) {
      const r = await window.__pdWalletRequest(method, params ?? []);
      if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
      return r.result;
    },
  };
});
const page = await context.newPage();
let shot = 0;
const snap = (name) => page.screenshot({ path: `${OUT}/restart-${String(++shot).padStart(2, '0')}-${name}.png`, fullPage: true });
let workerStopped = false;

try {
  const before = await indexState();
  if (before.status !== 'following') throw new Error(`Indexer source is ${before.status}; expected following before the check.`);
  step('before', before);

  await page.goto(`${WEB}/login`);
  await page.getByLabel('Email').fill('owner@palletdock.local');
  await page.locator('#password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/app/);
  await page.goto(`${WEB}/app/indexer?project=${src.project_id}`);
  await page.getByText('Following').first().waitFor();
  await snap('before');

  step('stopping worker', { output: services('stop') });
  workerStopped = true;

  await page.goto(`${WEB}/app/contracts?project=${src.project_id}`);
  await page.getByRole('link', { name: /PalletDockStorage/ }).first().click();
  await page.getByRole('heading', { name: 'PalletDockStorage' }).waitFor();
  const connect = page.getByRole('button', { name: 'Connect wallet' }).first();
  if (await connect.isVisible()) {
    await connect.click();
    await page.getByRole('button', { name: /Connect EVM wallet/ }).click();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
  }
  await page.getByRole('tab', { name: /Write/ }).click();
  await page.locator('#write-0').fill('43');
  await page.getByRole('button', { name: 'Review write' }).click();
  const review = page.getByRole('dialog', { name: 'Review on-chain write' });
  await review.getByText('store(uint256)').waitFor();
  if (await review.getByText(/Fee estimate failed|simulated revert/i).count()) throw new Error('Write review shows a failure; not signing.');
  await review.getByRole('button', { name: 'Request signature' }).click();
  for (let i = 0; i < 60 && !sentHash; i++) await page.waitForTimeout(1_000);
  if (!sentHash) throw new Error('No transaction hash returned by the signer.');
  await snap('submitted-worker-down');

  // Inclusion straight from the RPC (the worker is down, so PalletDock cannot record it yet).
  let receipt = null;
  for (let i = 0; i < 20 && !receipt; i++) {
    receipt = await rpc('eth_getTransactionReceipt', [sentHash]);
    if (!receipt) await page.waitForTimeout(3_000);
  }
  if (!receipt) throw new Error('No receipt within 60 s; the worker stays stopped only as long as needed. Check the hash manually.');
  step('included while worker down (from RPC)', { block: BigInt(receipt.blockNumber).toString(), blockHash: receipt.blockHash, status: receipt.status, logs: receipt.logs.length });
  result.hash = sentHash;
  result.receiptBlock = BigInt(receipt.blockNumber).toString();
  result.receiptBlockHash = receipt.blockHash;
  const logIndex = receipt.logs[0] ? BigInt(receipt.logs[0].logIndex).toString() : null;

  const downSince = Date.now();
  await page.waitForTimeout(DOWN_MS);
  const duringDown = await indexState();
  step('worker down for ~60 s', { downMs: Date.now() - downSince, ...duringDown });

  step('starting worker', { output: services('start') });
  workerStopped = false;

  // Wait for the indexer to pass the write's block and store the record (bounded).
  let after = null;
  for (let i = 0; i < 60; i++) {
    after = await indexState();
    if (after.checkpoint && BigInt(after.checkpoint) >= BigInt(result.receiptBlock) && after.canonicalRecords >= before.canonicalRecords + 1) break;
    await page.waitForTimeout(5_000);
  }
  const rows = await q(
    `SELECT r.block_number::text, r.block_hash, r.log_index, r.canonical, d.event_name, d.args FROM raw_logs r LEFT JOIN decoded_events d ON d.raw_log_id = r.id
      WHERE r.source_id = $1 AND lower(r.transaction_hash) = lower($2) ORDER BY r.log_index`,
    [src.id, sentHash],
  );
  const [txRow] = await q(`SELECT inclusion_status, execution_status, block_number::text, block_hash, tracking_status FROM transactions WHERE lower(hash) = lower($1)`, [sentHash]);
  result.after = after;
  result.newRecords = rows;
  result.transaction = txRow;
  result.checks = {
    exactlyOneNewCanonicalRecord: after.canonicalRecords === before.canonicalRecords + 1 && rows.filter((r) => r.canonical).length === 1,
    noDuplicateIdentities: after.duplicateIdentities === 0,
    recordMatchesReceipt: rows.length === 1 && rows[0].block_hash.toLowerCase() === receipt.blockHash.toLowerCase() && String(rows[0].log_index) === logIndex,
    decodedNewValue43: rows[0]?.args?.newValue === '43' && rows[0]?.args?.previousValue === '42',
    checkpointPassedWriteBlock: !!after.checkpoint && BigInt(after.checkpoint) >= BigInt(result.receiptBlock),
    trackerRecordedInclusion: txRow?.inclusion_status === 'included' && txRow?.block_hash?.toLowerCase() === receipt.blockHash.toLowerCase(),
  };
  step('verified', result.checks);

  await page.goto(`${WEB}/app/indexer?project=${src.project_id}`);
  await page.getByText(/newValue=43/).first().waitFor({ timeout: 60_000 }).catch(() => {});
  await snap('indexed-after-restart');
  const [tx] = await q(`SELECT id FROM transactions WHERE lower(hash) = lower($1)`, [sentHash]);
  if (tx) {
    await page.goto(`${WEB}/app/transactions/${tx.id}?project=${src.project_id}`);
    await page.getByText('Observed timeline').waitFor();
    await snap('transaction');
  }
} catch (e) {
  result.error = String(e.message ?? e);
  log(`ERROR ${result.error}`);
  await snap('error').catch(() => {});
} finally {
  if (workerStopped) {
    try {
      step('restarting worker after error', { output: services('start') });
    } catch (e) {
      log(`Could not restart the worker: ${e.message}`);
    }
  }
  result.finishedAt = new Date().toISOString();
  writeFileSync(`${OUT}/result-restart.json`, JSON.stringify(result, null, 2));
  await browser.close();
  await db.end();
}
