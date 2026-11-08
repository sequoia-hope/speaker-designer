import { test, expect } from '@playwright/test';
test('a customised design carries into the Room tab, and across browser tabs', async ({ context, page }) => {
  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const nav = page.getByRole('navigation', { name: 'Home Hi-Fi sections (sidebar)' });
  await nav.getByRole('button', { name: /Speakers/ }).click();
  await page.locator('.gcard', { hasText: 'Tower' }).first().click();
  await expect(page.getByTestId('design-not-in-system')).toBeVisible();
  await page.getByRole('button', { name: 'Sealed', exact: true }).click();
  await expect(page.getByTestId('design-auto-assigned')).toContainText('mains');
  await nav.getByRole('button', { name: /Room/ }).click();
  await expect(page.getByText(/Using your mains, the/)).toContainText('Floor-standing tower');
  // a second browser tab sees it, and edits there flow back
  const p2 = await context.newPage();
  await p2.goto('./#home/room');
  await expect(p2.getByText(/Using your mains, the/)).toContainText('Floor-standing tower');
  await p2.getByRole('button', { name: /7\.1/ }).first().click();
  await expect(page.locator('.side-sum')).toContainText('System: 7.1');
  // and survives a reload
  await page.reload();
  await expect(page.getByText(/Using your mains, the/)).toContainText('Floor-standing tower');
});
