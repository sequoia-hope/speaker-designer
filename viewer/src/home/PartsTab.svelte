<script lang="ts">
  import { home, saveHome } from './homeState.svelte';
  import { LAYOUTS, layoutSpeakers } from './system';
  import { systemBom, kitPath, type BomLine } from './bom';
  import { PRICES_AS_OF, PARTS } from './catalog';
  import { fmtInFrac } from './roomAcoustics';
  import Speaker3D from './Speaker3D.svelte';

  let { onOpenDesign }: { onOpenDesign: (id: string) => void } = $props();

  let path = $state<'diy' | 'kit'>('diy');
  let route = $state<'passive' | 'active'>('active');
  let preview = $state<string | null>(null);

  const layout = $derived(LAYOUTS.find((l) => l.id === home.system.layout) ?? LAYOUTS[0]);
  const speakers = $derived(layoutSpeakers(home.system.layout, home.room, home.placement, home.sub));
  const bom = $derived(
    systemBom(home.system.layout, speakers, home.system.roles, home.designs, Math.round(home.placement.earHeightM * 1000), route)
  );
  const surround = $derived(['lcr', '5.1', '5.1.2', '7.1'].includes(home.system.layout));
  const groups = $derived([...new Set(bom.lines.map((l) => l.group))]);
  const kits = $derived(kitPath(home.system.layout, speakers));
  const subUse = $derived(bom.uses.find((u) => u.roles.includes('sub')));
  const kitTotal = $derived(
    kits.reduce((a, k) => a + k.kit.usd * k.qty, 0) +
      (subUse ? subUse.units * ((subUse.planned.woofer.priceUsd ?? 0) + PARTS.plateAmp.usd) : 0) +
      PARTS.umm6.usd
  );
  const money = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  const lineTotal = (l: BomLine) => (l.unit !== undefined ? money(l.unit * l.qty) : '—');
  const previewUse = $derived(bom.uses.find((u) => u.designId === preview) ?? null);
  $effect(() => {
    void home.system;
    saveHome();
  });
</script>

<div class="split">
  <div class="vis">
    <section class="card vis-card">
      <div class="vis-hd">
        <h2>{previewUse ? previewUse.name : 'Your system'}</h2>
        {#if previewUse}<button class="btn ghost" onclick={() => (preview = null)}>✕</button>{/if}
      </div>
      {#if previewUse}
        <p class="small muted" style="margin:0">{previewUse.units} × for {previewUse.roles.join(' & ')}. Tap parts for sizes.</p>
        <div class="s3d-wrap">
          <Speaker3D plan={previewUse.planned.plan} woofer={previewUse.planned.woofer} tweeter={previewUse.planned.tweeter} />
        </div>
        <button class="btn" onclick={() => onOpenDesign(previewUse.designId)}>Open its woodworking plan →</button>
      {:else}
        <p class="small muted" style="margin:0">{layout.channels} · {layout.name}. Tap a speaker below to see it in 3D.</p>
        <div class="uses">
          {#each bom.uses as u}
            <button class="use" onclick={() => (preview = u.designId)}>
              <span class="n">{u.units}×</span>
              <span><b>{u.name}</b><small>{u.roles.join(', ')} · {fmtInFrac(u.planned.plan.box.externalMm.w, 4)} × {fmtInFrac(u.planned.plan.box.externalMm.h, 4)} × {fmtInFrac(u.planned.plan.box.externalMm.d, 4)}</small></span>
            </button>
          {/each}
        </div>
        <h3 style="margin-top:14px">Plywood for everything</h3>
        {#each bom.sheets as m}
          {#each m.layouts as s, si}
            <div class="cap">{m.materialName} — sheet {si + 1}/{m.layouts.length} · {(s.usedFraction * 100).toFixed(0)} % used</div>
            <div class="svg-wrap">
              <svg viewBox={`-10 -10 ${s.sheetMm[0] + 20} ${s.sheetMm[1] + 20}`} role="img" aria-label="Sheet layout">
                <rect x="0" y="0" width={s.sheetMm[0]} height={s.sheetMm[1]} class="sheet" />
                {#each s.parts as p}
                  <rect x={p.x} y={p.y} width={p.w} height={p.h} class="part" />
                  {#if p.w > 140 && p.h > 60}<text x={p.x + p.w / 2} y={p.y + p.h / 2 + 10} text-anchor="middle" class="ptxt sm">{p.label}</text>{/if}
                {/each}
              </svg>
            </div>
          {/each}
        {/each}
      {/if}
    </section>
  </div>
  <div class="side">
    <section class="card">
      <h2>Bill of materials</h2>
      <p class="sub">
        For the <b>{layout.channels} {layout.name}</b> layout from the Room tab. Prices are Parts Express (or Madisound, where
        Parts Express doesn't stock a driver) as of {PRICES_AS_OF} — check before ordering.
      </p>
      <div class="seg">
        <button class:on={path === 'diy'} onclick={() => (path = 'diy')}>Build your own</button>
        <button class:on={path === 'kit'} onclick={() => (path = 'kit')}>Kit path (Parts Express)</button>
      </div>
    </section>

    {#if path === 'diy'}
      {#if !surround}
        <section class="card">
          <h2>Crossover route</h2>
          <div class="seg">
            <button class:on={route === 'active'} onclick={() => (route = 'active')}>Active (DSP)</button>
            <button class:on={route === 'passive'} onclick={() => (route = 'passive')}>Passive</button>
          </div>
        </section>
      {/if}
      <section class="card">
        <p class="small">{bom.electronicsNote}</p>
        {#each groups as g}
          <h3>{g}</h3>
          <table class="tbl">
            <tbody>
              {#each bom.lines.filter((l) => l.group === g) as l}
                <tr>
                  <td>
                    {#if l.url}<a href={l.url} target="_blank" rel="noopener">{l.item}</a>{:else}<b>{l.item}</b>{/if}
                    <span class="mm">{l.vendor}{l.part ? ` #${l.part}` : ''}{l.note ? ` · ${l.note}` : ''}</span>
                  </td>
                  <td class="num">{l.qty}×</td>
                  <td class="num">{l.unit !== undefined ? money(l.unit) : '—'}</td>
                  <td class="num"><b>{lineTotal(l)}</b></td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/each}
        <div class="total">
          <span>Total (priced lines)</span><b>{money(bom.total)}</b>
        </div>
        <p class="small muted">{bom.unpriced} line{bom.unpriced === 1 ? '' : 's'} without a price (receiver, crossovers, treatment materials). Tools not included.</p>
      </section>
      <section class="card">
        <h2>Designs in this system</h2>
        {#each bom.uses as u}
          <div class="urow">
            <div><b>{u.units}× {u.name}</b><span class="mm">for {u.roles.join(', ')} · {u.planned.woofer.model}{u.planned.tweeter ? ` + ${u.planned.tweeter.model}` : ''}</span></div>
            <button class="btn ghost" onclick={() => (preview = u.designId)}>3D</button>
            <button class="btn ghost" onclick={() => onOpenDesign(u.designId)}>Build</button>
          </div>
        {/each}
        <p class="small muted">Change which design plays each role in the Speakers tab.</p>
      </section>
    {:else}
      <section class="card">
        <h2>Kit path</h2>
        <p class="sub">
          Parts Express kits come with drivers and a crossover someone has already designed and measured, plus knock-down
          cabinets you glue up and finish. You still learn the woodworking (assembly, flush-trimming, veneer or paint) without
          the riskiest part: crossover design. The subwoofer is still a scratch build from this app.
        </p>
        <table class="tbl">
          <tbody>
            {#each kits as k}
              <tr>
                <td>
                  <span class="mm">{k.role}</span>
                  <a href={k.kit.url} target="_blank" rel="noopener">{k.kit.name}</a>
                  <span class="mm">#{k.kit.part} · {k.kit.drivers}</span>
                  <span class="mm">{k.kit.includes}</span>
                  <span class="mm">{k.kit.notes}</span>
                </td>
                <td class="num">{k.qty}×</td>
                <td class="num"><b>{money(k.kit.usd * k.qty)}</b></td>
              </tr>
            {/each}
            {#if subUse}
              <tr>
                <td><span class="mm">Subwoofer (scratch build)</span><b>{subUse.name}</b><span class="mm">{subUse.planned.woofer.brand} {subUse.planned.woofer.model} + {PARTS.plateAmp.item}; plywood extra</span></td>
                <td class="num">{subUse.units}×</td>
                <td class="num"><b>{money(subUse.units * ((subUse.planned.woofer.priceUsd ?? 0) + PARTS.plateAmp.usd))}</b></td>
              </tr>
            {/if}
            <tr>
              <td><a href={PARTS.umm6.url} target="_blank" rel="noopener">{PARTS.umm6.item}</a><span class="mm">#{PARTS.umm6.part}</span></td>
              <td class="num">1×</td>
              <td class="num"><b>{money(PARTS.umm6.usd)}</b></td>
            </tr>
          </tbody>
        </table>
        <div class="total"><span>Kit path total</span><b>{money(kitTotal)}</b></div>
        <p class="small muted">
          Plus an amplifier or AV receiver. Kit prices are per pair except the C-Note centre (single). The C-Note MT and
          Centre are voice-matched to each other, which matters for surround.
        </p>
      </section>
    {/if}
  </div>
</div>

<style>
  .s3d-wrap {
    height: 54vh;
    min-height: 320px;
  }
  .uses {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .use {
    display: flex;
    gap: 10px;
    align-items: center;
    text-align: left;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 9px 11px;
    color: var(--text-1);
    font: inherit;
    cursor: pointer;
  }
  .use .n {
    font-size: 20px;
    font-weight: 800;
    color: var(--accent);
    min-width: 34px;
  }
  .use b {
    display: block;
    color: var(--text-0);
  }
  .use small {
    color: var(--text-2);
  }
  .cap {
    font-size: 12px;
    color: var(--text-2);
    margin-top: 8px;
  }
  .num {
    text-align: right;
    white-space: nowrap;
  }
  .total {
    display: flex;
    justify-content: space-between;
    border-top: 2px solid var(--border);
    margin-top: 10px;
    padding-top: 8px;
    font-size: 16px;
  }
  .total b {
    color: var(--emerald);
    font-size: 20px;
  }
  .urow {
    display: flex;
    gap: 6px;
    align-items: center;
    padding: 6px 0;
    border-bottom: 1px solid #1a2541;
  }
  .urow > div {
    flex: 1;
  }
  .urow .btn {
    padding: 6px 10px;
    font-size: 13px;
  }
  :global(.ptxt.sm) {
    font-size: 30px;
  }
</style>
