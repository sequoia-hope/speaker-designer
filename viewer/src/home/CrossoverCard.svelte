<script lang="ts">
  // Two-way crossover helper: pick the crossover, see the woofer + tweeter sum, and get
  // either DSP settings (biquads, delay) or a textbook passive network to start from.
  import MiniChart from './MiniChart.svelte';
  import type { DriverInfo } from './drivers';
  import { biquads, bestTweeterDelayMs, levelMatchDb, passiveNetwork, twoWaySum, type XoOpts, type XoType } from './crossover';

  let {
    woofer,
    tweeter,
    freqs,
    wooferH,
    tweeterOffsetMm,
    suggestedFc,
    baffleStep = null,
    tweeterH = null,
    sources = null,
    measNotes = [],
  }: {
    woofer: DriverInfo;
    tweeter: DriverInfo;
    /** the woofer's on-axis response (its box, baffle), normalised to ≈ 1 in the passband */
    freqs: number[];
    wooferH: { re: number; im: number }[];
    /** + = tweeter's acoustic centre behind the woofer's */
    tweeterOffsetMm: number;
    suggestedFc: number;
    /** baffle-step compensation suggestion for this cabinet */
    baffleStep?: { f3Hz: number; gainDb: number; note: string } | null;
    /** measured tweeter response on freqs (relative), replacing the ideal roll-off */
    tweeterH?: { re: number; im: number }[] | null;
    /** where each driver's response comes from (simulated / measured …) */
    sources?: { woofer: string; tweeter: string } | null;
    measNotes?: string[];
  } = $props();

  let fc = $state<number | null>(null);
  let type = $state<XoType>('LR4');
  let trim = $state(0);
  let invert = $state<boolean | null>(null);
  let delayMs = $state<number | null>(null);
  let route = $state<'dsp' | 'passive'>('dsp');

  const fcHz = $derived(fc ?? Math.round(suggestedFc / 50) * 50);
  const opts = $derived<XoOpts>({
    fcHz,
    type,
    tweeterLevelDb: trim,
    tweeterOffsetMm,
    invertTweeter: invert ?? type === 'LR2',
    delayTweeterMs: delayMs ?? 0,
    tweeterH,
  });
  const r = $derived(twoWaySum(freqs, wooferH, woofer, tweeter, opts));
  const lm = $derived(levelMatchDb(woofer, tweeter));
  const dsp = $derived(biquads(opts, 48000, lm));
  const net = $derived(passiveNetwork(opts, woofer, tweeter));
  function align() {
    const b = bestTweeterDelayMs(freqs, wooferH, woofer, tweeter, { ...opts, delayTweeterMs: 0 });
    delayMs = b.delayMs;
    invert = b.invertTweeter;
  }
  const dev = $derived.by(() => {
    let worst = 0;
    r.sumDb.forEach((db, i) => {
      if (r.freqs[i] > fcHz / 2 && r.freqs[i] < fcHz * 2) worst = Math.max(worst, Math.abs(db));
    });
    return worst;
  });
  const pts = (ys: number[]) => r.freqs.map((x, i) => ({ x, y: ys[i] }));
  const fmt = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
</script>

<section class="card" data-testid="crossover">
  <h2>Crossover (2-way)</h2>
  <p class="sub">Where the woofer hands over to the {tweeter.model}. Aim for a flat line through the crossover.</p>
  <ul class="callouts" data-testid="xo-sources">
    <li class={sources?.woofer.startsWith('measured') ? 'good' : ''}><b>Woofer:</b> {sources?.woofer ?? "simulated (this woofer's response in its box)"}</li>
    <li class={sources?.tweeter.startsWith('measured') ? 'good' : ''}><b>Tweeter:</b> {sources?.tweeter ?? 'ideal roll-off at its Fs'}</li>
  </ul>
  <div class="field">
    <label for="xo-fc">Crossover frequency</label>
    <span class="val">{fcHz} Hz</span>
    <span class="hint">Suggested ≈ {Math.round(suggestedFc / 50) * 50} Hz: low enough that the woofer isn't beaming yet, high enough to spare the tweeter (≥ 2.5 × its Fs = {Math.round(tweeter.fsHz * 2.5)} Hz).</span>
    <input id="xo-fc" type="range" min="800" max="5000" step="50" value={fcHz} oninput={(e) => (fc = +(e.currentTarget as HTMLInputElement).value)} />
  </div>
  <div class="chips">
    {#each [['LR4', 'LR4 (24 dB/oct)'], ['LR2', 'LR2 (12 dB/oct)'], ['BW3', 'Butterworth 3 (18 dB/oct)']] as [k, lbl]}
      <button class="chip" class:on={type === k} onclick={() => { type = k as XoType; invert = null; delayMs = null; }}>{lbl}</button>
    {/each}
  </div>
  <div class="field">
    <label for="xo-trim">Tweeter level trim</label>
    <span class="val">{trim > 0 ? '+' : ''}{trim.toFixed(1)} dB</span>
    <span class="hint">On top of the automatic {lm >= 0 ? `${lm.toFixed(1)} dB cut` : `${(-lm).toFixed(1)} dB shortfall`} that matches its sensitivity to the woofer's.</span>
    <input id="xo-trim" type="range" min="-6" max="6" step="0.5" bind:value={trim} />
  </div>
  <div class="chips">
    <button class="chip" onclick={align}>Align the tweeter (delay & polarity)</button>
    <label class="chip"><input type="checkbox" checked={opts.invertTweeter} onchange={(e) => (invert = (e.currentTarget as HTMLInputElement).checked)} /> Tweeter polarity inverted</label>
  </div>
  <p class="small muted">Acoustic offset: the tweeter's sound starts {Math.abs(tweeterOffsetMm).toFixed(0)} mm {tweeterOffsetMm >= 0 ? 'behind' : 'ahead of'} the woofer's{delayMs ? `; ${delayMs > 0 ? 'tweeter' : 'woofer'} delayed ${Math.abs(delayMs).toFixed(3)} ms to line them up` : ''}.</p>
  <MiniChart
    series={[
      { label: 'Sum', color: '#38bdf8', points: pts(r.sumDb) },
      { label: 'Woofer', color: '#94a3b8', points: pts(r.wooferDb), dashed: true, width: 1.3 },
      { label: 'Tweeter', color: '#f472b6', points: pts(r.tweeterDb), dashed: true, width: 1.3 },
    ]}
    xMin={200}
    xMax={20000}
    yMin={-30}
    yMax={6}
    yStep={6}
    xTicks={[200, 500, 1000, 2000, 5000, 10000, 20000]}
    markers={[{ x: fcHz, label: 'crossover', color: '#fbbf24' }]}
  />
  <ul class="callouts">
    <li class={dev < 1.5 ? 'good' : dev < 3 ? 'warn' : 'bad'}>Within ±1 octave of the crossover the sum strays up to {dev.toFixed(1)} dB.{dev >= 1.5 ? ' Try “Align the tweeter”, the other polarity, or a slightly different frequency.' : ''}</li>
    {#each r.notes as n}<li>{n}</li>{/each}
    {#each measNotes as n}<li>{n}</li>{/each}
    {#if baffleStep}<li>Baffle step: below ≈ {Math.round(baffleStep.f3Hz)} Hz this cabinet's front stops supporting the woofer and it falls towards −6 dB (left of the graph). Add a {baffleStep.gainDb} dB low shelf at about {Math.round(baffleStep.f3Hz)} Hz on the woofer (DSP), or the equivalent in the passive network. {baffleStep.note}</li>{/if}
  </ul>
  <div class="chips">
    <button class="chip" class:on={route === 'dsp'} onclick={() => (route = 'dsp')}>DSP settings</button>
    <button class="chip" class:on={route === 'passive'} onclick={() => (route = 'passive')}>Passive network</button>
  </div>
  {#if route === 'dsp'}
    <ul class="callouts">{#each dsp.summary as l}<li>{l}</li>{/each}</ul>
  {:else}
    <table class="tbl">
      <thead><tr><th>Part</th><th>Value</th><th>Where</th></tr></thead>
      <tbody>
        {#each [...net.woofer.map((p) => ['Woofer', p] as const), ...net.tweeter.map((p) => ['Tweeter', p] as const), ...(net.wooferZobel ?? []).map((p) => ['Woofer Zobel', p] as const), ...(net.tweeterLPad ?? []).map((p) => ['Tweeter L-pad', p] as const)] as [who, p]}
          <tr><td>{who} {p.ref}</td><td>{fmt(p.value)} {p.unit}</td><td>{p.placement}{p.note ? ` — ${p.note}` : ''}</td></tr>
        {/each}
      </tbody>
    </table>
    <p class="small muted">{net.caveat}</p>
  {/if}
</section>
