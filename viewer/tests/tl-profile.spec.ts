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
      const L = g.path.s[g.path.s.length - 1];
      const at = (s: number) => {
        const i = Math.max(1, g.path.s.findIndex((v) => v >= s));
        const f = (s - g.path.s[i - 1]) / Math.max(1e-9, g.path.s[i] - g.path.s[i - 1]);
        return g.path.area[i - 1] + (g.path.area[i] - g.path.area[i - 1]) * f;
      };
      // no staircase: the area never jumps from one path node to the next (past the first
      // fold — leg 1 is held at the driver's size and blends into the line round that fold)
      const after1 = g.path.s.findIndex((v, i) => v > g.foldS![0] && !g.path.bend?.[i]);
      for (let i = after1 + 1; i < g.path.s.length; i++) expect(Math.abs(g.path.area[i] / g.path.area[i - 1] - 1), `${label} node ${i}`).toBeLessThan(0.2);
      // the area tracks the drawn shape continuously: sampled at many points along every
      // straight run (bends excluded), area / drawn value is the same scale everywhere —
      // except the first leg, which never gets narrower than the driver needs
      if (!odd.includes(prof)) {
        const straight = (s: number) => {
          const i = Math.max(1, g.path.s.findIndex((v) => v >= s));
          return !g.path.bend?.[i] && !g.path.bend?.[i - 1];
        };
        const ratios: number[] = [];
        for (let k = 0; k <= 200; k++) {
          const s = (k / 200) * L;
          if (s <= g.foldS![0] || !straight(s)) continue;
          ratios.push(at(s) / tlAreaAt(p, s / L));
        }
        expect(ratios.length, label).toBeGreaterThan(80);
        const mid = [...ratios].sort((a, b) => a - b)[ratios.length >> 1];
        for (const r of ratios) {
          expect(r / mid, label).toBeGreaterThan(0.88);
          expect(r / mid, label).toBeLessThan(1.13);
        }
      }
      // the walls between legs slope with the shape: in a taper the line's last leg is
      // narrower at its terminus end than where it starts
      if (prof === TL_SHAPES.find((sh) => sh.id === 'taper')!.pts) expect(g.path.area[g.path.area.length - 1]).toBeLessThan(at(g.foldS![g.foldS!.length - 1]) * 0.97);
      const r = simulate(p, d, g, { coupled: 1, floor: false, f0: 20, f1: 400, n: 80 });
      expect(r.spl.every(Number.isFinite), label).toBe(true);
    }
});

test('the simple taper is smooth too: sloped walls, plates and strips to match', () => {
  for (const base of tls) {
    const p = { ...base.params, tlProfile: null, taper: 0.35 };
    const d = findDriver(p.driverId)!;
    const g = buildGeometry(p, d);
    expect(g.fits, g.warnings.join('; ')).toBe(true);
    const L = g.path.s[g.path.s.length - 1];
    // past the first leg, area / (1 + (taper − 1)·x) is constant (±12 %) along the straight runs
    const rs = g.path.s
      .map((s, i) => ({ s, i }))
      .filter(({ s, i }) => i > 0 && s > g.foldS![0] && !g.path.bend?.[i] && !g.path.bend?.[i - 1])
      .map(({ s, i }) => g.path.area[i] / tlAreaAt(p, s / L));
    const mid = [...rs].sort((a, b) => a - b)[rs.length >> 1];
    for (const r of rs) expect(Math.abs(r / mid - 1)).toBeLessThan(0.12);
    // printed bends + plywood walls: the fold walls become sloped strips, as long as their slope
    const q = { ...p, construction: 'bends' as const };
    const gb = buildGeometry(q, d);
    if (gb.construction === 'bends') {
      const folds = gb.strips.filter((st) => /Fold wall/.test(st.name));
      expect(folds.length).toBeGreaterThan(0);
      expect(folds.some((st) => st.line)).toBe(true);
      for (const st of folds)
        if (st.line) expect(st.lengthMm).toBeCloseTo(Math.hypot(st.line.x1 - st.line.x0, st.line.y1 - st.line.y0), 6);
    }
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
