<script lang="ts">
  // Off-axis prediction for the tweeter (bare or in its printed round waveguide)
  // and the woofer: a polar map, normalised off-axis curves and the DI match at
  // the crossover. Model and its limits: see directivity.ts.
  import MiniChart from './MiniChart.svelte';
  import type { DriverInfo } from './drivers';
  import type { HybridParams, RoundWaveguide } from './hybrid';
  import { COVERAGE_RANGE, diMatch, logFreqs, pistonOf, polarMap, waveguideRadiator } from './directivity';

  let {
    p,
    tweeter,
    woofer,
    wg,
    onCoverage,
    fits = () => true,
  }: {
    p: HybridParams;
    tweeter: DriverInfo;
    woofer: DriverInfo;
    wg: RoundWaveguide | null;
    /** null = bare tweeter, else a waveguide of that coverage (°) */
    onCoverage: (coverageDeg: number | null) => void;
    /** whether the design still builds with a guide of this coverage */
    fits?: (coverageDeg: number) => boolean;
  } = $props();

  const F0 = 500;
  const F1 = 20000;
  const FREQS = logFreqs(F0, F1, 64);
  const ANGLES = Array.from({ length: 31 }, (_, i) => i * 3);
  const CURVES: [number, string][] = [
    [0, '#e2e8f0'],
    [15, '#38bdf8'],
    [30, '#34d399'],
    [45, '#fbbf24'],
    [60, '#fb923c'],
    [90, '#f472b6'],
  ];
  // viridis in 3 dB steps, 0 dB (on-axis level) brightest
  const BANDS = ['#fde725', '#b5de2b', '#6ece58', '#35b779', '#1f9e89', '#26828e', '#31688e', '#3e4989', '#482878', '#440154'];
  const bandColor = (db: number) => BANDS[Math.min(BANDS.length - 1, Math.max(0, Math.floor(-db / 3)))];

  const xoHz = $derived(p.tweeterXoHz ?? 2000);
  const twRad = $derived(wg ? waveguideRadiator(wg, tweeter) : pistonOf(tweeter));
  const tMap = $derived(polarMap(twRad, FREQS, ANGLES));
  const wMap = $derived(polarMap(pistonOf(woofer), FREQS, [0]));
  const bareDi = $derived(wg ? polarMap(pistonOf(tweeter), FREQS, [0]).di : null);
  const match = $derived(diMatch(woofer, tweeter, wg, xoHz, 4, p.tweeterXoHz, fits));

  const setCoverage = (cov: number | null) => onCoverage(cov);
  const covChips = $derived(
    [60, 75, 90, 105, 120].filter((c) => c >= COVERAGE_RANGE.min && c <= COVERAGE_RANGE.max)
  );

  // polar map geometry (same frame as MiniChart)
  const W = 360;
  const H = 190;
  const padL = 30;
  const padR = 8;
  const padT = 8;
  const padB = 20;
  const sx = (f: number) => padL + (Math.log(f / F0) / Math.log(F1 / F0)) * (W - padL - padR);
  const sy = (a: number) => padT + ((90 - a) / 180) * (H - padT - padB);
  const edges = $derived(FREQS.map((f, i) => (i === 0 ? F0 : Math.sqrt(f * FREQS[i - 1]))).concat(F1));
  const fmtX = (x: number) => (x >= 1000 ? `${x / 1000}k` : `${x}`);
  const cells = $derived.by(() => {
    const out: { x: number; y: number; w: number; h: number; c: string }[] = [];
    const rowH = (3 / 180) * (H - padT - padB);
    tMap.anglesDeg.forEach((a, ai) => {
      for (const sgn of a === 0 ? [1] : [1, -1]) {
        const yc = sy(sgn * a);
        tMap.freqs.forEach((_, fi) => {
          const x0 = sx(edges[fi]);
          const x1 = sx(edges[fi + 1]);
          out.push({ x: x0, y: yc - rowH / 2, w: x1 - x0 + 0.4, h: rowH + 0.4, c: bandColor(tMap.db[ai][fi]) });
        });
      }
    });
    return out;
  });
</script>

<section class="card">
  <h2>Dispersion (off-axis)</h2>
  <div class="chips" role="group" aria-label="Tweeter waveguide coverage">
    <button class="chip" class:on={!wg} onclick={() => setCoverage(null)}>Bare tweeter</button>
    {#each covChips as c}
      <button class="chip" class:on={wg?.coverageDeg === c} class:nofit={!fits(c)} title={fits(c) ? undefined : "doesn't fit this cabinet"} onclick={() => setCoverage(c)}>{c}° guide</button>
    {/each}
  </div>
  <ul class="callouts" data-testid="di-verdict">
    <li class={match.ok ? 'good' : 'warn'}>
      {match.verdict}
      {#if match.suggestCoverageDeg != null}
        <button class="chip" onclick={() => setCoverage(match.suggestCoverageDeg)}>Use {match.suggestCoverageDeg}°</button>
      {/if}
    </li>
  </ul>

  <h3>Polar map: {wg ? `${tweeter.model} in the ${wg.coverageDeg}° guide` : `bare ${tweeter.model}`}</h3>
  <svg viewBox={`0 0 ${W} ${H}`} class="polar-map" role="img" aria-label="Polar map of the tweeter, level relative to on-axis">
    {#each cells as c}<rect x={c.x} y={c.y} width={c.w} height={c.h} fill={c.c} />{/each}
    {#each [-90, -60, -30, 0, 30, 60, 90] as a}
      <line x1={padL} x2={W - padR} y1={sy(a)} y2={sy(a)} class="grid" />
      <text x={padL - 4} y={sy(a) + 3} class="tick" text-anchor="end">{a}°</text>
    {/each}
    {#each [500, 1000, 2000, 5000, 10000, 20000] as f}
      <line x1={sx(f)} x2={sx(f)} y1={padT} y2={H - padB} class="grid" />
      <text x={sx(f)} y={H - 6} class="tick" text-anchor="middle">{fmtX(f)}</text>
    {/each}
    <text x={padL - 4} y={H - 6} class="tick unit" text-anchor="end">Hz</text>
    {#if wg}
      {#each [1, -1] as sgn}
        <line x1={padL} x2={W - padR} y1={sy((sgn * wg.coverageDeg) / 2)} y2={sy((sgn * wg.coverageDeg) / 2)} stroke="#e2e8f0" stroke-dasharray="4 3" stroke-width="1" />
      {/each}
      <text x={W - padR - 3} y={sy(wg.coverageDeg / 2) - 3} text-anchor="end" class="mk" fill="#e2e8f0">nominal ±{wg.coverageDeg / 2}°</text>
    {/if}
    <line x1={sx(xoHz)} x2={sx(xoHz)} y1={padT} y2={H - padB} stroke="#fbbf24" stroke-dasharray="3 3" stroke-width="1.2" />
    <text x={sx(xoHz) + 3} y={padT + 9} class="mk" fill="#fbbf24">X-over</text>
  </svg>
  <div class="scale" aria-label="Colour scale">
    {#each BANDS as b, i}<span style:background={b} title={`${-3 * i} to ${-3 * (i + 1)} dB`}></span>{/each}
  </div>
  <div class="scale-lbl small muted"><span>0 dB (on axis)</span><span>−15</span><span>≤ −27 dB</span></div>

  <h3>Off-axis, relative to on-axis</h3>
  <MiniChart
    series={CURVES.map(([a, color]) => {
      const ai = ANGLES.indexOf(a);
      return { label: `${a}°`, color, width: a === 0 ? 1.4 : 1.8, points: FREQS.map((f, i) => ({ x: f, y: tMap.db[ai][i] })) };
    })}
    xMin={F0}
    xMax={F1}
    yMin={-30}
    yMax={5}
    yStep={5}
    yLabel="dB"
    xTicks={[500, 1000, 2000, 5000, 10000, 20000]}
    markers={[{ x: xoHz, label: 'X-over' }]}
    height={180}
  />

  <h3>Directivity index</h3>
  <MiniChart
    series={[
      { label: `Woofer (${woofer.model})`, color: '#34d399', points: FREQS.map((f, i) => ({ x: f, y: wMap.di[i] })) },
      { label: wg ? `Tweeter in ${wg.coverageDeg}° guide` : 'Tweeter (bare)', color: '#38bdf8', points: FREQS.map((f, i) => ({ x: f, y: tMap.di[i] })) },
      ...(bareDi ? [{ label: 'Tweeter bare', color: '#94a3b8', dashed: true, width: 1.3, points: FREQS.map((f, i) => ({ x: f, y: bareDi[i] })) }] : []),
    ]}
    xMin={F0}
    xMax={F1}
    yMin={0}
    yMax={25}
    yStep={5}
    yLabel="DI dB"
    xTicks={[500, 1000, 2000, 5000, 10000, 20000]}
    markers={[
      { x: xoHz, label: `X-over ${xoHz >= 1000 ? (xoHz / 1000).toFixed(1) + 'k' : xoHz}${p.tweeterXoHz ? '' : ' (assumed)'}` },
      ...(wg ? [{ x: wg.controlHz, label: 'guide controls', color: '#a78bfa' }] : []),
    ]}
    height={180}
  />
  <p class="small muted">
    At the crossover: woofer DI {match.wooferDi.toFixed(1)} dB, tweeter {match.tweeterDi.toFixed(1)} dB. Matching DI there keeps the
    off-axis sound — and so the room's reflections — even through the crossover.
    {#if !p.tweeterXoHz}Crossover assumed at 2 kHz; set it with “Match it to your crossover” above.{/if}
  </p>
  <p class="small muted">
    Prediction, not a measurement. The woofer and bare dome are rigid pistons of their Sd in an infinite baffle. The waveguide is a
    Rayleigh integral over its mouth with a spherical-cap wavefront from the flare's apex, fed by the dome's own beaming: wide below the
    mouth's control frequency, ≈ the wall angle above it, narrowing again at the top. Deep, narrow guides narrow a little below nominal
    just above the control frequency, as real conical horns do; shallow wide guides on large-faceplate tweeters stay wider than nominal.
    No cabinet-edge diffraction, internal reflections or cone breakup — expect ±20 % on beamwidth and ~1 dB on DI. Round guide, so vertical
    = horizontal.
  </p>
</section>

<style>
  .nofit {
    opacity: 0.55;
    text-decoration: line-through;
  }
  .polar-map {
    width: 100%;
    height: auto;
    display: block;
    shape-rendering: crispEdges;
  }
  .grid {
    stroke: #0d1322;
    stroke-width: 0.6;
    opacity: 0.55;
  }
  .tick {
    fill: #8b9dc3;
    font-size: 9px;
  }
  .unit {
    fill: #64748b;
  }
  .mk {
    font-size: 9px;
    font-weight: 600;
  }
  .scale {
    display: flex;
    height: 8px;
    margin: 4px 8px 0 30px;
    border-radius: 2px;
    overflow: hidden;
  }
  .scale span {
    flex: 1;
  }
  .scale-lbl {
    display: flex;
    justify-content: space-between;
    margin: 2px 8px 0 30px;
  }
</style>
