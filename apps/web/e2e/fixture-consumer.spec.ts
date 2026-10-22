import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { installFixtureWallet } from './fixture-wallet';

/**
 * Consumer demo against the fixture stack (local Hardhat chain; not Portaldot
 * evidence). The consumer page reads only the public /v1 API through its
 * server route, with a read key kept in a server-side config file.
 */
const state = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../../.data/e2e/state.json'), 'utf8')) as {
  email: string;
  password: string;
  rpcUrl: string;
  accounts: string[];
  consumerConfig: string;
};

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(state.email);
  await page.locator('#password').fill(state.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/app/);
}

async function nav(page: Page, name: string) {
  await page.getByRole('navigation', { name: 'Project' }).getByRole('link', { name, exact: true }).click();
}

async function writeValue(page: Page, value: string) {
  await nav(page, 'Contracts');
  await page.getByRole('link', { name: /PalletDockStorage/ }).first().click();
  await page.getByRole('tab', { name: /Write/ }).click();
  await page.locator('#write-0').fill(value);
  await page.getByRole('button', { name: 'Review write' }).click();
  await page.getByRole('dialog', { name: 'Review on-chain write' }).getByRole('button', { name: 'Request signature' }).click();
  await expect(page.getByText('Succeeded').first()).toBeVisible({ timeout: 90_000 });
}

const status = (page: Page) => page.getByTestId('consumer-status');
const value = (page: Page) => page.getByTestId('consumer-value');
const rows = (page: Page) => page.getByTestId('consumer-event-row');

test.describe.configure({ mode: 'serial' });

test.describe('consumer demo (fixture chain)', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 1280) < 860, 'The full flow runs on desktop.');
  const projectName = `Consumer ${Date.now().toString(36)}`;
  const config: { projectId: string; readKey: string; contract: string } = { projectId: '', readKey: '', contract: '' };
  const writeConfig = (over: Record<string, string> = {}) => writeFileSync(state.consumerConfig, JSON.stringify({ ...config, ...over }));
  // One signed-in session for the whole flow: login is rate limited (10 per 15 minutes) and the other fixture specs need their share.
  let ctx: BrowserContext;
  let page: Page;
  test.beforeAll(async ({ browser }) => {
    ctx = await browser.newContext();
    page = await ctx.newPage();
    await installFixtureWallet(page, { rpcUrl: state.rpcUrl, account: state.accounts[0] });
  });
  test.afterAll(async () => {
    await ctx?.close();
  });

  test('is not a public proxy: without a session there is no project data', async ({ page: anonymous, request }) => {
    rmSync(state.consumerConfig, { force: true });
    const r = await request.get('/consumer/state');
    expect(r.status()).toBe(401);
    expect(await r.text()).not.toMatch(/blockHash|transactionHash|pd_live_/);
    await anonymous.goto('/consumer');
    await expect(anonymous.getByTestId('consumer-blocked')).toContainText('Sign in required');
  });

  test('setup in the workspace: deploy, store(42), index, and a scoped read key', async () => {
    await signIn(page);
    await page.goto('/app/projects/new');
    await page.locator('#name').fill(projectName);
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('heading', { name: projectName })).toBeVisible();
    config.projectId = new URL(page.url()).searchParams.get('project')!;

    // Signed in but not configured yet: the consumer says so instead of guessing.
    await page.goto('/consumer');
    await expect(page.getByTestId('consumer-blocked')).toContainText('Not configured');
    await page.goto(`/app?project=${config.projectId}`);

    await page.getByRole('button', { name: 'Connect wallet' }).first().click();
    await page.getByRole('button', { name: /Connect EVM wallet/ }).click();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await nav(page, 'Contracts');
    await page.getByRole('link', { name: 'Deploy contract' }).first().click();
    await page.getByRole('button', { name: /PalletDockStorage/ }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Continue to review' }).click();
    await page.getByRole('dialog', { name: 'Review deployment' }).getByRole('button', { name: 'Request signature' }).click();
    const open = page.getByRole('link', { name: /Open contract 0x/ });
    await open.waitFor({ timeout: 90_000 });
    config.contract = (await open.innerText()).match(/0x[0-9a-fA-F]{40}/)![0];

    await nav(page, 'Indexer');
    await page.getByRole('button', { name: 'Configure log source' }).click();
    await page.getByRole('button', { name: 'Save and start indexing' }).click();
    await expect(page.getByRole('heading', { name: 'PalletDockStorage events' })).toBeVisible();

    await writeValue(page, '42');
    await nav(page, 'Indexer');
    await expect(page.getByText(/newValue=42/)).toBeVisible({ timeout: 120_000 });

    await nav(page, 'API');
    await page.getByRole('tab', { name: 'Keys' }).click();
    await page.getByRole('button', { name: 'Create API key' }).click();
    await page.locator('#key-name').fill('consumer-demo');
    await page.getByRole('checkbox', { name: 'indexer:read' }).check();
    await page.getByRole('checkbox', { name: 'transactions:read' }).check();
    await page.getByRole('button', { name: 'Create key' }).click();
    const secret = (await page.locator('.secret-panel code').innerText()).trim();
    expect(secret).toMatch(/^pd_live_[\w-]+\.[\w-]+$/);
    config.readKey = secret;
    await page.getByRole('button', { name: 'Done' }).click();
    writeConfig();
  });

  test('A: shows the event from the API with network, identity, coverage, and unknown finality', async () => {
    await page.goto('/consumer');
    await expect(value(page)).toHaveText('42');
    await expect(status(page)).toHaveAttribute('data-level', 'fresh');
    await expect(rows(page)).toHaveCount(1);
    const main = page.locator('main');
    await expect(main).toContainText('420420777');
    await expect(main).toContainText('Not the Portaldot V3 Testnet genesis');
    await expect(main).toContainText('Unknown: not confirmed');
    await expect(main).toContainText(config.contract);
    await expect(main).toContainText('Log index');
    // The read key never reaches the browser: not in the page, the state response, or storage.
    const keySecret = config.readKey.split('.')[1];
    expect(await page.content()).not.toContain(keySecret);
    const stateBody = await (await page.request.get('/consumer/state')).text();
    expect(stateBody).not.toContain(keySecret);
    expect(stateBody).toContain(config.readKey.split('.')[0]); // only the public prefix
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    expect(stored).not.toContain(keySecret);
  });

  test('B–D: a paused indexer shows as behind; resuming syncs the new event exactly once', async () => {
    await page.goto(`/app/indexer?project=${config.projectId}`);
    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(page.getByText(/Paused/).first()).toBeVisible();
    const connect = page.getByRole('button', { name: 'Connect wallet' }).first();
    if (await connect.isVisible()) {
      await connect.click();
      await page.getByRole('button', { name: /Connect EVM wallet/ }).click();
      await page.getByRole('button', { name: 'Close', exact: true }).click();
    }
    await writeValue(page, '43');

    const consumer = await ctx.newPage();
    await consumer.goto('/consumer');
    await expect(status(consumer)).toHaveAttribute('data-level', 'lagging');
    await expect(status(consumer)).toContainText(/paused at block/);
    await expect(value(consumer)).toHaveText('42'); // the new event is not claimed before it is indexed
    await expect(consumer.locator('main')).toContainText('may not be the current on-chain value');

    await page.goto(`/app/indexer?project=${config.projectId}`);
    await page.getByRole('button', { name: 'Resume' }).click();
    await expect(value(consumer)).toHaveText('43', { timeout: 120_000 });
    await expect(status(consumer)).toHaveAttribute('data-level', 'fresh');
    await expect(rows(consumer)).toHaveCount(2);
    await expect(consumer.getByTestId('consumer-notes')).toContainText('1 new and 0 removed');
    // A fresh page load reconciles from scratch to the same set: no duplicates.
    await consumer.reload();
    await expect(value(consumer)).toHaveText('43');
    await expect(rows(consumer)).toHaveCount(2);
  });

  test('C: when the API is unreachable the last value stays, labelled with its read time, then recovers', async () => {
    await page.goto('/consumer');
    await expect(value(page)).toHaveText('43');
    writeConfig({ apiUrl: 'http://127.0.0.1:9' }); // nothing listens there
    try {
      await page.getByRole('button', { name: 'Refresh now' }).click();
      await expect(status(page)).toHaveAttribute('data-level', 'unavailable');
      await expect(status(page)).toContainText(/Showing data last read at/);
      await expect(value(page)).toHaveText('43');
    } finally {
      writeConfig();
    }
    await page.getByRole('button', { name: 'Refresh now' }).click();
    await expect(status(page)).toHaveAttribute('data-level', 'fresh');
    await expect(page.getByTestId('consumer-notes')).toContainText('API reachable again');
    await expect(rows(page)).toHaveCount(2);
  });
});
