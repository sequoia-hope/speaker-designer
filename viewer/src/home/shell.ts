// Curved / spherical printed enclosures: an egg-shaped shell that is a solid of
// revolution about the woofer's axis (the way spherical speakers are made — e.g.
// B&W's "Nautilus" heads), with a flat circular mounting land at the front pole
// and the woofer hole in it. Because shell, land and hole are all one revolved
// cross-section, every part is a clean watertight solid: the 3D view, the
// cut-in-half section and the STL bands need no 3D booleans.
//
// Shape: outer radius along the axis  R(u) = Rmax · (1 − |u|^n)^(1/n),
// u ∈ [−1, 1] from the back pole to the (truncated) front; n = 2 is an
// ellipsoid (a sphere when length = diameter), larger n a fuller capsule.
// No parallel walls inside, and the front edge curves away gently — the two
// reasons curved enclosures measure smoother (internal standing waves and
// edge diffraction), and why woodworkers rarely build them.

import type { DriverInfo } from './drivers';

export interface ShellSpec {
  /** max diameter (mm) and length along the axis (mm) */
  diaMm: number;
  lengthMm: number;
  /** 2 = ellipsoid/sphere … 6 = capsule */
  n: number;
  wallMm: number;
}

export interface ShellGeometry {
  spec: ShellSpec;
  Rmax: number;
  /** axial position (mm from the back pole) of the front land, and its radius */
  zFront: number;
  landR: number;
  /** woofer cut-out radius in the land */
  holeR: number;
  /** closed cross-section to revolve: [r, z] (r ≥ 0), back pole at z = 0, front at zFront */
  section: [number, number][];
  /** net internal volume (L), excluding the driver */
  netL: number;
  /** curvature radius of the shell where it meets the land (mm) — an "edge radius" for diffraction */
  edgeRadiusMm: number;
  problems: string[];
}

const outerR = (s: ShellSpec, u: number) => (s.diaMm / 2) * Math.pow(Math.max(0, 1 - Math.pow(Math.abs(u), s.n)), 1 / s.n);

export function shellGeometry(s: ShellSpec, woofer: DriverInfo): ShellGeometry {
  const problems: string[] = [];
  const Rmax = s.diaMm / 2;
  const L = s.lengthMm;
  const t = s.wallMm;
  const landR = woofer.frameDiaMm / 2 + 12;
  const holeR = woofer.cutoutDiaMm / 2;
  if (landR >= Rmax - t) problems.push(`The woofer (Ø${woofer.frameDiaMm} mm) needs a Ø${Math.round(2 * landR)} mm flat front, but the shell is only Ø${s.diaMm} mm — make it bigger.`);
  // u along the axis: back pole u = −1 at z = 0; the front is cut where R = landR
  const zOf = (u: number) => ((u + 1) / 2) * L;
  let uf = 1;
  for (let u = 0; u <= 1; u += 0.0005)
    if (outerR(s, u) <= landR) {
      uf = u;
      break;
    }
  const zFront = zOf(uf);
  // the section, outer surface back → front, land, then inner surface front → back
  const N = 120;
  const outer: [number, number][] = [];
  for (let i = 0; i <= N; i++) {
    const u = -1 + ((uf + 1) * i) / N;
    outer.push([outerR(s, u), zOf(u)]);
  }
  outer[0] = [0, 0];
  outer[outer.length - 1] = [landR, zFront];
  const inner: [number, number][] = [];
  for (let i = N; i >= 0; i--) {
    const u = -1 + ((uf + 1) * i) / N;
    const z = zOf(u);
    if (z < t || z > zFront - t) continue;
    inner.push([Math.max(0, outerR(s, u) - t), z]);
  }
  const rInAtLand = Math.max(holeR + 2, outerR(s, uf - (2 * t) / L) - t);
  const section: [number, number][] = [
    ...outer,
    [holeR, zFront], // the land, inwards to the woofer hole
    [holeR, zFront - t],
    [rInAtLand, zFront - t], // back face of the land, out to the inner wall
    ...inner,
    [0, t],
  ];
  // net volume: ∫ π r_in² dz between the back wall and the land
  let V = 0;
  const steps = 400;
  for (let i = 0; i < steps; i++) {
    const z0 = t + ((zFront - 2 * t) * i) / steps;
    const z1 = t + ((zFront - 2 * t) * (i + 1)) / steps;
    const u = ((z0 + z1) / 2 / L) * 2 - 1;
    const r = Math.max(0, outerR(s, u) - t);
    V += Math.PI * r * r * (z1 - z0);
  }
  const netL = V / 1e6 - (woofer.displacementL ?? 0.6);
  if ((woofer.mountDepthMm ?? 80) > zFront - 2 * t) problems.push(`The shell is too short for the woofer's ${woofer.mountDepthMm} mm mounting depth.`);
  // curvature radius where the shell meets the land: from three nearby surface points
  const p = (u: number): [number, number] => [zOf(u), outerR(s, u)];
  const [a, b, c] = [p(uf - 0.06), p(uf - 0.03), p(uf)];
  const area2 = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  const dist = (x: [number, number], y: [number, number]) => Math.hypot(x[0] - y[0], x[1] - y[1]);
  const edgeRadiusMm = area2 > 1e-9 ? (dist(a, b) * dist(b, c) * dist(a, c)) / (2 * area2) : 1000;
  return { spec: s, Rmax, zFront, landR, holeR, section, netL, edgeRadiusMm: Math.min(edgeRadiusMm, 2000), problems };
}

/** Bands along the axis (printed nose-up, one after another), each fitting the bed. */
export function shellBands(g: ShellGeometry, maxZ: number, bedMin: number, bedMax = bedMin): { z0: number; z1: number; diaMm: number; halves: boolean; fits: boolean }[] {
  // a band wider than the bed prints as two half-rings (glued along a keyed seam)
  const out: { z0: number; z1: number; diaMm: number; halves: boolean; fits: boolean }[] = [];
  const n = Math.max(1, Math.ceil(g.zFront / Math.max(50, maxZ - 5)));
  for (let i = 0; i < n; i++) {
    const z0 = (g.zFront * i) / n;
    const z1 = (g.zFront * (i + 1)) / n;
    const dia = 2 * Math.max(...g.section.filter(([, z]) => z >= z0 - 1 && z <= z1 + 1).map(([r]) => r));
    const whole = dia <= bedMin;
    out.push({ z0, z1, diaMm: dia, halves: !whole, fits: whole || (dia <= bedMax && dia / 2 <= bedMin) });
  }
  return out;
}

/** Printed volume of the shell (cm³): area of the section × the path its centroid travels. */
export function shellVolumeCm3(g: ShellGeometry): number {
  let A = 0;
  let Cr = 0;
  const pts = g.section;
  for (let i = 0; i < pts.length; i++) {
    const [r0, z0] = pts[i];
    const [r1, z1] = pts[(i + 1) % pts.length];
    const cr = r0 * z1 - r1 * z0;
    A += cr;
    Cr += (r0 + r1) * cr;
  }
  A /= 2;
  const rc = Cr / (6 * A);
  return Math.abs(2 * Math.PI * rc * A) / 1000;
}
