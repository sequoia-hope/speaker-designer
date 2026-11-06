<script lang="ts">
  export interface ChartSeries {
    label: string;
    color: string;
    values: number[];
    dashed?: boolean;
    width?: number;
    opacity?: number;
  }

  export interface HorizontalRefLine {
    value: number;
    label: string;
    color: string;
  }

  interface Props {
    title: string;
    subtitle?: string;
    freqsHz: number[];
    series: ChartSeries[];
    yLabel: string;
    yMin?: number;
    yMax?: number;
    refLines?: HorizontalRefLine[];
    height?: number;
  }

  let {
    title,
    subtitle = '',
    freqsHz,
    series,
    yLabel,
    yMin,
    yMax,
    refLines = [],
    height = 235,
  }: Props = $props();

  const W = 760;
  const PAD_L = 52;
  const PAD_R = 18;
  const PAD_T = 16;
  const PAD_B = 30;

  let hoverIdx = $state<number | null>(null);

  const plotW = $derived(W - PAD_L - PAD_R);
  const plotH = $derived(height - PAD_T - PAD_B);

  const fMin = $derived(freqsHz.length > 0 ? Math.max(10, freqsHz[0]) : 20);
  const fMax = $derived(freqsHz.length > 0 ? Math.max(fMin * 1.2, freqsHz[freqsHz.length - 1]) : 20000);
  const logMin = $derived(Math.log10(fMin));
  const logMax = $derived(Math.log10(fMax));

  const yBounds = $derived.by(() => {
    if (yMin !== undefined && yMax !== undefined) return [yMin, yMax] as const;
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of series) {
      for (const v of s.values) {
        if (Number.isFinite(v)) {
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
    }
    for (const r of refLines) {
      if (r.value < lo) lo = r.value;
      if (r.value > hi) hi = r.value;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 100] as const;
    const span = Math.max(4, hi - lo);
    const pad = span * 0.1;
    return [
      yMin !== undefined ? yMin : Math.floor((lo - pad) * 2) / 2,
      yMax !== undefined ? yMax : Math.ceil((hi + pad) * 2) / 2,
    ] as const;
  });

  function xOfFreq(f: number): number {
    const lf = Math.log10(Math.max(fMin, Math.min(fMax, f)));
    return PAD_L + ((lf - logMin) / Math.max(1e-9, logMax - logMin)) * plotW;
  }

  function yOfVal(v: number): number {
    const [lo, hi] = yBounds;
    const u = (v - lo) / Math.max(1e-9, hi - lo);
    const clamped = Math.max(-0.02, Math.min(1.02, u));
    return PAD_T + (1 - clamped) * plotH;
  }

  const xTicks = $derived.by(() => {
    const candidates = [20, 30, 50, 80, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
    return candidates.filter((f) => f >= fMin * 0.98 && f <= fMax * 1.02);
  });

  const yTicks = $derived.by(() => {
    const [lo, hi] = yBounds;
    const count = 5;
    const step = (hi - lo) / count;
    const out: number[] = [];
    for (let i = 0; i <= count; i++) {
      out.push(lo + i * step);
    }
    return out;
  });

  function buildPath(vals: number[]): string {
    const n = Math.min(freqsHz.length, vals.length);
    if (n === 0) return '';
    let d = '';
    for (let i = 0; i < n; i++) {
      const x = xOfFreq(freqsHz[i]).toFixed(1);
      const y = yOfVal(vals[i]).toFixed(1);
      d += i === 0 ? `M${x},${y}` : ` L${x},${y}`;
    }
    return d;
  }

  function formatTickFreq(f: number): string {
    return f >= 1000 ? `${f / 1000}k` : `${f}`;
  }

  function handlePointerMove(e: PointerEvent) {
    if (freqsHz.length === 0) return;
    const svg = e.currentTarget as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / Math.max(1, rect.width)) * W;
    const u = Math.max(0, Math.min(1, (relX - PAD_L) / plotW));
    const targetF = Math.pow(10, logMin + u * (logMax - logMin));
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < freqsHz.length; i++) {
      const d = Math.abs(Math.log(freqsHz[i] / targetF));
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    hoverIdx = best;
  }
</script>

<div class="chart-card">
  <div class="chart-head">
    <div>
      <div class="chart-title">{title}</div>
      {#if subtitle}
        <div class="chart-sub">{subtitle}</div>
      {/if}
    </div>
    <div class="legend">
      {#each series as s}
        <span class="legend-item">
          <span
            class="swatch"
            style:background={s.dashed ? 'transparent' : s.color}
            style:border-top={s.dashed ? `2px dashed ${s.color}` : 'none'}
          ></span>
          <span>{s.label}</span>
          {#if hoverIdx !== null && s.values[hoverIdx] !== undefined}
            <strong style:color={s.color}>{s.values[hoverIdx].toFixed(1)}</strong>
          {/if}
        </span>
      {/each}
    </div>
  </div>

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <svg
    viewBox="0 0 {W} {height}"
    class="chart-svg"
    onpointerdown={handlePointerMove}
    onpointermove={handlePointerMove}
    onpointerleave={(e) => {
      if (e.pointerType === 'mouse') hoverIdx = null;
    }}
  >
    <rect x={PAD_L} y={PAD_T} width={plotW} height={plotH} fill="#090e1a" rx="4" />

    {#each xTicks as ft}
      {@const x = xOfFreq(ft)}
      <line x1={x} y1={PAD_T} x2={x} y2={PAD_T + plotH} stroke="#18233d" stroke-width="1" />
      <text x={x} y={height - 9} fill="#7d90b8" font-size="10.5" text-anchor="middle">
        {formatTickFreq(ft)}
      </text>
    {/each}

    {#each yTicks as yt}
      {@const y = yOfVal(yt)}
      <line x1={PAD_L} y1={y} x2={PAD_L + plotW} y2={y} stroke="#18233d" stroke-width="1" />
      <text x={PAD_L - 7} y={y + 3.5} fill="#7d90b8" font-size="10.5" text-anchor="end">
        {Math.abs(yt) >= 100 ? yt.toFixed(0) : yt.toFixed(1)}
      </text>
    {/each}

    <text
      x={13}
      y={PAD_T + plotH / 2}
      fill="#8b9dc3"
      font-size="10"
      text-anchor="middle"
      transform="rotate(-90, 13, {PAD_T + plotH / 2})"
    >
      {yLabel}
    </text>

    {#each refLines as rl}
      {@const ry = yOfVal(rl.value)}
      {#if ry >= PAD_T && ry <= PAD_T + plotH}
        <line
          x1={PAD_L}
          y1={ry}
          x2={PAD_L + plotW}
          y2={ry}
          stroke={rl.color}
          stroke-width="1.3"
          stroke-dasharray="5 4"
        />
        <text x={PAD_L + plotW - 6} y={ry - 4} fill={rl.color} font-size="10" text-anchor="end">
          {rl.label}
        </text>
      {/if}
    {/each}

    {#each series as s}
      <path
        d={buildPath(s.values)}
        fill="none"
        stroke={s.color}
        stroke-width={s.width ?? 2.1}
        stroke-dasharray={s.dashed ? '6 4' : undefined}
        opacity={s.opacity ?? 1}
      />
    {/each}

    {#if hoverIdx !== null && freqsHz[hoverIdx] !== undefined}
      {@const hx = xOfFreq(freqsHz[hoverIdx])}
      <line
        x1={hx}
        y1={PAD_T}
        x2={hx}
        y2={PAD_T + plotH}
        stroke="#94a3b8"
        stroke-width="1"
        stroke-dasharray="3 3"
      />
      <rect x={Math.min(W - 88, Math.max(PAD_L, hx - 38))} y={PAD_T + 3} width="76" height="17" rx="4" fill="#1e293b" stroke="#38bdf8" stroke-width="0.8" />
      <text
        x={Math.min(W - 50, Math.max(PAD_L + 38, hx))}
        y={PAD_T + 14.5}
        fill="#f8fafc"
        font-size="10"
        font-weight="600"
        text-anchor="middle"
      >
        {freqsHz[hoverIdx] >= 1000
          ? `${(freqsHz[hoverIdx] / 1000).toFixed(2)} kHz`
          : `${freqsHz[hoverIdx].toFixed(1)} Hz`}
      </text>
      {#each series as s}
        {#if s.values[hoverIdx] !== undefined}
          <circle cx={hx} cy={yOfVal(s.values[hoverIdx])} r="3.4" fill={s.color} stroke="#090e1a" stroke-width="1.2" />
        {/if}
      {/each}
    {/if}
  </svg>
</div>

<style>
  .chart-card {
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .chart-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 10px;
    flex-wrap: wrap;
  }
  .chart-title {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-0);
  }
  .chart-sub {
    font-size: 11px;
    color: var(--text-2);
    margin-top: 1px;
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    font-size: 11px;
    color: var(--text-1);
  }
  .legend-item {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .swatch {
    width: 13px;
    height: 3px;
    border-radius: 2px;
    display: inline-block;
  }
  .chart-svg {
    width: 100%;
    height: auto;
    display: block;
    cursor: crosshair;
    touch-action: pan-y;
  }
  @media (max-width: 640px) {
    .chart-card {
      padding: 9px 10px 7px;
    }
    .chart-title {
      font-size: 12px;
      line-height: 1.3;
    }
    .legend {
      gap: 6px 10px;
      font-size: 10.5px;
    }
  }
</style>
