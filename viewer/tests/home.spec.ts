import { test, expect, devices } from '@playwright/test';

test.use({ ...devices['iPhone 15 Pro Max'], defaultBrowserType: 'chromium' });

test('Home Hi-Fi: room planner, speaker designer and woodworking plan work on a phone', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  // Room tab is the landing page
  await expect(page.getByTestId('home-studio')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your room' })).toBeVisible();
  // defaults to the living room, and warns that it is square
  await expect(page.locator('#rm-widthM')).toHaveValue('12′ 6″');
  await expect(page.getByText('Almost square room')).toBeVisible();
  await expect(page.locator('canvas').first()).toBeVisible();
  // floor-plan style entry
  await page.locator('#rm-depthM').fill(`13'2 1/2"`);
  await page.locator('#rm-depthM').press('Enter');
  await page.locator('#rm-depthM').blur();
  await expect(page.locator('#rm-depthM')).toHaveValue('13′ 2 1/2″');
  await page.getByRole('button', { name: '15×25 ft' }).click();
  await expect(page.locator('#rm-widthM')).toHaveValue('15′ 0″');
  await page.getByRole('button', { name: 'Top view' }).click();
  await expect(page.getByRole('img', { name: 'Room plan view' })).toBeVisible();

  // optimiser moves the seat/speakers and reports an improvement
  await page.getByRole('button', { name: /Find best spot/ }).click();
  await expect(page.getByText(/Bass unevenness .* → .* dB/)).toBeVisible({ timeout: 20_000 });

  await page.getByRole('button', { name: '2 subs' }).click();
  await expect(page.getByText('sub X-over')).toBeVisible();

  // Speaker tab: switch to vented, a port appears
  await page.getByRole('navigation', { name: 'Home Hi-Fi sections' }).getByRole('button', { name: /Speaker/ }).click();
  await page.getByRole('button', { name: 'Vented (ported)' }).click();
  await expect(page.locator('.stat', { hasText: 'Port' })).toBeVisible();
  await expect(page.locator('canvas').first()).toBeVisible();
  await page.getByRole('button', { name: 'On its stand' }).click();

  // Build tab: drawings, cut list, steps
  await page.getByRole('button', { name: /See the woodworking plan/ }).click();
  await expect(page.getByRole('heading', { name: 'Cut list' })).toBeVisible();
  await expect(page.locator('.tbl').filter({ hasText: 'Top / bottom' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Front baffle' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Router circle-jig settings' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Stands' })).toBeVisible();
  await page.locator('details.acc summary', { hasText: 'Window brace' }).first().click();
  await expect(page.getByRole('img', { name: 'Window brace drawing' })).toBeVisible();
  const first = page.getByLabel('Mark step 1 done');
  await first.click();
  await expect(page.getByText(/1 of \d+ steps done/)).toBeVisible();

  // System layouts: 5.1.2 adds ceiling speakers; party adds delayed fills
  const nav = page.getByRole('navigation', { name: 'Home Hi-Fi sections' });
  await nav.getByRole('button', { name: /Room/ }).click();
  await page.locator('.lcard', { hasText: '5.1.2' }).click();
  await expect(page.getByRole('cell', { name: /Top left/ }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Loudness coverage' }).click();
  await expect(page.getByText(/Spread across the room/)).toBeVisible();
  await page.locator('.lcard', { hasText: 'Guests / party' }).click();
  await expect(page.getByText(/delay \d+\.\d ms/).first()).toBeVisible();
  // timing: arrival map, delay slider, slow-mo wavefronts; interference map + wave animation
  await page.getByRole('button', { name: 'Arrival & delay' }).click();
  await expect(page.getByText(/Sound still comes\s+from the front over 100 %/)).toBeVisible();
  await page.locator('#fdelay').fill('0');
  await expect(page.getByText(/front over (\d|[1-8]\d) %/)).toBeVisible();
  await page.getByRole('button', { name: /Auto delay/ }).click();
  await page.getByRole('button', { name: /Play arrivals/ }).click();
  await expect(page.getByText(/t = \d+\.\d ms/)).toBeVisible();
  await page.getByRole('button', { name: 'Interference' }).click();
  await page.locator('.chip', { hasText: /^1k$/ }).click();
  await expect(page.getByText(/Deep dips/)).toBeVisible();
  await page.getByRole('button', { name: /Animate waves/ }).click();
  await page.getByRole('button', { name: /Pause/ }).click();
  // wall reflections in the interference map
  await page.getByRole('button', { name: '2nd bounce' }).click();
  await expect(page.getByText(/up to two bounces off the floor/)).toBeVisible();
  await page.getByRole('button', { name: 'Off', exact: true }).click();
  await expect(page.getByText(/walls switched off/)).toBeVisible();
  // per-speaker DSP: flipping the sub's polarity breaks the crossover sum, the finder fixes it
  await page.locator('.lcard', { hasText: 'Stereo + subwoofer' }).click();
  await expect(page.getByRole('heading', { name: /Delays, levels/ })).toBeVisible();
  await page.getByRole('button', { name: 'S1 polarity' }).click();
  await expect(page.getByText(/dB short of a perfect sum/)).toBeVisible();
  await page.getByRole('button', { name: /Find best sub delay/ }).click();
  await expect(page.getByText(/Subs: \d+\.\d ms/)).toBeVisible();
  await page.getByRole('button', { name: 'Reset S1' }).click();
  await expect(page.getByText('a perfect sum', { exact: true })).toBeVisible();

  // Speakers gallery: open the tower and the sub
  await nav.getByRole('button', { name: /Speakers/ }).click();
  await page.locator('.gcard', { hasText: 'Floor-standing tower' }).click();
  await expect(page.getByRole('heading', { name: 'Floor-standing tower' })).toBeVisible();
  await page.locator('.gcard', { hasText: '12″ sealed subwoofer' }).click();
  await expect(page.getByRole('heading', { name: 'Subwoofer driver' })).toBeVisible();

  // Parts: bill of materials with Parts Express part numbers, and the kit path
  await nav.getByRole('button', { name: /Parts/ }).click();
  await expect(page.getByText('#295-445').first()).toBeVisible();
  await expect(page.locator('.total').first()).toContainText('$');
  await page.getByRole('button', { name: /Kit path/ }).click();
  await expect(page.getByText(/C-Note MT Bookshelf Kit Pair/)).toBeVisible();

  // Outdoor venue: cardioid subs, delay towers, maps
  await nav.getByRole('button', { name: /Room/ }).click();
  await page.getByRole('button', { name: /Outdoor/ }).first().click();
  await expect(page.getByRole('heading', { name: /Clearing/ })).toBeVisible();
  await expect(page.getByText(/Crowd spread \d+\.\d dB/)).toBeVisible();
  await page.getByRole('button', { name: 'Bass evenness' }).click();
  await expect(page.getByText(/behind the stage\s+[\d.]+ dB\s+quieter/)).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'End-fire' }).click();
  await expect(page.getByText(/Rank 4/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Arrival & delay' }).click();
  await expect(page.getByText(/% of the crowd area is fine/)).toBeVisible();
  await expect(page.getByRole('cell', { name: /T1/ })).toBeVisible();
  await page.getByRole('button', { name: /Living room/ }).first().click();
  await expect(page.getByText('Furniture & zones')).toBeVisible();

  // Print tab: reachable from the Build tab's picker; hybrid printed + wood cabinets
  await nav.getByRole('button', { name: /Build/ }).click();
  await page.getByLabel('Design to build').selectOption('print:sub');
  await expect(page.getByRole('heading', { name: 'Printed horn sub' })).toBeVisible();
  await expect(page.getByText(/Horn path length/)).toBeVisible();
  await page.getByRole('button', { name: 'Print layout' }).click();
  await expect(page.locator('.stat', { hasText: 'Segments' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Plywood strips (per cabinet)' })).toBeVisible();
  await page.getByRole('button', { name: 'Fully printed core' }).click();
  await expect(page.getByRole('heading', { name: 'Plywood strips (per cabinet)' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Printed bends + plywood walls' }).click();
  await page.getByRole('button', { name: 'Assembled' }).click();
  await page.getByLabel('Use this horn for the outdoor subs').check();
  await page.getByRole('button', { name: /Living-room speaker/ }).click();
  await expect(page.getByRole('heading', { name: 'Printed transmission line' })).toBeVisible();
  await page.getByRole('button', { name: 'Folded slot port' }).click();
  await expect(page.getByText(/Helmholtz tuning/)).toBeVisible();
  await page.getByLabel('Use this speaker as the living-room mains').check();
  await nav.getByRole('button', { name: /Room/ }).click();
  await page.getByRole('button', { name: /Outdoor/ }).first().click();
  await expect(page.getByText(/Your printed hybrid horn/)).toBeVisible();
  await page.getByRole('button', { name: /Living room/ }).first().click();
  await expect(page.getByText(/printed hybrid speaker/).first()).toBeVisible();

  // Learn + Lab round-trip
  await nav.getByRole('button', { name: /Learn/ }).click();
  await page.getByRole('button', { name: 'Acoustics Lab' }).first().click();
  await expect(page.locator('h1').first()).toContainText('Oasis-360', { timeout: 20_000 });
  await page.getByRole('button', { name: /Home Hi-Fi/ }).click();
  await expect(page.getByTestId('home-studio')).toBeVisible();

  expect(errors).toEqual([]);
});
