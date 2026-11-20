// Every design × driver × option combination must be physically buildable:
// no part inside the box collides with another, ports clear the walls by one
// diameter, nothing sits in a tower's sand space. (Pure planner, no browser.)
import { test, expect } from '@playwright/test';
import { DESIGNS } from '../src/home/designs';
import { planFor } from '../src/home/planning';
import { PRINTED_DESIGNS, HYBRID_PRESETS, DEFAULT_PRINTER, buildGeometry, buildIssues, planPrint, roundWaveguide, waveguideIssues, isAir, pointInPoly } from '../src/home/hybrid';
import { DRIVERS, findDriver } from '../src/home/drivers';
import { isSubArrangement } from '../src/home/speakerBuild';

test('every planner design is physically buildable', () => {
  const failures: string[] = [];
  let n = 0;
  for (const d of DESIGNS) {
    const isSub = isSubArrangement(d.settings.arrangement);
    const woofers = DRIVERS.filter((x) => x.role === (isSub ? 'sub' : 'woofer'));
    for (const w of woofers)
      for (const boxType of ['sealed', 'vented'] as const)
        for (const portSide of ['front', 'rear'] as const)
          for (const aspect of ['bookshelf', 'tall', 'cube'] as const)
            for (const volumeScale of [0.6, 1, 1.4])
              for (const tuningScale of [0.75, 1, 1.25])
                for (const doubleBaffle of [false, true])
                  for (const materialId of ['bb18', 'bb12']) {
                    if (boxType === 'sealed' && (portSide === 'rear' || tuningScale !== 1)) continue;
                    const { plan } = planFor({ ...d.settings, wooferId: w.id, boxType, portSide, aspect, volumeScale, tuningScale, doubleBaffle, materialId }, 1000);
                    n++;
                    if (plan.box.fitIssues.length && failures.length < 20)
                      failures.push(`${d.id} ${w.model} ${boxType} ${portSide} ${aspect} v${volumeScale} t${tuningScale} ${doubleBaffle ? 'double' : 'single'} ${materialId}: ${plan.box.fitIssues.join(' | ')}`);
                  }
  }
  expect(n).toBeGreaterThan(10000);
  expect(failures).toEqual([]);
});

test('the catalogue designs build as designed (no sealed fallback, no raised tuning)', () => {
  for (const d of DESIGNS) {
    const { plan } = planFor(d.settings, 1000);
    expect(plan.box.fitIssues, d.id).toEqual([]);
    expect(plan.box.warnings.filter((w) => /No practical port|No port tuned/.test(w)), d.id).toEqual([]);
  }
});

test('every printed design fits: woofer space clear, walls intact, dividers cut round the driver', () => {
  for (const [id, p] of [...PRINTED_DESIGNS.map((d) => [d.id, d.params] as const), ['sub', HYBRID_PRESETS.sub] as const]) {
    const d = findDriver(p.driverId)!;
    const g = buildGeometry(p, d);
    expect(g.fits, `${id}: ${g.warnings.join(' | ')}`).toBe(true);
    const bad = buildIssues(p, g, d, planPrint(g, DEFAULT_PRINTER), DEFAULT_PRINTER, id === 'sub').filter((i) => i.level === 'bad');
    expect(bad.map((i) => i.title), id).toEqual([]);
    if (p.type !== 'waveguide' && p.type !== 'shell' && p.type !== 'tube') expect(g.dividerCuts.length, `${id} divider cut-outs`).toBeGreaterThan(0);
  }
});

test('round waveguides: never narrow or fold back, throat takes the faceplate, for every tweeter and angle', () => {
  for (const tw of DRIVERS.filter((d) => d.role === 'tweeter'))
    for (let cov = 60; cov <= 120; cov += 5) {
      const wg = roundWaveguide(tw, cov);
      expect(waveguideIssues(wg, tw), `${tw.model} ${cov}°`).toEqual([]);
      expect(wg.r0 * 2).toBeGreaterThanOrEqual(tw.frameDiaMm);
    }
});

test('printed waveguide profile: opening only widens from throat to mouth', () => {
  for (const coverageDeg of [40, 90, 120])
    for (const throatMm of [20, 45])
      for (const rounding of [0, 1]) {
        const tw = DRIVERS.find((d) => d.role === 'tweeter')!;
        const g = buildGeometry({ ...HYBRID_PRESETS.waveguide, coverageDeg, throatMm, rounding, driverId: tw.id }, tw);
        let widest = 0;
        for (let x = g.wallMm + 1; x < g.W - 0.5; x += 1) {
          let up = 0;
          let dn = 0;
          while (g.H / 2 + up < g.H && isAir(g, x, g.H / 2 + up)) up += 0.25;
          while (g.H / 2 - dn > 0 && isAir(g, x, g.H / 2 - dn)) dn += 0.25;
          expect(up + dn, `${coverageDeg}° throat ${throatMm} rounding ${rounding} at ${x} mm`).toBeGreaterThanOrEqual(widest - 1);
          widest = Math.max(widest, up + dn);
        }
      }
});

test('tweeter in the cabinet: the monitors carry it in the front wall, clear of print', () => {
  for (const id of ['mon-sealed', 'mon-slot', 'mon-tl', 'mon-wg']) {
    const p = PRINTED_DESIGNS.find((d) => d.id === id)!.params;
    const g = buildGeometry(p, findDriver(p.driverId)!);
    expect(g.tweeter, id).not.toBeNull();
    expect(g.tweeter!.y, `${id}: tweeter above the woofer`).toBeGreaterThan(g.driver.y);
    expect(g.fits, `${id}: ${g.warnings.join(' | ')}`).toBe(true);
  }
});

test('printed designs: anything self-intersecting or with a driver off the front is flagged unbuildable', () => {
  // an independent check of the shapes, across sizes, rounding and tweeter set-ups
  const cross = (a: number[], b: number[], c: number[], d: number[]) => {
    const o = (p: number[], q: number[], r: number[]) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
    return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
  };
  const selfX = (poly: number[][]) => {
    for (let i = 0; i < poly.length; i++)
      for (let j = i + 2; j < poly.length; j++) {
        if (i === 0 && j === poly.length - 1) continue;
        if (cross(poly[i], poly[(i + 1) % poly.length], poly[j], poly[(j + 1) % poly.length])) return true;
      }
    return false;
  };
  const tweeters = DRIVERS.filter((d) => d.role === 'tweeter');
  let checked = 0;
  for (const pd of PRINTED_DESIGNS)
    for (const hs of [0.7, 1, 1.3])
      for (const es of [0.7, 1, 1.3])
        for (const rounding of [0, 1])
          for (const tweeterMount of ['front', 'pod', 'none'] as const)
            for (const tweeterWaveguide of [false, true]) {
              const p = { ...pd.params, heightMm: Math.round(pd.params.heightMm * hs), extrusionMm: Math.round(pd.params.extrusionMm * es), rounding, tweeterMount, tweeterWaveguide, tweeterId: tweeters[0].id };
              const d = findDriver(p.driverId)!;
              const g = buildGeometry(p, d);
              if (!g.fits) continue;
              checked++;
              expect(selfX(g.core), `${pd.id} outline`).toBe(false);
              for (const h of g.holes) expect(selfX(h), `${pd.id} chamber`).toBe(false);
              const solid = (y: number) => pointInPoly(g.core, g.W - 0.5, y) && !g.holes.some((h) => pointInPoly(h, g.W - 0.5, y));
              const mounts = [[g.driver.y, d.frameDiaMm / 2], ...(g.tweeter ? [[g.tweeter.y, g.tweeter.waveguide ? g.tweeter.waveguide.flangeR : g.tweeter.driver.frameDiaMm / 2]] : [])];
              for (const [y, r] of mounts) for (let dy = -r; dy <= r; dy += 2) expect(solid(y + dy), `${pd.id}: front face under the driver at ${Math.round(y + dy)} mm`).toBe(true);
            }
  expect(checked).toBeGreaterThan(50);
});

test('opposed sub: drivers front and back on one axis, magnets clear, two pairs of posts, sealed', () => {
  for (const id of ['sub8-opposed', 'sub65-opposed']) {
    const d = DESIGNS.find((x) => x.id === id)!;
    for (const w of DRIVERS.filter((x) => x.role === 'sub'))
      for (const targetQtc of [0.5, 0.707, 1.0]) {
        const { plan } = planFor({ ...d.settings, wooferId: w.id, targetQtc, boxType: 'vented' }, 1000);
        const tag = `${id} ${w.model} Qtc ${targetQtc}`;
        expect(plan.box.alignment.kind, tag).toBe('sealed');
        expect(plan.box.port, tag).toBeNull();
        expect(plan.box.wooferCount, tag).toBe(2);
        expect(plan.box.fitIssues, tag).toEqual([]);
        const front = plan.holes.filter((h) => h.kind === 'woofer');
        expect(front, tag).toHaveLength(1);
        expect(plan.backHoles, tag).toHaveLength(1);
        expect(plan.backHoles[0].xMm).toBeCloseTo(front[0].xMm, 6);
        expect(plan.backHoles[0].yMm).toBeCloseTo(front[0].yMm, 6);
        // inside depth holds both mounting depths and the magnet gap
        expect(plan.box.internalMm.d, tag).toBeGreaterThanOrEqual(2 * (w.mountDepthMm ?? 80) + 20 - 1);
        expect(plan.box.terminalMm.kind, tag).toBe('posts');
        // the reported air volume is what the box really holds (not less)
        const grossL = (plan.box.internalMm.w * plan.box.internalMm.h * plan.box.internalMm.d) / 1e6;
        expect(plan.box.netVolumeL, tag).toBeLessThan(grossL);
        expect(plan.box.netVolumeL, tag).toBeGreaterThan(grossL / 1.04 - 2 * (w.displacementL ?? 0.6) - 1.5);
        expect(plan.shopping.find((s) => /Subwoofer driver/.test(s.item))?.qty, tag).toMatch(/^4 /);
      }
  }
});

test('printed opposed tube: whole rings on the bed, both woofers fit with the magnet gap, two woofers in the sim', () => {
  const p = PRINTED_DESIGNS.find((x) => x.id === 'tube-sub')!.params;
  const d = findDriver(p.driverId)!;
  const g = buildGeometry(p, d);
  expect(g.fits, g.warnings.join(' | ')).toBe(true);
  const sh = g.shell!;
  expect(sh.opposed).toBeTruthy();
  // both ends carry a land at least as wide as the frame, with the woofer hole
  expect(2 * sh.landR).toBeGreaterThanOrEqual(d.frameDiaMm);
  expect(sh.section.filter(([r, z]) => r === sh.holeR && (z === 0 || z === sh.zFront))).toHaveLength(2);
  expect(sh.opposed!.innerLenMm).toBeGreaterThanOrEqual(2 * (d.mountDepthMm ?? 80) + 20);
  // every band prints as a whole ring on the default bed (no half-ring seams)
  const plan = planPrint(g, DEFAULT_PRINTER);
  expect(plan.segments.every((s) => s.core === 0)).toBe(true);
  expect(buildIssues(p, g, d, plan, DEFAULT_PRINTER, false).filter((i) => i.level === 'bad')).toEqual([]);
  // the shared volume with both woofers: Qtc from 2 × Vas
  const qtc = d.qts * Math.sqrt(1 + (2 * d.vasL) / sh.netL);
  expect(qtc).toBeGreaterThan(0.6);
  expect(qtc).toBeLessThan(0.8);
  // too short for two magnets back to back → flagged, not drawn
  const short = buildGeometry({ ...p, depthMm: 2 * (d.mountDepthMm ?? 80) }, d);
  expect(short.fits).toBe(false);
  expect(short.warnings.join(' ')).toMatch(/two woofers need/);
  // too narrow for the frame → flagged
  expect(buildGeometry({ ...p, heightMm: d.frameDiaMm - 10 }, d).fits).toBe(false);
});
