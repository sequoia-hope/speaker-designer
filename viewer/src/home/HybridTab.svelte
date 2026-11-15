<script lang="ts">
  import MiniChart from './MiniChart.svelte';
  import Speaker3D from './Speaker3D.svelte';
  import { platesDxf, printPieces, printPiecesStl } from './printExport';
  import { downloadBlob } from './exporters';
  import type { Snippet } from 'svelte';
  import { home, printedParams, saveHome } from './homeState.svelte';
  import { allDrivers, findDriver } from './drivers';
  import { trapTuningHz } from './lineNetwork';
  import { printedAsModel, runModel } from './boxModel';
  import { autoFitAsync, MOUTH_NOISE_MS, buildGeometry, buildIssues, DEFAULT_SANDWICH, HYBRID_PRESETS, headGeometry, type FitChange, type HybridParams, roundWaveguide, tweeterSetup, waveguideIssues, type TweeterMount, planPanels, planPrint, plateProps, plateThickness, printedDesignById, sandwichPlate, simulate, SKINS, WOOD_CORES, type HeadKind, type PlateMaterial, type PrintedModel, type ProfileType, type SandwichCore } from './hybrid';
  import { cabinetDims, driverFor } from './hybridModels';

  // One printed design ('sub' or a PRINTED_DESIGNS id), shown either as a design
  // (Speakers tab: shape, driver, response) or as a build (Build tab: print plan).
  let { id, mode, top }: { id: string; mode: 'design' | 'build'; top?: Snippet } = $props();
  const isSub = $derived(id === 'sub');
  const p = $derived(printedParams(id));
  const entry = $derived(printedDesignById(id));
  const tw = $derived(tweeterSetup(p));
  const tweeter = $derived(isSub ? null : tw.tweeter);
  const twWg = $derived(tw.tweeter && tw.waveguide ? roundWaveguide(tw.tweeter, p.coverageDeg || 90, 4, p.tweeterXoHz) : null);
  const head = $derived(isSub ? null : headGeometry(p, tweeter, driverFor(p)));
  const tweeters = $derived(allDrivers().filter((x) => x.role === 'tweeter'));
  const d = $derived(driverFor(p));
  const geo = $derived(buildGeometry(p, d));
  const plan = $derived(planPrint(geo, home.hybrid.printer));
  const issues = $derived(buildIssues(p, geo, d, plan, home.hybrid.printer, isSub));
  const solidPath = $derived(
    [geo.core, ...geo.holes].map((poly) => 'M ' + poly.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L ') + ' Z').join(' ')
  );
  const lw = $derived(home.hybrid.printer.lineWidth);
  const sims = $derived.by(() => {
    if (p.type === 'waveguide') return [];
    const ns = isSub ? [1, 2, p.mouth === 'corner' ? 4 : 0].filter(Boolean) : [1];
    return ns.map((n) => ({ n, r: simulate(p, d, geo, { coupled: n, floor: isSub, f0: isSub ? 15 : 20, f1: isSub ? 300 : 600 }) }));
  });
  const dims = $derived(cabinetDims(p));
  // sandwich plates: keep the plate thickness in step with skins + core
  $effect(() => {
    if (!p.sandwich) p.sandwich = { ...DEFAULT_SANDWICH };
    if (p.plateMaterial === 'sandwich') {
      const t = plateThickness(p, home.hybrid.printer);
      if (p.plateMm !== t) p.plateMm = t;
    }
  });
  const sw = $derived(p.sandwich ?? DEFAULT_SANDWICH);
  const swInfo = $derived(sandwichPlate(sw, home.hybrid.printer));
  const panels = $derived(p.plateMaterial === 'sandwich' ? planPanels(p, geo, home.hybrid.printer) : null);
  const birchRef = $derived(plateProps({ ...p, plateMaterial: 'bb18', plateMm: 18 }, home.hybrid.printer));
  function setPlate(id: PlateMaterial, t?: number) {
    p.plateMaterial = id;
    if (t) p.plateMm = t;
  }
  function setCore(c: SandwichCore) {
    p.sandwich.core = c;
    if (c !== 'ribs') {
      const sizes = WOOD_CORES[c].sizes;
      p.sandwich.coreMm = sizes.reduce((a, b) => (Math.abs(b - p.sandwich.coreMm) < Math.abs(a - p.sandwich.coreMm) ? b : a));
    }
  }
  const plateColor = $derived(
    p.plateMaterial === 'mdf19' ? 0x9c7a55 : p.plateMaterial === 'sandwich' ? SKINS[sw.skin].color : 0xcfa874
  );
  $effect(() => {
    JSON.stringify(home.hybrid);
    saveHome();
  });


  const drivers = $derived(
    allDrivers().filter((x) =>
      isSub || p.type === 'tapped' ? x.role === 'pa' || x.role === 'sub' : x.role === 'woofer' || (p.type === 'waveguide' && x.role === 'tweeter')
    )
  );
  function setType(t: ProfileType) {
    // start the new profile from the catalogue design of that type (keeps the tweeter head)
    const like = { sealed: 'mon-sealed', 'slot-port': 'mon-slot', tl: 'mon-tl', blh: 'blh', tapped: 'th-sub', shell: 'egg' }[t as string];
    const base = t === 'waveguide' ? HYBRID_PRESETS.waveguide : (printedDesignById(like ?? 'line')?.params ?? HYBRID_PRESETS.living);
    const keep = tweeterSetup(p);
    home.hybrid.designs[id] = {
      ...structuredClone(base),
      type: t,
      head: undefined,
      tweeterMount: t === 'waveguide' ? 'none' : keep.mount === 'none' ? (base.tweeterMount ?? 'none') : keep.mount,
      tweeterWaveguide: keep.waveguide,
      tweeterId: p.tweeterId ?? base.tweeterId,
    };
  }
  const model = $derived<PrintedModel>({
    geo,
    params: p,
    head,
    plateColor,
    dividerColor: p.plateMaterial === 'sandwich' ? plateColor : undefined,
    printSummary: `${plan.segments.length} printed pieces, ≈ ${(plan.totalGrams / 1000).toFixed(1)} kg of filament, ~${plan.hours.toFixed(0)} h — the print plan is on the Build tab.`,
  });
  // "Make it fit": smallest size change that makes this design buildable, with undo
  let fitNote = $state<{ changes: FitChange[]; before: HybridParams } | { none: true } | null>(null);
  let fitting = $state<number | null>(null);
  async function makeItFit() {
    if (fitting !== null) return;
    fitting = 0;
    const r = await autoFitAsync($state.snapshot(p) as HybridParams, d, $state.snapshot(home.hybrid.printer), (f) => (fitting = f));
    fitting = null;
    if (!r) {
      fitNote = { none: true };
      return;
    }
    const before = $state.snapshot(p) as HybridParams;
    Object.assign(p, r.params);
    fitNote = { changes: r.changes, before };
  }
  function undoFit() {
    if (fitNote && 'before' in fitNote) Object.assign(p, fitNote.before);
    fitNote = null;
  }
  let outGraph = $state<'spl' | 'z' | 'gd' | 'vel'>('spl');
  const r0 = $derived(sims[0]?.r);
  const isLine = $derived(p.type === 'tl' || p.type === 'blh' || p.type === 'tapped');
  const stuffing = $derived(p.stuffing ?? (p.type === 'tl' ? [{ from: 0, to: 0.5, densityGL: 8 }] : []));
  function setStuffing(patch: Partial<{ from: number; to: number; densityGL: number }>) {
    const cur = stuffing[0] ?? { from: 0, to: 0.5, densityGL: 0 };
    p.stuffing = [{ ...cur, ...patch }];
  }
  function toggleTrap(h: number, on: boolean) {
    const set = new Set(p.trapHarmonics ?? []);
    if (on) set.add(h);
    else set.delete(h);
    p.trapHarmonics = [...set].sort();
  }
  const fileBase = $derived((entry?.name ?? (isSub ? 'printed-horn-sub' : 'printed-speaker')).replace(/[^A-Za-z0-9]+/g, '-').toLowerCase());
  // comparison pins (shared with the plywood box modeler), shown at 2.83 V / 1 m full space here
  const pinLabel = $derived(`${entry?.name ?? 'Printed design'} (printed${p.driverId !== entry?.params.driverId ? `, ${d.model}` : ''})`);
  function pinPrinted() {
    if (home.modelerPins.length >= 4) return;
    home.modelerPins.push({
      id: `pin-${Date.now().toString(36)}`,
      label: pinLabel,
      driver: $state.snapshot(d) as typeof d,
      count: 1,
      box: { kind: 'sealed', netL: geo.chambers[0]?.volumeL ?? 0 },
      printed: $state.snapshot(p) as HybridParams,
    });
    saveHome();
  }
  const PIN_COLORS = ['#a3e635', '#fb923c', '#2dd4bf', '#e2e8f0'];
  const pinSeries = $derived(
    isSub
      ? []
      : home.modelerPins.map((pin, i) => {
          // 2.83 V, 1 m, full space: printed pins straight from their simulation; plywood ones from the box model (half space − 6 dB)
          const m = pin.printed ? printedAsModel(pin.printed, pin.driver, 1, 20, 600, 90) : runModel({ driver: pin.driver, count: pin.count, box: pin.box, powerW: 1, f0: 20, f1: 600, n: 90 });
          return { label: pin.label, color: PIN_COLORS[i % PIN_COLORS.length], width: 1.6, points: m.freqs.map((f, k) => ({ x: f, y: m.spl283[k] - 6.02 })) };
        })
  );
  const title = $derived(isSub ? 'Printed horn sub' : (entry?.name ?? 'Printed speaker'));
  const COLORS = ['#38bdf8', '#34d399', '#f472b6'];
  const sc = $derived(Math.min(1, 520 / Math.max(geo.W, geo.H)));
  const mm = (v: number) => `${Math.round(v)} mm`;
  const inch = (v: number) => `${(v / 25.4).toFixed(1)}″`;
</script>

<div class="split">
  <div class="vis">
    <section class="card vis-card">
      <div class="vis-hd"><h2>{title}</h2></div>
      <div class="dimline">
        {mm(dims.w)} W × {mm(dims.h)} H × {mm(dims.d)} D ({inch(dims.w)} × {inch(dims.h)} × {inch(dims.d)}){head ? ` + ${head.h} mm tweeter pod` : ''} · {geo.cores > 1 ? `${geo.cores} printed cores of ${geo.coreMm.toFixed(0)} mm with ${geo.cores - 1} divider${geo.cores > 2 ? 's' : ''}` : `core ${geo.coreMm.toFixed(0)} mm thick`} between two {p.plateMm} mm plates
      </div>
      {#if fitting !== null}
        <div class="fitnote" role="status">Finding the smallest change that makes it buildable…</div>
      {/if}
      {#if fitNote}
        <div class="fitnote" role="status">
          {#if 'none' in fitNote}
            No size within reach makes this buildable — try a different driver or cabinet type.
          {:else}
            <b>Adjusted to fit:</b>
            {#each fitNote.changes as c, i}{i ? ' · ' : ' '}{c.label} {c.from} → <b>{c.to}</b>{/each}
            <button class="linklike" onclick={undoFit}>Undo</button>
          {/if}
          <button class="linklike" onclick={() => (fitNote = null)} aria-label="Dismiss">✕</button>
        </div>
      {/if}
      <div class="s3d-wrap">
        <Speaker3D printed={model} woofer={d} {tweeter} initialExplode={mode === 'build' ? 0.55 : 0} problems={geo.fits ? [] : geo.warnings} onFix={geo.fits ? null : makeItFit} />
      </div>
    </section>
  </div>

  <div class="side">
    {@render top?.()}
    {#if mode === 'design'}
    <section class="card">
      <h2>3D-printed + wood cabinet</h2>
      <p class="sub">{entry?.blurb ?? 'A 3D-printed core carries the complicated inside (horn folds, line, port, waveguide); two flat plywood plates close it off.'} Big flat surfaces are wood, complex shapes are plastic.</p>
      {#if !isSub}
        <div class="chips" style="margin-top:8px">
          {#each [['sealed', 'Sealed'], ['slot-port', 'Folded slot port'], ['tl', 'Transmission line'], ['blh', 'Back-loaded horn'], ['tapped', 'Tapped horn'], ['shell', 'Curved shell'], ['waveguide', 'Waveguide only']] as [t, lbl]}
            <button class="chip" class:on={p.type === t} onclick={() => setType(t as ProfileType)}>{lbl}</button>
          {/each}
        </div>
      {/if}
      <label class="pick">
        <span>{p.type === 'waveguide' ? 'Driver' : 'Woofer'}</span>
        <select bind:value={p.driverId} aria-label="Driver">
          {#each drivers as dr}<option value={dr.id}>{dr.brand} {dr.model} ({dr.sizeLabel}){dr.priceUsd ? ` — $${dr.priceUsd.toFixed(0)}` : ''}</option>{/each}
        </select>
      </label>
      {#if !isSub && p.type !== 'waveguide' && p.type !== 'tapped'}
        <h3>Tweeter</h3>
        <div class="chips">
          {#each [['front', 'In the cabinet'], ['pod', 'Separate pod on top'], ['none', 'None (woofer only)']].filter(([k]) => p.type !== 'shell' || k !== 'front') as [k, lbl]}
            <button class="chip" class:on={tw.mount === k} onclick={() => { p.tweeterMount = k as TweeterMount; p.head = undefined; if (k !== 'none' && !p.tweeterId) p.tweeterId = tweeters[0]?.id; }}>{lbl}</button>
          {/each}
        </div>
        {#if tw.mount !== 'none'}
          <label class="pick">
            <span>Tweeter</span>
            <select bind:value={p.tweeterId} aria-label="Tweeter">
              {#each tweeters as t}<option value={t.id}>{t.brand} {t.model}{t.priceUsd ? ` — $${t.priceUsd.toFixed(0)}` : ''}</option>{/each}
            </select>
          </label>
          <label class="toggle"><input type="checkbox" checked={tw.waveguide} onchange={(e) => { p.tweeterWaveguide = (e.currentTarget as HTMLInputElement).checked; p.head = undefined; }} /> Printed round waveguide</label>
          {#if tw.waveguide}
            <div class="field">
              <label for="h-twcov">Waveguide coverage</label><span class="val">{p.coverageDeg || 90}°</span>
              <span class="hint">Narrower = more directivity control, a deeper flare.</span>
              <input id="h-twcov" type="range" min="60" max="120" step="5" value={p.coverageDeg || 90} oninput={(e) => (p.coverageDeg = +(e.currentTarget as HTMLInputElement).value)} />
            </div>
            <div class="field">
              <label for="h-twxo">Match it to your crossover</label>
              <span class="val">{p.tweeterXoHz ? `${p.tweeterXoHz} Hz` : 'standard size'}</span>
              <span class="hint">The mouth is sized so the guide still controls the tweeter's spread at ~0.8 × the crossover — lower crossover, bigger guide.</span>
              <input id="h-twxo" type="range" min="1000" max="4000" step="100" value={p.tweeterXoHz ?? 2000} oninput={(e) => (p.tweeterXoHz = +(e.currentTarget as HTMLInputElement).value)} />
            </div>
          {/if}
          {#if twWg && tw.tweeter}
            <p class="small muted">Waveguide: Ø{Math.round(2 * twWg.R)} mm mouth, {twWg.depthMm.toFixed(0)} mm deep, throat Ø{Math.round(2 * twWg.r0)} mm for the {tw.tweeter.model}'s Ø{tw.tweeter.frameDiaMm} mm faceplate · controls directivity down to ≈ {Math.round(twWg.controlHz / 100) * 100} Hz.</p>
            {#each waveguideIssues(twWg, tw.tweeter) as w}<ul class="callouts"><li class="bad">{w}</li></ul>{/each}
          {/if}
          {#if tw.mount === 'front'}
            <p class="small muted">Above the woofer in the same printed front{p.type === 'tl' ? ', in its own small sealed compartment so the line stays the right size' : ''}{tw.waveguide ? '; the waveguide is a separate print that drops into a hole in the front wall' : ''}.</p>
          {:else if head}
            <p class="small muted">A separate printed {head.kind === 'waveguide' ? 'waveguide pod' : 'round pod'}, {head.w} × {head.h} × {head.d} mm, sitting {head.setbackMm} mm back on a soft pad: decoupled from the woofer cabinet, low diffraction, time-aligned with the woofer.</p>
          {/if}
        {/if}
      {/if}
    </section>

    {#if sims.length}
      <section class="card">
        <h2>Output (simulated from this geometry)</h2>
        {#if r0.impedance}
          <div class="chips" role="tablist" aria-label="Output graph">
            {#each [['spl', 'Response'], ['z', 'Impedance'], ['gd', 'Group delay'], ['vel', 'Mouth air speed']] as [k, lbl]}
              <button class="chip" role="tab" aria-selected={outGraph === k} class:on={outGraph === k} onclick={() => (outGraph = k as typeof outGraph)}>{lbl}</button>
            {/each}
          </div>
        {/if}
        {#if outGraph === 'spl' || !r0.impedance}
          <MiniChart
            series={[
              ...sims.map((s, i) => ({ label: s.n === 1 ? (isSub ? '1 cabinet on the ground' : r0.mouthSpl ? 'Total, 1 m, 2.83 V' : '1 m, 2.83 V') : `${s.n} cabinets coupled`, color: COLORS[i], points: s.r.freqs.map((f, k) => ({ x: f, y: s.r.spl[k] })) })),
              ...pinSeries,
              ...(r0.mouthSpl && p.type !== 'tapped' ? [{ label: 'Cone (front)', color: '#94a3b8', dashed: true, width: 1.3, points: r0.freqs.map((f, k) => ({ x: f, y: r0.coneSpl![k] })) }] : []),
              ...(r0.mouthSpl ? [{ label: p.type === 'tl' ? 'Terminus' : 'Horn mouth', color: '#f472b6', dashed: true, width: 1.3, points: r0.freqs.map((f, k) => ({ x: f, y: r0.mouthSpl![k] })) }] : []),
            ]}
            xMin={isSub ? 15 : 20}
            xMax={isSub ? 300 : 600}
            yMin={isSub ? 80 : 50}
            yMax={isSub ? 125 : 100}
            yStep={5}
            yLabel="dB"
            xTicks={isSub ? [20, 30, 50, 100, 200] : [20, 50, 100, 200, 500]}
            markers={[{ x: r0.f3, label: `f3 ${r0.f3.toFixed(0)} Hz` }, ...(r0.resonances ?? []).slice(0, 4).map((f) => ({ x: f, label: `${Math.round(f)}`, color: '#a78bfa' }))]}
          />
        {:else}
          {@const ys = outGraph === 'z' ? r0.impedance! : outGraph === 'gd' ? r0.groupDelayMs! : r0.mouthVelocity!}
          {@const top = Math.max(...ys.filter((_, i) => r0.freqs[i] > 20 && Number.isFinite(ys[i])))}
          <MiniChart
            series={[
              { label: outGraph === 'z' ? 'Impedance' : outGraph === 'gd' ? 'Group delay' : 'Peak air speed at 2.83 V', color: COLORS[0], points: r0.freqs.map((f, k) => ({ x: f, y: ys[k] })) },
              ...(outGraph === 'vel' ? [{ label: `${MOUTH_NOISE_MS} m/s: noise starts`, color: '#fbbf24', dashed: true, width: 1.3, points: [{ x: 15, y: MOUTH_NOISE_MS }, { x: 600, y: MOUTH_NOISE_MS }] }] : []),
            ]}
            xMin={20}
            xMax={600}
            yMin={0}
            yMax={Math.ceil((Math.max(top, outGraph === 'vel' ? MOUTH_NOISE_MS : 0) * 1.1) / 5) * 5 || 5}
            yStep={outGraph === 'z' && top > 60 ? 20 : 5}
            yLabel={outGraph === 'z' ? 'Ω' : outGraph === 'gd' ? 'ms' : 'm/s'}
            xTicks={[20, 50, 100, 200, 500]}
          />
        {/if}
        {#if !isSub}
          <div class="chips">
            <button class="chip" data-testid="pin-printed" onclick={pinPrinted} disabled={home.modelerPins.length >= 4 || home.modelerPins.some((x) => x.label === pinLabel)}>📌 {home.modelerPins.some((x) => x.label === pinLabel) ? 'Pinned' : 'Pin to compare'}</button>
            <span class="small muted" style="align-self:center">Pinned designs — plywood or printed — show here and in the plywood box modeler, on the same basis.</span>
          </div>
        {/if}
        {#if r0.lineWarnings?.length}
          <ul class="callouts">{#each r0.lineWarnings as w}<li class="warn">{w}</li>{/each}</ul>
        {/if}
        <p class="small muted">SPL at 1 m for 2.83 V{isSub ? ' (on the ground; coupled stacks are the whole stack)' : ''}. Max output (excursion- or power-limited) at 40 Hz: <b>{sims[sims.length - 1].r.maxSpl[sims[sims.length - 1].r.freqs.findIndex((f) => f >= 40)].toFixed(0)} dB</b>{isSub ? ` for ${sims[sims.length - 1].n} coupled` : ''}.</p>
      </section>
    {/if}
    <section class="card">
      <h2>Size & profile</h2>
      {#each (p.type === 'shell' ? [['heightMm', 'Diameter', 150, 600, 10], ['depthMm', 'Length (back to front)', 150, 800, 10]] : [['heightMm', 'Height', 200, 1400, 10], ['depthMm', 'Depth (profile width)', 120, 1400, 10], ['extrusionMm', 'Width between the outer plates', 60, 900, 5]]) as [k, lbl, mn, mx, st]}
        {@const key = k as 'heightMm' | 'depthMm' | 'extrusionMm'}
        <div class="field">
          <label for={`h-${key}`}>{lbl}</label><span class="val">{p[key]} mm</span>
          <input id={`h-${key}`} type="range" min={mn} max={mx} step={st} bind:value={p[key]} />
        </div>
      {/each}
      {#if p.type !== 'waveguide' && p.type !== 'sealed' && p.type !== 'shell'}
        <div class="seg" style="margin:6px 0">
          <button class:on={p.construction === 'full'} onclick={() => (p.construction = 'full')}>Fully printed core</button>
          <button class:on={p.construction === 'bends'} onclick={() => { p.construction = 'bends'; if (![12, 18, 19].includes(p.wallMm)) p.wallMm = 18; }}>Printed bends + plywood walls</button>
        </div>
        <p class="small muted" style="margin:0 0 6px">
          {#if geo.construction === 'bends'}
            Only the front and back end-caps are printed (the curved bends, rounded wall tips, mouth and throat). Every long straight wall is a plywood strip slotted into the caps — far less plastic and print time, same acoustics.
          {:else}
            The whole internal profile is one printed core — simplest assembly, most plastic.
          {/if}
        </p>
      {/if}
      {#if geo.construction === 'bends'}
        <div class="chips">
          <span class="small muted" style="align-self:center">Wall plywood:</span>
          {#each [12, 18, 19] as tw}<button class="chip" class:on={p.wallMm === tw} onclick={() => (p.wallMm = tw)}>{tw === 19 ? '19 mm MDF' : `${tw} mm birch`}</button>{/each}
        </div>
      {:else}
      <div class="field">
        <label for="h-wall">Printed wall thickness</label>
        <span class="val">{p.wallMm.toFixed(1)} mm = {Math.round(p.wallMm / lw)} lines</span>
        <span class="hint">Snaps to whole {lw} mm lines. Chunky walls are stiffer; the flex check below tells you if they are enough.</span>
        <input id="h-wall" type="range" min={lw * 3} max={lw * 16} step={lw} value={p.wallMm} oninput={(e) => (p.wallMm = Math.round(+(e.target as HTMLInputElement).value / lw) * lw)} />
      </div>
      {/if}
      {#if p.type !== 'shell'}
      <div class="field">
        <label for="h-div">Plywood dividers inside the core</label>
        <span class="val">{p.dividers} → {geo.cores} printed core{geo.cores > 1 ? 's' : ''} of {geo.coreMm.toFixed(0)} mm</span>
        <span class="hint">Each divider halves the span the printed walls bridge — ~4× stiffer — and makes each core a shorter print.</span>
        <input id="h-div" type="range" min="0" max="3" step="1" bind:value={p.dividers} />
      </div>
      <div class="field">
        <label for="h-round">Organic rounding</label>
        <span class="val">{Math.round(p.rounding * 100)} %</span>
        <span class="hint">0 = square corners; 100 % = bends as round as the space allows.</span>
        <input id="h-round" type="range" min="0" max="1" step="0.05" bind:value={p.rounding} />
      </div>
      <div class="chips">
        {#each [['bb18', 18, '18 mm birch'], ['bb12', 12, '12 mm birch'], ['mdf19', 19, '19 mm MDF'], ['glass', 12, '12 mm laminated glass'], ['acrylic', 10, '10 mm acrylic']] as [id, t, lbl]}
          <button class="chip" class:on={p.plateMaterial === id} onclick={() => setPlate(id as PlateMaterial, t as number)}>{lbl} plates</button>
        {/each}
        <button class="chip" class:on={p.plateMaterial === 'sandwich'} onclick={() => setPlate('sandwich')}>Fibre sandwich plates</button>
      </div>
      {#if p.plateMaterial === 'sandwich'}
        <div class="sandwich">
          <div class="seg">
            <button class:on={sw.skin === 'carbon'} onclick={() => (p.sandwich.skin = 'carbon')}>Carbon skins</button>
            <button class:on={sw.skin === 'glass'} onclick={() => (p.sandwich.skin = 'glass')}>Fibreglass skins</button>
          </div>
          <div class="chips">
            <span class="small muted" style="align-self:center">Core:</span>
            <button class="chip" class:on={sw.core === 'ribs'} onclick={() => setCore('ribs')}>Printed ribs</button>
            {#each Object.entries(WOOD_CORES) as [id, w]}
              <button class="chip" class:on={sw.core === id} onclick={() => setCore(id as SandwichCore)}>{w.short}</button>
            {/each}
          </div>
          <div class="field">
            <label for="sw-plies">Cloth layers on each face</label>
            <span class="val">{sw.plies} × {SKINS[sw.skin].tPly} mm = {swInfo.tSkinMm.toFixed(2)} mm</span>
            <input id="sw-plies" type="range" min="1" max="6" step="1" bind:value={p.sandwich.plies} />
          </div>
          {#if sw.core === 'ribs'}
            <div class="field">
              <label for="sw-core">Rib core thickness</label><span class="val">{sw.coreMm} mm</span>
              <input id="sw-core" type="range" min="8" max="50" step="1" bind:value={p.sandwich.coreMm} />
            </div>
            <div class="field">
              <label for="sw-pitch">Rib spacing</label><span class="val">{sw.ribPitchMm} mm grid, ribs {swInfo.ribMm.toFixed(1)} mm ({sw.ribLines} line{sw.ribLines > 1 ? 's' : ''})</span>
              <input id="sw-pitch" type="range" min="15" max="100" step="5" bind:value={p.sandwich.ribPitchMm} />
            </div>
            <div class="chips">
              <span class="small muted" style="align-self:center">Rib lines:</span>
              {#each [1, 2, 3] as n}<button class="chip" class:on={sw.ribLines === n} onclick={() => (p.sandwich.ribLines = n)}>{n}</button>{/each}
            </div>
          {:else}
            <div class="chips">
              <span class="small muted" style="align-self:center">{WOOD_CORES[sw.core].short} thickness:</span>
              {#each WOOD_CORES[sw.core].sizes as t}<button class="chip" class:on={sw.coreMm === t} onclick={() => (p.sandwich.coreMm = t)}>{t} mm</button>{/each}
            </div>
          {/if}
          <div class="stats">
            <div class="stat"><div class="k">Plate</div><div class="v sm">{swInfo.tMm.toFixed(1)} mm</div><div class="s">{swInfo.m.toFixed(1)} kg/m² (birch 18: {birchRef.m.toFixed(1)})</div></div>
            <div class="stat"><div class="k">Stiffness</div><div class="v sm">{(swInfo.D / birchRef.D).toFixed(1)}×</div><div class="s">18 mm birch</div></div>
            {#if panels}
              <div class="stat"><div class="k">Plates / cabinet</div><div class="v sm">{panels.plateKg.toFixed(1)} kg</div><div class="s">birch: {panels.birchKg.toFixed(1)} kg</div></div>
              <div class="stat"><div class="k">Layup</div><div class="v sm">{panels.clothM2.toFixed(1)} m²</div><div class="s">cloth + {panels.epoxyKg.toFixed(1)} kg epoxy{panels.tilesPerPanel ? ` · ${panels.panels}×${panels.tilesPerPanel} rib tiles, ${(panels.grams / 1000).toFixed(1)} kg, ~${panels.hours.toFixed(0)} h` : ''}</div></div>
            {/if}
          </div>
          <p class="small muted">{geo.cores > 1 ? 'Dividers are the same sandwich panel. ' : ''}Build steps and checks are in the build notes below.</p>
        </div>
      {/if}
      {/if}
      {#if p.type !== 'waveguide' && p.type !== 'sealed' && p.type !== 'shell'}
        <div class="field">
          <label for="h-legs">{p.type === 'slot-port' ? 'Port folds' : 'Legs (folds + 1)'}</label><span class="val">{p.legs}</span>
          <input id="h-legs" type="range" min="1" max="8" step="1" bind:value={p.legs} />
        </div>
      {/if}
      {#if p.type === 'folded-horn'}
        <div class="field">
          <label for="h-thr">Throat area / cone area</label><span class="val">{p.throatRatio.toFixed(2)}</span>
          <span class="hint">Smaller = more compression (efficiency) but more air-speed and driver stress.</span>
          <input id="h-thr" type="range" min="0.25" max="1" step="0.01" bind:value={p.throatRatio} />
        </div>
        <div class="field">
          <label for="h-rc">Rear chamber</label><span class="val">{p.rearChamberL} L (min. set by driver depth)</span>
          <input id="h-rc" type="range" min="10" max="150" step="1" bind:value={p.rearChamberL} />
        </div>
        <div class="chips">
          <span class="small muted" style="align-self:center">Mouth:</span>
          <button class="chip" class:on={p.mouth === 'edge'} onclick={() => (p.mouth = 'edge')}>Bottom edge (2 couple)</button>
          <button class="chip" class:on={p.mouth === 'corner'} onclick={() => (p.mouth = 'corner')}>Corner (4 couple)</button>
        </div>
      {:else if p.type === 'tl'}
        <div class="field">
          <label for="h-tap">Line taper (end / start area)</label><span class="val">{p.taper.toFixed(2)}{p.taper > 1 ? ' — expanding' : p.taper < 1 ? ' — tapering' : ' — straight'}</span>
          <span class="hint">Below 1 the line narrows towards the terminus (classic tapered line); above 1 it opens up (an expanding line, nearer a horn).</span>
          <input id="h-tap" type="range" min="0.2" max="2.5" step="0.05" bind:value={p.taper} />
        </div>
        <div class="field">
          <label for="h-fold">Woofer position along the line</label>
          <span class="val">{(p.driverFold ?? 0) === 0 ? 'at the closed end' : `at front fold ${p.driverFold} (≈ ${Math.round((geo.taps?.rearMm ?? 0) / Math.max(1, geo.path.s[geo.path.s.length - 1]) * 100)} % along)`}</span>
          <span class="hint">An offset driver (≈ ⅓ along) doesn't excite the line's 3rd harmonic — a cleaner mid-bass with less stuffing.</span>
          <input id="h-fold" type="range" min="0" max={Math.max(0, Math.floor((p.legs - 1) / 2))} step="1" value={p.driverFold ?? 0} oninput={(e) => (p.driverFold = +(e.currentTarget as HTMLInputElement).value)} />
        </div>
      {:else if p.type === 'blh' || p.type === 'tapped'}
        <div class="field">
          <label for="h-thr2">Throat area / cone area</label><span class="val">{p.throatRatio.toFixed(2)}</span>
          <span class="hint">Smaller throat = more horn loading (efficiency) but more air speed; the horn then expands to fill the height.</span>
          <input id="h-thr2" type="range" min="0.3" max="1.5" step="0.05" bind:value={p.throatRatio} />
        </div>
        {#if p.type === 'blh'}
          <div class="field">
            <label for="h-rc2">Rear chamber (at least what the woofer needs)</label><span class="val">{p.rearChamberL} L</span>
            <span class="hint">The chamber behind the woofer and the throat form a low-pass filter that keeps the horn to the bass.</span>
            <input id="h-rc2" type="range" min="1" max="30" step="0.5" bind:value={p.rearChamberL} />
          </div>
        {/if}
      {:else if p.type === 'slot-port'}
        <div class="field">
          <label for="h-slot">Slot height</label><span class="val">{p.slotMm} mm</span>
          <input id="h-slot" type="range" min="15" max="120" step="1" bind:value={p.slotMm} />
        </div>
      {:else}
        <div class="field">
          <label for="h-cov">Coverage angle</label><span class="val">{p.coverageDeg}°</span>
          <input id="h-cov" type="range" min="40" max="120" step="5" bind:value={p.coverageDeg} />
        </div>
        <div class="field">
          <label for="h-thw">Throat width</label><span class="val">{p.throatMm} mm</span>
          <input id="h-thw" type="range" min="20" max="60" step="1" bind:value={p.throatMm} />
        </div>
      {/if}
      <ul class="callouts">
        {#each geo.stats as st}<li><b>{st.label}:</b> {st.value}</li>{/each}
        {#each geo.chambers as c}<li><b>{c.label}:</b> {c.volumeL.toFixed(1)} L</li>{/each}
      </ul>
    </section>

    {#if isLine}
      <section class="card">
        <h2>Stuffing &amp; resonance traps</h2>
        <p class="sub">Damping the {p.type === 'tl' ? 'line' : 'horn'} tames its higher resonances (the 3rd, 5th… harmonics) that would otherwise colour the mid-bass. Modelled with the Miki fibre-absorption model from the fill density.</p>
        <div class="field">
          <label for="st-d">Polyester fibre fill</label>
          <span class="val">{(stuffing[0]?.densityGL ?? 0).toFixed(1)} g/L{(stuffing[0]?.densityGL ?? 0) === 0 ? ' — unstuffed' : ''}</span>
          <span class="hint">~5 = light, ~10 = typical first half of a line, 15+ = dense.</span>
          <input id="st-d" type="range" min="0" max="20" step="0.5" value={stuffing[0]?.densityGL ?? 0} oninput={(e) => setStuffing({ densityGL: +(e.currentTarget as HTMLInputElement).value })} />
        </div>
        {#if (stuffing[0]?.densityGL ?? 0) > 0}
          <div class="field">
            <label for="st-to">Stuffed from the closed end to</label>
            <span class="val">{Math.round((stuffing[0]?.to ?? 0.5) * 100)} % of the {p.type === 'tl' ? 'line' : 'path'}</span>
            <input id="st-to" type="range" min="0.1" max="1" step="0.05" value={stuffing[0]?.to ?? 0.5} oninput={(e) => setStuffing({ from: 0, to: +(e.currentTarget as HTMLInputElement).value })} />
          </div>
        {/if}
        <div class="chips">
          <span class="small muted" style="align-self:center">Trap the line's</span>
          {#each [3, 5] as h}
            <label class="chip"><input type="checkbox" checked={(p.trapHarmonics ?? []).includes(h)} onchange={(e) => toggleTrap(h, (e.currentTarget as HTMLInputElement).checked)} /> {h}{h === 3 ? 'rd' : 'th'} harmonic</label>
          {/each}
        </div>
        {#if geo.traps?.length}
          <ul class="callouts">
            {#each geo.traps as tr}
              <li>Trap for the {tr.harmonic}{tr.harmonic === 3 ? 'rd' : 'th'} harmonic: a printed bottle of {tr.volumeL.toFixed(2)} L (Ø{tr.diaMm} × {Math.round(tr.lenMm)} mm) with a Ø{Math.round(2 * Math.sqrt(tr.neckAreaCm2 / Math.PI) * 10)} × {tr.neckLenMm} mm neck through the side plate, {Math.round(tr.atMm)} mm along the path — tuned to {Math.round(trapTuningHz(tr))} Hz. A wisp of wool inside broadens it.</li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}

    <section class="card">
      <details>
        <summary><h2 class="inline">Profile drawing (2D)</h2></summary>
        <div class="svg-wrap sect">
          <svg viewBox={`-60 -40 ${geo.W + 120} ${geo.H + 90}`} role="img" aria-label="Cross-section">
            <g transform={`translate(0 ${geo.H}) scale(1 -1)`}>
              <path d={solidPath} class="print" fill-rule="evenodd" />
              {#each geo.dead as r}<rect x={r.x0} y={r.y0} width={r.x1 - r.x0} height={r.y1 - r.y0} class="deadsp" />{/each}
              {#each geo.strips as st}<rect x={st.rect.x0} y={st.rect.y0} width={st.rect.x1 - st.rect.x0} height={st.rect.y1 - st.rect.y0} class="ply" />{/each}
              {#each geo.caps as c}<rect x={c.x0} y={c.y0} width={c.x1 - c.x0} height={c.y1 - c.y0} class="capline" />{/each}
              {#if geo.mouthRect}<rect x={geo.mouthRect.x0 - 4} y={geo.mouthRect.y0} width="8" height={geo.mouthRect.y1 - geo.mouthRect.y0} class="mouth" />{/if}
              {#if geo.tweeter}
                {@const twd = (geo.tweeter.waveguide ? geo.tweeter.waveguide.depthMm : 0) + (geo.tweeter.driver.mountDepthMm ?? 35)}
                <rect x={geo.W - twd} y={geo.tweeter.y - geo.tweeter.holeR} width={twd} height={2 * geo.tweeter.holeR} class="drv tw" />
              {/if}
              <!-- driver -->
              <rect x={geo.driver.x - 6} y={geo.driver.y - geo.driver.dia / 2} width="12" height={geo.driver.dia} class="drv" />
              <path d={`M ${geo.driver.x} ${geo.driver.y - geo.driver.dia * 0.45} L ${geo.driver.x + (geo.driver.face === 'front' ? -1 : 1) * geo.driver.dia * 0.28} ${geo.driver.y} L ${geo.driver.x} ${geo.driver.y + geo.driver.dia * 0.45}`} class="cone" />
            </g>
            {#each geo.labels as l}
              <text x={l.x} y={geo.H - l.y + 5} text-anchor="middle" class="lbl">{l.text}</text>
            {/each}
            <text x={geo.W + 8} y={geo.H - ((geo.mouthRect?.y0 ?? 0) + (geo.mouthRect?.y1 ?? 0)) / 2} class="lbl mouthlbl">{isSub ? 'mouth →' : p.type === 'waveguide' ? 'mouth →' : 'exit →'}</text>
            <line x1="0" y1={geo.H + 22} x2={geo.W} y2={geo.H + 22} class="dim" />
            <text x={geo.W / 2} y={geo.H + 42} text-anchor="middle" class="dimtxt">{mm(geo.W)} (depth, back → front)</text>
            <line x1="-22" y1="0" x2="-22" y2={geo.H} class="dim" />
            <text x="-30" y={geo.H / 2} text-anchor="middle" class="dimtxt" transform={`rotate(-90 -30 ${geo.H / 2})`}>{mm(geo.H)}</text>
          </svg>
        </div>
        <p class="small muted">Grey = printed plastic, dark = air. This profile is extruded {geo.coreMm.toFixed(0)} mm (into the screen){geo.cores > 1 ? ` as ${geo.cores} cores separated by ${geo.cores - 1} plywood divider${geo.cores > 2 ? 's' : ''}` : ''} and closed on both sides by the wooden plates. Bends sweep round, wall tips are half-round and the mouth lips roll out — the shapes 3D printing makes easy.</p>
      </details>
    </section>

    {#if !isSub}
      <section class="card">
        <h2>Use it in the simulator</h2>
        <label class="toggle"><input type="checkbox" checked={home.hybrid.useLiving && home.hybrid.livingId === id} onchange={(e) => { const on = (e.currentTarget as HTMLInputElement).checked; home.hybrid.useLiving = on; if (on) home.hybrid.livingId = id; }} disabled={p.type === 'waveguide' || !geo.fits} /> Use this speaker as the living-room mains</label>
        <p class="small muted">The living-room bass maps then use this speaker's simulated bass response instead of a plywood design's.</p>
      </section>
    {:else}
      <section class="card">
        <h2>Use it in the simulator</h2>
        <label class="toggle"><input type="checkbox" bind:checked={home.hybrid.useOutdoor} disabled={p.type !== 'folded-horn' || !geo.fits} /> Use this horn for the outdoor subs</label>
        <p class="small muted">The outdoor maps then use this cabinet's size and its simulated response, including how {p.mouth === 'corner' ? 'up to 4' : 'pairs of'} mouths couple.</p>
      </section>
    {/if}
    {/if}

    {#if mode === 'build'}
    <section class="card">
      <h2>Printing</h2>
      <div class="chips" style="margin-bottom:8px">
        <button class="chip" onclick={() => downloadBlob(`${fileBase}-print-pieces.stl`, printPiecesStl(printPieces(geo, p, plan, d, head)), 'model/stl')} disabled={!geo.fits}>⬇ Print pieces (STL)</button>
        <button class="chip" onclick={() => downloadBlob(`${fileBase}-plates.dxf`, platesDxf(geo, p, d), 'application/dxf')} disabled={!geo.fits}>⬇ Plates &amp; dividers (DXF)</button>
      </div>
      <p class="small muted" style="margin-top:0">The STL holds every piece as the plan splits it, laid out side by side in millimetres (your slicer can split them into objects). The front wall prints flat as its own plate — its round holes then need no support — and glues to the cores.</p>
      <div class="bedin">
        {#each [['bedX', 'Bed X', 1], ['bedY', 'Bed Y', 1], ['maxZ', 'Max Z', 1], ['margin', 'Margin', 1], ['nozzle', 'Nozzle', 0.1], ['lineWidth', 'Line width', 0.05], ['layerH', 'Layer', 0.05], ['flow', 'Flow mm³/s', 1]] as [k, lbl, st]}
          {@const key = k as 'bedX' | 'bedY' | 'maxZ' | 'margin' | 'nozzle' | 'lineWidth' | 'layerH' | 'flow'}
          <label>{lbl}<input type="number" min="0" max="1000" step={st} bind:value={home.hybrid.printer[key]} /></label>
        {/each}
      </div>
      <div class="stats">
        <div class="stat"><div class="k">Segments</div><div class="v">{plan.segments.length}</div><div class="s">{geo.cores > 1 ? `${geo.cores} cores · ` : ''}{plan.regions.length > 1 ? 'front + back caps' : 'whole profile'}{plan.cutsZ.length ? ` · ${plan.cutsZ.length + 1} layers` : ''}</div></div>
        <div class="stat"><div class="k">Alignment keys</div><div class="v">{plan.keys.length}</div><div class="s">+ dowels between layers</div></div>
        <div class="stat"><div class="k">Filament / time</div><div class="v">{(plan.totalGrams / 1000).toFixed(1)} kg</div><div class="s">~{plan.hours.toFixed(0)} h at {home.hybrid.printer.flow} mm³/s · {plan.layers} layers per core</div></div>
        <div class="stat"><div class="k">Largest piece</div><div class="v sm">{Math.round(Math.max(...plan.segments.map((s) => s.bedW)))} × {Math.round(Math.max(...plan.segments.map((s) => s.bedH)))} mm</div><div class="s">fits {plan.usable[0]} × {plan.usable[1]} usable</div></div>
      </div>
        <div class="svg-wrap sect">
        <svg viewBox={`-30 -30 ${geo.W + 60} ${geo.H + 60}`} role="img" aria-label="Print layout">
          <g transform={`translate(0 ${geo.H}) scale(1 -1)`}>
            <path d={solidPath} class="print" fill-rule="evenodd" />
            {#each geo.dead as r}<rect x={r.x0} y={r.y0} width={r.x1 - r.x0} height={r.y1 - r.y0} class="deadsp" />{/each}
            {#each geo.strips as st}<rect x={st.rect.x0} y={st.rect.y0} width={st.rect.x1 - st.rect.x0} height={st.rect.y1 - st.rect.y0} class="ply" />{/each}
            {#each geo.caps as c}<rect x={c.x0} y={c.y0} width={c.x1 - c.x0} height={c.y1 - c.y0} class="capline" />{/each}
            {#each plan.cutLines as c}<line x1={c.x1} y1={c.y1} x2={c.x2} y2={c.y2} class="cut" />{/each}
            {#each plan.keys as k}<rect x={k.x - 6} y={k.y - 6} width="12" height="12" class="key" transform={`rotate(45 ${k.x} ${k.y})`} />{/each}
          </g>
          {#each plan.segments.filter((sg) => sg.z0 === 0 && sg.core === 0) as sg}
            <text x={(sg.x0 + sg.x1) / 2} y={geo.H - (sg.y0 + sg.y1) / 2} text-anchor="middle" class="seglbl">{sg.tile}</text>
          {/each}
        </svg>
      </div>
      <p class="small muted">
        {geo.construction === 'bends' ? 'Only the yellow-outlined end-caps are printed; wood-coloured parts are plywood. ' : ''}Red dashed = cut lines (placed through walls where possible); ◆ = alignment keys. Printed flat (profile on the bed){plan.rotated ? ', rotated 90° to fit' : ''}, the extrusion grows upward
        {#if plan.cutsZ.length}in {plan.cutsZ.length + 1} layers of ≤ {home.hybrid.printer.maxZ} mm{/if}.
      </p>
      <div class="beds">
        {#each plan.segments.filter((sg) => sg.z0 === 0 && sg.core === 0) as sg}
          <div class="bed">
            <svg viewBox={`0 0 ${home.hybrid.printer.bedX} ${home.hybrid.printer.bedY}`}>
              <rect x="0" y="0" width={home.hybrid.printer.bedX} height={home.hybrid.printer.bedY} class="bedrect" />
              <rect x={home.hybrid.printer.margin} y={home.hybrid.printer.margin} width={home.hybrid.printer.bedX - 2 * home.hybrid.printer.margin} height={home.hybrid.printer.bedY - 2 * home.hybrid.printer.margin} class="bedmargin" />
              <rect x={home.hybrid.printer.margin} y={home.hybrid.printer.margin} width={sg.bedW} height={sg.bedH} class="part" />
            </svg>
            <span>{sg.tile} · {Math.round(sg.bedW)}×{Math.round(sg.bedH)}</span>
          </div>
        {/each}
      </div>
      <table class="tbl" style="margin-top:8px">
        <thead><tr><th>Piece</th><th>On the bed</th><th>Height (Z)</th><th>≈ g</th></tr></thead>
        <tbody>
          {#each plan.segments as sg}
            <tr><td>{sg.id}</td><td>{Math.round(sg.bedW)} × {Math.round(sg.bedH)} mm</td><td>{Math.round(sg.z1 - sg.z0)} mm</td><td>{Math.round(sg.grams)}</td></tr>
          {/each}
        </tbody>
      </table>
    </section>

    {#if geo.strips.length}
      <section class="card">
        <h2>Plywood strips (per cabinet)</h2>
        <p class="sub">All strips are {geo.coreMm.toFixed(0)} mm wide (the core thickness) and {p.wallMm} mm thick. Rip one long strip at that width, then crosscut to length.</p>
        <table class="tbl">
          <thead><tr><th>Part</th><th>Qty</th><th>Length</th></tr></thead>
          <tbody>
            {#each geo.strips as st}
              <tr><td><b>{st.name}</b>{#if st.note}<span class="mm">{st.note}</span>{/if}</td><td>{st.qty}</td><td>{Math.round(st.lengthMm)} mm<span class="mm">{(st.lengthMm / 25.4).toFixed(1)}″</span></td></tr>
            {/each}
          </tbody>
        </table>
      </section>
    {/if}

    {#if geo.tweeter}
      {@const gt = geo.tweeter}
      <section class="card">
        <h2>Tweeter in the front wall{gt.waveguide ? ' (printed waveguide)' : ''}</h2>
        <div class="stats">
          <div class="stat"><div class="k">Hole in the front</div><div class="v sm">Ø{Math.round(2 * gt.holeR)} mm</div><div class="s">centre {Math.round(geo.H - gt.y)} mm from the top</div></div>
          <div class="stat"><div class="k">Tweeter</div><div class="v sm">{gt.driver.model}</div><div class="s">cut-out Ø{gt.driver.cutoutDiaMm} mm · {gt.driver.mountDepthMm ?? '?'} mm deep</div></div>
          {#if gt.waveguide}
            <div class="stat"><div class="k">Waveguide insert</div><div class="v sm">Ø{Math.round(2 * gt.waveguide.flangeR)} × {gt.waveguide.depthMm.toFixed(0)} mm</div><div class="s">{gt.waveguide.coverageDeg}° · controls down to ≈ {Math.round(gt.waveguide.controlHz / 100) * 100} Hz</div></div>
          {/if}
        </div>
        <ul class="callouts">
          {#if gt.waveguide}
            <li>Print the waveguide face down as one piece (no supports: the flare widens steadily). It drops into the Ø{Math.round(2 * gt.holeR)} mm hole and is screwed through its flange into heat-set inserts; seal the flange with foam gasket tape.</li>
            <li>The tweeter mounts from behind, its faceplate flush in the throat recess (Ø{Math.round(2 * gt.waveguide.r0)} mm, {gt.waveguide.recessMm} mm deep), held by its own screws into the insert's back.</li>
          {:else}
            <li>The hole is printed in; use heat-set M3 inserts for the tweeter screws and seal it with foam gasket tape.</li>
          {/if}
          {#if p.type === 'tl'}<li>The tweeter sits in its own small sealed compartment above the line; run its wire through a sealed grommet.</li>{:else}<li>Its closed back sits inside the woofer's box — normal for dome tweeters.</li>{/if}
        </ul>
      </section>
    {/if}
    {#if head}
      <section class="card">
        <h2>Tweeter head ({head.kind === 'waveguide' ? 'waveguide pod' : 'round pod'})</h2>
        <div class="stats">
          <div class="stat"><div class="k">Pod</div><div class="v sm">{head.w} × {head.h} × {head.d} mm</div><div class="s">one print, face down</div></div>
          <div class="stat"><div class="k">Filament</div><div class="v sm">≈ {head.grams} g</div><div class="s">{head.wallMm} mm walls</div></div>
          <div class="stat"><div class="k">Tweeter hole</div><div class="v sm">Ø{head.tweeterCutoutMm} mm</div><div class="s">printed in, with a flush rebate</div></div>
          <div class="stat"><div class="k">Set back</div><div class="v sm">{head.setbackMm} mm</div><div class="s">behind the cabinet front</div></div>
        </div>
        <ul class="callouts">{#each head.notes as n}<li>{n}</li>{/each}</ul>
        {#if Math.max(head.w, head.h) > Math.min(home.hybrid.printer.bedX, home.hybrid.printer.bedY) - 2 * home.hybrid.printer.margin}
          <ul class="callouts"><li class="bad">The pod's {Math.max(head.w, head.h)} mm face is bigger than your bed — print it in two halves split vertically.</li></ul>
        {/if}
      </section>
    {/if}

    <section class="card">
      <h2>Build notes</h2>
      <ul class="callouts">
        {#each issues as is}<li class={is.level === 'ok' ? 'good' : is.level}><b>{is.title}</b><br />{is.body}</li>{/each}
      </ul>
    </section>
    {/if}
  </div>
</div>

<style>
  .fitnote {
    margin: 6px 0;
    padding: 7px 10px;
    border-radius: 8px;
    background: rgba(52, 211, 153, 0.12);
    color: #a7f3d0;
    font-size: 13px;
    display: flex;
    flex-wrap: wrap;
    gap: 4px 8px;
    align-items: center;
  }
  .fitnote b {
    color: #d1fae5;
  }
  .linklike {
    background: none;
    border: 0;
    padding: 0;
    color: inherit;
    text-decoration: underline;
    cursor: pointer;
    font: inherit;
  }
  .drv.tw {
    opacity: 0.55;
  }
  .s3d-wrap {
    height: 58vh;
    min-height: 340px;
  }
  details > summary {
    cursor: pointer;
    list-style: none;
  }
  details > summary::-webkit-details-marker {
    display: none;
  }
  details > summary .inline {
    display: inline;
  }
  details > summary .inline::before {
    content: '▸ ';
    color: var(--text-2);
  }
  details[open] > summary .inline::before {
    content: '▾ ';
  }
  .sandwich {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px;
    margin: 6px 0 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .dimline {
    font-size: 13px;
    color: var(--amber);
  }
  .vis-3d {
    height: 52vh;
    min-height: 320px;
  }
  .sect svg {
    max-height: 56vh;
  }
  :global(.print) {
    fill: #9ca3af;
    stroke: #e5e7eb;
    stroke-width: 1;
  }
  :global(.air) {
    fill: #0b1020;
  }
  :global(.air.dim2) {
    fill: #1e293b;
  }
  :global(.mouth) {
    fill: #34d399;
  }
  :global(.drv) {
    fill: #1f2024;
    stroke: #38bdf8;
    stroke-width: 2;
  }
  :global(.cone) {
    fill: none;
    stroke: #38bdf8;
    stroke-width: 3;
  }
  :global(.lbl) {
    fill: #e2e8f0;
    font-size: 16px;
    font-weight: 600;
  }
  :global(.mouthlbl) {
    fill: #34d399;
  }
  :global(.deadsp) {
    fill: #1e293b;
  }
  :global(.ply) {
    fill: #c99a62;
    stroke: #6b4a2a;
    stroke-width: 1;
  }
  :global(.capline) {
    fill: none;
    stroke: #fbbf24;
    stroke-width: 3;
    stroke-dasharray: 10 6;
  }
  :global(.cut) {
    stroke: #f87171;
    stroke-width: 3;
    stroke-dasharray: 12 8;
  }
  :global(.key) {
    fill: #fbbf24;
  }
  :global(.seglbl) {
    fill: #fde68a;
    font-size: 26px;
    font-weight: 800;
  }
  .beds {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(70px, 1fr));
    gap: 6px;
    margin-top: 6px;
  }
  .bed {
    display: flex;
    flex-direction: column;
    align-items: center;
    font-size: 11px;
    color: var(--text-2);
  }
  .bed svg {
    width: 100%;
    height: auto;
  }
  :global(.bedrect) {
    fill: #111827;
    stroke: #475569;
    stroke-width: 4;
  }
  :global(.bedmargin) {
    fill: none;
    stroke: #64748b;
    stroke-width: 2;
    stroke-dasharray: 8 6;
  }
  .bed :global(.part) {
    fill: #93c5fd;
  }
  .pick {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-top: 10px;
    font-size: 13px;
    color: var(--text-2);
  }
  .pick select {
    flex: 1;
    background: var(--bg-0);
    color: var(--text-0);
    border: 1px solid var(--border);
    border-radius: 9px;
    padding: 8px;
    font-size: 14px;
  }
  .bedin {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    row-gap: 8px;
    gap: 6px;
  }
  .bedin label {
    display: flex;
    flex-direction: column;
    font-size: 12px;
    color: var(--text-2);
  }
  .bedin input {
    background: var(--bg-0);
    color: var(--text-0);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 6px;
    font-size: 15px;
  }
  .sm {
    font-size: 14px !important;
  }
  .toggle {
    display: flex;
    gap: 8px;
    align-items: center;
    margin: 8px 0;
    font-size: 14px;
  }
  .toggle input {
    width: 20px;
    height: 20px;
    accent-color: var(--accent);
  }
</style>
