// Two windows of the app share localStorage. They must never ping-pong saves
// (even with a peer that normalises the state differently, like a stale tab
// running an older build), and each window keeps showing its own speaker.
import { test, expect, type Page } from '@playwright/test';

const KEY = 'speaker-designer.home.v4';
const speakers = (p: Page) => p.getByRole('navigation', { name: 'Home Hi-Fi sections' }).getByRole('button', { name: /Speaker/ });

test('two windows: no save ping-pong, independent selections, shared edits', async ({ context }) => {
  await context.addInitScript(() => {
    (window as any).__writes = 0;
    const si = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k: string, v: string) {
      if (k.includes('home') && this.getItem(k) !== v) (window as any).__writes++;
      return si.call(this, k, v);
    };
  });
  const A = await context.newPage();
  await A.goto('./');
  await A.evaluate(() => localStorage.clear());
  await A.reload();
  await speakers(A).click();
  await A.locator('.gcard', { hasText: 'Printed sealed monitor' }).click();

  const B = await context.newPage();
  await B.goto('./');
  await speakers(B).click();
  await B.locator('.gcard', { hasText: 'Printed slot-port monitor' }).click();
  await B.waitForTimeout(1500);

  // each window still shows what it picked
  await expect(A.getByRole('heading', { name: 'Printed sealed monitor' })).toBeVisible();
  await expect(B.getByRole('heading', { name: 'Printed slot-port monitor' })).toBeVisible();

  // a peer that rewrites every save in its own format (an old build would add/drop fields)
  const C = await context.newPage();
  await C.goto('about:blank');
  await C.goto(A.url());
  await C.evaluate((key) => {
    window.addEventListener('storage', (e) => {
      if (e.key !== key || !e.newValue) return;
      const s = JSON.parse(e.newValue);
      s.hybrid = { ...s.hybrid, living: { legacy: true }, edit: 'living' };
      localStorage.setItem(key, JSON.stringify(s));
    });
  }, KEY);
  // an edit in A reaches B…
  await A.getByLabel('Height').fill('360');
  await expect(B.locator('.gcard', { hasText: 'Printed sealed monitor' })).toBeVisible();
  await B.locator('.gcard', { hasText: 'Printed sealed monitor' }).click();
  await expect(B.locator('.dimline').first()).toContainText('360 mm H');
  // …and then everything settles: no endless rewriting
  const before = await Promise.all([A, B].map((p) => p.evaluate(() => (window as any).__writes)));
  await A.waitForTimeout(2000);
  const after = await Promise.all([A, B].map((p) => p.evaluate(() => (window as any).__writes)));
  expect(after).toEqual(before);
});
