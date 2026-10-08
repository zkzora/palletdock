import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

/** Captures screenshots of populated workspace pages from the fixture stack for visual review. */
const state = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../../.data/e2e/state.json'), 'utf8'));

test('capture workspace screens', async ({ page }, info) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(state.email);
  await page.locator('#password').fill(state.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/app/);
  const project = new URL(page.url()).searchParams.get('project') ?? '';
  const q = project ? `?project=${project}` : '';
  const shots: Array<[string, string]> = [
    ['overview', `/app${q}`],
    ['contracts', `/app/contracts${q}`],
    ['transactions', `/app/transactions${q}`],
    ['indexer', `/app/indexer${q}`],
    ['api', `/app/api${q}`],
    ['monitoring', `/app/monitoring${q}`],
    ['settings', `/app/settings${q}`],
    ['network', `/app/network${q}`],
  ];
  for (const [name, url] of shots) {
    await page.goto(url);
    await expect(page.locator('main h1').first()).toBeVisible();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
  }
  await page.goto(`/app/contracts${q}`);
  const card = page.locator('a.contract-card').first();
  if (await card.count()) {
    await card.click();
    await expect(page.locator('main h1')).toBeVisible();
    await page.screenshot({ path: info.outputPath('contract-detail.png'), fullPage: true });
  }
  await page.goto(`/app/transactions${q}`);
  const row = page.locator('a.row-link').first();
  if (await row.count()) {
    await row.click();
    await expect(page.getByText('Observed timeline')).toBeVisible();
    await page.screenshot({ path: info.outputPath('transaction-detail.png'), fullPage: true });
  }
});
