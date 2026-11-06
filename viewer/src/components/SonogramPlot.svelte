<script lang="ts">
  import { splNormalizedToRgb, formatFreq } from '../colormaps';

  interface Props {
    title: string;
    subtitle?: string;
    freqsHz: number[];
    anglesDeg: number[];
    splMatrix: number[][];
    normalizeToOnAxis?: boolean;
  }

  let {
    title,
    subtitle = '',
    freqsHz,
    anglesDeg,
    splMatrix,
    normalizeToOnAxis = true,
  }: Props = $props();

  let canvasEl = $state<HTMLCanvasElement | null>(null);
  let hoverInfo = $state<string>('');

  const CW = 620;
  const CH = 220;
  const PAD_L = 46;
  const PAD_R = 16;
  const PAD_T = 10;
  const PAD_B = 26;

  const onAxisIdx = $derived.by(() => {
    let best = Math.floor(anglesDeg.length / 2);
    let minAbs = Infinity;
    for (let i = 0; i < anglesDeg.length; i++) {
      if (Math.abs(anglesDeg[i]) < minAbs) {
        minAbs = Math.abs(anglesDeg[i]);
        best = i;
      }
    }
    return best;
  });

  function getNormalizedValue(fi: number, ai: number): number {
    const row = splMatrix[fi];
    if (!row) return -24;
    const raw = row[ai] ?? -120;
    if (normalizeToOnAxis) {
      const ref = row[onAxisIdx] ?? raw;
      return raw - ref; // 0 dB .. -24 dB
    }
    return raw;
  }

  $effect(() => {
    if (!canvasEl || freqsHz.length < 2 || anglesDeg.length < 2 || splMatrix.length < 2) return;
    const ctx = canvasEl.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = '#090e1a';
    ctx.fillRect(0, 0, CW, CH);

    const pw = CW - PAD_L - PAD_R;
    const ph = CH - PAD_T - PAD_B;
    const img = ctx.createImageData(pw, ph);

    const logMin = Math.log10(Math.max(10, freqsHz[0]));
    const logMax = Math.log10(Math.max(20, freqsHz[freqsHz.length - 1]));

    let globalMax = -Infinity;
    if (!normalizeToOnAxis) {
      for (const row of splMatrix) {
        for (const v of row) if (v > globalMax) globalMax = v;
      }
    }
    const maxVal = normalizeToOnAxis ? 0 : globalMax;
    const minVal = maxVal - 24;

    for (let py = 0; py < ph; py++) {
      // top = +180 deg, bottom = -180 deg
      const vFrac = 1 - py / Math.max(1, ph - 1);
      const aFloat = vFrac * (anglesDeg.length - 1);
      const a0 = Math.floor(aFloat);
      const a1 = Math.min(anglesDeg.length - 1, a0 + 1);
      const wa = aFloat - a0;

      for (let px = 0; px < pw; px++) {
        const uFrac = px / Math.max(1, pw - 1);
        const fTarget = Math.pow(10, logMin + uFrac * (logMax - logMin));
        // Binary/linear search in freqsHz
        let f0 = 0;
        while (f0 + 1 < freqsHz.length - 1 && freqsHz[f0 + 1] < fTarget) f0++;
        const f1 = Math.min(freqsHz.length - 1, f0 + 1);
        const wf =
          freqsHz[f1] > freqsHz[f0]
            ? Math.log(fTarget / freqsHz[f0]) / Math.log(freqsHz[f1] / freqsHz[f0])
            : 0;

        const v00 = getNormalizedValue(f0, a0);
        const v01 = getNormalizedValue(f0, a1);
        const v10 = getNormalizedValue(f1, a0);
        const v11 = getNormalizedValue(f1, a1);
        const val = (1 - wf) * ((1 - wa) * v00 + wa * v01) + wf * ((1 - wa) * v10 + wa * v11);

        const norm = (val - minVal) / (maxVal - minVal);
        const [r, g, b] = splNormalizedToRgb(norm);
        const idx = (py * pw + px) * 4;
        img.data[idx] = Math.round(r * 255);
        img.data[idx + 1] = Math.round(g * 255);
        img.data[idx + 2] = Math.round(b * 255);
        img.data[idx + 3] = 255;
      }
    }

    ctx.putImageData(img, PAD_L, PAD_T);

    // Angle grid lines (-180, -90, -45, 0, +45, +90, +180)
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.fillStyle = '#8b9dc3';
    ctx.font = '10px Inter, sans-serif';
    ctx.textAlign = 'right';
    for (const ang of [-180, -90, -45, 0, 45, 90, 180]) {
      const u = (ang - anglesDeg[0]) / Math.max(1e-6, anglesDeg[anglesDeg.length - 1] - anglesDeg[0]);
      const y = PAD_T + (1 - u) * ph;
      ctx.beginPath();
      ctx.setLineDash(ang === 0 ? [] : [3, 3]);
      ctx.moveTo(PAD_L, y);
      ctx.lineTo(PAD_L + pw, y);
      ctx.stroke();
      ctx.fillText(`${ang > 0 ? '+' : ''}${ang}°`, PAD_L - 5, y + 3);
    }

    // Frequency ticks
    ctx.textAlign = 'center';
    ctx.setLineDash([3, 3]);
    for (const ft of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
      if (ft < freqsHz[0] * 0.98 || ft > freqsHz[freqsHz.length - 1] * 1.02) continue;
      const x = PAD_L + ((Math.log10(ft) - logMin) / Math.max(1e-6, logMax - logMin)) * pw;
      ctx.beginPath();
      ctx.moveTo(x, PAD_T);
      ctx.lineTo(x, PAD_T + ph);
      ctx.stroke();
      ctx.fillText(ft >= 1000 ? `${ft / 1000}k` : `${ft}`, x, CH - 8);
    }
    ctx.setLineDash([]);
  });

  function handleMove(e: PointerEvent) {
    if (!canvasEl || freqsHz.length < 2) return;
    const rect = canvasEl.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / Math.max(1, rect.width)) * CW;
    const y = ((e.clientY - rect.top) / Math.max(1, rect.height)) * CH;
    const pw = CW - PAD_L - PAD_R;
    const ph = CH - PAD_T - PAD_B;
    if (x < PAD_L || x > PAD_L + pw || y < PAD_T || y > PAD_T + ph) {
      if (e.pointerType === 'mouse') hoverInfo = '';
      return;
    }
    const u = (x - PAD_L) / pw;
    const v = 1 - (y - PAD_T) / ph;
    const logMin = Math.log10(Math.max(10, freqsHz[0]));
    const logMax = Math.log10(Math.max(20, freqsHz[freqsHz.length - 1]));
    const f = Math.pow(10, logMin + u * (logMax - logMin));
    const ang = anglesDeg[0] + v * (anglesDeg[anglesDeg.length - 1] - anglesDeg[0]);

    let fi = 0;
    for (let i = 1; i < freqsHz.length; i++) {
      if (Math.abs(freqsHz[i] - f) < Math.abs(freqsHz[fi] - f)) fi = i;
    }
    let ai = 0;
    for (let i = 1; i < anglesDeg.length; i++) {
      if (Math.abs(anglesDeg[i] - ang) < Math.abs(anglesDeg[ai] - ang)) ai = i;
    }
    const db = getNormalizedValue(fi, ai);
    hoverInfo = `${formatFreq(freqsHz[fi])} @ ${anglesDeg[ai] >= 0 ? '+' : ''}${anglesDeg[ai].toFixed(0)}° → ${db >= 0 && normalizeToOnAxis ? '+' : ''}${db.toFixed(1)} dB`;
  }
</script>

<div class="sono-card">
  <div class="sono-head">
    <div>
      <div class="sono-title">{title}</div>
      {#if subtitle}
        <div class="sono-sub">{subtitle}</div>
      {/if}
    </div>
    <div class="sono-meta">
      {#if hoverInfo}
        <span class="readout">{hoverInfo}</span>
      {:else}
        <span class="scale-bar">
          <span>-24 dB</span>
          <span class="grad"></span>
          <span>0 dB</span>
        </span>
      {/if}
    </div>
  </div>
  <canvas
    bind:this={canvasEl}
    width={CW}
    height={CH}
    class="sono-canvas"
    onpointerdown={handleMove}
    onpointermove={handleMove}
    onpointerleave={(e) => {
      if (e.pointerType === 'mouse') hoverInfo = '';
    }}
  ></canvas>
</div>

<style>
  .sono-card {
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .sono-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .sono-title {
    font-size: 12.5px;
    font-weight: 600;
  }
  .sono-sub {
    font-size: 11px;
    color: var(--text-2);
  }
  .sono-meta {
    font-size: 11px;
    color: var(--text-1);
  }
  .readout {
    color: var(--accent);
    font-weight: 600;
  }
  .scale-bar {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--text-2);
  }
  .grad {
    width: 78px;
    height: 7px;
    border-radius: 4px;
    background: linear-gradient(90deg, #0d1538, #129eb2, #44ce72, #f2c636, #ef5334, #fff0f5);
  }
  .sono-canvas {
    width: 100%;
    height: auto;
    border-radius: 4px;
    cursor: crosshair;
    touch-action: pan-y;
  }
</style>
