<script lang="ts">
  import type { CalibrationReportData } from '../types';
  import LineChart from './LineChart.svelte';

  interface Props {
    calibration: CalibrationReportData;
  }

  let { calibration }: Props = $props();

  function corrColor(r: number): string {
    const c = Math.max(-1, Math.min(1, r));
    if (c >= 0) {
      const a = 0.12 + 0.72 * c;
      return `rgba(56, 189, 248, ${a.toFixed(2)})`;
    } else {
      const a = 0.12 + 0.72 * -c;
      return `rgba(251, 113, 133, ${a.toFixed(2)})`;
    }
  }

  function shiftPct(prior: number, post: number): number {
    return ((post - prior) / Math.max(1e-9, Math.abs(prior))) * 100;
  }
</script>

<div class="cal-wrap">
  <div class="cal-banner">
    <div>
      <div class="cal-badge">Forward-Mode Dual-AD · Levenberg-Marquardt Bayesian MAP</div>
      <div class="cal-summary">{calibration.summary}</div>
    </div>
    <div class="rms-pills">
      <div class="pill prior">
        <span>CAD Prior Error</span>
        <strong>{calibration.prior_rms_error_db.toFixed(2)} dB RMS</strong>
      </div>
      <div class="pill post">
        <span>Posterior Calibrated</span>
        <strong>{calibration.posterior_rms_error_db.toFixed(3)} dB RMS</strong>
      </div>
    </div>
  </div>

  {#if calibration.diagnostics.length > 0}
    <div class="diag-list">
      {#each calibration.diagnostics as d}
        <div class="diag-item">⚡ {d}</div>
      {/each}
    </div>
  {/if}

  <div class="cal-charts">
    <LineChart
      title="Electrical Impedance Fit |Z_e(f)| — Prior vs Measured (.zma) vs Posterior"
      subtitle="Twin vented impedance saddle reveals box tuning, port mass, and enclosure air leaks (Q_L)"
      freqsHz={calibration.freqs_hz}
      yLabel="Impedance (Ω)"
      height={215}
      series={[
        { label: 'CAD Design Prior', color: '#64748b', values: calibration.prior_z_mag_ohm, dashed: true },
        { label: 'Measured Prototype (.zma)', color: '#fbbf24', values: calibration.measured_z_mag_ohm, width: 2.6 },
        { label: 'Posterior MAP Model', color: '#38bdf8', values: calibration.posterior_z_mag_ohm, width: 1.9 },
      ]}
    />

    <LineChart
      title="2π Ground-Plane Acoustic Fit — Prior vs Measured (.frd) vs Posterior"
      subtitle="Simultaneous SPL sensitivity + low-end rolloff breaks Bl / M_ms / V_b collinearity"
      freqsHz={calibration.freqs_hz}
      yLabel="SPL @ 2m (dB)"
      height={215}
      series={[
        { label: 'CAD Design Prior', color: '#64748b', values: calibration.prior_spl_db, dashed: true },
        { label: 'Measured Prototype (.frd)', color: '#fbbf24', values: calibration.measured_spl_db, width: 2.6 },
        { label: 'Posterior MAP Model', color: '#34d399', values: calibration.posterior_spl_db, width: 1.9 },
      ]}
    />
  </div>

  <div class="cal-bottom">
    <div class="table-card">
      <div class="sec-title">Posterior Physical Parameters &amp; 95% Laplace Credible Intervals</div>
      <table class="param-table">
        <thead>
          <tr>
            <th>Parameter</th>
            <th>CAD Prior</th>
            <th>Posterior MAP</th>
            <th>95% CI</th>
            {#if calibration.parameters.some((p) => p.ground_truth !== null)}
              <th>True Bench</th>
            {/if}
            <th>Δ Shift</th>
          </tr>
        </thead>
        <tbody>
          {#each calibration.parameters as p}
            {@const pct = shiftPct(p.prior_value, p.posterior_value)}
            <tr>
              <td class="pname">{p.name} <span class="unit">({p.unit})</span></td>
              <td>{p.prior_value.toPrecision(4)}</td>
              <td class="post-val">{p.posterior_value.toPrecision(4)}</td>
              <td class="ci">[{p.ci95_low.toPrecision(4)}, {p.ci95_high.toPrecision(4)}]</td>
              {#if calibration.parameters.some((x) => x.ground_truth !== null)}
                <td class="gt">{p.ground_truth !== null ? p.ground_truth.toPrecision(4) : '—'}</td>
              {/if}
              <td class:warn={Math.abs(pct) > 15} class:ok={Math.abs(pct) <= 15}>
                {pct >= 0 ? '+' : ''}{pct.toFixed(1)}%
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <div class="corr-card">
      <div class="sec-title">SVD Fisher Posterior Correlation Matrix</div>
      <div
        class="corr-grid"
        style:grid-template-columns="auto repeat({calibration.parameter_names.length}, 1fr)"
      >
        <div></div>
        {#each calibration.parameter_names as nm}
          <div class="corr-hdr">{nm.split(' ')[0]}</div>
        {/each}
        {#each calibration.correlation_matrix as row, ri}
          <div class="corr-row-lbl">{calibration.parameter_names[ri]?.split(' ')[0]}</div>
          {#each row as val}
            <div class="corr-cell" style:background={corrColor(val)} title={val.toFixed(3)}>
              {val.toFixed(2)}
            </div>
          {/each}
        {/each}
      </div>
    </div>
  </div>
</div>

<style>
  .cal-wrap {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .cal-banner {
    background: linear-gradient(135deg, rgba(56, 189, 248, 0.1), rgba(167, 139, 250, 0.08));
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 14px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .cal-badge {
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--accent);
    font-weight: 700;
  }
  .cal-summary {
    font-size: 12px;
    color: var(--text-0);
    margin-top: 3px;
  }
  .rms-pills {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }
  .pill {
    padding: 6px 11px;
    border-radius: 6px;
    background: var(--bg-1);
    border: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    font-size: 10.5px;
    color: var(--text-2);
  }
  .pill strong {
    font-size: 13px;
    margin-top: 1px;
  }
  .pill.prior strong {
    color: var(--amber);
  }
  .pill.post strong {
    color: var(--emerald);
  }
  .diag-list {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .diag-item {
    background: rgba(251, 191, 36, 0.1);
    border: 1px solid rgba(251, 191, 36, 0.35);
    color: #fde68a;
    padding: 7px 11px;
    border-radius: 6px;
    font-size: 11.5px;
  }
  .cal-charts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr));
    gap: 10px;
  }
  .cal-bottom {
    display: grid;
    grid-template-columns: 1.45fr 1fr;
    gap: 10px;
  }
  @media (max-width: 1100px) {
    .cal-bottom {
      grid-template-columns: 1fr;
    }
  }
  .table-card,
  .corr-card {
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    min-width: 0;
  }
  .sec-title {
    font-size: 12px;
    font-weight: 600;
    margin-bottom: 8px;
    color: var(--text-0);
  }
  .param-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 11.5px;
  }
  .param-table th {
    text-align: left;
    color: var(--text-2);
    font-weight: 500;
    padding: 5px 6px;
    border-bottom: 1px solid var(--border);
  }
  .param-table td {
    padding: 5px 6px;
    border-bottom: 1px solid rgba(36, 51, 84, 0.5);
  }
  .pname {
    font-weight: 600;
    color: var(--text-0);
  }
  .unit {
    color: var(--text-2);
    font-weight: 400;
  }
  .post-val {
    color: var(--accent);
    font-weight: 600;
  }
  .ci {
    color: var(--text-2);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 10.5px;
  }
  .gt {
    color: var(--emerald);
  }
  .warn {
    color: var(--rose);
    font-weight: 600;
  }
  .ok {
    color: var(--emerald);
  }
  .corr-grid {
    display: grid;
    gap: 2px;
    font-size: 9.5px;
    align-items: center;
  }
  .corr-hdr {
    text-align: center;
    color: var(--text-2);
    font-weight: 600;
    padding-bottom: 3px;
  }
  .corr-row-lbl {
    color: var(--text-2);
    font-weight: 600;
    padding-right: 5px;
    text-align: right;
  }
  .corr-cell {
    text-align: center;
    padding: 4px 1px;
    border-radius: 3px;
    color: #f8fafc;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
</style>
