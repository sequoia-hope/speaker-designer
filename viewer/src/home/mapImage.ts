// Render map data to a canvas (one pixel per grid cell) for the top view
// (as an <image>) and the 3D floor (as a texture).

import type { Field } from './system';

export function cellsCanvas(
  cells: { x: number; y: number; v: number }[],
  grid: number,
  widthM: number,
  depthM: number,
  color: (v: number) => string,
  canvas: HTMLCanvasElement = document.createElement('canvas')
) {
  const nx = Math.max(1, Math.round(widthM / grid));
  const ny = Math.max(1, Math.round(depthM / grid));
  canvas.width = nx;
  canvas.height = ny;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#334155';
  ctx.fillRect(0, 0, nx, ny);
  for (const c of cells) {
    ctx.fillStyle = color(c.v);
    ctx.fillRect(Math.floor(c.x / grid), Math.floor(c.y / grid), 1, 1);
  }
  return canvas;
}

/** level: |p| relative to the median (blue = dip, yellow = peak); wave: instantaneous pressure at `phase`. */
export function fieldCanvas(f: Field, mode: 'level' | 'wave', phase: number, canvas: HTMLCanvasElement) {
  canvas.width = f.nx;
  canvas.height = f.ny;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(f.nx, f.ny);
  const d = img.data;
  const norm = Math.pow(10, f.medianDb / 20) * 1.6;
  const c = Math.cos(phase);
  const s = Math.sin(phase);
  for (let i = 0; i < f.nx * f.ny; i++) {
    let r: number;
    let g: number;
    let b: number;
    if (mode === 'level') {
      const t = Math.min(Math.max((f.db[i] - f.medianDb + 15) / 21, 0), 1); // −15 dB → 0, +6 dB → 1
      // dark blue → teal → green → yellow
      r = 255 * Math.max(0, (t - 0.55) / 0.45);
      g = 255 * Math.min(1, 0.15 + t * 1.1);
      b = 255 * Math.max(0, 0.75 - t);
      const l = 0.35 + 0.65 * t;
      r *= l;
      g *= l;
      b *= l;
    } else {
      const v = Math.max(-1, Math.min(1, (f.re[i] * c - f.im[i] * s) / norm));
      r = v > 0 ? 40 + 215 * v : 40;
      b = v < 0 ? 40 - 215 * v : 40;
      g = 40 + 60 * (1 - Math.abs(v));
    }
    d[i * 4] = r;
    d[i * 4 + 1] = g;
    d[i * 4 + 2] = b;
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}
