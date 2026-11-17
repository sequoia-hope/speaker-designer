// Reference checks for the off-axis / directivity model (directivity.ts).
// Pure module, no browser.
import { test, expect } from '@playwright/test';
import {
  beamwidth6,
  diMatch,
  directivityIndex,
  logFreqs,
  pistonOf,
  polarMap,
  waveguideRadiator,
  type Radiator,
} from '../src/home/directivity';
import { roundWaveguide } from '../src/home/hybrid';
import { findDriver } from '../src/home/drivers';
import { SPEED_OF_SOUND } from '../src/home/roomAcoustics';

const TWEETERS = ['sb26stac-c000-4', 'nd25fa-4'].map((id) => findDriver(id)!);
const WOOFER = findDriver('rs180-8')!;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

test('bare piston: −6 dB beamwidth matches 2·J1(x)/x = ½ at x = 2.2152', () => {
  const a = 0.0125;
  const piston: Radiator = { kind: 'piston', radiusM: a };
  for (const ka of [3, 4, 6, 8, 12]) {
    const f = (ka * SPEED_OF_SOUND) / (2 * Math.PI * a);
    const expected = 2 * Math.asin(2.2152 / ka) * (180 / Math.PI);
    expect(beamwidth6(piston, f)).toBeCloseTo(expected, 0);
  }
  // below ka ≈ 2.2 it never falls 6 dB inside the hemisphere
  expect(beamwidth6(piston, (2 * SPEED_OF_SOUND) / (2 * Math.PI * a))).toBe(180);
});

test('on-axis level is 0 dB after normalisation, for pistons and waveguides', () => {
  const freqs = logFreqs(500, 20000, 24);
  const tw = TWEETERS[0];
  for (const r of [pistonOf(tw), pistonOf(WOOFER), waveguideRadiator(roundWaveguide(tw, 90, 4), tw)]) {
    const m = polarMap(r, freqs, [0, 15, 30, 45, 60, 90]);
    for (const v of m.db[0]) expect(Math.abs(v)).toBeLessThan(1e-9);
    // nothing off axis is wildly louder than on axis
    for (const row of m.db) for (const v of row) expect(v).toBeLessThan(3);
  }
});

test('piston DI: 3 dB (hemisphere) at low frequency and rising with frequency', () => {
  for (const d of [TWEETERS[0], WOOFER]) {
    const r = pistonOf(d);
    expect(directivityIndex(r, 20)).toBeCloseTo(10 * Math.log10(2), 1);
    const fs = logFreqs(200, 20000, 60);
    const di = fs.map((f) => directivityIndex(r, f));
    for (let i = 1; i < di.length; i++) expect(di[i]).toBeGreaterThan(di[i - 1] - 1e-9);
    expect(di[di.length - 1]).toBeGreaterThan(di[0] + 5);
  }
});

test('waveguide: beamwidth ≈ nominal coverage in its controlled band, wider below it', () => {
  for (const tw of TWEETERS) {
    for (const [cov, xo] of [[75, undefined], [90, undefined], [105, undefined], [90, 2000]] as const) {
      const wg = roundWaveguide(tw, cov, 4, xo);
      const r = waveguideRadiator(wg, tw);
      const band = logFreqs(2 * wg.controlHz, 10000, 16);
      const bw = median(band.map((f) => beamwidth6(r, f)));
      expect(bw, `${tw.model} ${cov}° guide${xo ? ` for ${xo} Hz` : ''}: median ${bw.toFixed(0)}°`).toBeGreaterThan(0.75 * cov);
      expect(bw).toBeLessThan(1.25 * cov);
      // below its control frequency the mouth is small against λ: it spreads much wider than nominal
      expect(beamwidth6(r, wg.controlHz / 2)).toBeGreaterThan(1.3 * cov);
    }
  }
});

test('narrower coverage gives higher DI; a guide raises DI over the bare dome at the crossover', () => {
  for (const tw of TWEETERS) {
    const band = logFreqs(4000, 10000, 12);
    const meanDi = (cov: number) => {
      const r = waveguideRadiator(roundWaveguide(tw, cov, 4), tw);
      return band.reduce((s, f) => s + directivityIndex(r, f), 0) / band.length;
    };
    const [d60, d90, d120] = [meanDi(60), meanDi(90), meanDi(120)];
    expect(d60).toBeGreaterThan(d90 + 1);
    expect(d90).toBeGreaterThan(d120 + 1);
    const wg = roundWaveguide(tw, 90, 4, 2000);
    expect(directivityIndex(waveguideRadiator(wg, tw), 2000)).toBeGreaterThan(directivityIndex(pistonOf(tw), 2000) + 2);
  }
});

test('DI match verdict: bare dome is wider than a 7″ woofer at 2 kHz and a guide is suggested', () => {
  const tw = TWEETERS[0];
  const bare = diMatch(WOOFER, tw, null, 2000);
  expect(bare.deltaDb).toBeLessThan(-1.5);
  expect(bare.ok).toBe(false);
  expect(bare.suggestCoverageDeg).not.toBeNull();
  expect(bare.verdict).toMatch(/try a waveguide with coverage \d+°/);
  const fix = diMatch(WOOFER, tw, roundWaveguide(tw, bare.suggestCoverageDeg!, 4, 2000), 2000, 4, 2000);
  expect(Math.abs(fix.deltaDb)).toBeLessThan(Math.abs(bare.deltaDb));
  expect(fix.ok).toBe(true);
  expect(fix.verdict).toMatch(/DI matches within [\d.]+ dB/);
});

test('a coverage that does not fit the cabinet is never suggested; the verdict says so', () => {
  const tw = TWEETERS[0];
  const bare = diMatch(WOOFER, tw, null, 2000);
  const best = bare.suggestCoverageDeg!;
  const blocked = diMatch(WOOFER, tw, null, 2000, 4, undefined, (c) => c !== best);
  expect(blocked.suggestCoverageDeg).not.toBe(best);
  const none = diMatch(WOOFER, tw, null, 2000, 4, undefined, () => false);
  expect(none.suggestCoverageDeg).toBeNull();
  expect(none.blockedCoverageDeg).toBe(best);
  expect(none.verdict).toMatch(/doesn't fit this cabinet/);
});
