// Image-source reflections for a room with a real outline: vertical walls along
// any polygon (the bay's angled facets included), plus the floor and ceiling.
// Every image is validated per listening point by tracing the path back from
// the listener: each bounce must land on its actual surface (inside the
// segment, below the ceiling, inside the floor outline). Bounces that land in
// an opening are lost (the sound leaves the room); bounces off window glass
// use glass's own absorption, which falls with frequency.

import type { RoomConfig, Vec3 } from './roomAcoustics';
import type { AppShape } from './roomShape';

interface Hole {
  u0: number;
  u1: number;
  z0: number;
  z1: number;
  kind: 'window' | 'opening';
}

export interface Surface {
  kind: 'wall' | 'floor' | 'ceiling';
  /** inward unit normal and plane offset: n·p = d on the surface, > d inside */
  n: Vec3;
  d: number;
  /** walls: start point, along-wall unit vector, length */
  a?: [number, number];
  u?: [number, number];
  len?: number;
  holes: Hole[];
}

export interface Room3 {
  surfaces: Surface[];
  poly: [number, number][];
  H: number;
}

/** Surfaces of the room: the outline's walls (with windows/openings) + floor + ceiling. */
export function buildRoom(room: RoomConfig, shape: AppShape | null): Room3 {
  const H = room.heightM;
  const W = room.widthM;
  const D = room.depthM;
  const poly: [number, number][] = shape
    ? shape.outline
    : [
        [0, 0],
        [W, 0],
        [W, D],
        [0, D],
      ];
  const cx = poly.reduce((a, p) => a + p[0], 0) / poly.length;
  const cy = poly.reduce((a, p) => a + p[1], 0) / poly.length;
  const surfaces: Surface[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-3) continue;
    const u: [number, number] = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    let n: Vec3 = { x: -u[1], y: u[0], z: 0 };
    let d = n.x * a[0] + n.y * a[1];
    if (n.x * cx + n.y * cy - d < 0) {
      n = { x: -n.x, y: -n.y, z: 0 };
      d = -d;
    }
    const feats = shape?.segments[i]?.features ?? [];
    surfaces.push({
      kind: 'wall',
      n,
      d,
      a,
      u,
      len,
      holes: feats.map((f) => ({ u0: f.centerM - f.widthM / 2, u1: f.centerM + f.widthM / 2, z0: f.sillM, z1: f.headM, kind: f.kind })),
    });
  }
  surfaces.push({ kind: 'floor', n: { x: 0, y: 0, z: 1 }, d: 0, holes: [] });
  surfaces.push({ kind: 'ceiling', n: { x: 0, y: 0, z: -1 }, d: -H, holes: [] });
  return { surfaces, poly, H };
}

export interface ImageSource {
  pos: Vec3;
  aim: Vec3;
  /** surface indices in the order the sound hits them */
  path: number[];
}

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const mirrorP = (p: Vec3, s: Surface): Vec3 => {
  const k = 2 * (dot(s.n, p) - s.d);
  return { x: p.x - k * s.n.x, y: p.y - k * s.n.y, z: p.z - k * s.n.z };
};
const mirrorV = (v: Vec3, s: Surface): Vec3 => {
  const k = 2 * dot(s.n, v);
  return { x: v.x - k * s.n.x, y: v.y - k * s.n.y, z: v.z - k * s.n.z };
};

/** The source itself plus its images up to `order` bounces. */
export function imageSources(src: Vec3, aim: Vec3, room: Room3, order: number): ImageSource[] {
  const out: ImageSource[] = [{ pos: src, aim, path: [] }];
  let frontier = out.slice();
  for (let o = 1; o <= order; o++) {
    const next: ImageSource[] = [];
    for (const im of frontier) {
      room.surfaces.forEach((s, si) => {
        if (im.path[im.path.length - 1] === si) return;
        // the (image) source must face the surface from the room side
        if (dot(s.n, im.pos) - s.d <= 1e-6) return;
        next.push({ pos: mirrorP(im.pos, s), aim: mirrorV(im.aim, s), path: [...im.path, si] });
      });
    }
    out.push(...next);
    frontier = next;
  }
  return out;
}

function insidePoly(x: number, y: number, poly: [number, number][]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Average absorption of single-pane window glass (octave bands, typical tables). */
export function glassAlpha(f: number) {
  const bands: [number, number][] = [
    [125, 0.35],
    [250, 0.25],
    [500, 0.18],
    [1000, 0.12],
    [2000, 0.07],
    [4000, 0.04],
  ];
  if (f <= bands[0][0]) return bands[0][1];
  for (let i = 1; i < bands.length; i++) {
    if (f <= bands[i][0]) {
      const t = Math.log(f / bands[i - 1][0]) / Math.log(bands[i][0] / bands[i - 1][0]);
      return bands[i - 1][1] + t * (bands[i][1] - bands[i - 1][1]);
    }
  }
  return bands[bands.length - 1][1];
}

/**
 * Amplitude factor of an image's path to `rcv` (product of the reflection
 * factors), or 0 when the path doesn't actually exist (misses its surface or
 * leaves through an opening).
 */
export function pathGain(img: ImageSource, src: Vec3, rcv: Vec3, room: Room3, Rwall: number, Rglass: number): number {
  if (!img.path.length) return 1;
  // the chain of images: I0 = source, I1 … In = img.pos
  let g = 1;
  let q = rcv;
  // walk back: the last bounce first. Rebuild the intermediate images on the fly.
  const chain: Vec3[] = [src];
  for (const si of img.path) chain.push(mirrorP(chain[chain.length - 1], room.surfaces[si]));
  for (let k = img.path.length; k >= 1; k--) {
    const s = room.surfaces[img.path[k - 1]];
    const t0 = chain[k];
    const dir = { x: t0.x - q.x, y: t0.y - q.y, z: t0.z - q.z };
    const den = dot(s.n, dir);
    if (Math.abs(den) < 1e-12) return 0;
    const t = (s.d - dot(s.n, q)) / den;
    if (t <= 1e-6 || t >= 1 - 1e-6) return 0;
    const p = { x: q.x + t * dir.x, y: q.y + t * dir.y, z: q.z + t * dir.z };
    if (s.kind === 'wall') {
      const u = (p.x - s.a![0]) * s.u![0] + (p.y - s.a![1]) * s.u![1];
      if (u < 0 || u > s.len! || p.z < 0 || p.z > room.H) return 0;
      let r = Rwall;
      for (const h of s.holes) {
        if (u >= h.u0 && u <= h.u1 && p.z >= h.z0 && p.z <= h.z1) {
          if (h.kind === 'opening') return 0;
          r = Rglass;
        }
      }
      g *= r;
    } else {
      if (!insidePoly(p.x, p.y, room.poly)) return 0;
      g *= Rwall;
    }
    q = p;
  }
  return g;
}
