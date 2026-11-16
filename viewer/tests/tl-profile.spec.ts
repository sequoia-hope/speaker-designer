// Custom transmission-line cross-sections: each named shape (and a few odd
// hand-drawn ones) builds or is flagged, the legs follow the drawn shape, and
// the line simulation follows the area it is given. (Pure module, no browser.)
import { test, expect } from '@playwright/test';
import { PRINTED_DESIGNS, DEFAULT_PRINTER, TL_SHAPES, buildGeometry, buildIssues, planPrint, simulate, tlAreaAt } from '../src/home/hybrid';
import { findDriver } from '../src/home/drivers';

const tls = PRINTED_DESIGNS.filter((x) => x.params.type === 'tl');
const odd = [
  [1, 0.2, 2.5, 0.3, 2.8, 0.15],
  [3, 3, 3, 3, 3, 3],
  [0.15, 0.15, 0.15, 0.15, 0.15, 0.15],
];

test('every line shape builds or says why; the legs follow the shape', () => {
  expect(tls.length).toBeGreaterThan(0);
  for (const base of tls)
    for (const prof of [...TL_SHAPES.map((s) => s.pts), ...odd]) {
      const p = { ...base.params, tlProfile: prof };
      const d = findDriver(p.driverId)!;
      const g = buildGeometry(p, d);
      const label = `${base.id} ${prof.join('/')}`;
      if (!g.fits) {
        expect(g.warnings.length, label).toBeGreaterThan(0);
        continue;
      }
      const plan = planPrint(g, DEFAULT_PRINTER);
      expect(buildIssues(p, g, d, plan, DEFAULT_PRINTER, false).filter((i) => i.level === 'bad'), label).toEqual([]);
      // leg areas (sampled at each leg's middle along the path) keep the drawn ratios — except
      // leg 1, which never gets narrower than the driver needs
      const N = p.legs % 2 === 0 ? p.legs : p.legs + 1;
      const L = g.path.s[g.path.s.length - 1];
      const at = (x: number) => {
        const s = x * L;
        const i = Math.max(1, g.path.s.findIndex((v) => v >= s));
        const f = (s - g.path.s[i - 1]) / Math.max(1e-9, g.path.s[i] - g.path.s[i - 1]);
        return g.path.area[i - 1] + (g.path.area[i] - g.path.area[i - 1]) * f;
      };
      const legMid = Array.from({ length: N }, (_, i) => tlAreaAt(p, (i + 0.5) / N));
      // the last leg vs the second: the same ratio the shape asks for (±25 %: bends and the path's legs aren't equal length)
      const want = legMid[N - 1] / legMid[1];
      const got = at(1 - 0.25 / N) / at(1.5 / N);
      expect(got / want, label).toBeGreaterThan(0.75);
      expect(got / want, label).toBeLessThan(1.33);
      const r = simulate(p, d, g, { coupled: 1, floor: false, f0: 20, f1: 400, n: 80 });
      expect(r.spl.every(Number.isFinite), label).toBe(true);
    }
});

test('the simple taper is the two-point profile', () => {
  for (const taper of [0.3, 1, 2])
    for (const x of [0, 0.3, 1]) expect(tlAreaAt({ taper, tlProfile: null }, x)).toBeCloseTo(tlAreaAt({ taper: 1, tlProfile: [1, taper] }, x), 9);
});

test('a constricted terminus tunes the line lower than a straight one of the same length', () => {
  const base = tls[0].params;
  const d = findDriver(base.driverId)!;
  const lowest = (prof: number[]) => {
    const p = { ...base, tlProfile: prof, stuffing: [] };
    const g = buildGeometry(p, d);
    const r = simulate(p, d, g, { coupled: 1, floor: false, f0: 15, f1: 300, n: 400 });
    // first peak of the line's output (the mouth), i.e. its fundamental
    const m = r.mouthSpl ?? r.spl;
    for (let i = 2; i < m.length - 1; i++) if (m[i] > m[i - 1] && m[i] >= m[i + 1] && r.freqs[i] > 20) return r.freqs[i];
    return NaN;
  };
  const straight = lowest(TL_SHAPES.find((s) => s.id === 'straight')!.pts);
  const constricted = lowest(TL_SHAPES.find((s) => s.id === 'mass-loaded')!.pts);
  expect(constricted).toBeLessThan(straight);
});
