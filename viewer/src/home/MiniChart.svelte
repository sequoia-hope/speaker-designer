<script lang="ts">
  export interface MiniSeries {
    label: string;
    color: string;
    points: { x: number; y: number }[];
    dashed?: boolean;
    width?: number;
  }
  export interface MiniMarker {
    x: number;
    label: string;
    color?: string;
  }

  let {
    series,
    xMin,
    xMax,
    yMin,
    yMax,
    logX = true,
    xTicks = [20, 50, 100, 200, 500, 1000],
    yStep = 5,
    yLabel = 'dB',
    markers = [],
    height = 200,
    band = null,
    shadeFrom = null,
  }: {
    series: MiniSeries[];
    xMin: number;
    xMax: number;
    yMin: number;
    yMax: number;
    logX?: boolean;
    xTicks?: number[];
    yStep?: number;
    yLabel?: string;
    markers?: MiniMarker[];
    height?: number;
    band?: { y0: number; y1: number; color: string } | null;
    shadeFrom?: { x: number; label: string } | null;
  } = $props();

  const W = 360;
  const padL = 30;
  const padR = 8;
  const padT = 8;
  const padB = 20;

  const sx = (x: number) =>
    padL +
    ((logX ? Math.log(x / xMin) / Math.log(xMax / xMin) : (x - xMin) / (xMax - xMin)) *
      (W - padL - padR));
  const sy = (y: number) =>
    padT + (1 - (Math.min(Math.max(y, yMin), yMax) - yMin) / (yMax - yMin)) * (height - padT - padB);

  function path(pts: { x: number; y: number }[]) {
    let d = '';
    for (const p of pts) {
      if (p.x < xMin || p.x > xMax || !Number.isFinite(p.y)) continue;
      d += (d ? 'L' : 'M') + sx(p.x).toFixed(1) + ',' + sy(p.y).toFixed(1);
    }
    return d;
  }
  const yTicks = $derived.by(() => {
    const out: number[] = [];
    for (let y = Math.ceil(yMin / yStep) * yStep; y <= yMax; y += yStep) out.push(y);
    return out;
  });
  const fmtX = (x: number) => (x >= 1000 ? `${x / 1000}k` : `${x}`);
</script>

<svg viewBox={`0 0 ${W} ${height}`} class="mini-chart" role="img" aria-label="chart">
  {#if band}
    <rect
      x={padL}
      y={sy(band.y1)}
      width={W - padL - padR}
      height={Math.max(0, sy(band.y0) - sy(band.y1))}
      fill={band.color}
    />
  {/if}
  {#if shadeFrom && shadeFrom.x < xMax}
    <rect x={sx(Math.max(shadeFrom.x, xMin))} y={padT} width={W - padR - sx(Math.max(shadeFrom.x, xMin))} height={height - padT - padB} fill="#64748b" opacity="0.16" />
    <text x={W - padR - 3} y={height - padB - 5} text-anchor="end" class="tick">{shadeFrom.label}</text>
  {/if}
  {#each yTicks as y}
    <line x1={padL} x2={W - padR} y1={sy(y)} y2={sy(y)} class="grid" class:zero={y === 0} />
    <text x={padL - 4} y={sy(y) + 3} class="tick" text-anchor="end">{y}</text>
  {/each}
  {#each xTicks.filter((x) => x >= xMin && x <= xMax) as x}
    <line x1={sx(x)} x2={sx(x)} y1={padT} y2={height - padB} class="grid" />
    <text x={sx(x)} y={height - 6} class="tick" text-anchor="middle">{fmtX(x)}</text>
  {/each}
  <text x={4} y={padT + 6} class="tick unit">{yLabel}</text>
  <text x={padL - 4} y={height - 6} class="tick unit" text-anchor="end">Hz</text>
  {#each markers.filter((m) => m.x >= xMin && m.x <= xMax).sort((a, b) => a.x - b.x) as m, mi}
    <line
      x1={sx(m.x)}
      x2={sx(m.x)}
      y1={padT}
      y2={height - padB}
      stroke={m.color ?? '#fbbf24'}
      stroke-dasharray="3 3"
      stroke-width="1"
    />
    <text
      x={sx(m.x) > W * 0.75 ? sx(m.x) - 3 : sx(m.x) + 3}
      text-anchor={sx(m.x) > W * 0.75 ? 'end' : 'start'}
      y={padT + 9 + (mi % 3) * 11}
      class="mk" fill={m.color ?? '#fbbf24'}>{m.label}</text>
  {/each}
  {#each series as s}
    <path
      d={path(s.points)}
      fill="none"
      stroke={s.color}
      stroke-width={s.width ?? 2}
      stroke-dasharray={s.dashed ? '5 4' : undefined}
      stroke-linejoin="round"
    />
  {/each}
</svg>
{#if series.length > 1}
  <div class="legend">
    {#each series as s}
      <span><i style:background={s.color} class:dashed={s.dashed}></i>{s.label}</span>
    {/each}
  </div>
{/if}

<style>
  .mini-chart {
    width: 100%;
    height: auto;
    display: block;
  }
  .grid {
    stroke: #243354;
    stroke-width: 0.6;
  }
  .grid.zero {
    stroke: #475d8a;
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
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    font-size: 12px;
    color: var(--text-1);
    margin-top: 4px;
  }
  .legend i {
    display: inline-block;
    width: 14px;
    height: 3px;
    border-radius: 2px;
    margin-right: 5px;
    vertical-align: middle;
  }
  .legend i.dashed {
    background-image: linear-gradient(90deg, transparent 50%, #0d1322 50%) !important;
    background-size: 6px 3px;
  }
</style>
