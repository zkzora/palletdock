import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { installFixtureWallet } from './fixture-wallet';

/**
 * Full vertical slice against the fixture stack: empty project → deploy (wallet
 * approval) → navigable receipt → read/write → wallet rejection → indexer →
 * real API playground response → monitoring filters → export → archive/restore.
 * Fixture chain only; not live Portaldot evidence.
 */
const state = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../../.data/e2e/state.json'), 'utf8')) as {
  email: string;
  password: string;
  rpcUrl: string;
  accounts: string[];
};

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(state.email);
  await page.locator('#password').fill(state.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/app/);
}

async function selectProject(page: Page, name: string) {
  await page.locator('#project-switch').selectOption({ label: name });
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
}

async function nav(page: Page, name: string) {
  const isMobile = (page.viewportSize()?.width ?? 1280) < 860;
  if (isMobile) await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('navigation', { name: 'Project' }).getByRole('link', { name, exact: true }).click();
}

test.describe.configure({ mode: 'serial' });

test.describe('fixture vertical slice (desktop)', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 1280) < 860, 'Full flow runs on desktop; mobile has its own layout test.');
  const projectName = `E2E ${Date.now().toString(36)}`;

  test('empty project offers deploy and import', async ({ page }) => {
    await installFixtureWallet(page, { rpcUrl: state.rpcUrl, account: state.accounts[0] });
    await signIn(page);
    await page.goto('/app/projects/new');
    await page.locator('#name').fill(projectName);
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('heading', { name: projectName })).toBeVisible();
    await expect(page.getByText('FIXTURE NETWORK')).toBeVisible();
    await expect(page.getByText('No contracts in this project yet')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Deploy contract' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Import contract' })).toBeVisible();
  });

  test('deploy PalletDockStorage with wallet approval, read, write, and reject', async ({ page }) => {
    await installFixtureWallet(page, { rpcUrl: state.rpcUrl, account: state.accounts[0] });
    await signIn(page);
    await selectProject(page, projectName);
    await page.getByRole('button', { name: 'Connect wallet' }).first().click();
    await page.getByRole('button', { name: /Connect EVM wallet/ }).click();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await nav(page, 'Contracts');
    await page.getByRole('link', { name: 'Deploy contract' }).first().click();
    await page.getByRole('button', { name: /PalletDockStorage/ }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Continue to review' }).click();
    const dialog = page.getByRole('dialog', { name: 'Review deployment' });
    await expect(dialog.getByText('Fee estimate', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Fee estimate failed')).toHaveCount(0);
    await expect(dialog.getByText(/Storage deposit/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Request signature' }).click();
    // Receipt tracked by the worker; contract added from the receipt.
    await expect(page.getByText('Succeeded')).toBeVisible({ timeout: 90_000 });
    await page.getByRole('link', { name: /Open contract 0x/ }).click({ timeout: 90_000 });
    await expect(page.getByRole('heading', { name: 'PalletDockStorage' })).toBeVisible();

    // Read
    await page.getByRole('button', { name: 'Read', exact: true }).click();
    await expect(page.getByText(/at block/)).toBeVisible();

    // Write store(42)
    await page.getByRole('tab', { name: /Write/ }).click();
    await page.locator('#write-0').fill('42');
    await page.getByRole('button', { name: 'Review write' }).click();
    const review = page.getByRole('dialog', { name: 'Review on-chain write' });
    await expect(review.getByText('store(uint256)')).toBeVisible();
    await review.getByRole('button', { name: 'Request signature' }).click();
    await expect(page.getByText('Succeeded').first()).toBeVisible({ timeout: 90_000 });
    await page.getByRole('link', { name: 'View transaction details' }).click();
    await expect(page.getByText('Observed timeline')).toBeVisible();
    await expect(page.getByText('Receipt observed').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Raw receipt')).toBeVisible();

    // Wallet rejection is recorded and nothing is broadcast.
    await page.goBack();
    await page.getByRole('tab', { name: /Write/ }).click();
    await page.evaluate(() => ((window as any).__pdWallet.mode = 'reject'));
    await page.locator('#write-0').fill('7');
    await page.getByRole('button', { name: 'Review write' }).click();
    await page.getByRole('dialog', { name: 'Review on-chain write' }).getByRole('button', { name: 'Request signature' }).click();
    await expect(page.getByText('Rejected in the wallet', { exact: false }).first()).toBeVisible();
  });

  test('configure indexer and observe the NumberChanged record', async ({ page }) => {
    await signIn(page);
    await selectProject(page, projectName);
    await nav(page, 'Indexer');
    await page.getByRole('button', { name: 'Configure log source' }).click();
    await expect(page.getByText('NumberChanged(address,uint256,uint256)')).toBeVisible();
    await page.getByRole('button', { name: 'Save and start indexing' }).click();
    await expect(page.getByRole('heading', { name: 'PalletDockStorage events' })).toBeVisible();
    await expect(page.getByText(/newValue=42/)).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText(/complete/).first()).toBeVisible();
  });

  test('playground returns the indexed event from the real API', async ({ page }) => {
    await signIn(page);
    await selectProject(page, projectName);
    await nav(page, 'API');
    await page.getByRole('button', { name: 'Create 7-day playground key' }).click();
    await expect(page.getByText(/Created a 7-day playground key/)).toBeVisible();
    await page.getByRole('button', { name: 'Send request' }).click();
    await expect(page.locator('pre').filter({ hasText: '"newValue": "42"' })).toBeVisible();
    await expect(page.getByText('200', { exact: true })).toBeVisible();
    await expect(page.getByText(/^req_/)).toBeVisible();
    // Curl snippet never contains the secret.
    await expect(page.locator('pre').filter({ hasText: 'curl' })).toContainText('$PALLETDOCK_READ_KEY');
  });

  test('monitoring filters change the query, export downloads, archive and restore', async ({ page }) => {
    await signIn(page);
    await selectProject(page, projectName);
    await nav(page, 'Monitoring');
    await expect(page.getByRole('heading', { name: 'Probes, lag, and errors' })).toBeVisible();
    const req = page.waitForRequest((r) => r.url().includes('/monitoring?') && r.url().includes('source=indexer'));
    await page.getByRole('group', { name: 'Log source' }).getByRole('button', { name: 'Indexer' }).click();
    await req;
    await expect(page.getByText(/Checkpoint committed/).first()).toBeVisible();

    await nav(page, 'Settings');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download configuration JSON' }).click();
    const file = await download;
    const text = readFileSync((await file.path())!, 'utf8');
    expect(text).toContain('palletdock.project-export/v1');
    expect(text).not.toMatch(/pd_live_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{20,}/);

    await page.getByRole('button', { name: 'Archive project' }).click();
    await page.getByRole('dialog', { name: 'Archive project' }).getByRole('button', { name: 'Archive project' }).click();
    await expect(page.getByText('Archived project')).toBeVisible();
    await page.getByRole('button', { name: 'Restore project' }).click();
    await page.getByRole('dialog', { name: 'Restore project' }).getByRole('button', { name: 'Restore project' }).click();
    await expect(page.getByText('Resume indexer sources individually')).toBeVisible();
  });

  test('import rejects an address without runtime code', async ({ page }) => {
    await signIn(page);
    await selectProject(page, projectName);
    await page.goto(page.url().replace(/\/app.*$/, '') + '/app/contracts/import?' + new URL(page.url()).searchParams.toString());
    await page.locator('#imp-name').fill('Nothing');
    await page.locator('#imp-address').fill('0x1111111111111111111111111111111111111111');
    await page.getByRole('button', { name: 'Use PalletDockStorage ABI' }).click();
    // The sample ABI is fetched asynchronously; submit only once it is in the form.
    await expect(page.locator('#imp-abi')).toHaveValue(/NumberChanged/);
    await page.getByRole('button', { name: 'Import contract' }).click();
    await expect(page.getByText(/No runtime code exists/)).toBeVisible();
  });
});

test('mobile layout: navigation drawer and pages render without horizontal scroll', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1280) >= 860, 'mobile only');
  await signIn(page);
  for (const name of ['Contracts', 'Transactions', 'Indexer', 'API', 'Monitoring', 'Settings']) {
    await nav(page, name);
    await expect(page.locator('main h1')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${name} overflows horizontally`).toBeLessThanOrEqual(1);
  }
});
