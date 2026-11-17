<script lang="ts">
  // A transmission line's cross-section along its length: drag the six points
  // (driver end → terminus) or pick a named shape. Shaded bands mark where each
  // leg of the folded line runs (its walls slope so the area follows the curve);
  // the green line is the area the simulation uses.
  import { TL_PROFILE_MAX, TL_PROFILE_MIN, TL_SHAPES } from './hybrid';

  let {
    profile = $bindable(),
    legs,
    path,
    folds,
  }: { profile: number[] | null | undefined; legs: number; path: { s: number[]; area: number[] }; folds?: number[] } = $props();

  const W = 320;
  const Hh = 150;
  const PAD = { l: 34, r: 10, t: 10, b: 24 };
  const iw = W - PAD.l - PAD.r;
  const ih = Hh - PAD.t - PAD.b;
  const X = (x: number) => PAD.l + x * iw;
  const Y = (v: number) => PAD.t + ih - ((v - 0) / TL_PROFILE_MAX) * ih;
  const pts = $derived(profile ?? [1, 1, 1, 1, 1, 1]);
  // where each leg runs along the line: between the folds (evenly, before there's a geometry)
  const legBands = $derived.by(() => {
    const L = path.s[path.s.length - 1] || 0;
    const cuts = folds && folds.length === legs - 1 && L > 0 ? [0, ...folds.map((f) => f / L), 1] : Array.from({ length: legs + 1 }, (_, i) => i / legs);
    return cuts.slice(0, -1).map((x0, i) => ({ x0, x1: cuts[i + 1] }));
  });
  // the simulated area along the path, relative to its start
  const simLine = $derived.by(() => {
    const L = path.s[path.s.length - 1] || 1;
    const a0 = path.area[0] || 1;
    return path.s.map((s, i) => `${i ? 'L' : 'M'}${X(s / L).toFixed(1)},${Y(Math.min(path.area[i] / a0, TL_PROFILE_MAX)).toFixed(1)}`).join(' ');
  });
  const shape = $derived(TL_SHAPES.find((sh) => sh.pts.every((v, i) => Math.abs(v - pts[i]) < 1e-6)));

  let drag = $state<number | null>(null);
  let svg: SVGSVGElement;
  function setFrom(e: PointerEvent) {
    if (drag === null) return;
    const r = svg.getBoundingClientRect();
    const y = ((e.clientY - r.top) / r.height) * Hh;
    const v = ((PAD.t + ih - y) / ih) * TL_PROFILE_MAX;
    const next = [...pts];
    next[drag] = Math.round(Math.min(TL_PROFILE_MAX, Math.max(TL_PROFILE_MIN, v)) * 100) / 100;
    profile = next;
  }
  function nudge(i: number, d: number) {
    const next = [...pts];
    next[i] = Math.round(Math.min(TL_PROFILE_MAX, Math.max(TL_PROFILE_MIN, next[i] + d)) * 100) / 100;
    profile = next;
  }
</script>

<div class="tlp" data-testid="tl-profile">
  <div class="chips">
    {#each TL_SHAPES as sh}
      <button class="chip" class:on={shape?.id === sh.id} title={sh.hint} onclick={() => (profile = [...sh.pts])}>{sh.name}</button>
    {/each}
  </div>
  <svg
    bind:this={svg}
    viewBox={`0 0 ${W} ${Hh}`}
    role="img"
    aria-label="Line cross-section along its length"
    onpointermove={setFrom}
    onpointerup={() => (drag = null)}
    onpointerleave={() => (drag = null)}
  >
    {#each [0.5, 1, 1.5, 2, 2.5, 3] as g}
      <line x1={PAD.l} x2={W - PAD.r} y1={Y(g)} y2={Y(g)} class="grid" />
      <text x={PAD.l - 4} y={Y(g) + 3} text-anchor="end" class="ax">{g}×</text>
    {/each}
    {#each legBands as b, i}
      <rect x={X(b.x0) + 0.5} width={Math.max(0, X(b.x1) - X(b.x0) - 1)} y={PAD.t} height={ih} class="bar" class:alt={i % 2 === 1} />
      <text x={(X(b.x0) + X(b.x1)) / 2} y={Hh - 10} text-anchor="middle" class="ax">leg {i + 1}</text>
    {/each}
    <path d={simLine} class="sim" />
    <polyline points={pts.map((v, i) => `${X(i / (pts.length - 1))},${Y(v)}`).join(' ')} class="ctl" />
    {#each pts as v, i}
      <circle
        cx={X(i / (pts.length - 1))}
        cy={Y(v)}
        r="6"
        class="pt"
        role="slider"
        tabindex="0"
        aria-label={`Area at ${Math.round((i / (pts.length - 1)) * 100)} % along the line`}
        aria-valuemin={TL_PROFILE_MIN}
        aria-valuemax={TL_PROFILE_MAX}
        aria-valuenow={v}
        onpointerdown={(e) => {
          drag = i;
          (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
        }}
        onkeydown={(e) => {
          if (e.key === 'ArrowUp') nudge(i, 0.05);
          if (e.key === 'ArrowDown') nudge(i, -0.05);
        }}
      />
    {/each}
    <text x={PAD.l} y={Hh - 1} class="ax">driver end</text>
    <text x={W - PAD.r} y={Hh - 1} text-anchor="end" class="ax">terminus</text>
  </svg>
  <p class="small muted">
    {shape ? shape.hint : 'Your own shape.'} Drag the points (or focus one and use ↑/↓). Bands: where each of the {legs} legs runs — the walls between legs slope, so the area follows your curve smoothly along every leg and round every fold; green line: the area the simulation follows (relative to the line's start), bends included. The start is still sized to the woofer — the shape scales from there.
  </p>
</div>

<style>
  .tlp svg {
    width: 100%;
    max-width: 480px;
    touch-action: none;
    display: block;
  }
  .grid {
    stroke: var(--border);
    stroke-width: 0.5;
  }
  .ax {
    font-size: 8px;
    fill: var(--text-2, #8a94a8);
  }
  .bar {
    fill: rgba(148, 163, 184, 0.1);
  }
  .bar.alt {
    fill: rgba(148, 163, 184, 0.2);
  }
  .sim {
    fill: none;
    stroke: #4ade80;
    stroke-width: 1.4;
  }
  .ctl {
    fill: none;
    stroke: #60a5fa;
    stroke-width: 1.5;
    stroke-dasharray: 3 2;
  }
  .pt {
    fill: #60a5fa;
    stroke: #0b1220;
    stroke-width: 1.5;
    cursor: ns-resize;
  }
  .pt:focus {
    outline: none;
    stroke: #fff;
  }
</style>
