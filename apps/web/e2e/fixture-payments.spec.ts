import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { installFixtureWallet } from './fixture-wallet';

/**
 * Payments sample on the fixture stack: deploy PalletDockPayments, pay an order with
 * native value through the UI, index PaymentReceived, then withdraw as the owner.
 * Fixture chain only; not live Portaldot evidence.
 */
const state = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../../.data/e2e/state.json'), 'utf8')) as {
  email: string;
  password: string;
  rpcUrl: string;
  accounts: string[];
};

const ORDER_REF = '0x' + '0'.repeat(62) + '7b'; // order #123
const ONE_TPOT = '1000000000000000000';

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(state.email);
  await page.locator('#password').fill(state.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/app/);
}

async function write(page: Page, signature: string, args: string[], value?: string) {
  await page.getByRole('tab', { name: /Write/ }).click();
  await page.locator('#write-fn').selectOption(signature);
  for (const [i, a] of args.entries()) await page.locator(`#write-${i}`).fill(a);
  if (value !== undefined) await page.locator('#write-value').fill(value);
  await page.getByRole('button', { name: 'Review write' }).click();
  const review = page.getByRole('dialog', { name: 'Review on-chain write' });
  await expect(review.getByText(signature)).toBeVisible();
  await review.getByRole('button', { name: 'Request signature' }).click();
  await expect(page.getByText('Succeeded').first()).toBeVisible({ timeout: 90_000 });
}

test.describe.configure({ mode: 'serial' });

test.describe('payments sample (desktop)', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 1280) < 860, 'Desktop flow.');
  const projectName = `Payments ${Date.now().toString(36)}`;

  test('deploy, pay an order with value, index the payment, and withdraw', async ({ page }) => {
    await installFixtureWallet(page, { rpcUrl: state.rpcUrl, account: state.accounts[0] });
    await signIn(page);
    await page.goto('/app/projects/new');
    await page.locator('#name').fill(projectName);
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('heading', { name: projectName })).toBeVisible();

    await page.getByRole('button', { name: 'Connect wallet' }).first().click();
    await page.getByRole('button', { name: /Connect EVM wallet/ }).click();
    await page.getByRole('button', { name: 'Close', exact: true }).click();

    // Deploy from the bundled sample.
    await page.getByRole('link', { name: 'Deploy contract' }).first().click();
    await page.getByRole('button', { name: /PalletDockPayments/ }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Continue to review' }).click();
    await page.getByRole('dialog', { name: 'Review deployment' }).getByRole('button', { name: 'Request signature' }).click();
    await expect(page.getByText('Succeeded')).toBeVisible({ timeout: 90_000 });
    await page.getByRole('link', { name: /Open contract 0x/ }).click({ timeout: 90_000 });
    await expect(page.getByRole('heading', { name: 'PalletDockPayments' })).toBeVisible();

    // pay(bytes32) is payable: the form offers a value field and the review shows it.
    await write(page, 'pay(bytes32)', [ORDER_REF], ONE_TPOT);

    // A non-payable function has no value field.
    await page.locator('#write-fn').selectOption('withdraw(address)');
    await expect(page.locator('#write-value')).toHaveCount(0);

    // Index the payment events.
    await page.goto('/app/indexer');
    await page.getByRole('button', { name: 'Configure log source' }).click();
    await expect(page.getByText('PaymentReceived(address,bytes32,uint256)')).toBeVisible();
    await page.getByRole('button', { name: 'Save and start indexing' }).click();
    await expect(page.getByText(new RegExp(`amount=${ONE_TPOT}`))).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText(new RegExp(`orderRef=${ORDER_REF}`))).toBeVisible();

    // Owner withdraws the balance; Withdrawn is indexed too.
    await page.goBack();
    await page.goto('/app/contracts');
    await page.getByRole('link', { name: /PalletDockPayments/ }).first().click();
    // Full page loads drop the wallet connection; reconnect before signing.
    await page.getByRole('button', { name: 'Connect wallet' }).first().click();
    await page.getByRole('button', { name: /Connect EVM wallet/ }).click();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await write(page, 'withdraw(address)', [state.accounts[0]]);
    await page.goto('/app/indexer');
    await expect(page.getByText(/Withdrawn/).first()).toBeVisible({ timeout: 120_000 });
  });
});
