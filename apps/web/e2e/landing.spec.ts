import { expect, test, type Page } from '@playwright/test';

const stages = (page: Page) => page.getByRole('group', { name: 'Preview stages' }).getByRole('button');
/** The detail panel that is rendered for the current viewport (desktop frame or mobile panel). */
const panelTitle = (page: Page) => page.locator('#showcase-preview .ld-panel-head strong').filter({ visible: true });
/** The tour control renders only after hydration, so it doubles as a "ready" signal. */
const ready = (page: Page) => expect(page.getByRole('button', { name: 'Pause the preview tour' })).toBeVisible();

test('dashboard preview: stage buttons switch the detail panel and stop the tour', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await expect(page.getByText('illustrative data, not live network activity')).toBeVisible();
  await expect(stages(page)).toHaveCount(4);
  await expect(stages(page).nth(0)).toHaveAttribute('aria-pressed', 'true');
  await expect(panelTitle(page)).toHaveText('Import contract');

  await stages(page).nth(2).click();
  await expect(stages(page).nth(2)).toHaveAttribute('aria-pressed', 'true');
  await expect(stages(page).nth(0)).toHaveAttribute('aria-pressed', 'false');
  await expect(panelTitle(page)).toHaveText('Transaction');
  await expect(page.locator('#showcase-preview .ld-life-step.is-unknown').filter({ visible: true })).toContainText('Not confirmed');
  // A manual choice ends the autoplay tour; the control offers to play again.
  await expect(page.getByRole('button', { name: 'Play the preview tour' })).toBeVisible();
  await expect(page.locator('.ld-stage-progress')).toHaveCount(0);

  await page.getByRole('button', { name: 'Play the preview tour' }).click();
  await expect(page.getByRole('button', { name: 'Pause the preview tour' })).toBeVisible();
});

test('dashboard preview is keyboard operable', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await stages(page).nth(0).focus();
  await page.keyboard.press('ArrowRight');
  await expect(stages(page).nth(1)).toBeFocused();
  await expect(stages(page).nth(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(panelTitle(page)).toHaveText('Review write');

  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(stages(page).nth(3)).toBeFocused();
  await expect(panelTitle(page)).toHaveText('Read API');

  await stages(page).nth(0).focus();
  await page.keyboard.press('Enter');
  await expect(stages(page).nth(0)).toHaveAttribute('aria-pressed', 'true');
  await expect(panelTitle(page)).toHaveText('Import contract');
});

test('mobile shows one focused preview panel instead of the scaled desktop frame', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'Mobile layout only.');
  await page.goto('/');
  await expect(page.locator('.ld-frame')).toBeHidden();
  await expect(page.locator('.ld-mobile')).toBeVisible();
  for (const box of await Promise.all((await stages(page).all()).map((b) => b.boundingBox()))) {
    expect(box!.height).toBeGreaterThanOrEqual(40);
  }
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(sw).toBeLessThanOrEqual(iw);
  await page.screenshot({ path: testInfo.outputPath('landing-mobile.png'), fullPage: true });
});

test('dashboard table never sits behind the detail panel', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Desktop widths only.');
  for (const width of [1079, 1080, 1180, 1279, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    if (width < 1080) {
      await expect(page.locator('.ld-frame')).toBeHidden();
      await expect(page.locator('.ld-mobile')).toBeVisible();
      continue;
    }
    await expect(page.locator('.ld-frame')).toBeVisible();
    const table = await page.locator('.ld-table').boundingBox();
    const panel = await page.locator('.ld-float').boundingBox();
    expect(table!.x + table!.width, `table clear of panel at ${width}px`).toBeLessThanOrEqual(panel!.x);
  }
});

test('reduced motion turned on while the page is open stops the tour', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.getByRole('button', { name: /preview tour/ })).toHaveCount(0);
  await expect(page.locator('.ld-stage-progress')).toHaveCount(0);
  // Turning it off again brings the control back, paused.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(page.getByRole('button', { name: 'Play the preview tour' })).toBeVisible();
});

test('reduced motion: no autoplay and figures render complete', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(stages(page).nth(0)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: /preview tour/ })).toHaveCount(0);
  await expect(page.locator('.ld-stage-progress')).toHaveCount(0);
  await expect(page.locator('.ld-figs-grid')).toHaveClass(/is-drawn/);
  await expect(page.locator('.fig-layer').first()).toHaveCSS('opacity', '1');
});
