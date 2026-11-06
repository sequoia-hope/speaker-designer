<script lang="ts">
  import type { BuildPlan, Panel } from './speakerBuild';
  import { fmtInFrac } from './roomAcoustics';

  let { panel, plan }: { panel: Panel; plan: BuildPlan } = $props();

  const t = $derived(plan.material.thicknessMm);
  const innerD = $derived(plan.box.externalMm.d - plan.box.baffleMm - t);
  // drawing axes per part (x across, y down), with the FRONT edge noted
  const geom = $derived.by(() => {
    switch (panel.id) {
      case 'side':
        return { w: panel.widthMm, h: panel.lengthMm, front: 'left' as const };
      case 'topbottom':
        return { w: panel.lengthMm, h: panel.widthMm, front: 'bottom' as const };
      default:
        return { w: panel.widthMm, h: panel.lengthMm, front: null };
    }
  });
  const M = 46;
  const inch = (mm: number) => fmtInFrac(mm, 16);
  const hasBrace = $derived(plan.panels.some((p) => p.id === 'brace'));
</script>

<svg viewBox={`${-M} ${-M * 0.8} ${geom.w + M * 1.6} ${geom.h + M * 1.7}`} class="pd" role="img" aria-label={`${panel.name} drawing`}>
  <rect x="0" y="0" width={geom.w} height={geom.h} class="wood" />
  {#if panel.id === 'brace'}
    <rect x="38" y="38" width={geom.w - 76} height={geom.h - 76} class="cut" />
    <text x={geom.w / 2} y={geom.h / 2} text-anchor="middle" class="note">cut out</text>
    <line x1="0" y1={geom.h / 2 + 30} x2="38" y2={geom.h / 2 + 30} class="dim" />
    <text x="40" y={geom.h / 2 + 46} class="note">38 mm (1½″)</text>
  {:else if panel.id === 'back'}
    <rect x={geom.w / 2 - 37.5} y={(geom.h * 2) / 3 - 37.5} width="75" height="75" class="cut" rx="4" />
    <text x={geom.w / 2} y={(geom.h * 2) / 3 + 58} text-anchor="middle" class="note">terminal cup (use its template)</text>
    {#if plan.box.port && home_port_rear(plan)}
      <circle cx={geom.w / 2} cy={geom.h * 0.22} r={(plan.box.port.diameterMm + 4) / 2} class="cut" />
    {/if}
  {:else if panel.id === 'stand-top'}
    <circle cx={geom.w / 2} cy={geom.h / 2} r="12.7" class="cut" />
    <text x={geom.w / 2} y={geom.h / 2 + 34} text-anchor="middle" class="note">1″ fill hole</text>
  {:else if (panel.id === 'baffle' || panel.id === 'baffle2')}
    {#each plan.holes as h}
      {#if panel.id === 'baffle' && h.rebateDiaMm}<circle cx={h.xMm} cy={h.yMm} r={h.rebateDiaMm / 2} class="reb" />{/if}
      <circle cx={h.xMm} cy={h.yMm} r={h.throughDiaMm / 2} class="cut" />
    {/each}
  {/if}
  {#if hasBrace && panel.id === 'side'}
    <line x1={innerD / 2} y1="0" x2={innerD / 2} y2={geom.h} class="mark" />
    <text x={innerD / 2 + 4} y="16" class="note">brace face</text>
  {/if}
  {#if hasBrace && panel.id === 'topbottom'}
    <line x1="0" y1={geom.h - innerD / 2} x2={geom.w} y2={geom.h - innerD / 2} class="mark" />
    <text x="4" y={geom.h - innerD / 2 - 5} class="note">brace face</text>
  {/if}
  {#if geom.front === 'left'}
    <text x={-8} y={geom.h / 2} text-anchor="middle" class="front" transform={`rotate(-90 -8 ${geom.h / 2})`}>FRONT EDGE</text>
  {:else if geom.front === 'bottom'}
    <text x={geom.w / 2} y={geom.h + 14} text-anchor="middle" class="front">FRONT EDGE</text>
  {/if}
  <!-- overall dims -->
  <line x1="0" y1={-16} x2={geom.w} y2={-16} class="dim" />
  <text x={geom.w / 2} y={-22} text-anchor="middle" class="dt">{inch(geom.w)} · {Math.round(geom.w)}</text>
  <line x1={geom.w + 16} y1="0" x2={geom.w + 16} y2={geom.h} class="dim" />
  <text x={geom.w + 22} y={geom.h / 2} class="dt" transform={`rotate(90 ${geom.w + 22} ${geom.h / 2})`} text-anchor="middle">{inch(geom.h)} · {Math.round(geom.h)}</text>
</svg>

<script lang="ts" module>
  import type { BuildPlan as BP } from './speakerBuild';
  // the back has a port hole only for a rear-ported vented box
  export function home_port_rear(plan: BP) {
    return !plan.holes.some((h) => h.kind === 'port');
  }
</script>

<style>
  .pd {
    width: 100%;
    max-width: 340px;
    height: auto;
    display: block;
  }
  .wood {
    fill: #b99066;
    stroke: #fde68a;
    stroke-width: 2;
  }
  .cut {
    fill: #0a1020;
    stroke: #f8fafc;
    stroke-width: 1.5;
  }
  .reb {
    fill: #8a6a48;
    stroke: #f8fafc;
    stroke-width: 1;
    stroke-dasharray: 5 3;
  }
  .mark {
    stroke: #38bdf8;
    stroke-width: 2;
    stroke-dasharray: 8 5;
  }
  .dim {
    stroke: #fbbf24;
    stroke-width: 1.5;
  }
  .dt {
    fill: #fbbf24;
    font-size: 14px;
    font-weight: 600;
  }
  .note {
    fill: #1c1408;
    font-size: 12px;
    font-weight: 600;
  }
  .cut + .note {
    fill: #cbd5e1;
  }
  .front {
    fill: #38bdf8;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.05em;
  }
</style>
