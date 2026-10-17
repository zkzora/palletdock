import { expect, test } from '@playwright/test';

const email = process.env.PALLETDOCK_E2E_EMAIL ?? 'owner@palletdock.local';
const password = process.env.PALLETDOCK_E2E_PASSWORD;

test('landing preserves the supplied PalletDock direction', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Deploy, index and monitor');
  await expect(page.getByRole('banner').getByRole('link', { name: 'Open workspace' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('landing.png'), fullPage: true });
});

test('owner can enter the real workspace and inspect network health', async ({ page }, testInfo) => {
  test.skip(!password, 'Set PALLETDOCK_E2E_PASSWORD for the authenticated workflow.');
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.locator('#password').fill(password!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/app/);
  await expect(page.locator('main h1').first()).toBeVisible();
  await page.goto('/app/network');
  await expect(page.getByRole('heading', { name: 'Network' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('EVM RPC probe')).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: testInfo.outputPath('network.png'), fullPage: true });
});
