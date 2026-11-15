<script lang="ts">
  import { untrack } from 'svelte';
  import MiniChart from './MiniChart.svelte';
  import Speaker3D from './Speaker3D.svelte';
  import BoxModeler from './BoxModeler.svelte';
  import { boxSpecOf, driverGuidance, runModel } from './boxModel';
  import CrossoverCard from './CrossoverCard.svelte';
  import { baffleStepShelf } from './diffraction';
  import CustomDriverForm from './CustomDriverForm.svelte';
  import SavedDesigns from './SavedDesigns.svelte';
  import HybridTab from './HybridTab.svelte';
  import { PRINTED_DESIGNS } from './hybrid';
  import { home, saveHome } from './homeState.svelte';
  import { allDrivers, type DriverInfo } from './drivers';
  import { DESIGNS, designById, type Role } from './designs';
  import { MATERIALS, type BuildPlan } from './speakerBuild';
  import { SPEED_OF_SOUND, fmtInFrac } from './roomAcoustics';

  let { plan, woofer, tweeter, onGoBuild, onOpenPrint }: {
    plan: BuildPlan;
    woofer: DriverInfo;
    tweeter: DriverInfo | null;
    onGoBuild: () => void;
    onOpenPrint: (w: 'sub' | 'living') => void;
  } = $props();

  $effect(() => {
    JSON.stringify(home.designs);
    saveHome();
  });

  const cur = $derived(home.designs[home.activeDesign]);
  const preset = $derived(designById(home.activeDesign));
  const box = $derived(plan.box);
  let onStand = $state(false);
  const isSub = $derived(cur.arrangement === 'sub');
  const woofers = $derived(allDrivers().filter((d) => (isSub ? d.role === 'sub' || (!!d.custom && d.role === 'pa') : d.role === 'woofer')));
  const tweeters = $derived(allDrivers().filter((d) => d.role === 'tweeter'));
  // your own drivers: add / edit / delete
  let driverForm = $state<'closed' | 'new' | 'edit'>('closed');
  const curWoofer = $derived(woofers.find((d) => d.id === cur.wooferId));
  function saveDriver(d: DriverInfo) {
    const i = home.customDrivers.findIndex((x) => x.id === d.id);
    if (i >= 0) home.customDrivers[i] = d;
    else home.customDrivers.push(d);
    // a sub driver can only be picked in a sub design (and vice versa)
    if ((d.role === 'woofer') === !isSub) cur.wooferId = d.id;
    driverForm = 'closed';
    saveHome();
  }
  function deleteDriver(d: DriverInfo) {
    if (!confirm(`Delete your driver "${d.brand} ${d.model}"?`)) return;
    home.customDrivers = home.customDrivers.filter((x) => x.id !== d.id);
    for (const s of Object.values(home.designs)) if (s.wooferId === d.id) s.wooferId = woofers.find((x) => !x.custom)?.id ?? s.wooferId;
    driverForm = 'closed';
    saveHome();
  }
  const ROLE_LABEL: Record<Role, string> = {
    mains: 'Left/right mains',
    center: 'Centre',
    surround: 'Surrounds',
    height: 'Ceiling (height)',
    fill: 'Party fills',
    sub: 'Subwoofer',
  };
  const usedFor = (id: string) =>
    (Object.entries(home.system.roles) as [Role, string][]).filter(([, d]) => d === id).map(([r]) => r);
  function assign(role: Role) {
    home.system.roles[role] = home.activeDesign;
    if (role === 'mains') home.hybrid.useLiving = false;
    autoNote = null;
  }
  function resetDesign() {
    const p = designById(home.activeDesign);
    if (p) {
      skipAuto = true;
      home.designs[home.activeDesign] = { ...p.settings };
    }
  }

  // Customising a design that isn't in the sound system yet puts it in, so the
  // Room tab (system planner) simulates what you're actually designing.
  let autoNote = $state<string | null>(null);
  let skipAuto = false;
  let seen = { id: '', sig: '' };
  $effect(() => {
    const id = home.activeDesign;
    const sig = JSON.stringify(home.designs[id]);
    untrack(() => {
      const edited = seen.id === id && seen.sig !== sig && !skipAuto;
      seen = { id, sig };
      skipAuto = false;
      const p = designById(id);
      if (!edited || !p || usedFor(id).length) return;
      const role = p.roles[0];
      const was = designById(home.system.roles[role])?.name ?? 'nothing';
      home.system.roles[role] = id;
      if (role === 'mains') home.hybrid.useLiving = false;
      autoNote = `Now used as your ${ROLE_LABEL[role].toLowerCase()} in the Room tab (was ${was}).`;
    });
  });
  const roomMains = $derived(home.hybrid.useLiving ? 'the printed hybrid speaker' : (designById(home.system.roles.mains)?.name ?? '—'));

  const L = (l: number) => `${l.toFixed(1)} L (${(l / 28.317).toFixed(2)} ft³)`;
  const dims = (d: { w: number; h: number; d: number }) =>
    `${fmtInFrac(d.w, 8)} W × ${fmtInFrac(d.h, 8)} H × ${fmtInFrac(d.d, 8)} D`;

  const r100 = (x: number) => Math.round(x / 100) * 100;
  // crossover helper: the woofer's on-stand response (its box + this baffle's step), normalised
  const xo = $derived.by(() => {
    if (!tweeter) return null;
    const wy = plan.holes.find((h) => h.kind === 'woofer')?.yMm ?? box.externalMm.h / 2;
    const baffle = { widthMm: box.externalMm.w, heightMm: box.externalMm.h, driverYmm: wy };
    const m = runModel({ driver: woofer, count: box.wooferCount, box: boxSpecOf(box), powerW: 1, placement: 'free', baffle, f0: 200, f1: 20000, n: 160 });
    // normalise to its level on a big baffle (the datasheet condition), so above the baffle
    // step it sits at 0 dB and the step shows as the −6 dB it really is
    const half = runModel({ driver: woofer, count: box.wooferCount, box: boxSpecOf(box), powerW: 1, f0: 100, f1: 2000, n: 40 });
    const k = 2.83 / (20e-6 * Math.pow(10, half.sensitivity283 / 20));
    const shelf = baffleStepShelf({ ...baffle, driverXmm: baffle.widthMm / 2, edgeRadiusMm: 12 });
    const dEff = 2 * Math.sqrt(woofer.sdCm2 / 1e4 / Math.PI);
    const beam = SPEED_OF_SOUND / (Math.PI * dEff);
    return {
      freqs: m.freqs,
      wooferH: m.H.map((h) => ({ re: h.re * k, im: h.im * k })),
      // woofer's acoustic centre ≈ its voice coil, ~60 % of the mounting depth behind the baffle;
      // a flush dome's is at its flange — so the tweeter is ahead (negative offset)
      offset: -0.6 * (woofer.mountDepthMm ?? 75),
      fc: Math.max(beam * 1.2, tweeter.fsHz * 2.5),
      shelf,
    };
  });
  // pairing advice
  const pairing = $derived.by(() => {
    const out: { cls: string; html: string }[] = [];
    const dEff = 2 * Math.sqrt(woofer.sdCm2 / 1e4 / Math.PI);
    const beamHz = SPEED_OF_SOUND / (Math.PI * dEff); // ka = 1
    out.push({
      cls: '',
      html: `Woofer starts to beam (ka = 1) around <b>${beamHz.toFixed(0)} Hz</b>. Crossing to the tweeter somewhere near ${r100(beamHz * 1.1)}–${r100(beamHz * 1.6)} Hz keeps the off-axis sound — and so the room's reflected sound — smooth.`,
    });
    if (tweeter) {
      const minXo = tweeter.fsHz * 2.5;
      out.push({
        cls: minXo > beamHz * 1.8 ? 'warn' : 'good',
        html: `Tweeter Fs ${tweeter.fsHz} Hz → cross it no lower than ~<b>${r100(minXo)} Hz</b> (≈2.5 × Fs).${minXo > beamHz * 1.8 ? ' That is high for this woofer: expect a dip in off-axis response. A lower-Fs tweeter would pair better.' : ''}`,
      });
      const pad = tweeter.sensDb - (woofer.sensDb - 3);
      out.push({
        cls: pad < 0 ? 'bad' : '',
        html:
          pad >= 0
            ? `Tweeter is ${tweeter.sensDb} dB vs woofer ${woofer.sensDb} dB. After baffle-step compensation the woofer effectively loses ~3–6 dB, so the tweeter needs about <b>${pad.toFixed(0)}–${(pad + 3).toFixed(0)} dB of padding</b> (an L-pad in a passive crossover, or simply a gain setting in DSP).`
            : `Tweeter is less sensitive than the (baffle-step-compensated) woofer — the system will be tweeter-limited.`,
      });
      if (tweeter.nominalOhm !== woofer.nominalOhm)
        out.push({
          cls: '',
          html: `Mixed impedances (${woofer.nominalOhm} Ω woofer, ${tweeter.nominalOhm} Ω tweeter) are normal; the crossover handles it.`,
        });
    }
    return out;
  });
</script>
{#snippet designsCard()}
<section class="card">
  <h2>Designs</h2>
  <p class="sub">Tap a design to see it in 3D. Plywood boxes and 🧩 3D-printed cabinets; each is a starting point — change drivers or shape below and the drawings follow.</p>
  <div class="gallery">
    {#each DESIGNS as d}
      <button class="gcard" class:on={!home.activePrint && home.activeDesign === d.id} onclick={() => { home.activeDesign = d.id; home.activePrint = null; }}>
        <div class="gname">{d.name}</div>
        <div class="gshort">{d.short}</div>
        <div class="gtags">
          {#each usedFor(d.id) as r}<span class="tag use">{ROLE_LABEL[r]}</span>{/each}
          <span class="tag">{'●'.repeat(d.difficulty)}{'○'.repeat(3 - d.difficulty)} skill</span>
        </div>
      </button>
    {/each}
    {#each PRINTED_DESIGNS as pd}
      <button class="gcard print" class:on={home.activePrint === pd.id} onclick={() => (home.activePrint = pd.id)}>
        <div class="gname">🧩 {pd.name}</div>
        <div class="gshort">{pd.short}</div>
        <div class="gtags">
          {#if home.hybrid.useLiving && home.hybrid.livingId === pd.id}<span class="tag use">Left/right mains</span>{/if}
          <span class="tag">3D-printed</span>
          <span class="tag">{'●'.repeat(pd.difficulty)}{'○'.repeat(3 - pd.difficulty)} skill</span>
        </div>
      </button>
    {/each}
    <button class="gcard print" class:on={home.activePrint === 'sub'} onclick={() => (home.activePrint = 'sub')}>
      <div class="gname">🧩 Printed horn sub</div>
      <div class="gshort">3D-printed folded horn + plywood sides</div>
      <div class="gtags">{#if home.hybrid.useOutdoor}<span class="tag use">Outdoor subs</span>{/if}<span class="tag">3D-printed</span></div>
    </button>
  </div>
  {#if preset && !home.activePrint}
    <p class="small" style="margin-top:10px">{preset.blurb}</p>
    <p class="small muted"><b>Learn:</b> {preset.learn}</p>
    <div class="chips">
      <span class="small muted" style="align-self:center">Use this design for:</span>
      {#each preset.roles as r}
        <button class="chip" class:on={home.system.roles[r] === home.activeDesign} onclick={() => assign(r)}>{ROLE_LABEL[r]}</button>
      {/each}
      <button class="chip" onclick={resetDesign}>↺ Reset design</button>
    </div>
    {#if autoNote}
      <p class="small sys-note" data-testid="design-auto-assigned">✓ {autoNote}</p>
    {:else if usedFor(home.activeDesign).length === 0}
      <p class="small sys-note warn" data-testid="design-not-in-system">Not in your sound system yet — the Room tab uses {roomMains} for the mains. Pick a role above, or change a setting and it's added automatically.</p>
    {:else if home.hybrid.useLiving && usedFor(home.activeDesign).includes('mains')}
      <p class="small sys-note warn">The Room tab is using the printed hybrid speaker as mains instead. <button class="linklike" onclick={() => (home.hybrid.useLiving = false)}>Use this design</button></p>
    {/if}
  {/if}
  <SavedDesigns />
</section>
{/snippet}

{#if home.activePrint}
  {#key home.activePrint}
    <HybridTab id={home.activePrint} mode="design" top={designsCard} />
  {/key}
{:else}
<div class="split">
<div class="vis">
  <section class="card vis-card">
    <div class="vis-hd">
      <h2>{preset?.name ?? 'Speaker'}</h2>
{#if plan.stand}
      <div class="seg">
        <button class:on={!onStand} onclick={() => (onStand = false)}>Speaker</button>
        <button class:on={onStand} onclick={() => (onStand = true)}>On its stand</button>
      </div>
{/if}
    </div>
    <div class="dimline">
      {fmtInFrac(plan.box.externalMm.w, 8)} W × {fmtInFrac(plan.box.externalMm.h, 8)} H × {fmtInFrac(plan.box.externalMm.d, 8)} D
      · {plan.box.netVolumeL.toFixed(1)} L · −3 dB at {plan.box.f3Hz.toFixed(0)} Hz · {plan.massKgPerBox.toFixed(1)} kg
    </div>
    <div class="s3d-wrap">
      <Speaker3D {plan} {woofer} {tweeter} problems={plan.box.fitIssues} showStand={onStand && !!plan.stand} />
    </div>
  </section>
</div>
<div class="side">
{@render designsCard()}
<section class="card">
  <h2>{isSub ? 'Subwoofer driver' : box.wooferCount > 1 ? `Woofers (×${box.wooferCount})` : 'Woofer'}</h2>
  <p class="sub">Real drivers with datasheet numbers. Tap to choose; the box and cut list follow.</p>
  <div class="drv-list">
    {#each woofers as d}
      <button class="drv" class:on={cur.wooferId === d.id} onclick={() => (cur.wooferId = d.id)}>
        <div class="drv-hd">
          <b>{d.brand} {d.model}</b><span class="tag">{d.sizeLabel}</span>{#if d.custom}<span class="tag mine">yours</span>{/if}
          {#if d.priceUsd}<span class="tag">${d.priceUsd.toFixed(0)}</span>{/if}
        </div>
        <div class="drv-specs">
          Fs {d.fsHz} Hz · Qts {d.qts} · Vas {d.vasL} L · Xmax {d.xmaxMm} mm · {d.sensDb} dB
        </div>
        {#if cur.wooferId === d.id}
          <div class="drv-blurb">{d.blurb}{#if d.url} <a href={d.url} target="_blank" rel="noopener">Datasheet ↗</a>{/if}</div>
        {/if}
      </button>
    {/each}
  </div>
  {#if curWoofer}
    {@const gd = driverGuidance(curWoofer)}
    <div class="guide" data-testid="driver-guidance">
      <div class="guide-hd"><b>Which box suits the {curWoofer.model}?</b> <span class="tag verdict">{gd.verdict === 'either' ? 'sealed or ported' : gd.verdict}</span></div>
      <ul>{#each gd.reasons as r}<li>{r}</li>{/each}</ul>
      <div class="small muted">EBP {gd.ebp.toFixed(0)} · BL {gd.blTm.toFixed(1)} T·m · Mms {gd.mmsG.toFixed(1)} g · Cms {gd.cmsMmPerN.toFixed(2)} mm/N · Rms {gd.rmsKgS.toFixed(2)} kg/s (derived from the datasheet's Fs, Qes, Qms, Vas, Sd, Re)</div>
      {#if gd.dataIssues.length}<ul class="small muted">{#each gd.dataIssues as r}<li>{r}</li>{/each}</ul>{/if}
    </div>
  {/if}
  {#if driverForm === 'closed'}
    <div class="chips" style="margin-top:8px">
      <button class="chip" onclick={() => (driverForm = 'new')}>＋ Add your own driver</button>
      {#if curWoofer?.custom}
        <button class="chip" onclick={() => (driverForm = 'edit')}>✎ Edit {curWoofer.model}</button>
        <button class="chip" onclick={() => deleteDriver(curWoofer)}>🗑 Delete</button>
      {/if}
    </div>
  {:else}
    {#key driverForm + (curWoofer?.id ?? '')}
      <CustomDriverForm
        initial={driverForm === 'edit' ? curWoofer : null}
        defaultRole={isSub ? 'sub' : 'woofer'}
        onSave={saveDriver}
        onCancel={() => (driverForm = 'closed')}
      />
    {/key}
  {/if}
</section>

{#if !isSub}
<section class="card">
  <h2>Tweeter</h2>
  <div class="drv-list">
    {#each tweeters as d}
      <button class="drv" class:on={cur.tweeterId === d.id} onclick={() => (cur.tweeterId = d.id)}>
        <div class="drv-hd">
          <b>{d.brand} {d.model}</b>
          {#if d.priceUsd}<span class="tag">${d.priceUsd.toFixed(0)}</span>{/if}
        </div>
        <div class="drv-specs">Fs {d.fsHz} Hz · {d.sensDb} dB · {d.nominalOhm} Ω · faceplate {d.frameDiaMm} mm</div>
        {#if cur.tweeterId === d.id}
          <div class="drv-blurb">{d.blurb}{#if d.url} <a href={d.url} target="_blank" rel="noopener">Datasheet ↗</a>{/if}</div>
        {/if}
      </button>
    {/each}
  </div>
  <ul class="callouts">
    {#each pairing as n}<li class={n.cls}>{@html n.html}</li>{/each}
  </ul>
</section>
{/if}

<section class="card">
  <h2>Box</h2>
  <div class="chips">
    <button class="chip" class:on={cur.boxType === 'sealed'} onclick={() => (cur.boxType = 'sealed')}>Sealed</button>
    <button class="chip" class:on={cur.boxType === 'vented'} onclick={() => (cur.boxType = 'vented')}>Vented (ported)</button>
  </div>
  <p class="small muted">
    {#if cur.boxType === 'sealed'}
      Sealed: smaller, simpler (no port to get wrong), tight bass that rolls off gently. Pairs naturally with a
      subwoofer and is forgiving of placement near walls. <b>Recommended for a first build.</b>
    {:else}
      Vented: a tuned port adds roughly half an octave of deeper bass from the same woofer, at the cost of a bigger box,
      a port to tune, and steeper roll-off. Good if you will not add a sub. Front ports tolerate wall placement better
      than rear ports.
    {/if}
  </p>
  {#if cur.boxType === 'sealed'}
    <div class="chips">
      <span class="small muted" style="align-self:center">Stuffing:</span>
      {#each [[0, 'None'], [0.5, 'Light'], [1, 'Full']] as [v, lbl]}
        <button class="chip" class:on={(cur.sealedFill ?? 0) === v} onclick={() => (cur.sealedFill = v as number)}>{lbl}</button>
      {/each}
    </div>
    <p class="small muted" style="margin:2px 0 6px">Polyester fill makes the air behave as if the box were up to ~15 % bigger (so the box shrinks for the same Qtc) and soaks up internal reflections.</p>
    <div class="field">
      <label for="qtc">Target Qtc (box "tightness")</label>
      <span class="val">{cur.targetQtc.toFixed(2)}</span>
      <span class="hint">0.5 = very tight, needs EQ · 0.71 = flattest (Butterworth) · 0.9+ = warm/boomy</span>
      <input id="qtc" type="range" min="0.5" max="1.0" step="0.01" bind:value={cur.targetQtc} />
    </div>
  {:else}
    <div class="chips">
      <span class="small muted" style="align-self:center">Alignment:</span>
      {#each [['compact', 'Compact (QB3)'], ['flat', 'Flattest (SBB4)'], ['deep', 'Deepest (+1 dB bump)']] as [k, lbl]}
        <button class="chip" class:on={(cur.ventAlignment ?? 'compact') === k} onclick={() => (cur.ventAlignment = k as typeof cur.ventAlignment)}>{lbl}</button>
      {/each}
    </div>
    <div class="chips">
      <span class="small muted" style="align-self:center">Port ends:</span>
      {#each [['one-flanged', 'Plain tube'], ['flanged', 'Flanged both ends'], ['flared', 'Flared (printed / routed)']] as [k, lbl]}
        <button class="chip" class:on={(cur.portEnds ?? 'one-flanged') === k} onclick={() => (cur.portEnds = k as typeof cur.portEnds)}>{lbl}</button>
      {/each}
    </div>
    <div class="field">
      <label for="vol">Box volume vs. the chosen alignment</label>
      <span class="val">{(cur.volumeScale * 100).toFixed(0)} %</span>
      <input id="vol" type="range" min="0.6" max="1.4" step="0.05" bind:value={cur.volumeScale} />
    </div>
    <div class="field">
      <label for="tune">Port tuning vs. textbook</label>
      <span class="val">{(cur.tuningScale * 100).toFixed(0)} %</span>
      <span class="hint">Lower = deeper but softer bass and longer port.</span>
      <input id="tune" type="range" min="0.75" max="1.25" step="0.05" bind:value={cur.tuningScale} />
    </div>
    <div class="chips">
      <button class="chip" class:on={cur.portSide === 'front'} onclick={() => (cur.portSide = 'front')}>Front port</button>
      <button class="chip" class:on={cur.portSide === 'rear'} onclick={() => (cur.portSide = 'rear')}>Rear port</button>
    </div>
  {/if}
  <h3>Shape</h3>
  <div class="chips">
    {#each [['bookshelf', 'Stand-mount'], ['tall', 'Tall & narrow'], ['cube', 'Compact / deep']] as [id, lbl]}
      <button class="chip" class:on={cur.aspect === id} onclick={() => (cur.aspect = id as typeof cur.aspect)}>{lbl}</button>
    {/each}
  </div>
  <h3>Material</h3>
  <div class="chips">
    {#each MATERIALS as m}
      <button class="chip" class:on={cur.materialId === m.id} onclick={() => (cur.materialId = m.id)}>{m.name}</button>
    {/each}
  </div>
  <p class="small muted">{plan.material.notes}</p>
  <label class="toggle">
    <input type="checkbox" bind:checked={cur.doubleBaffle} />
    Double-thickness front baffle <span class="muted small">(stiffer, deeper driver rebates; +1 sheet layer)</span>
  </label>
</section>

<section class="card">
  <h2>Result</h2>
  <div class="stats">
    <div class="stat"><div class="k">Outside size</div><div class="v small-v">{dims(box.externalMm)}</div><div class="s">{box.externalMm.w} × {box.externalMm.h} × {box.externalMm.d} mm</div></div>
    <div class="stat"><div class="k">Air volume (net)</div><div class="v">{L(box.netVolumeL)}</div><div class="s">gross inside {box.grossInternalL.toFixed(1)} L</div></div>
    <div class="stat"><div class="k">Bass −3 dB</div><div class="v">{box.f3Hz.toFixed(0)} Hz</div><div class="s">in free space; the room adds more</div></div>
    {#if box.alignment.kind === 'sealed'}
      <div class="stat"><div class="k">Qtc / fc</div><div class="v">{box.alignment.qtc.toFixed(2)} / {box.alignment.fcHz.toFixed(0)} Hz</div></div>
    {:else if box.alignment.kind === 'vented' && box.port}
      <div class="stat"><div class="k">Port</div><div class="v">{box.port.count}× Ø{box.port.diameterMm} mm</div><div class="s">{box.port.lengthMm.toFixed(0)} mm long · tuned {box.port.fbHz.toFixed(0)} Hz · {box.port.peakVelocityMs.toFixed(0)} m/s peak</div></div>
    {/if}
    <div class="stat"><div class="k">Weight (each)</div><div class="v">{plan.massKgPerBox.toFixed(1)} kg</div><div class="s">{(plan.massKgPerBox * 2.205).toFixed(0)} lb</div></div>
  </div>
  <MiniChart
    series={[{ label: 'Bass response (no room)', color: '#38bdf8', points: box.responseDb.map((p) => ({ x: p.f, y: p.db })) }]}
    xMin={15}
    xMax={400}
    yMin={-24}
    yMax={6}
    yStep={6}
    xTicks={[20, 30, 50, 100, 200, 400]}
    markers={[{ x: box.f3Hz, label: '−3 dB' }, { x: box.baffleStepHz, label: 'baffle step', color: '#a78bfa' }]}
  />
  {#if box.warnings.length}
    <ul class="callouts">{#each box.warnings as w}<li class="warn">{w}</li>{/each}</ul>
  {/if}
  <ul class="callouts">{#each box.notes as n}<li>{n}</li>{/each}</ul>
  <button class="btn" style="margin-top:12px; width:100%" onclick={onGoBuild}>See the woodworking plan →</button>
</section>

<BoxModeler {box} {woofer} wooferYmm={plan.holes.find((h) => h.kind === 'woofer')?.yMm ?? box.externalMm.h / 2} />
{#if xo && tweeter}
  <CrossoverCard {woofer} {tweeter} freqs={xo.freqs} wooferH={xo.wooferH} tweeterOffsetMm={xo.offset} suggestedFc={xo.fc} baffleStep={xo.shelf} />
{/if}
</div>
</div>

{/if}

<style>
  .sys-note {
    margin: 8px 0 0;
    padding: 6px 9px;
    border-radius: 6px;
    background: rgba(52, 211, 153, 0.1);
    color: #6ee7b7;
  }
  .sys-note.warn {
    background: rgba(251, 191, 36, 0.1);
    color: #fcd34d;
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
  .gallery {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 6px;
  }
  .gcard {
    text-align: left;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: 11px;
    padding: 9px 10px;
    color: var(--text-1);
    cursor: pointer;
    font: inherit;
  }
  .gcard.print {
    border-style: dashed;
  }
  .gcard.on {
    border-color: var(--accent);
    background: rgba(56, 189, 248, 0.09);
  }
  .gname {
    font-weight: 700;
    color: var(--text-0);
    font-size: 14px;
  }
  .gshort {
    font-size: 12px;
    color: var(--text-2);
  }
  .gtags {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
    margin-top: 5px;
  }
  .guide {
    margin-top: 8px;
    padding: 9px 11px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg-2);
    font-size: 13px;
  }
  .guide ul {
    margin: 4px 0;
    padding-left: 18px;
  }
  .tag.verdict {
    background: rgba(56, 189, 248, 0.16);
    color: var(--accent);
  }
  .tag.mine {
    background: rgba(251, 191, 36, 0.16);
    color: var(--amber);
  }
  .tag.use {
    background: rgba(52, 211, 153, 0.18);
    color: var(--emerald);
  }
  .dimline {
    font-size: 13px;
    color: var(--amber);
  }
  .s3d-wrap {
    height: 58vh;
    min-height: 340px;
  }
  .drv-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .drv {
    text-align: left;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: 11px;
    padding: 10px 12px;
    color: var(--text-1);
    cursor: pointer;
    font: inherit;
  }
  .drv.on {
    border-color: var(--accent);
    background: rgba(56, 189, 248, 0.08);
  }
  .drv-hd {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
  }
  .drv-hd b {
    color: var(--text-0);
    font-size: 14px;
  }
  .tag {
    font-size: 11px;
    background: var(--bg-3);
    border-radius: 6px;
    padding: 1px 6px;
    color: var(--text-1);
  }
  .drv-specs {
    font-size: 12px;
    color: var(--text-2);
    margin-top: 3px;
  }
  .drv-blurb {
    font-size: 13px;
    margin-top: 6px;
    color: var(--text-1);
  }
  .small-v {
    font-size: 14px !important;
  }
  .toggle {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-top: 10px;
    font-size: 14px;
  }
  .toggle input {
    width: 20px;
    height: 20px;
    accent-color: var(--accent);
  }
</style>
