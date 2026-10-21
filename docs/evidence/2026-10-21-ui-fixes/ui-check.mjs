// Screenshots of the transaction details page and unit labels after the UI fixes.
// Read-only: signs in and navigates; sends no transactions.
//
//   $env:PALLETDOCK_OWNER_PASSWORD = '<owner password>'
//   node C:\PalletDock\live-kit\ui-check.mjs <outDir> <webUrl> <email> <txPath> [label]
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const { chromium } = createRequire('C:/PalletDock/palletdock/apps/web/package.json')('@playwright/test');
const [OUT, WEB, EMAIL, TX_PATH, LABEL = 'live'] = process.argv.slice(2);
const PASSWORD = process.env.PALLETDOCK_OWNER_PASSWORD ?? '';
if (!PASSWORD || !TX_PATH) throw new Error('Usage: ui-check.mjs <outDir> <webUrl> <email> <txPath> [label] with PALLETDOCK_OWNER_PASSWORD set');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });
const report = [];
for (const [name, viewport] of [
  ['desktop', { width: 1440, height: 1000 }],
  ['mobile', { width: 390, height: 844 }],
]) {
  const page = await (await browser.newContext({ viewport })).newPage();
  await page.goto(`${WEB}/login`);
  await page.getByLabel('Email').fill(EMAIL);
  await page.locator('#password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/app/);
  if (TX_PATH === 'first') {
    // Open the most recent transaction of the selected project.
    await page.goto(`${WEB}/app/transactions`);
    await page.locator('a[href*="/app/transactions/"]').first().click();
  } else {
    await page.goto(`${WEB}${TX_PATH}`);
  }
  await page.getByText('Observed timeline').waitFor();
  await page.locator('.timeline > div').first().waitFor();
  // Timeline text must keep a usable width (it used to collapse to ~14 px).
  const widths = await page.locator('.timeline > div > div').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
  const units = await page.locator('dt', { hasText: /^Units$/ }).locator('xpath=following-sibling::dd[1]').innerText();
  const fee = await page.locator('dt', { hasText: /^Actual fee$/ }).locator('xpath=following-sibling::dd[1]').innerText();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await page.screenshot({ path: `${OUT}/${LABEL}-tx-details-${name}.png`, fullPage: true });
  report.push({ viewport: name, timelineTextWidths: widths, horizontalOverflow: overflow, units, fee });
}
await browser.close();
console.log(JSON.stringify(report, null, 2));
