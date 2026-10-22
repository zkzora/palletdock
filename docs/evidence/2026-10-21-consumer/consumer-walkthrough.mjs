// Consumer demo walkthrough on the live dev stack (Portaldot V3 Testnet data).
// Read-only: no transactions, no keys. It only stops and starts the local
// PalletDock worker and API to show how the consumer reports them.
//
//   $env:PALLETDOCK_OWNER_PASSWORD = '<owner password>'
//   node C:\PalletDock\live-kit\consumer-walkthrough.mjs C:\PalletDock\live-kit\run-consumer
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { chromium } = createRequire('C:/PalletDock/palletdock/apps/web/package.json')('@playwright/test');
const OUT = process.argv[2];
const WEB = 'http://127.0.0.1:3001';
const REPO = 'C:/PalletDock/palletdock';
const PASSWORD = process.env.PALLETDOCK_OWNER_PASSWORD ?? '';
if (!PASSWORD) throw new Error('Set PALLETDOCK_OWNER_PASSWORD first.');
mkdirSync(OUT, { recursive: true });

const args = (action, only) => ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `${REPO}/scripts/dev-services.ps1`, action, '-Only', only];
// Start without pipes: Start-Process children would otherwise hold the call open.
const svc = (action, only) => (action === 'start' ? execFileSync('powershell', args('start', only), { stdio: 'ignore', timeout: 60_000 }) : execFileSync('powershell', args(action, only), { encoding: 'utf8', timeout: 60_000 }));
const log = [];
const note = (step, data) => {
  log.push({ at: new Date().toISOString(), step, ...data });
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${step} ${JSON.stringify(data)}`);
  writeFileSync(`${OUT}/walkthrough.json`, JSON.stringify(log, null, 2));
};

const browser = await chromium.launch({ channel: 'chrome' });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
const level = () => page.getByTestId('consumer-status').getAttribute('data-level');
const observe = async (step, shot) => {
  const data = {
    level: await level(),
    value: (await page.getByTestId('consumer-value').innerText()).trim(),
    reasons: await page.locator('.cs-reasons li').allInnerTexts(),
    events: await page.getByTestId('consumer-event-row').allInnerTexts(),
  };
  await page.screenshot({ path: `${OUT}/${shot}.png`, fullPage: true });
  note(step, data);
  return data;
};
const waitLevel = async (want, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await page.getByRole('button', { name: 'Refresh now' }).click();
    await page.waitForTimeout(2_500);
    if (want.includes(await level())) return true;
  }
  return false;
};

let workerDown = false;
let apiDown = false;
try {
  await page.goto(`${WEB}/login`);
  await page.getByLabel('Email').fill('owner@palletdock.local');
  await page.locator('#password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/app/);
  await page.goto(`${WEB}/consumer`);
  await page.getByTestId('consumer-value').filter({ hasNotText: '—' }).waitFor({ timeout: 60_000 });
  await waitLevel(['fresh'], 30_000);
  await observe('A: normal (live data)', '01-normal');

  svc('stop', 'worker');
  workerDown = true;
  note('worker stopped', {});
  const staleSeen = await waitLevel(['stale'], 150_000);
  await observe(`C: worker stopped${staleSeen ? '' : ' (stale not reached in time)'}`, '02-worker-stopped');
  svc('start', 'worker');
  workerDown = false;
  note('worker started', {});
  await waitLevel(['fresh'], 120_000);
  await observe('D: worker back', '03-worker-back');

  svc('stop', 'api');
  apiDown = true;
  note('api stopped', {});
  await waitLevel(['unavailable'], 30_000);
  await observe('API unavailable', '04-api-down');
  svc('start', 'api');
  apiDown = false;
  note('api started', {});
  await waitLevel(['fresh'], 90_000);
  await observe('API back', '05-api-back');
} catch (e) {
  note('error', { message: String(e.message ?? e) });
  await page.screenshot({ path: `${OUT}/error.png`, fullPage: true }).catch(() => {});
} finally {
  if (workerDown) svc('start', 'worker');
  if (apiDown) svc('start', 'api');
  await browser.close();
}
