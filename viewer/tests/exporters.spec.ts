// STL / DXF exporters round-trip: parse what we write and check geometry.
// (Pure module, no browser.)
import { test, expect } from '@playwright/test';
import * as THREE from 'three';
import { meshesToStl, profileToStl, panelsToDxf } from '../src/home/exporters';

function parseStl(buf: ArrayBuffer) {
  const dv = new DataView(buf);
  const count = dv.getUint32(80, true);
  const tris: number[][][] = [];
  for (let i = 0; i < count; i++) {
    const o = 84 + i * 50 + 12;
    const t: number[][] = [];
    for (let v = 0; v < 3; v++) t.push([0, 1, 2].map((k) => dv.getFloat32(o + (v * 3 + k) * 4, true)));
    tris.push(t);
  }
  return { count, tris };
}

test('STL: box mesh written in mm', () => {
  const scene = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.2, 0.3));
  mesh.position.set(1, 2, 3);
  scene.add(mesh);
  scene.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1))));
  const hidden = new THREE.Mesh(new THREE.BoxGeometry(5, 5, 5));
  hidden.visible = false;
  scene.add(hidden);

  const buf = meshesToStl(scene);
  expect(buf.byteLength).toBe(84 + 50 * 12);
  const { count, tris } = parseStl(buf);
  expect(count).toBe(12);
  const box = new THREE.Box3();
  for (const t of tris) for (const v of t) box.expandByPoint(new THREE.Vector3(...v));
  const size = box.getSize(new THREE.Vector3());
  expect(size.x).toBeCloseTo(100, 3);
  expect(size.y).toBeCloseTo(200, 3);
  expect(size.z).toBeCloseTo(300, 3);
  expect(box.min.x).toBeCloseTo(950, 2);

  // Non-indexed geometry gives the same result.
  const flat = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.2, 0.3).toNonIndexed());
  expect(parseStl(meshesToStl(flat)).count).toBe(12);
});

test('STL: extruded profile with a hole is a closed manifold', () => {
  const outline: [number, number][] = [[0, 0], [100, 0], [100, 50], [0, 50]];
  const hole: [number, number][] = [[45, 20], [55, 20], [55, 30], [45, 30]];
  const { count, tris } = parseStl(profileToStl(outline, [hole], 20));
  expect(count).toBeGreaterThan(0);

  const key = (v: number[]) => v.map((c) => Math.round(c * 1000)).join(',');
  const edges = new Map<string, number>();
  const directed = new Set<string>();
  const box = new THREE.Box3();
  for (const t of tris) {
    const k = t.map(key);
    for (const v of t) box.expandByPoint(new THREE.Vector3(...v));
    for (let i = 0; i < 3; i++) {
      const a = k[i], b = k[(i + 1) % 3];
      expect(a).not.toBe(b);
      const e = a < b ? `${a}|${b}` : `${b}|${a}`;
      edges.set(e, (edges.get(e) ?? 0) + 1);
      directed.add(`${a}|${b}`);
    }
  }
  const bad = [...edges].filter(([, n]) => n !== 2);
  expect(bad).toEqual([]);
  // Consistent orientation: every directed edge appears once, its reverse once.
  for (const d of directed) expect(directed.has(d.split('|').reverse().join('|'))).toBe(true);
  expect(directed.size).toBe(edges.size * 2);
  const size = box.getSize(new THREE.Vector3());
  expect([size.x, size.y, size.z].map((v) => Math.round(v))).toEqual([100, 50, 20]);
});

type Ent = { type: string; codes: [number, string][] };
function parseDxfEntities(dxf: string): Ent[] {
  const lines = dxf.split('\n');
  const start = lines.findIndex((l, i) => l === 'ENTITIES' && lines[i - 1] === '2');
  const ents: Ent[] = [];
  for (let i = start + 1; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i]), val = lines[i + 1];
    if (code === 0) {
      if (val === 'ENDSEC') break;
      ents.push({ type: val, codes: [] });
    } else ents[ents.length - 1].codes.push([code, val]);
  }
  return ents;
}
const get = (e: Ent, c: number) => e.codes.find(([k]) => k === c)?.[1];

test('DXF: R12 panels laid out without overlap', () => {
  const dxf = panelsToDxf([
    { name: 'Front baffle', outline: [[0, 0], [300, 0], [300, 200], [0, 200]], holes: [{ x: 150, y: 100, r: 41.5 }], notes: ['18 mm birch ply'] },
    { name: 'side/L-piece', outline: [[0, 0], [200, 0], [200, 50], [50, 50], [50, 150], [0, 150]] },
  ], { gapMm: 25 });

  expect(dxf.startsWith('0\nSECTION\n2\nHEADER\n')).toBe(true);
  expect(dxf.trimEnd().endsWith('0\nEOF')).toBe(true);
  expect(dxf).not.toContain('LWPOLYLINE');
  expect(dxf).toContain('$INSUNITS\n70\n4');

  // Layers declared in TABLES.
  const tables = dxf.slice(dxf.indexOf('TABLES'), dxf.indexOf('ENTITIES'));
  for (const l of ['FRONT_BAFFLE', 'SIDE_L-PIECE', 'TEXT']) expect(tables).toContain(`0\nLAYER\n2\n${l}\n`);

  const ents = parseDxfEntities(dxf);
  const polys: { layer: string; flag: string | undefined; pts: [number, number][] }[] = [];
  for (let i = 0; i < ents.length; i++) {
    if (ents[i].type !== 'POLYLINE') continue;
    const pts: [number, number][] = [];
    let j = i + 1;
    for (; ents[j].type === 'VERTEX'; j++) pts.push([Number(get(ents[j], 10)), Number(get(ents[j], 20))]);
    expect(ents[j].type).toBe('SEQEND');
    polys.push({ layer: get(ents[i], 8)!, flag: get(ents[i], 70), pts });
  }
  expect(polys.length).toBe(2);
  expect(polys.map((p) => p.flag)).toEqual(['1', '1']);
  expect(polys.map((p) => p.pts.length)).toEqual([4, 6]);
  expect(polys.map((p) => p.layer)).toEqual(['FRONT_BAFFLE', 'SIDE_L-PIECE']);

  const circles = ents.filter((e) => e.type === 'CIRCLE');
  expect(circles.length).toBe(1);
  expect(Number(get(circles[0], 40))).toBeCloseTo(41.5, 6);
  expect(get(circles[0], 8)).toBe('FRONT_BAFFLE');

  const texts = ents.filter((e) => e.type === 'TEXT');
  expect(texts.map((t) => get(t, 1))).toEqual(['Front baffle', '18 mm birch ply', 'side/L-piece']);
  expect(texts.every((t) => get(t, 8) === 'TEXT')).toBe(true);

  // Circle is inside its panel after layout.
  const bb = polys.map((p) => {
    const xs = p.pts.map((v) => v[0]), ys = p.pts.map((v) => v[1]);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  });
  expect(bb[0].x1 - bb[0].x0).toBeCloseTo(300, 6);
  expect(bb[1].y1 - bb[1].y0).toBeCloseTo(150, 6);
  const cx = Number(get(circles[0], 10)), cy = Number(get(circles[0], 20));
  expect(cx).toBeCloseTo(bb[0].x0 + 150, 6);
  expect(cy).toBeCloseTo(bb[0].y0 + 100, 6);
  // No overlap between panel bounding boxes.
  const overlap = bb[0].x0 < bb[1].x1 && bb[1].x0 < bb[0].x1 && bb[0].y0 < bb[1].y1 && bb[1].y0 < bb[0].y1;
  expect(overlap).toBe(false);
});
