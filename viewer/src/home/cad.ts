// CAD export: every part of a design as an exact solid, written two ways.
//
//  * STEP (ISO 10303-21, AP214 AUTOMOTIVE_DESIGN), an exact B-rep — planes,
//    cylinders and cones, never a mesh. Same entity layout and orientation
//    contract as Waffle Iron's kernel-v2 exporter (crates/kernel-v2/src/step_export.rs):
//    each loop winds CCW about its face's outward normal, every FACE_BOUND is
//    .T., a face's same_sense makes its surface normal point outwards, each
//    undirected edge is one EDGE_CURVE, and a closed circle edge starts and ends
//    on one vertex with a seam line on the lateral face. Millimetres.
//  * A Waffle Iron document (.waffle, format v15): the same parts as a native
//    parametric recipe — a sketch plus an extrude or a revolve per part — so they
//    open editable in Waffle Iron (and Waffle Iron can write STEP/STL from it).
//
// A part is a recipe, not a mesh:
//  * prism  — a 2D profile (polygon or circle, with polygon/circle holes) in
//             the xy plane, extruded along +z from 0 to `depth`;
//  * revolve — a closed section (r, h) turned about +y by `sweep` radians from
//             `phi0`, a point at angle φ being (r·sin φ, h, r·cos φ) (three.js's
//             LatheGeometry convention).
// then placed: optionally turned +90° about x, then moved by `offset` (mm).

export type P2 = [number, number];
export type V3 = [number, number, number];

export type Loop2 = { kind: 'poly'; pts: P2[] } | { kind: 'circle'; c: P2; r: number };
export interface PrismRecipe {
  kind: 'prism';
  outer: Loop2;
  holes: Loop2[];
  depth: number;
}
export interface RevolveRecipe {
  kind: 'revolve';
  section: P2[];
  phi0: number;
  sweep: number;
}
export type Recipe = PrismRecipe | RevolveRecipe;
export interface CadPart {
  name: string;
  recipe: Recipe;
  /** turn +90° about x before moving (a lathe about y then stands on its axis along z) */
  rotX90?: boolean;
  offset?: V3;
  material?: string;
}

const EPS = 1e-7;
const TAU = Math.PI * 2;

// ---------------------------------------------------------------- 2D helpers

function area2(p: P2[]) {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j][0] - p[i][0]) * (p[j][1] + p[i][1]);
  return a / 2;
}

/** consecutive duplicates (and a closing repeat) removed */
function clean(p: P2[], tol = 1e-6): P2[] {
  const out: P2[] = [];
  for (const q of p) {
    const l = out[out.length - 1];
    if (!l || Math.hypot(q[0] - l[0], q[1] - l[1]) > tol) out.push([q[0], q[1]]);
  }
  while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= tol) out.pop();
  return out;
}

const orient = (p: P2[], ccw: boolean) => (area2(p) > 0 === ccw ? p : [...p].reverse());

// ---------------------------------------------------------------- 3D helpers

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const norm = (a: V3): V3 => scale(a, 1 / len(a));
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function perp(n: V3): V3 {
  const a: V3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return norm(cross(n, a));
}

/** rotation of a part's placement (directions) */
const rotDir = (p: CadPart, d: V3): V3 => (p.rotX90 ? [d[0], -d[2], d[1]] : d);
/** full placement (points) */
const place = (p: CadPart, q: V3): V3 => {
  const r = rotDir(p, q);
  const o = p.offset ?? [0, 0, 0];
  return [r[0] + o[0], r[1] + o[1], r[2] + o[2]];
};

// ---------------------------------------------------------------- B-rep

export type Curve = { type: 'line' } | { type: 'circle'; center: V3; axis: V3; ref: V3; r: number };
export type Surface =
  | { type: 'plane'; o: V3; n: V3 }
  | { type: 'cylinder'; o: V3; axis: V3; ref: V3; r: number }
  | { type: 'cone'; o: V3; axis: V3; ref: V3; r: number; semi: number };
export interface Edge {
  a: number;
  b: number;
  curve: Curve;
}
/** [edge index, used in its own direction] */
export type OEdge = [number, boolean];
export interface Face {
  surface: Surface;
  /** surface normal (as defined by STEP for the surface) points outwards */
  sense: boolean;
  /** outer loop first */
  loops: OEdge[][];
}
export interface Brep {
  name: string;
  verts: V3[];
  edges: Edge[];
  faces: Face[];
}

function prismBrep(name: string, r: PrismRecipe): Brep {
  const verts: V3[] = [];
  const edges: Edge[] = [];
  const faces: Face[] = [];
  const d = r.depth;
  if (!(d > 0)) throw new Error(`${name}: extrusion depth must be positive`);
  const bottom: OEdge[][] = [];
  const top: OEdge[][] = [];
  const V = (p: V3) => verts.push(p) - 1;
  const E = (a: number, b: number, curve: Curve = { type: 'line' }) => edges.push({ a, b, curve }) - 1;
  const loop = (l: Loop2, hole: boolean) => {
    if (l.kind === 'circle') {
      if (!(l.r > 0)) throw new Error(`${name}: circle radius must be positive`);
      const [cx, cy] = l.c;
      const v0 = V([cx + l.r, cy, 0]);
      const v1 = V([cx + l.r, cy, d]);
      const c0 = E(v0, v0, { type: 'circle', center: [cx, cy, 0], axis: [0, 0, 1], ref: [1, 0, 0], r: l.r });
      const c1 = E(v1, v1, { type: 'circle', center: [cx, cy, d], axis: [0, 0, 1], ref: [1, 0, 0], r: l.r });
      const s = E(v0, v1);
      const surface: Surface = { type: 'cylinder', o: [cx, cy, 0], axis: [0, 0, 1], ref: [1, 0, 0], r: l.r };
      if (!hole) {
        top.push([[c1, true]]);
        bottom.push([[c0, false]]);
        faces.push({ surface, sense: true, loops: [[[c0, true], [s, true], [c1, false], [s, false]]] });
      } else {
        top.push([[c1, false]]);
        bottom.push([[c0, true]]);
        faces.push({ surface, sense: false, loops: [[[c1, true], [s, false], [c0, false], [s, true]]] });
      }
      return;
    }
    const pts = orient(clean(l.pts), !hole);
    const n = pts.length;
    if (n < 3) throw new Error(`${name}: a profile loop needs at least 3 points`);
    const b = pts.map(([x, y]) => V([x, y, 0]));
    const t = pts.map(([x, y]) => V([x, y, d]));
    const eb = b.map((_, i) => E(b[i], b[(i + 1) % n]));
    const et = t.map((_, i) => E(t[i], t[(i + 1) % n]));
    const ev = b.map((_, i) => E(b[i], t[i]));
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const [dx, dy] = [pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]];
      faces.push({
        surface: { type: 'plane', o: [pts[i][0], pts[i][1], 0], n: norm([dy, -dx, 0]) },
        sense: true,
        loops: [[[eb[i], true], [ev[j], true], [et[i], false], [ev[i], false]]],
      });
    }
    bottom.push([...eb].reverse().map((e) => [e, false] as OEdge));
    top.push(et.map((e) => [e, true] as OEdge));
  };
  loop(r.outer, false);
  for (const h of r.holes) loop(h, true);
  faces.push({ surface: { type: 'plane', o: [0, 0, 0], n: [0, 0, -1] }, sense: true, loops: bottom });
  faces.push({ surface: { type: 'plane', o: [0, 0, d], n: [0, 0, 1] }, sense: true, loops: top });
  return { name, verts, edges, faces };
}

/** the revolve's section, cleaned, on or off the axis (r ≥ 0), CCW in (r, h) */
const rawSection = (r: RevolveRecipe) => orient(clean(r.section.map(([x, h]) => [x < 1e-6 ? 0 : x, h] as P2)), true);

export function revolveSection(r: RevolveRecipe): P2[] {
  const s = rawSection(r);
  // a slanted edge running onto the axis would sweep a cone with its apex on the axis, which
  // some readers (Waffle Iron among them) won't ingest exactly: end it AXIS_FLAT_MM short with
  // a flat (a disc on the axis) instead — far below anything a printer resolves
  const out: P2[] = [];
  const n = s.length;
  s.forEach((q, i) => {
    if (q[0] !== 0) return out.push(q);
    const prev = s[(i - 1 + n) % n];
    const next = s[(i + 1) % n];
    const slanted = (o: P2) => o[0] !== 0 && Math.abs(o[1] - q[1]) > EPS;
    if (slanted(prev)) out.push([AXIS_FLAT_MM, q[1]]);
    out.push(q);
    if (slanted(next)) out.push([AXIS_FLAT_MM, q[1]]);
  });
  return out;
}
const AXIS_FLAT_MM = 0.01;

function revolveBrep(name: string, rc: RevolveRecipe): Brep {
  const sec = revolveSection(rc);
  const n = sec.length;
  if (n < 3) throw new Error(`${name}: a revolve section needs at least 3 points`);
  if (Math.abs(area2(sec)) < 1e-6) throw new Error(`${name}: the revolve section has no area`);
  const full = rc.sweep >= TAU - 1e-9;
  if (!(rc.sweep > 0)) throw new Error(`${name}: sweep must be positive`);
  const phi0 = full ? 0 : rc.phi0;
  const phi1 = phi0 + rc.sweep;
  const P = (r: number, h: number, phi: number): V3 => [r * Math.sin(phi), h, r * Math.cos(phi)];
  const verts: V3[] = [];
  const edges: Edge[] = [];
  const faces: Face[] = [];
  const V = (p: V3) => verts.push(p) - 1;
  const E = (a: number, b: number, curve: Curve = { type: 'line' }) => edges.push({ a, b, curve }) - 1;
  const circ = (h: number, r: number): Curve => ({ type: 'circle', center: [0, h, 0], axis: [0, 1, 0], ref: [0, 0, 1], r });
  const onAxis = sec.map(([r]) => r === 0);
  // vertices at phi0 (v0) and phi1 (v1); one vertex for points on the axis, and for a full turn
  const v0 = sec.map(([r, h]) => V(P(r, h, phi0)));
  const v1 = sec.map(([r, h], i) => (full || onAxis[i] ? v0[i] : V(P(r, h, phi1))));
  // each off-axis point sweeps a circle (full) or an arc phi0 → phi1
  const ring = sec.map(([r, h], i) => (onAxis[i] ? -1 : E(v0[i], v1[i], circ(h, r))));
  // the section's edges at phi0 and phi1 (the same edge when it lies on the axis, or for a full turn: the seam)
  const l0 = sec.map((_, i) => E(v0[i], v0[(i + 1) % n]));
  const l1 = sec.map((_, i) => {
    const j = (i + 1) % n;
    return full || (onAxis[i] && onAxis[j]) ? l0[i] : E(v1[i], v1[j]);
  });
  const used = new Set<number>();
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (onAxis[i] && onAxis[j]) continue;
    const [ri, hi] = sec[i];
    const [rj, hj] = sec[j];
    const dh = hj - hi;
    const dr = rj - ri;
    let surface: Surface;
    let sense = true;
    if (Math.abs(dh) < EPS) surface = { type: 'plane', o: [0, hi, 0], n: [0, dr > 0 ? -1 : 1, 0] };
    else {
      // outward normal of a CCW section edge is (dh, −dr): away from the axis iff dh > 0
      sense = dh > 0;
      if (Math.abs(dr) < EPS) surface = { type: 'cylinder', o: [0, hi, 0], axis: [0, 1, 0], ref: [0, 0, 1], r: ri };
      else {
        const big = rj > ri ? j : i;
        const small = big === j ? i : j;
        const dir = Math.sign(sec[big][1] - sec[small][1]);
        surface = { type: 'cone', o: [0, sec[big][1], 0], axis: [0, dir, 0], ref: [0, 0, 1], r: sec[big][0], semi: Math.atan(Math.abs(dr) / Math.abs(dh)) };
      }
    }
    if (full && surface.type === 'plane') {
      // an annulus (or a disc): its two circles as separate loops, the larger outside
      const loops: OEdge[][] = [];
      if (!onAxis[i]) loops.push([[ring[i], true]]);
      if (!onAxis[j]) loops.push([[ring[j], false]]);
      if (loops.length === 2 && ri < rj) loops.reverse();
      faces.push({ surface, sense, loops });
      continue;
    }
    const lp: OEdge[] = [];
    if (!onAxis[i]) lp.push([ring[i], true]);
    lp.push([l1[i], true]);
    if (!onAxis[j]) lp.push([ring[j], false]);
    lp.push([l0[i], false]);
    used.add(l0[i]);
    faces.push({ surface, sense, loops: [lp] });
  }
  if (!full) {
    const t0: V3 = [Math.cos(phi0), 0, -Math.sin(phi0)];
    const t1: V3 = [Math.cos(phi1), 0, -Math.sin(phi1)];
    faces.push({ surface: { type: 'plane', o: [0, sec[0][1], 0], n: scale(t0, -1) }, sense: true, loops: [l0.map((e) => [e, true] as OEdge)] });
    faces.push({ surface: { type: 'plane', o: [0, sec[0][1], 0], n: t1 }, sense: true, loops: [[...l1].reverse().map((e) => [e, false] as OEdge)] });
  }
  // a full turn: seams that no curved face used (between two planar annuli) are not edges at all
  if (full) {
    const keep = new Set<number>();
    for (const f of faces) for (const l of f.loops) for (const [e] of l) keep.add(e);
    const remap = new Map<number, number>();
    const ne: Edge[] = [];
    edges.forEach((e, k) => {
      if (keep.has(k)) remap.set(k, ne.push(e) - 1);
    });
    for (const f of faces) f.loops = f.loops.map((l) => l.map(([e, s]) => [remap.get(e)!, s] as OEdge));
    const usedV = new Set(ne.flatMap((e) => [e.a, e.b]));
    const vmap = new Map<number, number>();
    const nv: V3[] = [];
    verts.forEach((v, k) => {
      if (usedV.has(k)) vmap.set(k, nv.push(v) - 1);
    });
    for (const e of ne) {
      e.a = vmap.get(e.a)!;
      e.b = vmap.get(e.b)!;
    }
    return { name, verts: nv, edges: ne, faces };
  }
  return { name, verts, edges, faces };
}

export function partBrep(p: CadPart): Brep {
  return p.recipe.kind === 'prism' ? prismBrep(p.name, p.recipe) : revolveBrep(p.name, p.recipe);
}

/**
 * Topology check of a B-rep: every loop closes, and every edge is used exactly
 * twice — once in each direction — so the shell is closed and consistently
 * oriented. Returns the problems (empty = sound).
 */
export function brepProblems(b: Brep): string[] {
  const out: string[] = [];
  const uses = b.edges.map(() => [0, 0]);
  b.faces.forEach((f, fi) =>
    f.loops.forEach((l, li) => {
      for (let k = 0; k < l.length; k++) {
        const [e, s] = l[k];
        const [ne, ns] = l[(k + 1) % l.length];
        const end = s ? b.edges[e].b : b.edges[e].a;
        const start = ns ? b.edges[ne].a : b.edges[ne].b;
        if (end !== start) out.push(`${b.name}: face ${fi} loop ${li} breaks after edge ${e}`);
        uses[e][s ? 0 : 1]++;
      }
    })
  );
  uses.forEach(([f, r], e) => {
    if (f !== 1 || r !== 1) out.push(`${b.name}: edge ${e} used ${f}× forwards and ${r}× backwards`);
  });
  return out;
}

// ---------------------------------------------------------------- recipe measures

/** exact volume (mm³) of a part's recipe */
export function recipeVolume(r: Recipe): number {
  if (r.kind === 'prism') {
    const a = (l: Loop2) => (l.kind === 'circle' ? Math.PI * l.r * l.r : Math.abs(area2(clean(l.pts))));
    return (a(r.outer) - r.holes.reduce((s, h) => s + a(h), 0)) * r.depth;
  }
  // Pappus: area × centroid radius × sweep
  const s = revolveSection(r);
  let A = 0;
  let Cr = 0;
  for (let i = 0; i < s.length; i++) {
    const [x0, y0] = s[i];
    const [x1, y1] = s[(i + 1) % s.length];
    const c = x0 * y1 - x1 * y0;
    A += c;
    Cr += (x0 + x1) * c;
  }
  A /= 2;
  Cr /= 6 * A;
  return Math.abs(A) * Cr * Math.min(r.sweep, TAU);
}

/** points on a part's boundary (mm, placed): enough for a bounding box */
export function partSamples(p: CadPart): V3[] {
  const r = p.recipe;
  const out: V3[] = [];
  if (r.kind === 'prism') {
    const ring = (l: Loop2): P2[] => (l.kind === 'poly' ? l.pts : Array.from({ length: 64 }, (_, k) => [l.c[0] + l.r * Math.cos((k / 64) * TAU), l.c[1] + l.r * Math.sin((k / 64) * TAU)] as P2));
    for (const [x, y] of ring(r.outer)) for (const z of [0, r.depth]) out.push(place(p, [x, y, z]));
  } else {
    const full = r.sweep >= TAU - 1e-9;
    for (const [rr, h] of revolveSection(r))
      for (let k = 0; k <= 48; k++) {
        const phi = (full ? 0 : r.phi0) + (Math.min(r.sweep, TAU) * k) / 48;
        out.push(place(p, [rr * Math.sin(phi), h, rr * Math.cos(phi)]));
      }
  }
  return out;
}

export function partBounds(p: CadPart): { min: V3; max: V3 } {
  const s = partSamples(p);
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const q of s)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], q[k]);
      max[k] = Math.max(max[k], q[k]);
    }
  return { min, max };
}

/** Lay parts out side by side on the bed plane (z ≥ 0), in rows no wider than `rowMm`. */
export function layOut(parts: CadPart[], gapMm = 20, rowMm = 1200): CadPart[] {
  let x = 0;
  let rowY = 0;
  let rowH = 0;
  return parts.map((p) => {
    const b = partBounds({ ...p, offset: [0, 0, 0] });
    const w = b.max[0] - b.min[0];
    const h = b.max[1] - b.min[1];
    if (x > 0 && x + w > rowMm) {
      x = 0;
      rowY += rowH + gapMm;
      rowH = 0;
    }
    const q: CadPart = { ...p, offset: [x - b.min[0], rowY - b.min[1], -b.min[2]] };
    x += w + gapMm;
    rowH = Math.max(rowH, h);
    return q;
  });
}

// ---------------------------------------------------------------- STEP

/** a STEP REAL: always with a decimal point, exponent as E */
export function stepReal(x: number): string {
  if (!Number.isFinite(x)) throw new Error(`STEP export: non-finite number ${x}`);
  if (Math.abs(x) < 1e-12) return '0.';
  let s = String(+x.toPrecision(15));
  if (s.includes('e')) {
    const [m, e] = s.split('e');
    s = `${m.includes('.') ? m : `${m}.`}E${e}`;
  } else if (!s.includes('.')) s += '.';
  return s;
}
const stepString = (s: string) => s.replace(/[^ -~]/g, '_').replace(/'/g, "''");

/**
 * One STEP file with every part as its own named solid, in millimetres. Each
 * part is checked first (closed, consistently oriented); a bad one is an error,
 * never a partial file.
 */
export function writeStep(parts: CadPart[], fileName: string): string {
  if (!parts.length) throw new Error('STEP export: nothing to export');
  const breps = parts.map((p) => {
    const b = partBrep(p);
    const bad = brepProblems(b);
    if (bad.length) throw new Error(`STEP export: ${bad.slice(0, 3).join('; ')}`);
    return b;
  });
  const ent: string[] = [];
  const add = (s: string) => ent.push(s);
  const product = stepString(fileName.replace(/\.(step|stp)$/i, '') || 'Part');
  const app = add("APPLICATION_CONTEXT('core data for automotive mechanical design processes')");
  add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2010,#${app})`);
  const pctx = add(`PRODUCT_CONTEXT('',#${app},'mechanical')`);
  const prod = add(`PRODUCT('${product}','${product}','',(#${pctx}))`);
  add(`PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(#${prod}))`);
  const form = add(`PRODUCT_DEFINITION_FORMATION('','',#${prod})`);
  const dctx = add(`PRODUCT_DEFINITION_CONTEXT('part definition',#${app},'design')`);
  const def = add(`PRODUCT_DEFINITION('design','',#${form},#${dctx})`);
  const pds = add(`PRODUCT_DEFINITION_SHAPE('','',#${def})`);
  const lu = add('( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )');
  const au = add('( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) )');
  const su = add('( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() )');
  const unc = add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(${stepReal(1e-6)}),#${lu},'distance_accuracy_value','confusion accuracy')`);
  const ctx = add(
    `( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${unc})) GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lu},#${au},#${su})) REPRESENTATION_CONTEXT('','3D') )`
  );
  const cp = (p: V3) => add(`CARTESIAN_POINT('',(${p.map(stepReal).join(',')}))`);
  const dir = (d: V3) => add(`DIRECTION('',(${norm(d).map(stepReal).join(',')}))`);
  const axis2 = (o: V3, z: V3, x: V3) => {
    const a = cp(o);
    const b = dir(z);
    const c = dir(x);
    return add(`AXIS2_PLACEMENT_3D('',#${a},#${b},#${c})`);
  };
  const world = axis2([0, 0, 0], [0, 0, 1], [1, 0, 0]);
  const solids: number[] = [];
  breps.forEach((b, bi) => {
    const part = parts[bi];
    const P = (q: V3) => place(part, q);
    const D = (q: V3) => rotDir(part, q);
    const vid = b.verts.map((v) => add(`VERTEX_POINT('',#${cp(P(v))})`));
    const eid = b.edges.map((e) => {
      let curve: number;
      if (e.curve.type === 'line') {
        const d = sub(b.verts[e.b], b.verts[e.a]);
        if (len(d) < 1e-9) throw new Error(`STEP export: ${b.name} has a zero-length edge`);
        const pt = cp(P(b.verts[e.a]));
        const vec = add(`VECTOR('',#${dir(D(d))},${stepReal(1)})`);
        curve = add(`LINE('',#${pt},#${vec})`);
      } else {
        const c = e.curve;
        curve = add(`CIRCLE('',#${axis2(P(c.center), D(c.axis), D(c.ref))},${stepReal(c.r)})`);
      }
      return add(`EDGE_CURVE('',#${vid[e.a]},#${vid[e.b]},#${curve},.T.)`);
    });
    const fids = b.faces.map((f) => {
      const s = f.surface;
      let surf: number;
      if (s.type === 'plane') surf = add(`PLANE('',#${axis2(P(s.o), D(s.n), D(perp(s.n)))})`);
      else if (s.type === 'cylinder') surf = add(`CYLINDRICAL_SURFACE('',#${axis2(P(s.o), D(s.axis), D(s.ref))},${stepReal(s.r)})`);
      else surf = add(`CONICAL_SURFACE('',#${axis2(P(s.o), D(s.axis), D(s.ref))},${stepReal(s.r)},${stepReal(s.semi)})`);
      const bounds = f.loops.map((l, li) => {
        const oe = l.map(([e, fw]) => `#${add(`ORIENTED_EDGE('',*,*,#${eid[e]},${fw ? '.T.' : '.F.'})`)}`);
        const loop = add(`EDGE_LOOP('',(${oe.join(',')}))`);
        return `#${add(`${li === 0 ? 'FACE_OUTER_BOUND' : 'FACE_BOUND'}('',#${loop},.T.)`)}`;
      });
      return `#${add(`ADVANCED_FACE('',(${bounds.join(',')}),#${surf},${f.sense ? '.T.' : '.F.'})`)}`;
    });
    const shell = add(`CLOSED_SHELL('',(${fids.join(',')}))`);
    solids.push(add(`MANIFOLD_SOLID_BREP('${stepString(b.name)}',#${shell})`));
  });
  const rep = add(`ADVANCED_BREP_SHAPE_REPRESENTATION('',(#${world},${solids.map((s) => `#${s}`).join(',')}),#${ctx})`);
  add(`SHAPE_DEFINITION_REPRESENTATION(#${pds},#${rep})`);
  const head = [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('Speaker designer exact B-Rep export'),'2;1');",
    `FILE_NAME('${stepString(fileName)}','${new Date().toISOString().slice(0, 19)}',(''),(''),'Speaker designer','Speaker designer','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    'ENDSEC;',
    'DATA;',
  ];
  return [...head, ...ent.map((e, i) => `#${i + 1} = ${e};`), 'ENDSEC;', 'END-ISO-10303-21;', ''].join('\n');
}

// ---------------------------------------------------------------- Waffle Iron

export const WAFFLE_FORMAT_VERSION = 15;
/** how far a revolve's on-axis points are kept off the axis in a .waffle (mm) */
export const AXIS_CLEARANCE_MM = 0.01;
const XY_DATUM = '00000000-0000-0000-0000-000000000001';

/** densities for the material table (so Waffle Iron can report each part's mass) */
export const CAD_MATERIALS: Record<string, { density_kg_m3: number; appearance?: [number, number, number] }> = {
  PETG: { density_kg_m3: 1270, appearance: [0.85, 0.85, 0.82] },
  PLA: { density_kg_m3: 1240, appearance: [0.85, 0.85, 0.82] },
  'Birch plywood': { density_kg_m3: 680, appearance: [0.86, 0.72, 0.52] },
  MDF: { density_kg_m3: 750, appearance: [0.62, 0.5, 0.36] },
  'Laminated glass': { density_kg_m3: 2500, appearance: [0.7, 0.85, 0.85] },
  Acrylic: { density_kg_m3: 1190, appearance: [0.8, 0.9, 0.95] },
};

const uuid = () => globalThis.crypto.randomUUID();
const M = (mm: number) => mm / 1000;

interface SketchOut {
  entities: unknown[];
  /** ids of the entities of each loop, outer first */
  loopIds: number[][];
}

function sketchLoops(loops: Loop2[], toUV: (p: P2) => P2): SketchOut {
  const entities: unknown[] = [];
  const loopIds: number[][] = [];
  let pid = 1;
  let eid = 10000;
  for (const l of loops) {
    if (l.kind === 'circle') {
      const [u, v] = toUV(l.c);
      const c = pid++;
      entities.push({ type: 'Point', id: c, x: M(u), y: M(v), construction: true });
      const id = eid++;
      entities.push({ type: 'Circle', id, center_id: c, radius: M(l.r), construction: false });
      loopIds.push([id]);
      continue;
    }
    const pts = l.pts.map(toUV);
    const ids = pts.map(([u, v]) => {
      const id = pid++;
      entities.push({ type: 'Point', id, x: M(u), y: M(v), construction: false });
      return id;
    });
    const lines = ids.map((a, i) => {
      const id = eid++;
      entities.push({ type: 'Line', id, start_id: a, end_id: ids[(i + 1) % ids.length], construction: false });
      return id;
    });
    loopIds.push(lines);
  }
  return { entities, loopIds };
}

function sketchFeature(name: string, origin: V3, normal: V3, xAxis: V3, sk: SketchOut) {
  const id = uuid();
  return {
    id,
    feature: {
      id,
      name,
      operation: {
        type: 'Sketch',
        sketch: {
          id: uuid(),
          plane: { kind: { type: 'Face' }, anchor: { type: 'Datum', datum_id: XY_DATUM }, selector: { type: 'Role', role: { type: 'EndCapPositive' }, index: 0 }, policy: { type: 'Strict' } },
          plane_origin: origin.map(M),
          plane_normal: norm(normal),
          plane_x_axis: norm(xAxis),
          entities: sk.entities,
          constraints: [],
          solve_status: { type: 'Unsolved' },
        },
      },
      suppressed: false,
      references: [],
    },
  };
}

/** a loop as a region boundary (metres, sketch uv): sampled polygon + exact edges */
function regionLoop(l: Loop2, ccw: boolean): { poly: P2[]; edges: unknown[] } {
  if (l.kind === 'circle') {
    const [cx, cy] = l.c.map(M);
    const r = M(l.r);
    const n = Math.max(24, Math.ceil(Math.PI / Math.acos(1 - 1e-3)));
    const s = ccw ? 1 : -1;
    const poly = Array.from({ length: n }, (_, k) => [cx + r * Math.cos((s * k * TAU) / n), cy + r * Math.sin((s * k * TAU) / n)] as P2);
    // four quarter arcs (the kernel takes minor arcs only), sharing exact endpoints
    const q: P2[] = [[cx + r, cy], [cx, cy + s * r], [cx - r, cy], [cx, cy - s * r]];
    return { poly, edges: q.map((a, k) => ({ kind: 'Arc', a, b: q[(k + 1) % 4], center: [cx, cy], radius: r, ccw })) };
  }
  const pts = orient(clean(l.pts), ccw).map(([x, y]) => [M(x), M(y)] as P2);
  return { poly: pts, edges: pts.map((a, i) => ({ kind: 'Line', a, b: pts[(i + 1) % pts.length] })) };
}

/**
 * A Waffle Iron document: one Part tab, each part a sketch plus an extrude (prism,
 * with its holes as an explicit region) or a revolve, as its own named body with
 * its material.
 */
export function writeWaffle(parts: CadPart[], docName: string): string {
  const features: unknown[] = [];
  const bodyNames: Record<string, string> = {};
  const bodyMaterials: Record<string, string> = {};
  const usedMaterials = new Set<string>();
  for (const p of parts) {
    const r = p.recipe;
    let fid: string;
    if (r.kind === 'prism') {
      const origin = place(p, [0, 0, 0]);
      const sk = sketchFeature(`${p.name} — profile`, origin, rotDir(p, [0, 0, 1]), rotDir(p, [1, 0, 0]), sketchLoops([r.outer, ...r.holes], (q) => q));
      features.push(sk.feature);
      const outer = regionLoop(r.outer, true);
      // holes too are listed CCW: Waffle Iron's kernel turns them round itself (a CW arc ring is refused)
      const holes = r.holes.map((h) => regionLoop(h, true));
      fid = uuid();
      features.push({
        id: fid,
        name: p.name,
        operation: {
          type: 'Extrude',
          params: {
            sketch_id: sk.id,
            profile_index: 0,
            depth: M(r.depth),
            direction: null,
            symmetric: false,
            cut: false,
            merge: false,
            target_body: null,
            depth_mode: { type: 'Blind' },
            second_direction: null,
            region: {
              outer: outer.poly,
              ...(holes.length ? { holes: holes.map((h) => h.poly) } : {}),
              area: (recipeVolume(r) / r.depth) * 1e-6,
              outer_edges: outer.edges,
              ...(holes.length ? { hole_edges: holes.map((h) => h.edges) } : {}),
            },
            combine: { type: 'NewBody' },
            targets: [],
          },
        },
        suppressed: false,
        references: [],
      });
    } else {
      const full = r.sweep >= TAU - 1e-9;
      const phi0 = full ? 0 : r.phi0;
      // sketch plane through the axis at phi0: u along the axis (h), v outwards (r)
      const normal: V3 = [Math.cos(phi0), 0, -Math.sin(phi0)];
      const origin = place(p, [0, 0, 0]);
      // Waffle Iron's revolve builds a section that touches the axis only for a few simple shapes,
      // so points on the axis sit AXIS_CLEARANCE_MM off it (a hairline far below any nozzle)
      const loops = sketchLoops([{ kind: 'poly', pts: clean(rawSection(r).map(([rr, h]) => [h, Math.max(rr, AXIS_CLEARANCE_MM)] as P2)) }], (q) => q);
      const sk = sketchFeature(`${p.name} — section`, origin, rotDir(p, normal), rotDir(p, [0, 1, 0]), loops);
      features.push(sk.feature);
      fid = uuid();
      features.push({
        id: fid,
        name: p.name,
        operation: {
          type: 'Revolve',
          params: {
            sketch_id: sk.id,
            profile_index: 0,
            profile_entity_ids: loops.loopIds[0],
            axis_origin: origin.map(M),
            axis_direction: rotDir(p, [0, 1, 0]),
            angle: (Math.min(r.sweep, TAU) * 180) / Math.PI,
            cut: false,
            merge: false,
            combine: { type: 'NewBody' },
            targets: [],
          },
        },
        suppressed: false,
        references: [],
      });
    }
    bodyNames[`${fid}/Main`] = p.name;
    if (p.material && CAD_MATERIALS[p.material]) {
      bodyMaterials[`${fid}/Main`] = p.material;
      usedMaterials.add(p.material);
    }
  }
  const now = new Date().toISOString();
  const tab = uuid();
  const tree: Record<string, unknown> = { features, active_index: null };
  if (Object.keys(bodyNames).length) tree.body_names = bodyNames;
  if (usedMaterials.size) {
    tree.materials = [...usedMaterials].map((name) => ({ name, density_kg_m3: CAD_MATERIALS[name].density_kg_m3, ...(CAD_MATERIALS[name].appearance ? { appearance: { color: CAD_MATERIALS[name].appearance } } : {}) }));
    tree.body_materials = bodyMaterials;
  }
  return JSON.stringify(
    {
      format: 'waffle-iron',
      version: WAFFLE_FORMAT_VERSION,
      min_reader_version: WAFFLE_FORMAT_VERSION,
      document: { id: uuid(), name: docName, created: now, modified: now, display_unit: 'mm' },
      sources: [],
      tabs: [{ id: tab, name: docName, kind: { type: 'Part', features: tree, preview_mesh: null } }],
      active_tab: tab,
      'x-speaker-designer': { generator: 'speaker-designer', parts: parts.length },
    },
    null,
    1
  );
}
