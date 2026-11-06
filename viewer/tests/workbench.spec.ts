import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const SCRATCH_DIR = process.env.SCRATCH_SHOT_DIR || path.join(os.tmpdir(), 'speaker-designer-shots');

test('3D Acoustic, Solid CAD, Design Encyclopedia & Live Rust WASM Parametric Lab work without errors', async ({
  page,
}) => {
  fs.mkdirSync(SCRATCH_DIR, { recursive: true });

  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.push(`console.error: ${msg.text()}`);
    }
  });

  await page.goto('/#lab');

  // 1. Default Oasis-360 Outdoor EDM Sound System + all 10 flagship designs in sidebar
  await expect(page.locator('h1')).toContainText('Oasis-360');
  await expect(page.locator('.sim-item')).toHaveCount(10);
  await expect(page.locator('canvas').first()).toBeVisible();
  await expect(page.getByText('12×12 m Dancefloor Sweet Spot')).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SCRATCH_DIR, '01_oasis360_venue.png') });

  // Inspect Synergy-3P 3-Way Synergy Horn CAD inside Oasis-360
  await page.getByRole('button', { name: /3D Cabinet CAD & Section Cut/ }).click();
  await page.getByRole('button', { name: /Cabinet CAD, Thickness & BOM/ }).click();
  const cabSelect = page.locator('select.cab-select');
  await expect(cabSelect).toBeVisible();
  await cabSelect.selectOption({ index: 1 }); // Synergy-3P
  await expect(page.locator('.cad-header-card h3')).toContainText('Synergy-3P');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SCRATCH_DIR, '06_synergy3p_cad_section.png') });

  // 2. TerraHorn-18 Coupled Subwoofer: 3D Solid Section Cut + 2D Millimeter Blueprints & BOM
  await page.locator('.sim-item', { hasText: /TerraHorn-18/ }).click();
  await expect(page.locator('h1')).toContainText('TerraHorn-18');
  await page.getByRole('button', { name: /3D Cabinet CAD & Section Cut/ }).click();
  await page.getByRole('button', { name: /Cabinet CAD, Thickness & BOM/ }).click();
  await expect(page.getByText('2D Orthographic CAD Cross-Sections')).toBeVisible();
  await expect(page.getByText('Bill of Materials & CNC Panel Cutlist')).toBeVisible();
  await expect(page.getByText('13-Ply Void-Free Baltic Birch').first()).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SCRATCH_DIR, '07_terrahorn18_cad_blueprints.png') });

  // 3. Studio Monitor Aether-83M: 22mm HDF-760 + 28mm CNC 6061-T6 Billet Aluminum OS-SE Baffle
  await page.locator('.sim-item', { hasText: /Aether-83M/ }).click();
  await expect(page.locator('h1')).toContainText('Aether-83M');
  await page.getByRole('button', { name: /Side Cut X/ }).click();
  await expect(page.getByText('CNC 6061-T6 Billet Aluminum').first()).toBeVisible();
  await page.getByRole('button', { name: 'Uncut Solid' }).click();
  const explodeSlider = page.getByLabel('Explode CAD Assembly');
  await explodeSlider.fill('0.62');
  await explodeSlider.dispatchEvent('input');
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(SCRATCH_DIR, '10_aether83m_exploded_coloration.png') });
  await explodeSlider.fill('0');
  await explodeSlider.dispatchEvent('input');

  // 4. NEW DESIGN #07: Keystone-18TH Tapped Bass Horn (3D Solid Tap-Junction CAD + 2D Blueprints)
  await page.locator('.sim-item', { hasText: /Keystone-18TH/ }).click();
  await expect(page.locator('h1')).toContainText('Keystone-18TH');
  await page.getByRole('button', { name: 'Side Cut X' }).click();
  await page.getByRole('button', { name: /Cabinet CAD, Thickness & BOM/ }).click();
  await expect(page.getByText('Phenolic-Film Marine Baltic Birch').first()).toBeVisible();
  await page.waitForTimeout(450);
  await page.screenshot({ path: path.join(SCRATCH_DIR, '12_keystone18th_tapped_horn_cad.png') });

  // 5. NEW DESIGN #08: IsoPulse-212 Force-Canceling Dual-12" Linkwitz-Transform Studio Sub
  await page.locator('.sim-item', { hasText: /IsoPulse-212/ }).click();
  await expect(page.locator('h1')).toContainText('IsoPulse-212');
  await expect(page.getByText('CNC 6061-T6 Billet Aluminum').first()).toBeVisible();
  await page.waitForTimeout(450);
  await page.screenshot({ path: path.join(SCRATCH_DIR, '13_isopulse212_linkwitz_cad.png') });

  // 6. NEW DESIGN ENCYCLOPEDIA / DATABASE (`📚 Design Guide`)
  await page.getByRole('button', { name: /Design Guide/ }).click();
  await expect(page.locator('.dossier-hdr h3')).toContainText('IsoPulse-212');
  await expect(
    page.locator('.dossier-card').getByText('Back-to-back Newtonian force cancellation')
  ).toBeVisible();
  await page.getByRole('button', { name: /Topologies & Arrays/ }).click();
  await expect(page.getByText('Tapped Bass Horn (λ/2 Dual-Side Loading)')).toBeVisible();
  await expect(page.getByText('End-Fire Progressive Delay Line (4-Deep)')).toBeVisible();
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(SCRATCH_DIR, '14_design_guide_encyclopedia.png') });

  // Jump into Outdoor Bass Array Shootout (#10) directly from the Topology Reference chip!
  await page.getByRole('button', { name: /End-Fire vs CSA/ }).first().click();
  await expect(page.locator('h1')).toContainText('Outdoor Bass Array Shootout');

  // 7. NEW DESIGN #09 + LIVE IN-BROWSER RUST WASM PARAMETRIC LAB (`🎛 Parametric Lab`)
  await page.locator('.sim-item', { hasText: /Chronos-MTM/ }).click();
  await expect(page.locator('h1')).toContainText('Chronos-MTM');
  await page.locator('button.tab-param-btn').click();
  await expect(page.locator('.wasm-badge')).toContainText('Rust WASM Ready', { timeout: 15000 });

  // Modify Wall Thickness to 32 mm & Enclosure Material to Valchromat HDF -> live WASM re-simulation!
  const wallSlider = page.locator('#sl-wall-t');
  await wallSlider.fill('32');
  await wallSlider.dispatchEvent('input');
  await page.locator('#sel-enc-mat').selectOption('valchromat_hdf');

  await expect(page.locator('.v-btn', { hasText: /Live Parametric/ })).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByRole('button', { name: /Export \.toml/ })).toBeVisible();
  await page.waitForTimeout(450);
  await page.screenshot({ path: path.join(SCRATCH_DIR, '15_parametric_lab_live_wasm.png') });

  // Confirm 3D/2D Cabinet CAD & Structural summary updated to Valchromat HDF-840 & 32 mm wall
  await page.getByRole('button', { name: /Inspect Updated 2D Blueprints/ }).click();
  await expect(page.getByText('Valchromat Structural Acoustic HDF-840').first()).toBeVisible();

  // Return to Parametric Lab and Reset to Factory cleanly
  await page.locator('button.tab-param-btn').click();
  await page.getByRole('button', { name: /Reset to Factory/ }).click();
  await expect(page.locator('.v-btn', { hasText: /Live Parametric/ })).toHaveCount(0);

  // 8. Prototype #1 Bayesian Measurement Calibration
  await page.locator('.sim-item', { hasText: /Prototype #1 Calibration/ }).click();
  await expect(page.locator('h1')).toContainText('Prototype #1 Calibration');
  await expect(page.getByText('Posterior Physical Parameters')).toBeVisible();

  expect(errors).toEqual([]);
});

test('iPhone 16 Pro Max (440×956 portrait & 956×440 landscape) mobile UX, Guide, WASM Tune & zero overflow', async ({
  browser,
}) => {
  fs.mkdirSync(SCRATCH_DIR, { recursive: true });

  const context = await browser.newContext({
    viewport: { width: 440, height: 956 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  });
  const page = await context.newPage();

  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.push(`console.error: ${msg.text()}`);
    }
  });

  const assertNoHorizontalOverflow = async (stepLabel: string) => {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    );
    expect(overflow, `Horizontal overflow at ${stepLabel}`).toBeLessThanOrEqual(1);
  };

  await page.goto('/#lab');
  await expect(page.locator('h1')).toContainText('Oasis-360');
  await expect(page.locator('nav.mobile-bottom-nav')).toBeVisible();
  await page.waitForTimeout(400);
  await assertNoHorizontalOverflow('Oasis-360 3D Stage');
  await page.screenshot({ path: path.join(SCRATCH_DIR, 'mobile_01_oasis360_stage.png') });

  // Open slide-over Designs drawer -> verify 10 designs
  await page.getByRole('button', { name: 'Open simulation designs menu' }).tap();
  await expect(page.locator('aside.sidebar.open')).toBeVisible();
  await expect(page.locator('.sim-item')).toHaveCount(10);

  // Select Keystone-18TH -> switch bottom bar to 3D CAD
  await page.locator('.sim-item', { hasText: /Keystone-18TH/ }).tap();
  await expect(page.locator('h1')).toContainText('Keystone-18TH');
  await page.locator('nav.mobile-bottom-nav button', { hasText: '3D CAD' }).tap();
  await expect(page.getByRole('button', { name: 'Side Cut X' })).toBeVisible();
  await page.waitForTimeout(400);
  await assertNoHorizontalOverflow('Keystone-18TH 3D CAD');

  // Switch bottom bar to Guide (`📚`) -> inspect Design Encyclopedia on mobile
  await page.locator('nav.mobile-bottom-nav button', { hasText: 'Guide' }).tap();
  await expect(page.locator('.dossier-hdr h3')).toContainText('Keystone-18TH');
  await page.waitForTimeout(300);
  await assertNoHorizontalOverflow('Mobile Design Guide Dossier');
  await page.screenshot({ path: path.join(SCRATCH_DIR, 'mobile_08_design_guide.png') });

  // Switch bottom bar to Tune (`🎛`) -> execute live WASM parametric edit on mobile
  await page.locator('nav.mobile-bottom-nav button', { hasText: 'Tune' }).tap();
  await expect(page.locator('.wasm-badge')).toContainText('Rust WASM Ready', { timeout: 15000 });
  const hornLenSlider = page.locator('#sl-horn-len');
  await hornLenSlider.fill('1.16');
  await hornLenSlider.dispatchEvent('input');
  await expect(page.locator('.v-btn', { hasText: /Live Parametric/ })).toBeVisible({
    timeout: 15000,
  });
  await page.waitForTimeout(350);
  await assertNoHorizontalOverflow('Mobile Parametric WASM Tune');
  await page.screenshot({ path: path.join(SCRATCH_DIR, 'mobile_09_parametric_tune.png') });

  // Switch bottom bar to Blueprints -> touch Part Inspector Callout Strip
  await page.locator('nav.mobile-bottom-nav button', { hasText: 'Blueprints' }).tap();
  await expect(page.getByText('2D Orthographic CAD Cross-Sections')).toBeVisible();
  await page.locator('.bp-svg polygon').nth(2).dispatchEvent('pointerdown', { pointerType: 'touch' });
  await expect(page.locator('.bp-inspect-bar')).toBeVisible();
  await assertNoHorizontalOverflow('Keystone-18TH 2D Blueprints');

  // Switch bottom bar to Plots -> touch-scrub LineChart
  await page.locator('nav.mobile-bottom-nav button', { hasText: 'Plots' }).tap();
  const firstChart = page.locator('svg.chart-svg').first();
  await expect(firstChart).toBeVisible();
  const box = await firstChart.boundingBox();
  if (box) {
    await page.touchscreen.tap(box.x + box.width * 0.55, box.y + box.height * 0.5);
  }
  await page.waitForTimeout(250);
  await assertNoHorizontalOverflow('Keystone-18TH Plots Touch Scrub');

  // Rotate to iPhone 16 Pro Max Landscape (956 × 440) and inspect 3D CAD
  await page.setViewportSize({ width: 956, height: 440 });
  await page.locator('nav.mobile-bottom-nav button', { hasText: '3D CAD' }).tap();
  await page.waitForTimeout(400);
  await assertNoHorizontalOverflow('iPhone 16 Pro Max Landscape 3D CAD');
  await page.screenshot({ path: path.join(SCRATCH_DIR, 'mobile_07_landscape_cad.png') });

  await context.close();
  expect(errors).toEqual([]);
});
