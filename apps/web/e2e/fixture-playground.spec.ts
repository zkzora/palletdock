import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { expect, test, type Page } from '@playwright/test';
import { installFixtureWallet } from './fixture-wallet';

/**
 * Playground (temporary workspace) journeys against the fixture stack: a local Hardhat
 * chain labelled FIXTURE NETWORK and the controlled fixture wallet. Not live Portaldot evidence.
 */
const state = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../../.data/e2e/state.json'), 'utf8')) as {
  email: string;
  password: string;
  rpcUrl: string;
  accounts: string[];
  signupInviteCode: string;
  databaseUrl: string;
  sharedStorage: string;
};

const guide = (page: Page) => page.getByRole('region', { name: 'Playground guide' });
const observed = (page: Page, n: number) => expect(guide(page).getByText(`${n} of 6 observed`)).toBeVisible({ timeout: 120_000 });

async function nav(page: Page, name: string) {
  if ((page.viewportSize()?.width ?? 1280) < 860) await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('navigation', { name: 'Project' }).getByRole('link', { name, exact: true }).click();
}

async function startPlayground(page: Page, template: RegExp = /^Storage/) {
  await page.goto('/playground');
  await expect(page.getByRole('heading', { name: 'Try the PalletDock workspace' })).toBeVisible();
  await page.getByRole('group', { name: 'Templates' }).getByRole('button', { name: template }).click();
  await page.getByRole('button', { name: 'Start temporary workspace' }).click();
  await page.waitForURL(/\/app\?project=/);
  await expect(guide(page)).toBeVisible();
}

async function connectWallet(page: Page) {
  await page.locator('.header-actions').getByRole('button', { name: /Connect wallet|Wrong network/ }).click();
  await page.getByRole('button', { name: /Connect EVM wallet/ }).click();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
}

/** Deploy the selected template from the guide, sign it, and wait for the receipt-tracked contract. */
async function deployFromGuide(page: Page) {
  await guide(page).getByRole('link', { name: 'Open deploy' }).click();
  await expect(page.getByText(/Playground template:/)).toBeVisible();
  await connectWallet(page);
  await page.getByRole('button', { name: 'Continue to review' }).click();
  const dialog = page.getByRole('dialog', { name: 'Review deployment' });
  await expect(dialog.getByText('FIXTURE NETWORK transaction · local test chain, not Portaldot')).toBeVisible();
  await expect(dialog.getByText('Fee estimate failed')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Request signature' }).click();
  await expect(page.getByText('Succeeded').first()).toBeVisible({ timeout: 90_000 });
  await observed(page, 2);
}

async function startIndexingAndRead(page: Page, readFn: string) {
  await guide(page).getByRole('button', { name: 'Start indexing' }).click();
  await expect(guide(page).getByText(/^Indexer: /)).toBeVisible();
  await guide(page).getByRole('link', { name: `Open ${readFn}` }).click();
  await expect(page.locator('#read-fn')).toHaveValue(readFn);
  await page.getByRole('button', { name: 'Read', exact: true }).click();
  await expect(page.getByText(/at block/)).toBeVisible();
  await observed(page, 3);
}

async function signWrite(page: Page) {
  await page.getByRole('button', { name: 'Review write' }).click();
  const review = page.getByRole('dialog', { name: 'Review on-chain write' });
  await expect(review.getByText('FIXTURE NETWORK transaction · local test chain, not Portaldot')).toBeVisible();
  await review.getByRole('button', { name: 'Request signature' }).click();
  await expect(page.getByText('Succeeded').first()).toBeVisible({ timeout: 90_000 });
}

test.describe.configure({ mode: 'serial' });

test.describe('playground (desktop)', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 1280) < 860, 'Full journeys run on desktop; mobile has its own layout test.');

  test('Storage: start without account or wallet, use the shared contract, read, write, index, query the API, and save', async ({ page, context }) => {
    await installFixtureWallet(page, { rpcUrl: state.rpcUrl, account: state.accounts[0] });

    // Rendering and prefetching create nothing.
    await page.goto('/');
    await expect(page.getByRole('link', { name: /Try Playground/ }).first()).toBeVisible();
    await page.goto('/playground');
    await expect(page.getByText(/Real testnet transactions/)).toBeVisible();
    await expect(page.getByText(/needs test tPOT/)).toBeVisible();
    await expect(page.getByText(/lasts 6 hours from the moment you start it/)).toBeVisible();
    // Storage has the operator's shared copy; the others are deployed by the visitor.
    const templates = page.getByRole('group', { name: 'Templates' });
    await expect(templates.getByRole('button', { name: /^Storage/ })).toContainText('Ready: shared contract, no deployment');
    await expect(templates.getByRole('button', { name: /^ERC-721/ })).toContainText('You deploy it');
    expect((await context.cookies()).some((c) => c.name === 'palletdock_session')).toBe(false);

    await startPlayground(page);
    const session = (await context.cookies()).find((c) => c.name === 'palletdock_session');
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe('Strict');
    // The real workspace: full navigation, fixture label, temporary indicator, save action.
    for (const name of ['Overview', 'Contracts', 'Transactions', 'Indexer', 'API', 'Monitoring', 'Settings']) {
      await expect(page.getByRole('navigation', { name: 'Project' }).getByRole('link', { name, exact: true })).toBeVisible();
    }
    await expect(page.getByText('FIXTURE NETWORK', { exact: true })).toBeVisible();
    await expect(page.getByText('Temporary playground · expires')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Save workspace' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Playground', level: 1 })).toBeVisible();
    // The shared contract was added at start after its code matched the artifact: no deployment, no deposit.
    await observed(page, 2);
    await expect(guide(page).getByText(new RegExp(`Shared PalletDockStorage at ${state.sharedStorage}`, 'i'))).toBeVisible();
    // No wallet prompt on load.
    expect(await page.evaluate(() => (window as any).__pdWallet.connected)).toBe(false);

    await startIndexingAndRead(page, 'retrieve()');

    await connectWallet(page);
    await guide(page).getByRole('link', { name: 'Prepare store(uint256)' }).click();
    await expect(page.locator('#write-0')).toHaveValue('42');
    await signWrite(page);
    // Written, indexed, and decoded (worker + indexer), not because a button was clicked.
    await observed(page, 5);
    await expect(guide(page).getByText(/NumberChanged indexed in block/)).toBeVisible();

    // Refresh keeps the journey.
    await page.reload();
    await observed(page, 5);

    await guide(page).getByRole('link', { name: 'Open API playground' }).click();
    await expect(page.locator('#pg-event')).toHaveValue('NumberChanged');
    await page.getByRole('button', { name: 'Create read key for this workspace' }).click();
    await expect(page.getByText(/expires with this temporary workspace/)).toBeVisible();
    await page.getByRole('button', { name: 'Send request' }).click();
    await expect(page.locator('pre').filter({ hasText: '"newValue": "42"' })).toBeVisible();
    await expect(page.locator('pre').filter({ hasText: 'curl' })).toContainText('$PALLETDOCK_READ_KEY');
    await observed(page, 6);

    await nav(page, 'Monitoring');
    await expect(page.getByRole('heading', { name: 'Probes, lag, and errors' })).toBeVisible();

    // Save workspace through the existing registration flow.
    const projectUrl = new URL(page.url()).searchParams.get('project');
    await page.getByRole('link', { name: 'Save workspace' }).click();
    await expect(page.getByRole('heading', { name: 'Save your workspace' })).toBeVisible();
    await page.getByLabel('Email').fill(`saved-${Date.now()}@palletdock.test`);
    await page.locator('#password').fill('correct horse battery staple');
    await page.getByLabel('Confirm password').fill('correct horse battery staple');
    await page.getByLabel('Registration code').fill(state.signupInviteCode);
    await page.getByRole('button', { name: 'Save workspace' }).click();
    await page.waitForURL(new RegExp(`/app\\?project=${projectUrl}`));
    await expect(page.getByText('Temporary playground · expires')).toHaveCount(0);
    await observed(page, 6);
    const rotated = (await context.cookies()).find((c) => c.name === 'palletdock_session');
    expect(rotated?.value).not.toBe(session?.value);
  });

  for (const t of [
    { name: /^Payments/, read: 'totalReceived()', write: 'Prepare pay(bytes32)', event: 'PaymentReceived' },
    { name: /^ERC-20 token/, read: 'totalSupply()', write: 'Prepare transfer(address,uint256)', event: 'Transfer' },
    { name: /^ERC-721 collectible/, read: 'nextTokenId()', write: 'Prepare mint(address)', event: 'Transfer' },
  ]) {
    test(`${t.event} journey through the same project: ${t.write}`, async ({ page }) => {
      await installFixtureWallet(page, { rpcUrl: state.rpcUrl, account: state.accounts[0] });
      await startPlayground(page, t.name);
      await deployFromGuide(page);
      await startIndexingAndRead(page, t.read);
      await guide(page).getByRole('link', { name: t.write }).click();
      const review = page.getByRole('button', { name: 'Review write' });
      if (t.event === 'PaymentReceived') {
        // The amount is never prefilled: it must be entered explicitly.
        // Sample order reference: ASCII "pd-sample-order-" + part of the project id, zero-padded.
        await expect(page.locator('#write-0')).toHaveValue(/^0x70642d73616d706c652d6f726465722d[0-9a-f]{16}0+$/);
        await expect(page.locator('#write-value')).toHaveValue('');
        await expect(review).toBeDisabled();
        await page.locator('#write-value').fill('1000');
      } else if (t.write.includes('transfer')) {
        // A valid recipient is required before review.
        await expect(page.locator('#write-0')).toHaveValue('');
        await expect(review).toBeDisabled();
        await page.locator('#write-0').fill(state.accounts[1]);
        await expect(page.locator('#write-1')).toHaveValue('1000000000000000000');
      } else {
        await expect(page.locator('#write-0')).toHaveValue(state.accounts[0].toLowerCase());
      }
      await signWrite(page);
      await observed(page, 5);
      await expect(guide(page).getByText(new RegExp(`${t.event} indexed in block`))).toBeVisible();
    });
  }

  test('wrong chain is switched before signing; a wallet rejection completes nothing', async ({ page }) => {
    await installFixtureWallet(page, { rpcUrl: state.rpcUrl, account: state.accounts[0], chainId: '0x1' });
    await startPlayground(page, /^ERC-721 collectible/);
    await guide(page).getByRole('link', { name: 'Open deploy' }).click();
    await connectWallet(page);
    await expect(page.locator('.header-actions').getByRole('button', { name: 'Wrong network' })).toBeVisible();
    await page.getByRole('button', { name: 'Continue to review' }).click();
    const dialog = page.getByRole('dialog', { name: 'Review deployment' });
    await page.evaluate(() => ((window as any).__pdWallet.mode = 'reject'));
    await dialog.getByRole('button', { name: 'Request signature' }).click();
    await expect(page.getByText('Rejected in the wallet')).toBeVisible();
    expect(await page.evaluate(() => (window as any).__pdWallet.chainId)).toBe('0x190f1ca9');
    await nav(page, 'Overview');
    // The rejected deployment is shown as not submitted; the step is not marked done.
    await observed(page, 1);
    await expect(guide(page).getByText(/was not submitted/)).toBeVisible();
  });

  test('an expired workspace is refused and offers a new start', async ({ page }) => {
    await startPlayground(page);
    const projectId = new URL(page.url()).searchParams.get('project');
    const client = new pg.Client({ connectionString: state.databaseUrl });
    await client.connect();
    try {
      await client.query(`UPDATE owners SET guest_expires_at = now() - interval '1 second' WHERE id = (SELECT owner_id FROM projects WHERE id=$1) AND kind='guest'`, [projectId]);
    } finally {
      await client.end();
    }
    await page.reload();
    await expect(page.getByRole('heading', { name: 'This temporary workspace expired' })).toBeVisible();
    await expect(page.getByText(/remain on the testnet/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Start a new playground' })).toBeVisible();
  });

  test('a signed-in account is kept and can add a guided sample project', async ({ page, context }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(state.email);
    await page.locator('#password').fill(state.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(/\/app/);
    const before = (await context.cookies()).find((c) => c.name === 'palletdock_session')?.value;
    await page.goto('/playground');
    await expect(page.getByText(`You are signed in as ${state.email}`)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start temporary workspace' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Create a sample project' }).click();
    await page.waitForURL(/\/app\?project=/);
    await expect(guide(page)).toBeVisible();
    await expect(page.getByText('Temporary playground · expires')).toHaveCount(0);
    expect((await context.cookies()).find((c) => c.name === 'palletdock_session')?.value).toBe(before);
  });
});

test('mobile: the temporary workspace keeps the full navigation without horizontal scroll', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1280) >= 860, 'mobile only');
  await startPlayground(page);
  await expect(page.locator('.temp-chip time')).toBeVisible();
  for (const name of ['Overview', 'Contracts', 'Indexer', 'API']) {
    await nav(page, name);
    await expect(page.locator('main h1')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${name} overflows horizontally`).toBeLessThanOrEqual(1);
  }
});
