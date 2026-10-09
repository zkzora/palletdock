import { expect, test } from '@playwright/test';
import { DOCS } from '../lib/docs';

/** Every documentation and public page renders in the docs design without overflow or console errors. */
test('docs, FAQ, roadmap, and support pages render', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const urls = [...DOCS.map((d) => `/docs${d.slug ? `/${d.slug}` : ''}`), '/faq', '/roadmap', '/support'];
  for (const url of urls) {
    await page.goto(url);
    await expect(page.locator('h1').first(), url).toBeVisible();
    await expect(page.getByText('Page not found')).toHaveCount(0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${url} overflows horizontally`).toBeLessThanOrEqual(1);
  }
  for (const [name, url] of [['docs-home', '/docs'], ['docs-network', '/docs/network'], ['docs-api', '/docs/api'], ['support', '/support']] as const) {
    await page.goto(url);
    await page.waitForTimeout(400);
    await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
  }
  expect(errors).toEqual([]);
});

test('docs navigation: sidebar or page picker, prev/next, and search', async ({ page }) => {
  await page.goto('/docs/network');
  const wide = (page.viewportSize()?.width ?? 1280) >= 900;
  if (wide) {
    await page.getByRole('navigation', { name: 'Documentation' }).getByRole('link', { name: 'Accounts And Address Mapping' }).click();
    await expect(page).toHaveURL(/\/docs\/accounts$/);
    await page.getByLabel('Search the docs').fill('reviveApi');
    await expect(page.getByRole('navigation', { name: 'Documentation' }).getByRole('link', { name: 'Glossary' })).toHaveCount(0);
  } else {
    await page.getByRole('combobox').selectOption('accounts');
    await expect(page).toHaveURL(/\/docs\/accounts$/);
  }
  await page.getByRole('link', { name: /Next/ }).click();
  await expect(page).toHaveURL(/\/docs\/funding$/);
});
