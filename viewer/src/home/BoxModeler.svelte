<script lang="ts">
  import MiniChart, { type MiniSeries } from './MiniChart.svelte';
  import type { DriverInfo } from './drivers';
  import type { BoxDesign } from './speakerBuild';
  import { boxSpecOf, runModel } from './boxModel';

  let { box, woofer }: { box: BoxDesign; woofer: DriverInfo } = $props();

  type Graph = 'spl' | 'excursion' | 'port' | 'maxspl' | 'impedance' | 'delay';
  let graph = $state<Graph>('spl');
  // power as a log-scale slider position so 1 W and 1000 W are both reachable
  let powerPos = $state<number | null>(null);
  let hpOn = $state(false);
  let hpHz = $state(25);
  let hpOrder = $state<2 | 4>(4);

  const N = $derived(box.wooferCount);
  const rated = $derived((woofer.powerW ?? 50) * N);
  const pMin = 0.5;
  const pMax = $derived(Math.max(rated * 2, 20));
  const toPos = (w: number) => Math.log(w / pMin) / Math.log(pMax / pMin);
  const pos = $derived(powerPos ?? toPos(rated));
  const powerW = $derived.by(() => {
    const w = pMin * Math.pow(pMax / pMin, pos);
    return w < 10 ? Math.round(w * 10) / 10 : Math.round(w);
  });

  const spec = $derived(boxSpecOf(box));
  const r = $derived(
    runModel({
      driver: woofer,
      count: N,
      box: spec,
      powerW,
      highPass: hpOn ? { hz: hpHz, order: hpOrder } : null,
      f0: 10,
      f1: 500,
      n: 170,
    })
  );
  const vented = $derived(spec.kind === 'vented');
  // a vented box unloads below tuning, so the useful high-pass sits just under it
  function toggleHp(on: boolean) {
    hpOn = on;
    if (on) hpHz = spec.kind === 'vented' ? Math.max(10, Math.round(spec.fbHz * 0.8)) : 25;
  }
  const PORT_LIMIT = 17;

  const pts = (ys: number[]) => r.freqs.map((x, i) => ({ x, y: ys[i] }));
  const flat = (y: number) => [
    { x: 10, y },
    { x: 500, y },
  ];
  const bassBand = (i: number) => r.freqs[i] >= 15 && r.freqs[i] <= 300;

  /** frequency range where ys > limit (in the bass band) */
  function overRange(ys: number[], limit: number): [number, number] | null {
    let lo = -1;
    let hi = -1;
    ys.forEach((y, i) => {
      if (!bassBand(i) || !(y > limit)) return;
      if (lo < 0) lo = i;
      hi = i;
    });
    return lo < 0 ? null : [r.freqs[lo], r.freqs[hi]];
  }
  function peak(ys: number[]) {
    let k = -1;
    ys.forEach((y, i) => {
      if (bassBand(i) && Number.isFinite(y) && (k < 0 || y > ys[k])) k = i;
    });
    return k < 0 ? { y: NaN, f: NaN } : { y: ys[k], f: r.freqs[k] };
  }

  const excOver = $derived(overRange(r.excursionMm, r.xmaxMm));
  const excPeak = $derived(peak(r.excursionMm));
  const portPeak = $derived(vented ? peak(r.portVelocity) : null);
  const portOver = $derived(vented ? overRange(r.portVelocity, PORT_LIMIT) : null);
  const splAt = (f: number, ys: number[]) => {
    const i = r.freqs.findIndex((x) => x >= f);
    return ys[Math.max(0, i)];
  };
  const fmtHz = (f: number) => `${f.toFixed(0)} Hz`;
  const fmtW = (w: number) => (w < 10 ? w.toFixed(1) : w.toFixed(0));

  function niceRange(ys: number[], span: number, step: number, floor?: number) {
    const top = Math.max(...ys.filter((y, i) => Number.isFinite(y) && bassBand(i)));
    const yMax = Math.ceil((top + step / 2) / step) * step;
    return { yMin: floor ?? yMax - span, yMax };
  }

  const chart = $derived.by(() => {
    const blue = '#38bdf8';
    const amber = '#fbbf24';
    const red = '#f87171';
    let series: MiniSeries[] = [];
    let yMin = 0;
    let yMax = 1;
    let yStep = 5;
    let yLabel = 'dB';
    if (graph === 'spl') {
      series = [
        { label: `${fmtW(powerW)} W (${r.voltsRms.toFixed(1)} V)`, color: blue, points: pts(r.spl) },
        { label: '2.83 V, no filter', color: '#94a3b8', points: pts(r.spl283), dashed: true, width: 1.4 },
      ];
      ({ yMin, yMax } = niceRange([...r.spl, ...r.spl283], 40, 5));
    } else if (graph === 'maxspl') {
      series = [
        { label: 'Max SPL (Xmax / power limited)', color: '#34d399', points: pts(r.maxSpl) },
        { label: `At ${fmtW(powerW)} W`, color: blue, points: pts(r.spl), dashed: true, width: 1.4 },
      ];
      ({ yMin, yMax } = niceRange([...r.maxSpl, ...r.spl], 40, 5));
    } else if (graph === 'excursion') {
      series = [
        { label: 'Cone excursion (peak)', color: blue, points: pts(r.excursionMm) },
        { label: `Xmax ${r.xmaxMm} mm`, color: red, points: flat(r.xmaxMm), dashed: true, width: 1.4 },
      ];
      yLabel = 'mm';
      const top = Math.min(Math.max(...r.excursionMm.filter((_, i) => bassBand(i))), r.xmaxMm * 4);
      yMax = Math.max(r.xmaxMm * 1.5, top * 1.1);
      yStep = yMax > 20 ? 5 : yMax > 8 ? 2 : 1;
      yMax = Math.ceil(yMax / yStep) * yStep;
    } else if (graph === 'port') {
      series = [
        { label: 'Port air speed (peak)', color: blue, points: pts(r.portVelocity) },
        { label: `${PORT_LIMIT} m/s: port noise starts`, color: amber, points: flat(PORT_LIMIT), dashed: true, width: 1.4 },
      ];
      yLabel = 'm/s';
      const top = Math.min(Math.max(...r.portVelocity.filter((_, i) => bassBand(i))), 80);
      yStep = top > 40 ? 10 : 5;
      yMax = Math.ceil(Math.max(top * 1.1, 25) / yStep) * yStep;
    } else if (graph === 'impedance') {
      series = [{ label: 'Impedance', color: blue, points: pts(r.impedance) }];
      yLabel = 'Ω';
      const top = Math.max(...r.impedance);
      yStep = top > 60 ? 20 : top > 30 ? 10 : 5;
      yMax = Math.ceil((top * 1.05) / yStep) * yStep;
    } else {
      series = [{ label: 'Group delay', color: blue, points: pts(r.groupDelayMs) }];
      yLabel = 'ms';
      const top = Math.max(...r.groupDelayMs.filter((_, i) => r.freqs[i] >= 15));
      yStep = top > 40 ? 10 : 5;
      yMax = Math.ceil((top * 1.1) / yStep) * yStep;
    }
    return { series, yMin, yMax, yStep, yLabel };
  });

  const markers = $derived([
    ...(vented && spec.kind === 'vented' ? [{ x: spec.fbHz, label: 'tuning', color: '#a78bfa' }] : []),
    ...(hpOn ? [{ x: hpHz, label: 'high-pass', color: '#f472b6' }] : []),
  ]);

  const GRAPHS: [Graph, string][] = [
    ['spl', 'Loudness'],
    ['excursion', 'Cone travel'],
    ['port', 'Port speed'],
    ['maxspl', 'Max output'],
    ['impedance', 'Impedance'],
    ['delay', 'Group delay'],
  ];
  const HELP: Record<Graph, string> = {
    spl: 'Sound level 1 m in front, on a large baffle (half space), with no room. The dashed line is the standard 2.83 V reference; the solid line is your amplifier power, including any high-pass filter.',
    excursion: 'How far the cone moves (peak). Above the red Xmax line distortion climbs fast; far above it the voice coil can hit the back plate. Vented boxes keep the cone still near tuning but let it flap freely below — that is what the high-pass filter is for.',
    port: 'Peak air speed in the port. Above ~17 m/s you start to hear chuffing and the port compresses; above ~25–30 m/s it is clearly audible. Fixes: a bigger (or second) port, flared ends, or less power below tuning.',
    maxspl: 'The loudest this box can play at each frequency before the cone reaches Xmax or the amplifier reaches the woofer’s power rating, whichever comes first. Where it dips, the bass is excursion-limited.',
    impedance: 'What your amplifier sees. Sealed boxes have one bass peak; vented boxes have two with a dip at the tuning frequency. Keep the minimum above what your amp is rated for.',
    delay: 'How much the bass lags behind the rest of the sound. Under ~10–20 ms at 40 Hz is generally inaudible; vented and high-Q boxes have more than sealed, low-Q ones.',
  };
</script>

<section class="card" data-testid="box-modeler">
  <h2>Box modeler</h2>
  <p class="sub">
    Simulates this woofer{N > 1 ? ` (×${N}, wired in parallel)` : ''} in this {spec.kind} box, like WinISD: loudness, cone travel{vented ? ', port speed' : ''}, impedance and timing, at a power you choose.
  </p>

  <div class="field">
    <label for="bm-power">Amplifier power</label>
    <span class="val">{fmtW(powerW)} W</span>
    <span class="hint">{r.voltsRms.toFixed(1)} V into {r.nominalOhm.toFixed(r.nominalOhm % 1 ? 1 : 0)} Ω nominal · woofer{N > 1 ? 's' : ''} rated {rated} W</span>
    <input id="bm-power" type="range" min="0" max="1" step="0.005" value={pos} oninput={(e) => (powerPos = +(e.currentTarget as HTMLInputElement).value)} />
  </div>
  <label class="toggle">
    <input type="checkbox" checked={hpOn} onchange={(e) => toggleHp((e.currentTarget as HTMLInputElement).checked)} />
    High-pass (subsonic) filter <span class="muted small">— DSP, receiver “speaker size” setting, or a cap in front of the amp</span>
  </label>
  {#if hpOn}
    <div class="field">
      <label for="bm-hp">High-pass at</label>
      <span class="val">{hpHz} Hz</span>
      <input id="bm-hp" type="range" min="10" max="120" step="1" bind:value={hpHz} />
    </div>
    <div class="chips">
      <button class="chip" class:on={hpOrder === 2} onclick={() => (hpOrder = 2)}>12 dB/oct</button>
      <button class="chip" class:on={hpOrder === 4} onclick={() => (hpOrder = 4)}>24 dB/oct</button>
    </div>
  {/if}

  <div class="chips graphs" role="tablist" aria-label="Box modeler graph">
    {#each GRAPHS.filter(([g]) => g !== 'port' || vented) as [g, lbl]}
      <button class="chip" role="tab" aria-selected={graph === g} class:on={graph === g} onclick={() => (graph = g)}>{lbl}</button>
    {/each}
  </div>
  <MiniChart
    series={chart.series}
    xMin={10}
    xMax={500}
    yMin={chart.yMin}
    yMax={chart.yMax}
    yStep={chart.yStep}
    yLabel={chart.yLabel}
    xTicks={[10, 20, 50, 100, 200, 500]}
    {markers}
    height={210}
  />
  <p class="small muted">{HELP[graph]}</p>

  <div class="stats">
    <div class="stat"><div class="k">Sensitivity</div><div class="v">{r.sensitivity283.toFixed(1)} dB</div><div class="s">2.83 V / 1 m, half space</div></div>
    <div class="stat"><div class="k">At {fmtW(powerW)} W</div><div class="v">{splAt(100, r.spl).toFixed(0)} dB</div><div class="s">at 100 Hz · {splAt(40, r.spl).toFixed(0)} dB at 40 Hz</div></div>
    <div class="stat">
      <div class="k">Peak cone travel</div>
      <div class="v" class:over={excPeak.y > r.xmaxMm}>{excPeak.y.toFixed(1)} mm</div>
      <div class="s">at {fmtHz(excPeak.f)} · Xmax {r.xmaxMm} mm</div>
    </div>
    {#if portPeak}
      <div class="stat">
        <div class="k">Peak port speed</div>
        <div class="v" class:over={portPeak.y > PORT_LIMIT}>{portPeak.y.toFixed(0)} m/s</div>
        <div class="s">at {fmtHz(portPeak.f)}</div>
      </div>
    {/if}
    <div class="stat"><div class="k">Lowest impedance</div><div class="v">{r.minImpedance.ohm.toFixed(1)} Ω</div><div class="s">{r.minImpedance.hz > 400 ? 'higher up, ≈ voice-coil Re' : `at ${fmtHz(r.minImpedance.hz)}`}</div></div>
    <div class="stat"><div class="k">Group delay</div><div class="v">{splAt(40, r.groupDelayMs).toFixed(1)} ms</div><div class="s">at 40 Hz</div></div>
  </div>

  <ul class="callouts">
    {#if excOver}
      <li class="bad">
        At {fmtW(powerW)} W the cone goes past Xmax between {fmtHz(excOver[0])} and {fmtHz(excOver[1])}.
        {#if vented && !hpOn}Turn on a high-pass just below tuning ({Math.round((spec.kind === 'vented' ? spec.fbHz : 30) * 0.8)} Hz or so) — that's where a vented box unloads.{:else}Use less power, a higher high-pass, or pair it with a subwoofer and cross over above {fmtHz(excOver[1])}.{/if}
      </li>
    {:else}
      <li class="good">Cone stays within Xmax everywhere at {fmtW(powerW)} W{hpOn ? ` with the ${hpHz} Hz high-pass` : ''}.</li>
    {/if}
    {#if portOver}
      <li class="warn">Port air reaches {portPeak?.y.toFixed(0)} m/s ({fmtHz(portOver[0])}–{fmtHz(portOver[1])}); expect audible chuffing when played this loud. A larger-diameter or flared port helps.</li>
    {/if}
    {#if r.minImpedance.ohm < 3.2}
      <li class="warn">Impedance dips to {r.minImpedance.ohm.toFixed(1)} Ω — check your amplifier is happy driving that (many are only rated to 4 Ω).</li>
    {/if}
    {#if r.mech.assumed.length}
      <li>The datasheet doesn't give {r.mech.assumed.join(', ')}; the curves use a typical value.</li>
    {/if}
  </ul>
  <p class="small muted">
    Model: Thiele/Small lumped circuit (voice coil, cone, box, port, box leakage Q<sub>L</sub>{spec.kind === 'vented' ? ` ${spec.ql ?? 7}` : ''}). It matches the textbook Small alignment curves within 0.2 dB and the woofers' datasheet sensitivities within ~1.5 dB. No room, no baffle step, no cone breakup — the Room tab adds the room. Voice-coil inductance isn't in the datasheets we have, so impedance above a few hundred Hz reads low.
  </p>
</section>

<style>
  .graphs {
    margin-top: 12px;
  }
  .over {
    color: #f87171 !important;
  }
  .toggle {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-top: 10px;
    font-size: 14px;
    flex-wrap: wrap;
  }
  .toggle input {
    width: 20px;
    height: 20px;
    accent-color: var(--accent);
  }
</style>
