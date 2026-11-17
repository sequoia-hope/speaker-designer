// Reference checks for the alignment choices, driver guidance, placement, crossover-matched
// waveguides and curved shells; plus the comparison and save/load flows in the app.
import { test, expect } from '@playwright/test';
import { ventedAlignment } from '../src/home/speakerBuild';
import { driverGuidance, runModel } from '../src/home/boxModel';
import { DRIVERS, findDriver } from '../src/home/drivers';
import { boxResponse, toDb } from '../src/home/roomAcoustics';
import { PRINTED_DESIGNS, DEFAULT_PRINTER, buildGeometry, buildIssues, planPrint, roundWaveguide, waveguideIssues } from '../src/home/hybrid';

const responseOf = (d: (typeof DRIVERS)[0], vbL: number, fbHz: number) => {
  const al = { kind: 'vented' as const, fsHz: d.fsHz, fbHz, qts: d.qts, alpha: d.vasL / vbL, ql: 7 };
  let f3 = 0;
  let peak = -99;
  for (let i = 0; i < 300; i++) {
    const f = 8 * Math.pow(50, i / 299);
    const db = toDb(boxResponse(al, f));
    peak = Math.max(peak, db);
    if (!f3 && db >= -3) f3 = f;
  }
  return { f3, peak };
};

test('vented alignments ladder: compact (QB3) → flat (≤0.1 dB) → extended (≤1 dB): bigger box, lower F3', () => {
  for (const d of DRIVERS.filter((x) => x.role === 'woofer')) {
    const c = ventedAlignment(d, 'compact');
    const f = ventedAlignment(d, 'flat');
    const e = ventedAlignment(d, 'deep');
    const rc = responseOf(d, c.vbL, c.fbHz);
    const rf = responseOf(d, f.vbL, f.fbHz);
    const re = responseOf(d, e.vbL, e.fbHz);
    expect(rf.peak, d.model).toBeLessThanOrEqual(0.15);
    expect(re.peak, d.model).toBeLessThanOrEqual(1.05);
    expect(rf.f3, d.model).toBeLessThanOrEqual(rc.f3 + 0.5);
    expect(re.f3, d.model).toBeLessThanOrEqual(rf.f3 + 0.5);
    expect(f.vbL).toBeLessThanOrEqual(1.5 * c.vbL + 1e-6);
    expect(e.vbL).toBeLessThanOrEqual(2 * c.vbL + 1e-6);
  }
});

test('driver guidance: EBP verdicts follow the 50 / 90 rule', () => {
  for (const d of DRIVERS.filter((x) => x.role !== 'tweeter')) {
    const g = driverGuidance(d);
    expect(g.ebp).toBeCloseTo(d.fsHz / (d.qes ?? (d.qts * 5) / (5 - d.qts)), 0);
    expect(g.verdict).toBe(g.ebp < 50 ? 'sealed' : g.ebp > 90 ? 'ported' : 'either');
    expect(g.blTm).toBeGreaterThan(0);
  }
});

test('placement: on a stand the box loses ~6 dB of bass vs the big-baffle (datasheet) level', () => {
  const d = findDriver('sb17nrx2c35-8')!;
  const base = { driver: d, count: 1, box: { kind: 'sealed' as const, netL: 15 }, powerW: 1, f0: 40, f1: 8000, n: 120 };
  const half = runModel(base);
  const free = runModel({ ...base, placement: 'free', baffle: { widthMm: 220, heightMm: 360, driverYmm: 220 } });
  const at = (r: typeof half, f: number) => r.spl283[r.freqs.findIndex((x) => x >= f)];
  expect(at(half, 120) - at(free, 120)).toBeGreaterThan(4);
  expect(Math.abs(at(half, 5000) - at(free, 5000))).toBeLessThan(2);
});

test('waveguides matched to a crossover control the tweeter down to 0.8 × it', () => {
  for (const tw of DRIVERS.filter((x) => x.role === 'tweeter'))
    for (const xo of [1500, 2000, 3000]) {
      const wg = roundWaveguide(tw, 90, 4, xo);
      expect(waveguideIssues(wg, tw)).toEqual([]);
      expect(wg.controlHz, `${tw.model} @ ${xo}`).toBeLessThanOrEqual(0.8 * xo + 1);
    }
});

test('curved shell: buildable, prints on the bed, and its edge diffraction is far below a box’s', () => {
  const p = PRINTED_DESIGNS.find((x) => x.id === 'egg')!.params;
  const d = findDriver(p.driverId)!;
  const g = buildGeometry(p, d);
  expect(g.fits, g.warnings.join(' | ')).toBe(true);
  const plan = planPrint(g, DEFAULT_PRINTER);
  expect(buildIssues(p, g, d, plan, DEFAULT_PRINTER, false).filter((i) => i.level === 'bad')).toEqual([]);
  const st = g.stats.find((s) => s.label === 'Edge diffraction ripple')!.value;
  const [curved, boxy] = [...st.matchAll(/≈ ([\d.]+) dB/g)].map((m) => +m[1]);
  expect(curved).toBeLessThan(boxy / 3);
});

test('app: pin a printed TL, see it in the plywood box modeler; save and load a design', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const nav = page.getByRole('navigation', { name: 'Home Hi-Fi sections' });
  await nav.getByRole('button', { name: /Speaker/ }).click();
  await page.locator('.gcard', { hasText: 'Printed mini transmission line' }).click();
  await page.getByTestId('pin-printed').click();
  // back to a plywood monitor: the TL shows in its comparison table
  await page.locator('.gcard', { hasText: 'Stand-mount monitor' }).first().click();
  await expect(page.getByTestId('compare-table')).toContainText('Printed mini transmission line');
  // save, change, load back
  await page.getByLabel('Name for the saved design').fill('My monitor');
  await page.getByTestId('saved-designs').getByRole('button', { name: /Save/ }).click();
  await page.getByRole('button', { name: 'Vented (ported)', exact: true }).click();
  await page.getByRole('button', { name: 'Load My monitor' }).click();
  await expect(page.getByRole('button', { name: 'Sealed', exact: true })).toHaveClass(/on/);
  expect(errors).toEqual([]);
});

test('app: custom TL cross-section, print estimate, STEP / .waffle downloads, horn sub in the room', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const nav = page.getByRole('navigation', { name: 'Home Hi-Fi sections' });
  await nav.getByRole('button', { name: /Speaker/ }).click();
  await page.locator('.gcard', { hasText: 'Printed mini transmission line' }).click();
  await page.getByTestId('tl-custom').click();
  await expect(page.getByTestId('tl-profile')).toBeVisible();
  // a constricted line needs more height than this cabinet: flagged, and "Make it fit" fixes it
  await page.getByTestId('tl-profile').getByRole('button', { name: 'Constricted end' }).click();
  await expect(page.getByTestId('tl-profile').getByRole('button', { name: 'Constricted end' })).toHaveClass(/on/);
  await page.getByRole('button', { name: /Make it fit/ }).first().click();
  await expect(page.getByText("Can't be built as drawn")).toHaveCount(0, { timeout: 15000 });
  await page.getByTestId('tl-profile').getByRole('button', { name: 'Tapered 3:1' }).click();
  // the build view: estimate and CAD files
  await nav.getByRole('button', { name: /Build/ }).click();
  await expect(page.getByTestId('print-estimate')).toContainText('kg');
  const [step] = await Promise.all([page.waitForEvent('download'), page.getByTestId('cad-step').click()]);
  const stepText = await (await import('node:fs')).promises.readFile((await step.path())!, 'utf8');
  expect(stepText.startsWith('ISO-10303-21;')).toBe(true);
  expect(stepText).toContain('MANIFOLD_SOLID_BREP');
  const [wf] = await Promise.all([page.waitForEvent('download'), page.getByTestId('cad-waffle').click()]);
  const doc = JSON.parse(await (await import('node:fs')).promises.readFile((await wf.path())!, 'utf8'));
  expect(doc.format).toBe('waffle-iron');
  expect(doc.tabs[0].kind.features.features.length).toBeGreaterThan(4);
  // a plywood design's panels too
  await nav.getByRole('button', { name: /Speaker/ }).click();
  await page.locator('.gcard', { hasText: 'Stand-mount monitor' }).first().click();
  await nav.getByRole('button', { name: /Build/ }).click();
  const [ply] = await Promise.all([page.waitForEvent('download'), page.getByTestId('ply-step').click()]);
  expect(ply.suggestedFilename()).toMatch(/\.step$/);
  // the tapped horn as the room's sub
  await nav.getByRole('button', { name: /Room/ }).click();
  const kinds = page.getByTestId('room-sub-kind');
  if (!(await kinds.isVisible())) await page.getByRole('button', { name: '1 sub', exact: true }).click();
  await kinds.getByRole('button', { name: 'Printed tapped-horn subwoofer' }).click();
  await expect(page.getByTestId('room-sub-note')).toContainText('−3 dB at');
  expect(errors).toEqual([]);
});

test('app: PR setting survives a reload, sheet layout + nested DXF, assembled STEP, dispersion, room EQ export', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const fs = await import('node:fs');
  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const nav = page.getByRole('navigation', { name: 'Home Hi-Fi sections' });
  // a passive-radiator box in the modeler is remembered
  await nav.getByRole('button', { name: /Speaker/ }).click();
  await page.locator('.gcard', { hasText: 'Stand-mount monitor' }).first().click();
  const modeler = page.getByTestId('box-modeler');
  await modeler.getByRole('button', { name: 'Passive radiator', exact: true }).click();
  await expect(page.getByTestId('pr-controls')).toBeVisible();
  await page.waitForTimeout(600);
  await page.reload();
  await nav.getByRole('button', { name: /Speaker/ }).click();
  await expect(page.getByTestId('pr-controls')).toBeVisible();
  // the plywood build: sheets, cut list, nested DXF, assembled STEP
  await nav.getByRole('button', { name: /Build/ }).click();
  await expect(page.getByTestId('sheet-layout')).toBeVisible();
  const [dxf] = await Promise.all([page.waitForEvent('download'), page.getByTestId('nest-dxf').click()]);
  const dxfText = await fs.promises.readFile((await dxf.path())!, 'utf8');
  for (const layer of ['SHEET', 'CUT_OUTSIDE', 'CUT_INSIDE']) expect(dxfText).toContain(layer);
  const [csv] = await Promise.all([page.waitForEvent('download'), page.getByTestId('nest-csv').click()]);
  expect(csv.suggestedFilename()).toMatch(/\.csv$/);
  await page.getByTestId('ply-cad-how').getByRole('radio', { name: 'Assembled' }).click();
  const [ply] = await Promise.all([page.waitForEvent('download'), page.getByTestId('ply-step').click()]);
  expect(await fs.promises.readFile((await ply.path())!, 'utf8')).toContain('MANIFOLD_SOLID_BREP');
  // a printed design with a tweeter: dispersion card, exploded .waffle
  await nav.getByRole('button', { name: /Speaker/ }).click();
  await page.locator('.gcard', { hasText: 'Printed mini transmission line' }).click();
  const di = page.getByTestId('di-verdict');
  await expect(di).toContainText(/kHz/);
  // following its suggestion (only coverages that fit the cabinet are offered) keeps the design buildable
  const use = di.getByRole('button', { name: /^Use \d+°/ });
  if (await use.count()) await use.click();
  await expect(page.getByText("Can't be built as drawn")).toHaveCount(0);
  await nav.getByRole('button', { name: /Build/ }).click();
  await page.getByTestId('cad-how').getByRole('radio', { name: 'Exploded' }).click();
  const [wf] = await Promise.all([page.waitForEvent('download'), page.getByTestId('cad-waffle').click()]);
  expect(JSON.parse(await fs.promises.readFile((await wf.path())!, 'utf8')).format).toBe('waffle-iron');
  // room-mode EQ: cuts only, exported as Equalizer APO text
  await nav.getByRole('button', { name: /Room/ }).click();
  const eq = page.getByTestId('room-eq');
  await eq.getByText('Suggest room-mode EQ').click();
  const [apo] = await Promise.all([page.waitForEvent('download'), page.getByTestId('room-eq-export').click()]);
  const apoText = await fs.promises.readFile((await apo.path())!, 'utf8');
  expect(apoText).toMatch(/Filter 1: ON PK Fc [\d.]+ Hz Gain -[\d.]+ dB Q [\d.]+/);
  expect(errors).toEqual([]);
});
