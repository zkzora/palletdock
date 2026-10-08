/**
 * Isolated browser-E2E stack (fixture mode). Starts a throwaway PostgreSQL, a
 * local Hardhat EVM node (chain ID 420420777, NOT Portaldot), and the
 * PalletDock API, worker, and web app on dedicated ports, then writes
 * .data/e2e/state.json for Playwright. Stops everything on SIGINT/SIGTERM.
 *
 *   pnpm e2e:stack        # run in one terminal
 *   pnpm e2e              # run Playwright against it
 *
 * Results from this stack are fixture results, never live testnet evidence.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { createPool, hashPassword, migrate } from '@palletdock/db';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORTS = { web: Number(process.env.E2E_WEB_PORT ?? 3199), api: Number(process.env.E2E_API_PORT ?? 4199), rpc: Number(process.env.E2E_RPC_PORT ?? 8599) };
const stateDir = path.join(ROOT, '.data', 'e2e');
mkdirSync(stateDir, { recursive: true });
const children: ChildProcess[] = [];
let pgServer: EmbeddedPostgres | null = null;
let pgDir = '';

function log(m: string) {
  console.log(`[e2e-stack] ${m}`);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

async function assertFree(port: number, name: string) {
  await new Promise<void>((resolve, reject) => {
    const s = createServer();
    s.once('error', () => reject(new Error(`Port ${port} for ${name} is in use. Set E2E_${name.toUpperCase()}_PORT.`)));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve()));
  });
}

function run(name: string, args: string[], env: Record<string, string>) {
  const out = openSync(path.join(stateDir, `${name}.log`), 'w');
  const child = spawn(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', out, out],
    shell: process.platform === 'win32',
    detached: process.platform !== 'win32',
  });
  children.push(child);
  child.on('exit', (code) => log(`${name} exited with ${code}`));
  return child;
}

async function waitFor(name: string, fn: () => Promise<boolean>, timeoutMs = 180_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await fn()) return;
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${name} did not become ready in ${timeoutMs / 1000}s (see .data/e2e/${name}.log)`);
}

async function rpc(method: string, params: unknown[] = []) {
  const r = await fetch(`http://127.0.0.1:${PORTS.rpc}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return (await r.json()).result;
}

async function shutdown(code = 0) {
  log('stopping');
  for (const c of children) {
    if (!c.pid) continue;
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/T', '/F', '/PID', String(c.pid)], { stdio: 'ignore' });
      else process.kill(-c.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  await new Promise((r) => setTimeout(r, 1500));
  await pgServer?.stop().catch(() => {});
  if (pgDir) rmSync(pgDir, { recursive: true, force: true });
  rmSync(path.join(stateDir, 'state.json'), { force: true });
  process.exit(code);
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

try {
  for (const [k, v] of Object.entries(PORTS)) await assertFree(v, k);
  // 1. Database
  pgDir = mkdtempSync(path.join(tmpdir(), 'palletdock-e2e-pg-'));
  const pgPort = await freePort();
  pgServer = new EmbeddedPostgres({ databaseDir: path.join(pgDir, 'data'), port: pgPort, user: 'pde2e', password: 'pde2e', persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {}, onError: () => {} });
  await pgServer.initialise();
  await pgServer.start();
  await pgServer.createDatabase('palletdock_e2e');
  const DATABASE_URL = `postgresql://pde2e:pde2e@127.0.0.1:${pgPort}/palletdock_e2e`;
  const pool = createPool(DATABASE_URL, 2);
  await migrate(pool, log);
  log(`postgres ready on ${pgPort}`);

  // 2. Fixture EVM chain
  run('chain', ['--filter', '@palletdock/e2e-chain', 'exec', 'hardhat', 'node', '--hostname', '127.0.0.1', '--port', String(PORTS.rpc)], {});
  await waitFor('chain', async () => (await rpc('eth_chainId')) === '0x190f1ca9', 90_000);
  const accounts: string[] = await rpc('eth_accounts');
  const genesis = (await rpc('eth_getBlockByNumber', ['0x0', false])).hash as string;
  log(`fixture chain ready (genesis ${genesis.slice(0, 12)}…)`);

  // 3. Owner + fixture fingerprint
  const email = 'e2e-owner@palletdock.test';
  const password = randomBytes(18).toString('base64url');
  await pool.query('INSERT INTO owners(email,password_hash) VALUES ($1,$2)', [email, await hashPassword(password)]);
  await pool.query(
    `INSERT INTO network_fingerprints(network_id,status,genesis_hash,evm_chain_id,evm_genesis_hash,spec_name,spec_version,ss58_format,token_symbol,token_decimals,evidence)
     VALUES ('portaldot-v3-testnet','active',$1,420420777,$1,'fixture-hardhat',0,42,'tPOTv3',14,$2)`,
    [genesis, JSON.stringify({ fixture: true, note: 'E2E fixture fingerprint for a local Hardhat chain. Not Portaldot.' })],
  );
  await pool.end();

  // 4. Services
  const common = {
    DATABASE_URL,
    NODE_ENV: 'development',
    PORTALDOT_EVM_RPC_URL: `http://127.0.0.1:${PORTS.rpc}`,
    PALLETDOCK_ALLOW_LOOPBACK_RPC: '1',
    PALLETDOCK_NATIVE_ADAPTER: 'disabled',
    PALLETDOCK_DEV_CONTROLS: '1',
    PALLETDOCK_CURSOR_SECRET: randomBytes(32).toString('base64url'),
    API_RATE_LIMIT_PER_MINUTE: '2000',
  };
  run('api', ['--filter', '@palletdock/api', 'start'], { ...common, API_HOST: '127.0.0.1', API_PORT: String(PORTS.api), WEB_ORIGIN: `http://127.0.0.1:${PORTS.web}` });
  run('worker', ['--filter', '@palletdock/worker', 'start'], common);
  run('web', ['--filter', '@palletdock/web', 'exec', 'next', 'dev', '--hostname', '127.0.0.1', '--port', String(PORTS.web)], { PALLETDOCK_API_URL: `http://127.0.0.1:${PORTS.api}`, NEXT_DIST_DIR: '.next-e2e' });
  await waitFor('api', async () => (await fetch(`http://127.0.0.1:${PORTS.api}/health`)).ok);
  await waitFor('web', async () => (await fetch(`http://127.0.0.1:${PORTS.web}/login`)).ok, 240_000);
  log('api and web ready');

  const state = { webUrl: `http://127.0.0.1:${PORTS.web}`, apiUrl: `http://127.0.0.1:${PORTS.api}`, rpcUrl: `http://127.0.0.1:${PORTS.rpc}`, email, password, accounts, fixture: true };
  writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify(state, null, 2));
  log(`ready: ${state.webUrl} (state in .data/e2e/state.json)`);
  // Keep running until SIGINT/SIGTERM (Playwright global teardown or Ctrl+C).
  setInterval(() => {}, 60_000);
} catch (e) {
  console.error(`[e2e-stack] failed: ${(e as Error).message}`);
  await shutdown(1);
}
