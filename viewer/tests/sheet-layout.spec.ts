// Sheet nesting, cut list and nested DXF. (Pure module, no browser.)
import { test, expect } from '@playwright/test';
import { nestPanels, nestedDxf, placedGeometry, cutListRows, cutListCsv, partBounds, type NestPart, type NestResult, type Placement } from '../src/home/sheetLayout';
import { plywoodNestParts, plateNestParts } from '../src/home/printExport';
import { DESIGNS } from '../src/home/designs';
import { planFor } from '../src/home/planning';
import { PRINTED_DESIGNS, buildGeometry } from '../src/home/hybrid';
import { findDriver } from '../src/home/drivers';

const rect = (name: string, w: number, h: number, qty = 1, extra: Partial<NestPart> = {}): NestPart => ({
  name,
  outline: [[0, 0], [w, 0], [w, h], [0, h]],
  qty,
  thickMm: 18,
  material: 'Birch plywood',
  ...extra,
});

const TOL = 1e-6;

/** every copy placed once, inside the trimmed sheet, kerf apart, and separable by guillotine cuts */
function checkLayout(parts: NestPart[], r: NestResult, kerf: number, margin: number, grain = false) {
  const seen = new Map<string, number>();
  for (const s of r.sheets) {
    for (const p of s.placements) {
      const k = `${p.part}/${p.copy}`;
      seen.set(k, (seen.get(k) ?? 0) + 1);
      expect(p.x).toBeGreaterThanOrEqual(margin - TOL);
      expect(p.y).toBeGreaterThanOrEqual(margin - TOL);
      expect(p.x + p.w).toBeLessThanOrEqual(s.w - margin + TOL);
      expect(p.y + p.h).toBeLessThanOrEqual(s.h - margin + TOL);
      const b = partBounds(parts[p.part]);
      if (p.rotated) {
        expect(parts[p.part].grainLocked).toBeFalsy();
        if (grain) expect(parts[p.part].visible).toBeFalsy();
        expect([p.w, p.h]).toEqual([b.h, b.w]);
      } else expect([p.w, p.h]).toEqual([b.w, b.h]);
    }
    const ps = s.placements;
    for (let i = 0; i < ps.length; i++)
      for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i], c = ps[j];
        const apart = a.x + a.w + kerf <= c.x + TOL || c.x + c.w + kerf <= a.x + TOL || a.y + a.h + kerf <= c.y + TOL || c.y + c.h + kerf <= a.y + TOL;
        expect(apart, `${a.name} vs ${c.name} on sheet ${s.index + 1}`).toBe(true);
      }
    expect(guillotine(ps), `sheet ${s.index + 1} is guillotine-cuttable`).toBe(true);
  }
  const unplaced = new Set(r.unplaced.map((u) => u.part));
  parts.forEach((p, i) => {
    for (let c = 0; c < p.qty; c++) expect(seen.get(`${i}/${c}`) ?? 0, `${p.name} #${c}`).toBe(unplaced.has(i) ? 0 : 1);
  });
  expect([...seen.values()].every((v) => v === 1)).toBe(true);
}

/** can the rectangles be separated by straight through-cuts, recursively? */
function guillotine(ps: Placement[]): boolean {
  if (ps.length <= 1) return true;
  for (const ax of ['x', 'y'] as const) {
    const lo = (p: Placement) => (ax === 'x' ? p.x : p.y);
    const hi = (p: Placement) => (ax === 'x' ? p.x + p.w : p.y + p.h);
    const sorted = [...ps].sort((a, b) => lo(a) - lo(b));
    let reach = -Infinity;
    for (let i = 0; i < sorted.length - 1; i++) {
      reach = Math.max(reach, hi(sorted[i]));
      if (reach <= lo(sorted[i + 1]) + TOL) return guillotine(sorted.slice(0, i + 1)) && guillotine(sorted.slice(i + 1));
    }
  }
  return false;
}

/** DXF group-code pairs */
function dxfPairs(s: string): [number, string][] {
  const lines = s.replace(/\n$/, '').split('\n');
  expect(lines.length % 2).toBe(0);
  const out: [number, string][] = [];
  for (let i = 0; i < lines.length; i += 2) {
    expect(lines[i].trim(), `line ${i}`).toMatch(/^-?\d+$/);
    out.push([parseInt(lines[i], 10), lines[i + 1]]);
  }
  return out;
}

test('known case: eight 600 × 1200 panels fill two 4×8 sheets exactly', () => {
  const parts = [rect('panel', 600, 1200, 8)];
  const r = nestPanels(parts, { sheetW: 1220, sheetH: 2440, kerfMm: 3.2, marginMm: 10, pricePerSheet: 60 });
  expect(r.unplaced).toEqual([]);
  expect(r.sheetsNeeded).toBe(2);
  expect(r.sheets.map((s) => s.placements.length)).toEqual([4, 4]);
  expect(r.cost).toBe(120);
  expect(r.utilisation).toBeCloseTo((8 * 600 * 1200) / (2 * 1220 * 2440), 6);
  checkLayout(parts, r, 3.2, 10);
  // a ninth needs a third sheet
  expect(nestPanels([rect('panel', 600, 1200, 9)], { sheetW: 1220, sheetH: 2440 }).sheetsNeeded).toBe(3);
});

test('a typical box: 2 speakers of 5 panels on one 5×5 sheet; rotation used when allowed', () => {
  const parts = [rect('baffle', 250, 400, 2), rect('back', 250, 400, 2), rect('side', 300, 400, 4), rect('top', 250, 264, 4)];
  const r = nestPanels(parts, { sheetW: 1525, sheetH: 1525, kerfMm: 3.2, marginMm: 10 });
  expect(r.sheetsNeeded).toBe(1);
  checkLayout(parts, r, 3.2, 10);
});

test('grain lock: visible panels never turn; panels that only fit turned are reported', () => {
  const parts = [rect('side', 300, 1300, 2, { visible: true }), rect('brace', 1300, 100, 3), rect('base', 1300, 400, 1, { grainLocked: true })];
  const free = nestPanels(parts, { sheetW: 1220, sheetH: 2440, grainMatters: false });
  checkLayout(parts, free, 3.2, 10);
  // 1300-wide parts only fit turned; the base is locked, so it can't be placed
  expect(free.unplaced.map((u) => u.name)).toEqual(['base']);
  expect(free.unplaced[0].reason).toMatch(/turned/);
  for (const s of free.sheets) for (const p of s.placements) if (p.name === 'brace') expect(p.rotated).toBe(true);

  const locked = nestPanels(parts, { sheetW: 1220, sheetH: 2440, grainMatters: true });
  checkLayout(parts, locked, 3.2, 10, true);
  for (const s of locked.sheets) for (const p of s.placements) if (p.name === 'side') expect(p.rotated).toBe(false);

  // a wide visible panel that only fits across the grain: placed when grain doesn't matter, not when it does
  const wide = [rect('wide top', 1300, 300, 1, { visible: true })];
  expect(nestPanels(wide, { sheetW: 1220, sheetH: 2440 }).unplaced).toEqual([]);
  expect(nestPanels(wide, { sheetW: 1220, sheetH: 2440, grainMatters: true }).unplaced.length).toBe(1);
});

test('random part sets: no overlaps with kerf, inside the trim, every part once, guillotine', () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let trial = 0; trial < 25; trial++) {
    const n = 3 + Math.floor(rnd() * 10);
    const parts: NestPart[] = [];
    for (let i = 0; i < n; i++)
      parts.push(rect(`p${i}`, 60 + Math.round(rnd() * 700), 60 + Math.round(rnd() * 1100), 1 + Math.floor(rnd() * 3), { visible: rnd() < 0.4, material: rnd() < 0.2 ? 'MDF' : 'Birch plywood' }));
    const kerf = [0, 3.2, 4][trial % 3];
    const margin = [0, 10, 25][trial % 3];
    const grain = trial % 2 === 0;
    const r = nestPanels(parts, { sheetW: 1220, sheetH: 2440, kerfMm: kerf, marginMm: margin, grainMatters: grain });
    expect(r.unplaced).toEqual([]);
    checkLayout(parts, r, kerf, margin, grain);
    for (const s of r.sheets) for (const p of s.placements) expect(parts[p.part].material).toBe(s.material);
    // cuts: inside the sheet and one per side of a part at most
    for (const s of r.sheets) {
      for (const c of s.cuts) {
        expect(c.pos).toBeGreaterThanOrEqual(-TOL);
        expect(c.pos).toBeLessThanOrEqual((c.axis === 'x' ? s.w : s.h) + TOL);
      }
      expect(s.cuts.filter((c) => c.kind === 'cut').length).toBeLessThanOrEqual(2 * s.placements.length);
    }
  }
});

test('holes stay inside their panel when it is turned 90°', () => {
  const part: NestPart = {
    ...rect('baffle', 300, 500, 1),
    holes: [{ x: 60, y: 420, r: 25 }, { x: 150, y: 200, r: 80 }],
    polyHoles: [[[200, 40], [260, 40], [260, 90], [200, 90]]],
  };
  // only fits turned
  const r = nestPanels([part], { sheetW: 600, sheetH: 400, kerfMm: 3, marginMm: 10 });
  expect(r.unplaced).toEqual([]);
  const pl = r.sheets[0].placements[0];
  expect(pl.rotated).toBe(true);
  const g = placedGeometry(part, pl);
  const xs = g.outline.map((p) => p[0]), ys = g.outline.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  expect([x0, y0, x1 - x0, y1 - y0]).toEqual([pl.x, pl.y, 500, 300]);
  for (const h of g.holes) {
    expect(h.x - h.r).toBeGreaterThanOrEqual(x0 - TOL);
    expect(h.x + h.r).toBeLessThanOrEqual(x1 + TOL);
    expect(h.y - h.r).toBeGreaterThanOrEqual(y0 - TOL);
    expect(h.y + h.r).toBeLessThanOrEqual(y1 + TOL);
  }
  for (const ph of g.polyHoles) for (const [x, y] of ph) expect(x >= x0 - TOL && x <= x1 + TOL && y >= y0 - TOL && y <= y1 + TOL).toBe(true);
  // a rotation, not a mirror: distances between features are kept and the outline keeps its winding
  const d = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  expect(d([g.holes[0].x, g.holes[0].y], [g.holes[1].x, g.holes[1].y])).toBeCloseTo(Math.hypot(90, 220), 6);
  const area = (pts: [number, number][]) => pts.reduce((a, p, i) => a + p[0] * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * p[1], 0) / 2;
  expect(Math.sign(area(g.outline))).toBe(Math.sign(area(part.outline)));
  // the original top-left hole (x 60, y 420 of 500) ends up near the placed panel's left after a CCW turn
  expect(g.holes[0].x - pl.x).toBeCloseTo(500 - 420, 6);
  expect(g.holes[0].y - pl.y).toBeCloseTo(60, 6);
});

test('nested DXF: R12 pairs, layers, one outline per sheet and per part, holes on CUT_INSIDE', () => {
  const parts: NestPart[] = [
    { ...rect('baffle', 250, 400, 2), holes: [{ x: 125, y: 300, r: 50 }, { x: 125, y: 120, r: 70 }] },
    { ...rect('back', 250, 400, 2), polyHoles: [[[90, 40], [160, 40], [160, 110], [90, 110]]] },
    rect('side', 300, 1100, 4),
  ];
  const r = nestPanels(parts, { sheetW: 1220, sheetH: 1220, kerfMm: 3.2, marginMm: 10 });
  expect(r.unplaced).toEqual([]);
  expect(r.sheetsNeeded).toBe(2);
  const dxf = nestedDxf(parts, r);
  const pairs = dxfPairs(dxf);
  expect(pairs.at(-1)).toEqual([0, 'EOF']);
  const ver = pairs.findIndex(([c, v]) => c === 9 && v === '$ACADVER');
  expect(pairs[ver + 1]).toEqual([1, 'AC1009']);
  const units = pairs.findIndex(([c, v]) => c === 9 && v === '$INSUNITS');
  expect(pairs[units + 1]).toEqual([70, '4']);
  const layerNames = pairs.filter(([c], i) => c === 2 && pairs[i - 1]?.[0] === 0 && pairs[i - 1][1] === 'LAYER').map(([, v]) => v);
  for (const l of ['SHEET', 'CUT_OUTSIDE', 'CUT_INSIDE', 'TEXT']) expect(layerNames).toContain(l);

  // entities: entity type then its layer (code 8)
  const ents: { type: string; layer: string }[] = [];
  const start = pairs.findIndex(([c, v], i) => c === 2 && v === 'ENTITIES' && pairs[i - 1][1] === 'SECTION');
  for (let i = start + 1; i < pairs.length; i++) {
    if (pairs[i][0] === 0 && ['POLYLINE', 'CIRCLE', 'TEXT'].includes(pairs[i][1])) ents.push({ type: pairs[i][1], layer: pairs[i + 1][1] });
  }
  const count = (type: string, layer: string) => ents.filter((e) => e.type === type && e.layer === layer).length;
  const placed = r.sheets.reduce((a, s) => a + s.placements.length, 0);
  expect(placed).toBe(8);
  expect(count('POLYLINE', 'SHEET')).toBe(r.sheetsNeeded);
  expect(count('POLYLINE', 'CUT_OUTSIDE')).toBe(placed);
  expect(count('CIRCLE', 'CUT_INSIDE')).toBe(4);
  expect(count('POLYLINE', 'CUT_INSIDE')).toBe(2);
  expect(count('TEXT', 'TEXT')).toBe(placed + 2 * r.sheetsNeeded);
  expect(dxf).toMatch(/kerf 3\.2 mm/);
  // every vertex sits on a sheet laid side by side (x), inside 0..h (y)
  const xs = pairs.filter(([c], i) => c === 10 && pairs[i - 1]).map(([, v]) => +v);
  expect(Math.max(...xs)).toBeGreaterThan(1220);
});

test('cut list groups identical panels, CSV has a row per group and totals', () => {
  const parts = [rect('side', 300, 400, 2), rect('side', 300, 400, 2), rect('top', 250, 264, 4)];
  const r = nestPanels(parts, { sheetW: 1220, sheetH: 2440, pricePerSheet: 55 });
  const rows = cutListRows(parts, r);
  expect(rows.length).toBe(2);
  expect(rows[0]).toMatchObject({ name: 'side', qty: 4, w: 300, h: 400, sheets: [1] });
  const csv = cutListCsv(parts, r);
  const lines = csv.trim().split('\n');
  expect(lines[0]).toBe('Panel,Qty,Width mm,Height mm,Thickness mm,Material,Sheet #,Rotated');
  expect(lines[1]).toMatch(/^side,4,300\.0,400\.0,18,Birch plywood,1,/);
  expect(csv).toMatch(/Est\. sheet cost,55\.00/);
});

test('every plywood design nests; every printed design’s plates nest', () => {
  for (const d of DESIGNS) {
    const { plan } = planFor(d.settings, 1000);
    const parts = plywoodNestParts(plan, 2);
    expect(parts.length).toBe(plan.panels.length + (plan.stand?.panels.length ?? 0));
    const [W, H] = plan.material.sheetMm;
    for (const grain of [false, true]) {
      const r = nestPanels(parts, { sheetW: W, sheetH: H, grainMatters: grain });
      checkLayout(parts, r, 3.2, 10, grain);
      if (!grain) expect(r.unplaced, d.id).toEqual([]);
      // holes inside their panels at the nested place
      for (const s of r.sheets)
        for (const pl of s.placements) {
          const g = placedGeometry(parts[pl.part], pl);
          for (const h of g.holes) {
            expect(h.x - h.r).toBeGreaterThanOrEqual(pl.x - TOL);
            expect(h.x + h.r).toBeLessThanOrEqual(pl.x + pl.w + TOL);
            expect(h.y - h.r).toBeGreaterThanOrEqual(pl.y - TOL);
            expect(h.y + h.r).toBeLessThanOrEqual(pl.y + pl.h + TOL);
          }
        }
      dxfPairs(nestedDxf(parts, r));
    }
  }
  for (const pd of PRINTED_DESIGNS) {
    const p = pd.params;
    const dr = findDriver(p.driverId)!;
    const g = buildGeometry(p, dr);
    const parts = plateNestParts(g, p, dr, 2);
    const r = nestPanels(parts, { sheetW: 1220, sheetH: 2440 });
    checkLayout(parts, r, 3.2, 10);
    dxfPairs(nestedDxf(parts, r));
  }
});
