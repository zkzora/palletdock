// Live RPC-interruption check on Portaldot V3 Testnet (no transactions, no keys).
// Uses the development control "Simulate RPC interruption" (the worker's next 3
// EVM RPC calls fail), then records how the indexer fails and recovers:
// UI state, the source/job rows over time, ops logs, and duplicate checks.
//
//   $env:PALLETDOCK_OWNER_PASSWORD = '<owner password>'
//   node --env-file=C:\PalletDock\palletdock\.env C:\PalletDock\live-kit\live-interrupt.mjs C:\PalletDock\live-kit\run-interrupt storage-demo-live
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { chromium } = createRequire('C:/PalletDock/palletdock/apps/web/package.json')('@playwright/test');
const pg = createRequire('C:/PalletDock/palletdock/packages/db/package.json')('pg');

const OUT = process.argv[2];
const PROJECT = process.argv[3] ?? 'storage-demo-live';
const WEB = 'http://127.0.0.1:3001';
const PASSWORD = process.env.PALLETDOCK_OWNER_PASSWORD ?? '';
if (!PASSWORD) throw new Error('Set PALLETDOCK_OWNER_PASSWORD first.');
if (!process.env.DATABASE_URL) throw new Error('Run with --env-file pointing at the PalletDock .env.');
mkdirSync(OUT, { recursive: true });

const log = (m) => console.log(`[${new Date().toISOString().slice(11, 23)}] ${m}`);
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const q = async (sql, params) => (await db.query(sql, params)).rows;

const [src] = await q(
  `SELECT s.id, s.project_id FROM indexer_sources s JOIN projects p ON p.id = s.project_id WHERE p.name = $1 AND s.desired_state = 'running' ORDER BY s.created_at DESC LIMIT 1`,
  [PROJECT],
);
if (!src) throw new Error(`No running indexer source in project ${PROJECT}`);

const state = async () =>
  (
    await q(
      `SELECT s.status, s.last_error, j.attempts, j.next_run_at, k.block_number::text AS checkpoint, k.block_hash AS checkpoint_hash
         FROM indexer_sources s JOIN indexer_jobs j ON j.source_id = s.id LEFT JOIN indexer_checkpoints k ON k.source_id = s.id
        WHERE s.id = $1`,
      [src.id],
    )
  )[0];
const logs = async () => {
  const rows = await q(`SELECT raw_logs.canonical, count(*)::int AS n FROM raw_logs WHERE source_id = $1 GROUP BY canonical`, [src.id]);
  const dup = await q(
    `SELECT count(*)::int AS n FROM (SELECT block_hash, transaction_hash, log_index FROM raw_logs WHERE source_id = $1 AND canonical GROUP BY 1, 2, 3 HAVING count(*) > 1) d`,
    [src.id],
  );
  return { byCanonical: rows, duplicateIdentities: dup[0].n };
};

const result = { project: PROJECT, sourceId: src.id, startedAt: new Date().toISOString(), before: { state: await state(), rawLogs: await logs() }, timeline: [] };
const save = () => writeFileSync(`${OUT}/result-interrupt.json`, JSON.stringify(result, null, 2));
if (result.before.state.status !== 'following') throw new Error(`Source is ${result.before.state.status}, expected following before the check.`);
log(`source ${src.id} following at checkpoint ${result.before.state.checkpoint}`);

const browser = await chromium.launch({ channel: 'chrome' });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1100 } })).newPage();
let shot = 0;
const snap = (name) => page.screenshot({ path: `${OUT}/interrupt-${String(++shot).padStart(2, '0')}-${name}.png`, fullPage: true });

try {
  await page.goto(`${WEB}/login`);
  await page.getByLabel('Email').fill('owner@palletdock.local');
  await page.locator('#password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/app/);
  await page.goto(`${WEB}/app/indexer?project=${src.project_id}`);
  await page.getByRole('heading', { name: /events$/ }).waitFor();
  await page.getByText('Following').first().waitFor();
  await snap('before');

  const clickedAt = Date.now();
  result.simulatedAt = new Date(clickedAt).toISOString();
  await page.getByRole('button', { name: 'Simulate RPC interruption' }).click();
  log('simulated RPC interruption requested');

  // Watch the local database (not the RPC) for the failure and the recovery.
  let sawError = false;
  let uiErrorShot = false;
  let last = '';
  const deadline = clickedAt + 180_000;
  while (Date.now() < deadline) {
    const s = await state();
    const key = `${s.status}|${s.attempts}|${s.last_error ?? ''}|${s.checkpoint}`;
    if (key !== last) {
      last = key;
      result.timeline.push({ at: new Date().toISOString(), ...s });
      log(`status=${s.status} attempts=${s.attempts} checkpoint=${s.checkpoint}${s.last_error ? ` error="${s.last_error}"` : ''}`);
    }
    if (s.status === 'error') {
      sawError = true;
      if (!uiErrorShot) {
        // The UI polls every 5 s; wait for it to show the failure.
        await page.getByText('Needs attention').first().waitFor({ timeout: 15_000 }).then(
          async () => {
            uiErrorShot = true;
            result.uiError = await page.getByText(/Simulated RPC interruption/).first().innerText().catch(() => null);
            await snap('needs-attention');
          },
          () => {},
        );
      }
    }
    if (sawError && s.status === 'following' && s.attempts === 0) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  result.recovered = sawError && last.startsWith('following|0|');
  if (!sawError) result.note = 'The source never entered the error state within 180 s.';

  await page.reload();
  await page.getByText('Following').first().waitFor({ timeout: 30_000 });
  await snap('recovered');

  await page.goto(`${WEB}/app/monitoring?project=${src.project_id}`);
  await page.getByRole('heading', { name: 'Probes, lag, and errors' }).waitFor();
  await page.getByText(/Recovered after/).first().waitFor({ timeout: 30_000 }).catch(() => {});
  await snap('monitoring');

  result.opsLogs = await q(
    `SELECT created_at, source, level, message, detail FROM ops_logs WHERE indexer_source_id = $1 AND created_at >= $2 ORDER BY created_at, id`,
    [src.id, new Date(clickedAt - 2_000)],
  );
  result.after = { state: await state(), rawLogs: await logs() };
  log(`recovered=${result.recovered}; duplicates=${result.after.rawLogs.duplicateIdentities}`);
} catch (e) {
  result.error = String(e.message ?? e);
  log(`ERROR ${result.error}`);
  await snap('error').catch(() => {});
} finally {
  result.finishedAt = new Date().toISOString();
  save();
  await browser.close();
  await db.end();
}
