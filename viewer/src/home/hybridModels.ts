// Turn a printed hybrid design into models the maps can use.
import { DRIVERS } from './drivers';
import { buildGeometry, mapResponse, simulate, type HybridParams } from './hybrid';
import type { SubModel } from './outdoor';
import type { BoxAlignment } from './roomAcoustics';

export function driverFor(p: HybridParams) {
  return DRIVERS.find((d) => d.id === p.driverId) ?? DRIVERS.find((d) => d.role === (p.type === 'folded-horn' ? 'pa' : 'woofer'))!;
}

export function cabinetDims(p: HybridParams) {
  return { w: p.extrusionMm + 2 * p.plateMm, h: p.heightMm, d: p.depthMm };
}

/** Outdoor sub model from a printed folded horn. */
export function hybridSubModel(p: HybridParams): SubModel | null {
  if (p.type !== 'folded-horn') return null;
  const d = driverFor(p);
  const g = buildGeometry(p, d);
  if (!g.fits) return null;
  const sims = new Map<number, ReturnType<typeof simulate>>();
  for (const n of [1, 2, 4]) sims.set(n, simulate(p, d, g, { coupled: n, floor: true, f0: 15, f1: 400, n: 80 }));
  const s1 = sims.get(1)!;
  const dims = cabinetDims(p);
  return {
    name: 'printed horn',
    cab: { w: dims.w / 1000, h: dims.h / 1000, d: dims.d / 1000 },
    maxCouple: p.mouth === 'corner' ? 4 : 2,
    response: (n: number) => mapResponse(s1, sims.get(n >= 4 ? 4 : n >= 2 ? 2 : 1)!, [50, 90]),
  };
}

/** Living-room alignment (bass response) from a printed TL / slot-port design. */
export function hybridLivingAlignment(p: HybridParams): BoxAlignment | null {
  if (p.type !== 'tl' && p.type !== 'slot-port') return null;
  const d = driverFor(p);
  const g = buildGeometry(p, d);
  const sim = simulate(p, d, g, { coupled: 1, floor: false, f0: 15, f1: 600, n: 90 });
  const fn = mapResponse(sim, sim, [180, 400]);
  return { kind: 'custom', fn };
}
