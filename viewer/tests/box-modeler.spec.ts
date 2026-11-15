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

test('box modeler: pin a design, change the box, compare both', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole('navigation', { name: 'Home Hi-Fi sections' }).getByRole('button', { name: /Speaker/ }).click();

  const card = page.getByTestId('box-modeler');
  await card.getByTestId('pin-design').click();
  await expect(card.getByTestId('pin-design')).toBeDisabled(); // this exact design is pinned
  await page.getByRole('button', { name: 'Vented (ported)' }).click();
  const table = card.getByTestId('compare-table');
  await expect(table.locator('tbody tr')).toHaveCount(2);
  await expect(table.locator('tbody tr').nth(1)).toContainText('sealed');
  await expect(table.locator('tbody tr').nth(0)).toContainText('m/s'); // vented row has a port speed
  // the overlay adds a second curve to the chart legend
  await expect(card.locator('.legend span')).toHaveCount(2);
  // survives a reload
  await page.reload();
  await page.getByRole('navigation', { name: 'Home Hi-Fi sections' }).getByRole('button', { name: /Speaker/ }).click();
  await expect(page.getByTestId('compare-table').locator('tbody tr')).toHaveCount(2);
  await page.getByTestId('compare-table').getByRole('button', { name: /Remove/ }).click();
  await expect(page.getByTestId('compare-table')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('your own driver: validated entry, used by the box, cut list and modeler', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole('navigation', { name: 'Home Hi-Fi sections' }).getByRole('button', { name: /Speaker/ }).click();
  await page.getByRole('button', { name: /Add your own driver/ }).click();
  const form = page.getByTestId('custom-driver-form');
  await expect(form.getByRole('button', { name: 'Add driver' })).toBeDisabled();

  // Dayton RS150-8 datasheet numbers
  await form.getByPlaceholder('e.g. Dayton Audio').fill('Test');
  await form.getByPlaceholder('e.g. RS150-8').fill('My6');
  const fill = (label: string, v: string) => form.getByLabel(label, { exact: true }).fill(v);
  await fill('Fs', '46.6');
  await fill('Qts', '0.38');
  await fill('Qes', '0.44');
  await fill('Qms', '2.71');
  await fill('Vas', '14.3');
  await fill('Sd', '118.8');
  await fill('Xmax', '5');
  await fill('Re', '6.1');
  await fill('Sensitivity', '86.5');
  await expect(form.locator('li.good')).toContainText('self-consistent');

  // a unit slip (Vas in ft³) is caught by the sensitivity cross-check
  await fill('Vas', '0.5');
  await expect(form.getByTestId('sens-mismatch')).toBeVisible();
  await fill('Vas', '14.3');

  await form.getByRole('button', { name: 'Add driver' }).click();
  await expect(page.locator('.drv.on', { hasText: 'My6' })).toBeVisible();
  await expect(page.locator('.drv.on .tag.mine')).toBeVisible();
  await expect(page.getByTestId('box-modeler')).toContainText('My6');
  // the woodworking plan uses it too
  await page.getByRole('button', { name: /See the woodworking plan/ }).click();
  await expect(page.getByText(/box for the Test My6/)).toBeVisible();
  expect(errors).toEqual([]);
});

test('3D view: section position slider; an unbuildable printed design says so', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole('navigation', { name: 'Home Hi-Fi sections' }).getByRole('button', { name: /Speaker/ }).click();
  // plywood: the slider appears with the cut and moves it
  await expect(page.getByLabel('Section position')).toHaveCount(0);
  await page.getByRole('button', { name: 'Cut in half' }).click();
  const slider = page.getByLabel('Section position');
  await expect(slider).toBeVisible();
  await slider.fill('0.2');
  await expect(page.locator('.s3d').getByRole('button', { name: 'Centre', exact: true })).toBeEnabled();
  await page.locator('.s3d').getByRole('button', { name: 'Centre', exact: true }).click();
  await expect(slider).toHaveValue('0.5');
  // printed: a cabinet too short for its woofer and tweeter is flagged and kept out of the simulator
  await page.locator('.gcard', { hasText: 'Printed sealed monitor' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByLabel('Height', { exact: true }).fill('200');
  await expect(page.getByRole('alert')).toContainText("Can't be built as drawn");
  await expect(page.getByLabel('Use this speaker as the living-room mains')).toBeDisabled();
  expect(errors).toEqual([]);
});
