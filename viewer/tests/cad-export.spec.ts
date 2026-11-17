// STEP and Waffle Iron export: every part of every design is an exact, closed,
// consistently oriented solid that matches the printed mesh it stands for.
// (Pure module, no browser.) Set CAD_OUT=<dir> to also write the files, for
// checking them in Waffle Iron itself.
import { test, expect } from '@playwright/test';
import * as THREE from 'three';
import fs from 'node:fs';
import path from 'node:path';
import { PRINTED_DESIGNS, HYBRID_PRESETS, DEFAULT_PRINTER, buildGeometry, headGeometry, planPrint, tweeterSetup } from '../src/home/hybrid';
import { findDriver } from '../src/home/drivers';
import { printPieces, printedCadParts, plywoodCadParts } from '../src/home/printExport';
import { DESIGNS } from '../src/home/designs';
import { planFor } from '../src/home/planning';
import { brepProblems, partBounds, partBrep, partDepth, partsBounds, recipeVolume, stepReal, writeStep, writeWaffle, type CadPart, type V3 } from '../src/home/cad';
import type { Geometry, HeadGeometry } from '../src/home/hybrid';
import type { BuildPlan } from '../src/home/speakerBuild';

function meshVolume(g: THREE.BufferGeometry) {
  const geo = g.index ? g.toNonIndexed() : g;
  const p = geo.getAttribute('position');
  let v = 0;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i);
    b.fromBufferAttribute(p, i + 1);
    c.fromBufferAttribute(p, i + 2);
    v += a.dot(b.clone().cross(c)) / 6;
  }
  return Math.abs(v);
}

const out = process.env.CAD_OUT;
const save = (name: string, text: string) => {
  if (!out) return;
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, name), text);
};

function checkFiles(id: string, parts: CadPart[], flat = true) {
  for (const p of parts) {
    const b = partBrep(p);
    expect(brepProblems(b), `${id}: ${p.name}`).toEqual([]);
    expect(recipeVolume(p.recipe), `${id}: ${p.name}`).toBeGreaterThan(0);
  }
  // laid out without overlaps, all on the bed
  const boxes = parts.map(partBounds);
  if (flat) boxes.forEach((b, i) => {
    expect(b.min[2], `${id}: ${parts[i].name}`).toBeGreaterThan(-1e-6);
    for (let j = 0; j < i; j++) {
      const o = boxes[j];
      const overlap = b.min[0] < o.max[0] - 1e-6 && o.min[0] < b.max[0] - 1e-6 && b.min[1] < o.max[1] - 1e-6 && o.min[1] < b.max[1] - 1e-6;
      expect(overlap, `${id}: ${parts[i].name} overlaps ${parts[j].name}`).toBe(false);
    }
  });
  const step = writeStep(parts, `${id}.step`);
  expect(step.startsWith('ISO-10303-21;')).toBe(true);
  expect((step.match(/MANIFOLD_SOLID_BREP\(/g) ?? []).length).toBe(parts.length);
  expect(step).not.toMatch(/NaN|Infinity/);
  const waffle = writeWaffle(parts, id);
  const doc = JSON.parse(waffle);
  expect(doc.format).toBe('waffle-iron');
  const feats = doc.tabs[0].kind.features.features;
  expect(feats.length).toBe(parts.length * 2);
  save(`${id}.step`, step);
  save(`${id}.waffle`, waffle);
  save(
    `${id}.expect.json`,
    JSON.stringify(parts.map((p) => ({ name: p.name, volumeMm3: recipeVolume(p.recipe), ...partBounds(p) })))
  );
}

/**
 * Pairs of parts whose solids run into each other by more than `tolMm`: points on
 * a grid through the common part of their boxes that lie more than tolMm inside
 * both. Panels that butt (share a face) don't count.
 */
function interpenetrations(parts: CadPart[], tolMm = 0.3): string[] {
  const boxes = parts.map(partBounds);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++)
    for (let j = 0; j < i; j++) {
      const lo = [0, 1, 2].map((k) => Math.max(boxes[i].min[k], boxes[j].min[k]) + tolMm);
      const hi = [0, 1, 2].map((k) => Math.min(boxes[i].max[k], boxes[j].max[k]) - tolMm);
      if (hi.some((h, k) => h <= lo[k])) continue;
      const vol = hi.reduce((a, h, k) => a * (h - lo[k]), 1);
      const step = Math.max(1, Math.cbrt(vol / 30000));
      const n = hi.map((h, k) => Math.max(1, Math.ceil((h - lo[k]) / step)));
      let hit: V3 | null = null;
      let count = 0;
      for (let a = 0; a <= n[0]; a++)
        for (let b = 0; b <= n[1]; b++)
          for (let c = 0; c <= n[2]; c++) {
            const q: V3 = [lo[0] + ((hi[0] - lo[0]) * a) / n[0], lo[1] + ((hi[1] - lo[1]) * b) / n[1], lo[2] + ((hi[2] - lo[2]) * c) / n[2]];
            if (partDepth(parts[i], q) > tolMm && partDepth(parts[j], q) > tolMm) {
              hit ??= q;
              count++;
            }
          }
      if (hit) out.push(`${parts[i].name} runs into ${parts[j].name} (${count} grid points, e.g. at ${hit.map((v) => v.toFixed(1)).join(', ')})`);
    }
  return out;
}

const near = (got: V3, want: V3, what: string, tolMm = 2) => {
  for (let k = 0; k < 3; k++) expect(Math.abs(got[k] - want[k]), `${what} [${k}]: ${got.map((v) => v.toFixed(1))} vs ${want.map((v) => v.toFixed(1))}`).toBeLessThan(tolMm);
};

/** assembled and exploded: placed solids that don't run into each other, the cabinet the design's size */
function checkAssembly(id: string, assembled: CadPart[], exploded: CadPart[], flatCount: number, outer: (b: { min: V3; max: V3 }, parts: CadPart[]) => void) {
  expect(assembled.length, id).toBeGreaterThanOrEqual(flatCount);
  expect(exploded.length).toBe(assembled.length);
  expect.soft(interpenetrations(assembled), `${id} assembled`).toEqual([]);
  expect.soft(interpenetrations(exploded), `${id} exploded`).toEqual([]);
  outer(partsBounds(assembled), assembled);
  // the exploded view is bigger, but every part keeps its turn
  const eb = partsBounds(exploded);
  const ab = partsBounds(assembled);
  for (let k = 0; k < 3; k++) expect(eb.max[k] - eb.min[k]).toBeGreaterThanOrEqual(ab.max[k] - ab.min[k] - 1e-6);
  exploded.forEach((p, i) => expect(p.rot).toEqual(assembled[i].rot));
  checkFiles(`${id}-assembled`, assembled, false);
  checkFiles(`${id}-exploded`, exploded, false);
}

/** a printed design's assembled size: the cabinet between its plates (or the shell), plus the pod, traps and a waveguide's flange */
function printedOuter(g: Geometry, plateMm: number, head: HeadGeometry | null) {
  return (all: { min: V3; max: V3 }, parts: CadPart[]) => {
    const extra = /pod|trap|waveguide/;
    const cab = partsBounds(parts.filter((p) => !extra.test(p.name)));
    if (g.shell) {
      const R = g.shell.Rmax;
      near(cab.min, [-R, 0, 60], 'shell min');
      near(cab.max, [R, g.shell.zFront, 60 + 2 * R], 'shell max');
    } else {
      const X = g.Etot / 2 + plateMm;
      near(cab.min, [-X, 0, 0], 'cabinet min');
      near(cab.max, [X, g.W, g.H], 'cabinet max');
    }
    const top = cab.max[2] + (head ? 3 + head.h : 0);
    const trapLen = Math.max(0, ...(g.traps ?? []).map((t) => t.lenMm + 4));
    // a waveguide's flange stands proud of the face it sits on
    const proud = Math.max(g.tweeter?.waveguide ? 3 : 0, head?.waveguide ? 3 - head.setbackMm : 0);
    // traps lie across the side plate, centred where the profile puts them (y = W − x from the front)
    const trapY = (g.traps ?? []).map((t) => [g.W - t.x - t.diaMm / 2, g.W - t.x + t.diaMm / 2]);
    near(all.min, [cab.min[0] - trapLen, Math.min(cab.min[1] - proud, ...trapY.map(([a]) => a)), cab.min[2]], 'all min');
    // a pod may be wider than the cabinet, or run past its back
    near(all.max, [Math.max(cab.max[0], head ? head.w / 2 : 0), Math.max(cab.max[1], head ? head.setbackMm + head.d : 0, ...trapY.map(([, b]) => b)), top], 'all max');
  };
}

function plywoodOuter(plan: BuildPlan) {
  const { w, h, d } = plan.box.externalMm;
  return (all: { min: V3; max: V3 }) => {
    near(all.min, [-w / 2, 0, 0], 'box min', 0.01);
    near(all.max, [w / 2, d, h], 'box max', 0.01);
  };
}

test('STEP REAL formatting', () => {
  expect(stepReal(1)).toBe('1.');
  expect(stepReal(-2.5)).toBe('-2.5');
  expect(stepReal(1e-7)).toBe('1.E-7');
  expect(stepReal(1.5e21)).toBe('1.5E+21');
  expect(stepReal(1e-14)).toBe('0.');
});

test('printed designs: exact solids that match the print meshes; STEP and .waffle for each', () => {
  const tl = PRINTED_DESIGNS.find((d) => d.id === 'mon-tl')!.params;
  // and one with what no stock design has: resonance traps on the side plate, a waveguide pod on top
  const extras = [['mon-tl-traps-pod', { ...tl, trapHarmonics: [3, 5], tweeterMount: 'pod' as const, tweeterWaveguide: true }] as const];
  let sawTraps = false;
  let sawPodWaveguide = false;
  for (const [id, p] of [...PRINTED_DESIGNS.map((d) => [d.id, d.params] as const), ['sub', HYBRID_PRESETS.sub] as const, ...extras]) {
    const d = findDriver(p.driverId)!;
    const g = buildGeometry(p, d);
    const plan = planPrint(g, DEFAULT_PRINTER);
    const pieces = printPieces(g, p, plan, d, headGeometry(p, tweeterSetup(p).tweeter, d));
    for (const pc of pieces) {
      // the recipe is the mesh: same volume (the mesh's circles are polygons) and the same place
      const v = recipeVolume(pc.recipe);
      expect(Math.abs(meshVolume(pc.geometry) - v) / v, `${id}: ${pc.name} volume`).toBeLessThan(0.01);
      pc.geometry.computeBoundingBox();
      const mb = pc.geometry.boundingBox!;
      const rb = partBounds({ name: pc.name, recipe: pc.recipe, rotX90: pc.rotX90 });
      for (const [k, ax] of (['x', 'y', 'z'] as const).entries()) {
        expect(Math.abs(mb.min[ax] - rb.min[k]), `${id}: ${pc.name} min ${ax}`).toBeLessThan(1);
        expect(Math.abs(mb.max[ax] - rb.max[k]), `${id}: ${pc.name} max ${ax}`).toBeLessThan(1);
      }
    }
    sawTraps ||= !!g.traps?.length;
    sawPodWaveguide ||= pieces.some((pc) => pc.name === 'pod waveguide');
    const flat = printedCadParts(pieces, g, p, d);
    checkFiles(id, flat);
    const head = headGeometry(p, tweeterSetup(p).tweeter, d);
    checkAssembly(id, printedCadParts(pieces, g, p, d, 'PETG', 'assembled'), printedCadParts(pieces, g, p, d, 'PETG', 'exploded'), flat.length, printedOuter(g, p.plateMm, head));
  }
  expect(sawTraps && sawPodWaveguide, 'the variants cover traps and a waveguide pod').toBe(true);
});

test('plywood designs: every panel with its holes, STEP and .waffle', () => {
  // and a variant for what the stock designs lack: the MTM as a tower (its box needs less than
  // the height: a false floor) with a double baffle
  const mtm = DESIGNS.find((d) => d.id === 'mtm')!;
  const variants = [...DESIGNS, { ...mtm, id: 'mtm-tower-double', settings: { ...mtm.settings, arrangement: 'tower' as const, doubleBaffle: true } }];
  let sawFloor = false;
  let sawDouble = false;
  for (const d of variants) {
    const { plan } = planFor(d.settings, 1000);
    sawFloor ||= plan.box.deadSpaceMm > 0;
    sawDouble ||= plan.panels.some((p) => p.id === 'baffle2');
    const parts = plywoodCadParts(plan);
    expect(parts.length).toBe(plan.panels.length);
    const holes = parts.reduce((s, p) => s + (p.recipe.kind === 'prism' ? p.recipe.holes.length : 0), 0);
    expect(holes, d.id).toBeGreaterThanOrEqual(plan.holes.length);
    checkFiles(`plywood-${d.id}`, parts);
    const assembled = plywoodCadParts(plan, 'assembled');
    expect(assembled.length).toBe(plan.panels.reduce((a, p) => a + p.qtyPerBox, 0));
    checkAssembly(`plywood-${d.id}`, assembled, plywoodCadParts(plan, 'exploded'), parts.length, plywoodOuter(plan));
  }
  expect(sawFloor && sawDouble, 'the variants cover a false floor and a double baffle').toBe(true);
});
