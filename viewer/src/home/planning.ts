import { DRIVERS, type DriverInfo } from './drivers';
import type { DesignSettings } from './designs';
import { makePlan, type BuildPlan } from './speakerBuild';

export interface PlannedDesign {
  plan: BuildPlan;
  woofer: DriverInfo;
  tweeter: DriverInfo | null;
}

/** Build plan for one design's settings; `earHeightMm` sizes stands / tower height. */
export function planFor(s: DesignSettings, earHeightMm: number): PlannedDesign {
  const woofer =
    DRIVERS.find((d) => d.id === s.wooferId) ??
    DRIVERS.find((d) => d.role === (s.arrangement === 'sub' ? 'sub' : 'woofer'))!;
  const tweeter = s.arrangement === 'sub' || s.arrangement === 'fr' ? null : (DRIVERS.find((d) => d.id === s.tweeterId) ?? null);
  const plan = makePlan({
    arrangement: s.arrangement,
    driverWoofer: woofer,
    driverTweeter: tweeter,
    boxType: s.boxType,
    targetQtc: s.targetQtc,
    tuningScale: s.tuningScale,
    volumeScale: s.volumeScale,
    portSide: s.portSide,
    materialId: s.materialId,
    doubleBaffle: s.doubleBaffle,
    roundoverMm: s.roundoverMm,
    quantity: s.quantity,
    standTweeterHeightMm: s.stands || s.arrangement === 'tower' ? earHeightMm : 0,
    aspect: s.aspect,
  });
  return { plan, woofer, tweeter };
}
