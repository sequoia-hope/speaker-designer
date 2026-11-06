/** Perceptually smooth acoustic SPL colormap (`0 -> 1`: deep indigo -> cyan -> emerald -> amber -> crimson -> white). */
const SPL_STOPS: [number, [number, number, number]][] = [
  [0.0, [13, 21, 56]],
  [0.18, [22, 72, 148]],
  [0.36, [18, 158, 178]],
  [0.54, [68, 206, 114]],
  [0.72, [242, 198, 54]],
  [0.88, [239, 83, 52]],
  [1.0, [255, 240, 245]],
];

export function splNormalizedToRgb(tRaw: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, tRaw));
  for (let i = 0; i < SPL_STOPS.length - 1; i++) {
    const [t0, c0] = SPL_STOPS[i];
    const [t1, c1] = SPL_STOPS[i + 1];
    if (t <= t1) {
      const u = (t - t0) / Math.max(1e-6, t1 - t0);
      return [
        (c0[0] + u * (c1[0] - c0[0])) / 255,
        (c0[1] + u * (c1[1] - c0[1])) / 255,
        (c0[2] + u * (c1[2] - c0[2])) / 255,
      ];
    }
  }
  return [1, 0.94, 0.96];
}

export function splNormalizedToCss(tRaw: number): string {
  const [r, g, b] = splNormalizedToRgb(tRaw);
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}

/** Diverging acoustic wavefront pressure colormap (`-1 -> 0 -> +1`: electric cyan -> dark slate -> warm coral/gold). */
export function wavePressureToRgb(vRaw: number): [number, number, number] {
  const v = Math.max(-1, Math.min(1, vRaw));
  if (v < 0) {
    const u = Math.pow(-v, 0.78);
    return [
      0.07 * (1 - u) + 0.12 * u,
      0.10 * (1 - u) + 0.76 * u,
      0.17 * (1 - u) + 0.98 * u,
    ];
  } else {
    const u = Math.pow(v, 0.78);
    return [
      0.07 * (1 - u) + 0.99 * u,
      0.10 * (1 - u) + 0.45 * u,
      0.17 * (1 - u) + 0.24 * u,
    ];
  }
}

export function formatFreq(hz: number): string {
  if (hz >= 1000) {
    const k = hz / 1000;
    return k >= 10 ? `${k.toFixed(1)} kHz` : `${k.toFixed(2)} kHz`;
  }
  return hz >= 100 ? `${Math.round(hz)} Hz` : `${hz.toFixed(1)} Hz`;
}
