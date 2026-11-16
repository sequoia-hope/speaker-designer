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
import { brepProblems, partBounds, partBrep, recipeVolume, stepReal, writeStep, writeWaffle, type CadPart } from '../src/home/cad';

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

function checkFiles(id: string, parts: CadPart[]) {
  for (const p of parts) {
    const b = partBrep(p);
    expect(brepProblems(b), `${id}: ${p.name}`).toEqual([]);
    expect(recipeVolume(p.recipe), `${id}: ${p.name}`).toBeGreaterThan(0);
  }
  // laid out without overlaps, all on the bed
  const boxes = parts.map(partBounds);
  boxes.forEach((b, i) => {
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

test('STEP REAL formatting', () => {
  expect(stepReal(1)).toBe('1.');
  expect(stepReal(-2.5)).toBe('-2.5');
  expect(stepReal(1e-7)).toBe('1.E-7');
  expect(stepReal(1.5e21)).toBe('1.5E+21');
  expect(stepReal(1e-14)).toBe('0.');
});

test('printed designs: exact solids that match the print meshes; STEP and .waffle for each', () => {
  for (const [id, p] of [...PRINTED_DESIGNS.map((d) => [d.id, d.params] as const), ['sub', HYBRID_PRESETS.sub] as const]) {
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
    checkFiles(id, printedCadParts(pieces, g, p, d));
  }
});

test('plywood designs: every panel with its holes, STEP and .waffle', () => {
  for (const d of DESIGNS) {
    const { plan } = planFor(d.settings, 1000);
    const parts = plywoodCadParts(plan);
    expect(parts.length).toBe(plan.panels.length);
    const holes = parts.reduce((s, p) => s + (p.recipe.kind === 'prism' ? p.recipe.holes.length : 0), 0);
    expect(holes, d.id).toBeGreaterThanOrEqual(plan.holes.length);
    checkFiles(`plywood-${d.id}`, parts);
  }
});
