import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const state = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../../.data/e2e/state.json'), 'utf8')) as {
  signupInviteCode: string;
};

test('invite signup creates an isolated workspace and authenticated session', async ({ page }) => {
  const email = `signup-${Date.now()}@palletdock.test`;
  await page.goto('/signup');
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
  await page.getByLabel('Email').fill(email);
  await page.locator('#password').fill('correct horse battery staple');
  await page.getByLabel('Confirm password').fill('correct horse battery staple');
  await page.getByLabel('Registration code').fill(state.signupInviteCode);
  await page.getByRole('button', { name: 'Create account' }).click();

  await page.waitForURL(/\/app\/projects\/new/);
  await expect(page.getByRole('heading', { name: 'Create project' })).toBeVisible();
  await page.getByLabel('Project name').fill('Signup workspace');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.waitForURL(/\/app\?project=/);
  await expect(page.getByRole('heading', { name: 'Signup workspace' })).toBeVisible();
});
