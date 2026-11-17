// File exporters for fabrication: binary STL (3D prints / CAM) and ASCII DXF
// (CNC / laser cut sheets).
//
// Units
//   - Scene units are metres. `meshesToStl` multiplies world-space coordinates
//     by `mmPerUnit` (default 1000) so the STL is written in millimetres, the
//     de-facto unit every slicer assumes.
//   - `profileToStl` and `panelsToDxf` take their input already in millimetres
//     and write millimetres.
//
// Formats
//   - STL: binary. 80-byte header, uint32 triangle count, then 50 bytes per
//     facet: normal (3 × float32), 3 vertices (9 × float32), uint16 attribute
//     (0). Little-endian. Facet normals are recomputed from the transformed
//     vertices (counter-clockwise winding = outward normal).
//   - DXF: ASCII, AutoCAD R12 (AC1009) entity set only, which LibreCAD,
//     Inkscape, Fusion, VCarve etc. all import. HEADER ($ACADVER, $INSUNITS=4
//     mm, extents), TABLES (LTYPE CONTINUOUS + one LAYER per panel + TEXT),
//     ENTITIES, EOF. Outlines and polygonal cut-outs are closed POLYLINE /
//     VERTEX / SEQEND (70=1) — LWPOLYLINE is not R12. Round holes are CIRCLE.
//     Panel names and notes are TEXT entities on the TEXT layer.
//
// `downloadBlob` is browser-only; this module is safe to import in Node.

import * as THREE from 'three';

// ---------------------------------------------------------------- STL

type Tri = [number, number, number, number, number, number, number, number, number];

function writeBinaryStl(tris: Tri[], header = 'speaker-designer binary STL, units: mm'): ArrayBuffer {
  const buf = new ArrayBuffer(84 + 50 * tris.length);
  const dv = new DataView(buf);
  const h = header.slice(0, 80);
  for (let i = 0; i < h.length; i++) dv.setUint8(i, h.charCodeAt(i) & 0x7f);
  dv.setUint32(80, tris.length, true);
  let o = 84;
  for (const t of tris) {
    const ux = t[3] - t[0], uy = t[4] - t[1], uz = t[5] - t[2];
    const vx = t[6] - t[0], vy = t[7] - t[1], vz = t[8] - t[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 0) { nx /= len; ny /= len; nz /= len; }
    dv.setFloat32(o, nx, true); dv.setFloat32(o + 4, ny, true); dv.setFloat32(o + 8, nz, true);
    o += 12;
    for (let k = 0; k < 9; k++) { dv.setFloat32(o, t[k], true); o += 4; }
    dv.setUint16(o, 0, true);
    o += 2;
  }
  return buf;
}

function geometryTris(geo: THREE.BufferGeometry, matrix: THREE.Matrix4, scale: number, out: Tri[]): void {
  const pos = geo.getAttribute('position');
  if (!pos) return;
  const index = geo.getIndex();
  const flip = matrix.determinant() < 0; // mirrored transform reverses winding
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const n = index ? index.count : pos.count;
  const at = (i: number) => (index ? index.getX(i) : i);
  for (let i = 0; i + 2 < n; i += 3) {
    a.fromBufferAttribute(pos, at(i)).applyMatrix4(matrix).multiplyScalar(scale);
    b.fromBufferAttribute(pos, at(i + 1)).applyMatrix4(matrix).multiplyScalar(scale);
    c.fromBufferAttribute(pos, at(i + 2)).applyMatrix4(matrix).multiplyScalar(scale);
    const [p, q] = flip ? [c, b] : [b, c];
    out.push([a.x, a.y, a.z, p.x, p.y, p.z, q.x, q.y, q.z]);
  }
}

function isVisible(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}

/** Binary STL (mm) of every visible THREE.Mesh under `root`, in world space. */
export function meshesToStl(
  root: THREE.Object3D,
  opts: { mmPerUnit?: number; filter?: (m: THREE.Mesh) => boolean } = {},
): ArrayBuffer {
  const scale = opts.mmPerUnit ?? 1000;
  root.updateWorldMatrix(true, true);
  const tris: Tri[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !(m.geometry as THREE.BufferGeometry)?.isBufferGeometry) return;
    if ((o as THREE.InstancedMesh).isInstancedMesh) {
      const im = o as THREE.InstancedMesh;
      if (!isVisible(im) || (opts.filter && !opts.filter(im))) return;
      const inst = new THREE.Matrix4(), world = new THREE.Matrix4();
      for (let k = 0; k < im.count; k++) {
        im.getMatrixAt(k, inst);
        geometryTris(im.geometry, world.multiplyMatrices(im.matrixWorld, inst), scale, tris);
      }
      return;
    }
    if (!isVisible(m) || (opts.filter && !opts.filter(m))) return;
    geometryTris(m.geometry, m.matrixWorld, scale, tris);
  });
  return writeBinaryStl(tris);
}

/** Extrude a 2D profile (mm) along +Z by `thicknessMm` into a closed solid; binary STL in mm. */
export function profileToStl(outline: [number, number][], holes: [number, number][][], thicknessMm: number): ArrayBuffer {
  const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
  for (const h of holes) if (h.length >= 3) shape.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: thicknessMm, bevelEnabled: false, steps: 1, curveSegments: 1 });
  const tris: Tri[] = [];
  geometryTris(geo, new THREE.Matrix4(), 1, tris);
  geo.dispose();
  return writeBinaryStl(tris);
}

// ---------------------------------------------------------------- DXF

export interface DxfPanel {
  name: string;
  outline: [number, number][];
  holes?: { x: number; y: number; r: number }[];
  polyHoles?: [number, number][][];
  notes?: string[];
}

const TEXT_LAYER = 'TEXT';

export function dxfLayerName(name: string): string {
  const s = name.toUpperCase().replace(/[^A-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return (s || 'PANEL').slice(0, 31);
}

const num = (v: number) => {
  const r = Math.round(v * 1e4) / 1e4;
  return (Object.is(r, -0) ? 0 : r).toString();
};
// DXF R12 text is ASCII; drop anything that would confuse a group-code parser.
const dxfText = (s: string) => s.replace(/[\r\n]+/g, ' ').replace(/[^\x20-\x7e]/g, '?');

/** Lay panels (mm) out on a grid and return an ASCII DXF R12 cut sheet. */
export function panelsToDxf(panels: DxfPanel[], opts: { gapMm?: number; columns?: number } = {}): string {
  const gap = opts.gapMm ?? 20;
  const cols = Math.max(1, Math.floor(opts.columns ?? Math.ceil(Math.sqrt(Math.max(1, panels.length)))));
  const textH = 8;
  const lineH = textH * 1.5;

  // Panel extents (outline + round holes, in case a hole pokes out).
  const ext = panels.map((p) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = (x: number, y: number) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
    for (const [x, y] of p.outline) add(x, y);
    for (const h of p.holes ?? []) { add(h.x - h.r, h.y - h.r); add(h.x + h.r, h.y + h.r); }
    if (!isFinite(x0)) { x0 = y0 = x1 = y1 = 0; }
    const labelH = lineH * (1 + (p.notes?.length ?? 0));
    return { x0, y0, w: x1 - x0, h: y1 - y0, labelH };
  });

  // Row-major grid; rows stack downward from y = 0, each row as tall as its tallest cell.
  const offsets: { dx: number; dy: number; tx: number; ty: number }[] = [];
  let rowTop = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let r = 0; r * cols < panels.length; r++) {
    const idx = [...Array(Math.min(cols, panels.length - r * cols)).keys()].map((k) => r * cols + k);
    const rowH = Math.max(...idx.map((i) => ext[i].h + ext[i].labelH));
    let x = 0;
    for (const i of idx) {
      const e = ext[i];
      const top = rowTop;                      // label sits at the top of the cell
      const panelTop = top - e.labelH;
      const dx = x - e.x0, dy = panelTop - e.h - e.y0;
      offsets[i] = { dx, dy, tx: x, ty: top - lineH + (lineH - textH) / 2 };
      minX = Math.min(minX, x); maxX = Math.max(maxX, x + e.w);
      minY = Math.min(minY, panelTop - e.h); maxY = Math.max(maxY, top);
      x += e.w + gap;
    }
    rowTop -= rowH + gap;
  }
  if (!isFinite(minX)) { minX = minY = maxX = maxY = 0; }

  const out: string[] = [];
  const g = (code: number, value: string | number) => { out.push(String(code), typeof value === 'number' ? num(value) : value); };

  // HEADER
  g(0, 'SECTION'); g(2, 'HEADER');
  g(9, '$ACADVER'); g(1, 'AC1009');
  g(9, '$INSUNITS'); g(70, '4');
  g(9, '$MEASUREMENT'); g(70, '1');
  g(9, '$EXTMIN'); g(10, minX); g(20, minY); g(30, 0);
  g(9, '$EXTMAX'); g(10, maxX); g(20, maxY); g(30, 0);
  g(0, 'ENDSEC');

  // TABLES
  const layers = ['0', ...new Set(panels.map((p) => dxfLayerName(p.name))), TEXT_LAYER].filter((l, i, a) => a.indexOf(l) === i);
  g(0, 'SECTION'); g(2, 'TABLES');
  g(0, 'TABLE'); g(2, 'LTYPE'); g(70, '1');
  g(0, 'LTYPE'); g(2, 'CONTINUOUS'); g(70, '0'); g(3, 'Solid line'); g(72, '65'); g(73, '0'); g(40, 0);
  g(0, 'ENDTAB');
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, String(layers.length));
  layers.forEach((l, i) => {
    const color = l === TEXT_LAYER ? 3 : l === '0' ? 7 : (i % 6) + 1;
    g(0, 'LAYER'); g(2, l); g(70, '0'); g(62, String(color)); g(6, 'CONTINUOUS');
  });
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');

  // ENTITIES
  g(0, 'SECTION'); g(2, 'ENTITIES');
  const polyline = (layer: string, pts: [number, number][], dx: number, dy: number) => {
    if (pts.length < 2) return;
    // Drop an explicit closing vertex; the closed flag closes it.
    const n = pts.length > 2 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1] ? pts.length - 1 : pts.length;
    g(0, 'POLYLINE'); g(8, layer); g(66, '1'); g(10, 0); g(20, 0); g(30, 0); g(70, '1');
    for (let i = 0; i < n; i++) { g(0, 'VERTEX'); g(8, layer); g(10, pts[i][0] + dx); g(20, pts[i][1] + dy); g(30, 0); }
    g(0, 'SEQEND'); g(8, layer);
  };
  const text = (s: string, x: number, y: number, h: number) => {
    g(0, 'TEXT'); g(8, TEXT_LAYER); g(10, x); g(20, y); g(30, 0); g(40, h); g(1, dxfText(s));
  };
  panels.forEach((p, i) => {
    const layer = dxfLayerName(p.name);
    const { dx, dy, tx, ty } = offsets[i];
    polyline(layer, p.outline, dx, dy);
    for (const h of p.polyHoles ?? []) polyline(layer, h, dx, dy);
    for (const h of p.holes ?? []) { g(0, 'CIRCLE'); g(8, layer); g(10, h.x + dx); g(20, h.y + dy); g(30, 0); g(40, h.r); }
    text(p.name, tx, ty, textH);
    (p.notes ?? []).forEach((note, k) => text(note, tx, ty - (k + 1) * lineH, textH * 0.75));
  });
  g(0, 'ENDSEC');
  g(0, 'EOF');
  return out.join('\n') + '\n';
}

/** A free-placed DXF entity (mm), for writers that do their own layout. */
export type DxfEntity =
  | { kind: 'poly'; layer: string; pts: [number, number][]; closed?: boolean }
  | { kind: 'circle'; layer: string; x: number; y: number; r: number }
  | { kind: 'text'; layer: string; x: number; y: number; h: number; s: string };

/** ASCII DXF R12 (AC1009, mm) of already-placed entities on named layers. */
export function entitiesToDxf(layers: { name: string; color: number }[], ents: DxfEntity[]): string {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x: number, y: number) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); };
  for (const e of ents) {
    if (e.kind === 'poly') for (const [x, y] of e.pts) add(x, y);
    else if (e.kind === 'circle') { add(e.x - e.r, e.y - e.r); add(e.x + e.r, e.y + e.r); }
    else add(e.x, e.y);
  }
  if (!isFinite(minX)) { minX = minY = maxX = maxY = 0; }
  const out: string[] = [];
  const g = (code: number, value: string | number) => { out.push(String(code), typeof value === 'number' ? num(value) : value); };
  g(0, 'SECTION'); g(2, 'HEADER');
  g(9, '$ACADVER'); g(1, 'AC1009');
  g(9, '$INSUNITS'); g(70, '4');
  g(9, '$MEASUREMENT'); g(70, '1');
  g(9, '$EXTMIN'); g(10, minX); g(20, minY); g(30, 0);
  g(9, '$EXTMAX'); g(10, maxX); g(20, maxY); g(30, 0);
  g(0, 'ENDSEC');
  const all = [{ name: '0', color: 7 }, ...layers.filter((l) => l.name !== '0')];
  g(0, 'SECTION'); g(2, 'TABLES');
  g(0, 'TABLE'); g(2, 'LTYPE'); g(70, '1');
  g(0, 'LTYPE'); g(2, 'CONTINUOUS'); g(70, '0'); g(3, 'Solid line'); g(72, '65'); g(73, '0'); g(40, 0);
  g(0, 'ENDTAB');
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, String(all.length));
  for (const l of all) { g(0, 'LAYER'); g(2, dxfLayerName(l.name)); g(70, '0'); g(62, String(l.color)); g(6, 'CONTINUOUS'); }
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'ENTITIES');
  for (const e of ents) {
    const layer = dxfLayerName(e.layer);
    if (e.kind === 'poly') {
      if (e.pts.length < 2) continue;
      const pts = e.pts;
      const n = pts.length > 2 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1] ? pts.length - 1 : pts.length;
      g(0, 'POLYLINE'); g(8, layer); g(66, '1'); g(10, 0); g(20, 0); g(30, 0); g(70, e.closed === false ? '0' : '1');
      for (let i = 0; i < n; i++) { g(0, 'VERTEX'); g(8, layer); g(10, pts[i][0]); g(20, pts[i][1]); g(30, 0); }
      g(0, 'SEQEND'); g(8, layer);
    } else if (e.kind === 'circle') {
      g(0, 'CIRCLE'); g(8, layer); g(10, e.x); g(20, e.y); g(30, 0); g(40, e.r);
    } else {
      g(0, 'TEXT'); g(8, layer); g(10, e.x); g(20, e.y); g(30, 0); g(40, e.h); g(1, dxfText(e.s));
    }
  }
  g(0, 'ENDSEC');
  g(0, 'EOF');
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------- download

/** Trigger a browser download. No-op outside a browser (e.g. Node tests). */
export function downloadBlob(filename: string, data: ArrayBuffer | string, mime: string): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof Blob === 'undefined') return;
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
