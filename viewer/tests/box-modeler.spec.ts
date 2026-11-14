import { test, expect, devices } from '@playwright/test';

test.use({ ...devices['iPhone 15 Pro Max'], defaultBrowserType: 'chromium' });

test('box modeler: graphs, sensitivity, and a high-pass that tames vented excursion', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole('navigation', { name: 'Home Hi-Fi sections' }).getByRole('button', { name: /Speaker/ }).click();
  await page.getByRole('button', { name: 'Vented (ported)' }).click();

  const card = page.getByTestId('box-modeler');
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByRole('heading', { name: 'Box modeler' })).toBeVisible();

  // modelled 2.83 V sensitivity lands near the default woofer's datasheet 87 dB
  const sens = parseFloat((await card.locator('.stat', { hasText: 'Sensitivity' }).locator('.v').textContent()) ?? '');
  expect(sens).toBeGreaterThan(85);
  expect(sens).toBeLessThan(90);

  for (const tab of ['Cone travel', 'Port speed', 'Max output', 'Impedance', 'Group delay', 'Loudness']) {
    await card.getByRole('tab', { name: tab }).click();
    await expect(card.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true');
    await expect(card.locator('svg path[d^="M"]').first()).toBeVisible();
  }

  const travel = async () =>
    parseFloat((await card.locator('.stat', { hasText: 'Peak cone travel' }).locator('.v').textContent()) ?? '');
  const before = await travel();
  await card.getByText('High-pass (subsonic) filter').click();
  await expect(card.getByLabel('High-pass at')).toBeVisible();
  const after = await travel();
  expect(after).toBeLessThan(before * 0.7);

  expect(errors).toEqual([]);
});
