// The files a design downloads: printed pieces (STL) and flat parts (DXF).
import { test, expect } from '@playwright/test';
import { PRINTED_DESIGNS, HYBRID_PRESETS, DEFAULT_PRINTER, buildGeometry, headGeometry, planPrint, tweeterSetup } from '../src/home/hybrid';
import { findDriver } from '../src/home/drivers';
import { platesDxf, printPieces, printPiecesStl, plywoodDxf } from '../src/home/printExport';
import { DESIGNS } from '../src/home/designs';
import { planFor } from '../src/home/planning';

test('printed designs: every print piece is a real solid, the STL holds them all', () => {
  for (const [id, p] of [...PRINTED_DESIGNS.map((d) => [d.id, d.params] as const), ['sub', HYBRID_PRESETS.sub] as const]) {
    const d = findDriver(p.driverId)!;
    const g = buildGeometry(p, d);
    const plan = planPrint(g, DEFAULT_PRINTER);
    const pieces = printPieces(g, p, plan, d, headGeometry(p, tweeterSetup(p).tweeter, d));
    expect(pieces.length, id).toBeGreaterThanOrEqual(plan.segments.length);
    let tris = 0;
    for (const pc of pieces) {
      const n = pc.geometry.index ? pc.geometry.index.count / 3 : pc.geometry.getAttribute('position').count / 3;
      expect(n, `${id}: ${pc.name}`).toBeGreaterThan(4);
      tris += n;
    }
    const stl = printPiecesStl(pieces);
    expect(new DataView(stl).getUint32(80, true), id).toBe(tris);
    const dxf = platesDxf(g, p, d);
    expect(dxf.startsWith('0\nSECTION')).toBe(true);
    expect(dxf.trimEnd().endsWith('EOF')).toBe(true);
    if (g.cores > 1) expect(dxf, id).toContain('DIVIDER');
  }
});

test('plywood designs: the cut sheet has every panel and the baffle holes', () => {
  for (const d of DESIGNS) {
    const { plan } = planFor(d.settings, 1000);
    const dxf = plywoodDxf(plan);
    const polylines = (dxf.match(/\nPOLYLINE\n/g) ?? []).length;
    expect(polylines, d.id).toBeGreaterThanOrEqual(plan.panels.length);
    const circles = (dxf.match(/\nCIRCLE\n/g) ?? []).length;
    expect(circles, d.id).toBeGreaterThanOrEqual(plan.holes.length);
  }
});
