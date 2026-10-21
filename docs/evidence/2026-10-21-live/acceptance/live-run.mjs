// Live acceptance run on Portaldot V3 Testnet, at the owner's instruction.
// Drives the real PalletDock UI (http://127.0.0.1:3001) with an injected
// EIP-1193 wallet whose signing happens in this Node process. The burner key is
// read from the session transcript, checked against the expected address, kept
// in memory only, and never printed, written, or passed to the page.
//
//   $env:PALLETDOCK_OWNER_PASSWORD = '<owner password>'
//   node C:\PalletDock\live-kit\live-run.mjs C:\PalletDock\live-kit\run main storage-demo-live
//   (stage "check" only verifies the signer and exits without sending anything)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { chromium } = createRequire('C:/PalletDock/palletdock/apps/web/package.json')('@playwright/test');
const chainReq = createRequire('C:/PalletDock/palletdock/packages/chain/package.json');
const { createWalletClient, defineChain, http } = chainReq('viem');
const { privateKeyToAccount } = chainReq('viem/accounts');

const OUT = process.argv[2];
const STAGE = process.argv[3] ?? 'main';
const PROJECT = process.argv[4] ?? `storage-demo-live-${new Date().toISOString().slice(0, 10)}`;
const TRANSCRIPT = 'C:/Users/Pongo/.claude/projects/c--PalletDock/dd24ec76-565d-4e4f-a0b8-1784d33b81c6.jsonl';
const EXPECTED = '0xfa02532d22cb7e9ef572751be928efcd2ac4fa8f';
const RPC = 'https://test-evm-rpc-v3.portaldot.dev';
const WEB = 'http://127.0.0.1:3001';
const PASSWORD = process.env.PALLETDOCK_OWNER_PASSWORD ?? '';
mkdirSync(OUT, { recursive: true });

const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const result = { stage: STAGE, project: PROJECT, startedAt: new Date().toISOString(), sent: [] };
const save = () => writeFileSync(`${OUT}/result-${STAGE}.json`, JSON.stringify(result, null, 2));

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

const account = loadAccount();
log(`signer ready for ${account.address}`);
if (STAGE === 'check') process.exit(0);
if (!PASSWORD) throw new Error('Set PALLETDOCK_OWNER_PASSWORD first.');
const chain = defineChain({ id: 420420777, name: 'Portaldot V3 Testnet', nativeCurrency: { name: 'tPOT', symbol: 'tPOT', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const wallet = createWalletClient({ account, chain, transport: http(RPC) });

let rpcId = 0;
async function rpc(method, params) {
  const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }), signal: AbortSignal.timeout(30_000) });
  const body = await res.json();
  if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code });
  return body.result;
}

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
      const req = { account, chain, to: tx.to ?? undefined, data: tx.data ?? tx.input, value: tx.value ? BigInt(tx.value) : undefined, gas: tx.gas ? BigInt(tx.gas) : undefined };
      if (tx.gasPrice) req.gasPrice = BigInt(tx.gasPrice);
      else if (tx.maxFeePerGas) Object.assign(req, { maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas ?? 0) });
      const hash = await wallet.sendTransaction(req);
      result.sent.push({ at: new Date().toISOString(), kind: tx.to ? 'call' : 'deploy', selector: (req.data ?? '').slice(0, 10), hash });
      save();
      log(`signed and broadcast ${tx.to ? 'call' : 'deploy'}: ${hash}`);
      return hash;
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
const snap = async (name) => page.screenshot({ path: `${OUT}/${STAGE}-${String(++shot).padStart(2, '0')}-${name}.png`, fullPage: true });

async function nav(name) {
  await page.getByRole('navigation', { name: 'Project' }).getByRole('link', { name, exact: true }).click();
}
async function waitOutcome(label, timeout = 240_000) {
  const ok = page.getByText('Succeeded').first();
  const bad = page.getByText(/Reverted|Not submitted|Rejected in the wallet|Unconfirmed|failed/i).first();
  await ok.or(bad).waitFor({ timeout });
  if (!(await ok.isVisible())) {
    await snap(`${label}-problem`);
    throw new Error(`${label}: ${await bad.innerText()}`);
  }
}

try {
  await page.goto(`${WEB}/login`);
  await page.getByLabel('Email').fill('owner@palletdock.local');
  await page.locator('#password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/app/);
  log('signed in');

  if (STAGE === 'main') {
    await page.goto(`${WEB}/app/projects/new`);
    await page.locator('#name').fill(PROJECT);
    await page.getByRole('button', { name: 'Create project' }).click();
    const projectHeading = page.getByRole('heading', { name: PROJECT });
    const duplicateProject = page.getByText('A project with this name already exists.');
    await projectHeading.or(duplicateProject).waitFor();
    if (await duplicateProject.isVisible()) {
      await nav('Overview');
      await projectHeading.waitFor();
      log(`reusing existing project ${PROJECT}`);
    }
    if (await page.getByText('FIXTURE NETWORK').count()) throw new Error('Workspace is on the fixture network; refusing to record live evidence.');
    result.projectId = new URL(page.url()).searchParams.get('project');
    log(`project ${PROJECT} (${result.projectId})`);

    const connectWallet = page.getByRole('button', { name: 'Connect wallet' }).first();
    if (await connectWallet.isVisible()) {
      await connectWallet.click();
      await page.getByRole('button', { name: /Connect EVM wallet/ }).click();
      await page.getByRole('button', { name: 'Close', exact: true }).click();
    } else {
      await page.getByRole('button', { name: /0xfa02.*fa8f/i }).first().waitFor();
      log('wallet already connected');
    }
    await snap('connected');

    await nav('Contracts');
    await page.getByRole('link', { name: 'Deploy contract' }).first().click();
    await page.getByRole('button', { name: /PalletDockStorage/ }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Continue to review' }).click();
    const review = page.getByRole('dialog', { name: 'Review deployment' });
    await review.getByText('Fee estimate', { exact: true }).waitFor({ timeout: 60_000 });
    result.deployReview = await review.innerText();
    await snap('deploy-review');
    if (await review.getByText(/Fee estimate failed|simulated revert/i).count()) throw new Error('Deployment review shows a failure; not signing.');
    await review.getByRole('button', { name: 'Request signature' }).click();
    await waitOutcome('deploy');
    const open = page.getByRole('link', { name: /Open contract 0x/ });
    await open.waitFor({ timeout: 120_000 });
    result.contractAddress = (await open.innerText()).match(/0x[0-9a-fA-F]{40}/)?.[0];
    await snap('deploy-succeeded');
    log(`deployed ${result.contractAddress}`);
    save();

    // Index right away: the node keeps state for only ~258 blocks.
    await nav('Indexer');
    await page.getByRole('button', { name: 'Configure log source' }).click();
    await page.getByText('NumberChanged(address,uint256,uint256)').waitFor();
    await page.getByRole('button', { name: 'Save and start indexing' }).click();
    await page.getByRole('heading', { name: 'PalletDockStorage events' }).waitFor({ timeout: 60_000 });
    log('indexer source saved');

    await nav('Contracts');
    await page.getByRole('link', { name: /PalletDockStorage/ }).first().click();
    await page.getByRole('heading', { name: 'PalletDockStorage' }).waitFor();
    await page.getByRole('tab', { name: /Write/ }).click();
    await page.locator('#write-0').fill('42');
    await page.getByRole('button', { name: 'Review write' }).click();
    const wr = page.getByRole('dialog', { name: 'Review on-chain write' });
    await wr.getByText('store(uint256)').waitFor();
    result.writeReview = await wr.innerText();
    await wr.getByRole('button', { name: 'Request signature' }).click();
    await waitOutcome('write');
    await snap('write-succeeded');
    await page.getByRole('link', { name: 'View transaction details' }).click();
    await page.getByText('Receipt observed').first().waitFor({ timeout: 120_000 });
    result.writeDetailsUrl = page.url();
    await snap('write-details');
    log('write receipt observed');
    save();

    await nav('Indexer');
    await page.getByText(/newValue=42/).waitFor({ timeout: 600_000 });
    await snap('indexed');
    log('NumberChanged newValue=42 indexed');

    // Real API response through the in-app playground (the key secret never leaves the page).
    await nav('API');
    await page.getByRole('button', { name: 'Create 7-day playground key' }).click();
    await page.getByText(/Created a 7-day playground key/).waitFor();
    await page.getByRole('button', { name: 'Send request' }).click();
    const resp = page.locator('pre').filter({ hasText: '"newValue": "42"' });
    await resp.waitFor({ timeout: 60_000 });
    result.apiRequestId = (await page.getByText(/^req_/).first().innerText()).trim();
    result.apiResponse = await resp.innerText();
    await snap('api');
    log(`API 200 ${result.apiRequestId}`);
  }
} catch (e) {
  result.error = String(e.message ?? e);
  log(`ERROR ${result.error}`);
  await snap('error').catch(() => {});
} finally {
  result.finishedAt = new Date().toISOString();
  save();
  await browser.close();
}
