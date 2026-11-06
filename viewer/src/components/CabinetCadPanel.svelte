<script lang="ts">
  import type { CrossSectionBlueprint2D, VisualCabinetModel } from '../types';
  import LineChart, { type ChartSeries } from './LineChart.svelte';

  interface Props {
    cabinets: VisualCabinetModel[];
    selectedCabIdx?: number;
    onSelectCab?: (idx: number) => void;
  }

  let { cabinets, selectedCabIdx = 0, onSelectCab }: Props = $props();

  let blueprintMode = $state<'dual' | 'side_yz' | 'plan_xy' | 'front_xz'>('dual');
  let hoveredPartId = $state<string>('');
  let hoveredPolyLabel = $state<string>('');

  const activeCab = $derived(cabinets[selectedCabIdx] ?? cabinets[0]);
  const compareCab = $derived(
    cabinets.length > 1 ? cabinets[selectedCabIdx === 0 ? 1 : 0] : null
  );

  const inspectedSubmesh = $derived(
    hoveredPartId && activeCab
      ? (activeCab.submeshes.find((s) => s.part_id === hoveredPartId) ?? null)
      : null
  );

  const visibleBlueprints = $derived.by((): CrossSectionBlueprint2D[] => {
    if (!activeCab) return [];
    if (blueprintMode === 'dual') {
      return activeCab.sections_2d.filter(
        (s) => s.view_id === 'side_yz' || s.view_id === 'front_xz'
      );
    }
    const found = activeCab.sections_2d.find((s) => s.view_id === blueprintMode);
    return found ? [found] : activeCab.sections_2d.slice(0, 1);
  });

  const colorationSeries = $derived.by((): ChartSeries[] => {
    if (!activeCab || !activeCab.structural?.modal_freqs_hz?.length) return [];
    const st = activeCab.structural;
    const out: ChartSeries[] = [
      {
        label: `${activeCab.title.split(' ')[0]} Braced (${st.wall_thickness_mm.toFixed(0)} mm, f₁₁=${st.braced_f11_hz.toFixed(0)} Hz)`,
        color: '#34d399',
        values: st.braced_coloration_db,
        width: 2.4,
      },
      {
        label: `Unbraced Reference Baseline (f₁₁=${st.unbraced_f11_hz.toFixed(0)} Hz)`,
        color: '#94a3b8',
        values: st.unbraced_coloration_db,
        dashed: true,
        width: 1.6,
      },
    ];
    if (compareCab && compareCab.structural?.braced_coloration_db?.length === st.modal_freqs_hz.length) {
      out.push({
        label: `Compare: ${compareCab.title.split(' ')[0]} (${compareCab.structural.wall_thickness_mm.toFixed(0)} mm, f₁₁=${compareCab.structural.braced_f11_hz.toFixed(0)} Hz)`,
        color: '#fb7185',
        values: compareCab.structural.braced_coloration_db,
        width: 2.0,
      });
    }
    return out;
  });

  function polyPointsAttr(pts: [number, number][]): string {
    // Flip V -> -V so +Z / +Y points UP in SVG screen coordinates!
    return pts.map(([u, v]) => `${u.toFixed(1)},${(-v).toFixed(1)}`).join(' ');
  }

  function viewBoxFor(bp: CrossSectionBlueprint2D): string {
    const [u0, u1, v0, v1] = bp.bounds_mm;
    const spanU = Math.max(100, u1 - u0);
    const spanV = Math.max(100, v1 - v0);
    const padL = Math.max(76, spanU * 0.22);
    const padR = Math.max(52, spanU * 0.15);
    const padT = Math.max(52, spanV * 0.15);
    const padB = Math.max(66, spanV * 0.17);
    const xMin = u0 - padL;
    const yMin = -v1 - padT;
    const width = spanU + padL + padR;
    const height = spanV + padT + padB;
    return `${xMin.toFixed(1)} ${yMin.toFixed(1)} ${width.toFixed(1)} ${height.toFixed(1)}`;
  }

  function strokeWidthFor(bp: CrossSectionBlueprint2D): number {
    const [u0, u1, v0, v1] = bp.bounds_mm;
    return Math.max(1.1, Math.max(u1 - u0, v1 - v0) * 0.0024);
  }

  function fontSizeFor(bp: CrossSectionBlueprint2D): number {
    const [u0, u1, v0, v1] = bp.bounds_mm;
    return Math.max(11, Math.max(u1 - u0, v1 - v0) * 0.025);
  }

  function fillUrlFor(kind: string, colorHex: string, isDashed: boolean): string {
    if (isDashed || kind === 'outline') return 'none';
    if (kind === 'birch') return 'url(#hatch-birch)';
    if (kind === 'mdf' || kind === 'hdf') return 'url(#hatch-mdf)';
    if (kind === 'aluminum') return 'url(#hatch-alu)';
    if (kind === 'damping') return 'url(#hatch-damping)';
    if (kind === 'magnet' || kind === 'steel') return 'url(#hatch-steel)';
    return colorHex;
  }

  function layerBadgeColor(layer: string): string {
    switch (layer) {
      case 'outer_shell':
        return '#d4a36a';
      case 'front_baffle':
        return '#38bdf8';
      case 'internal_horn':
        return '#fbbf24';
      case 'bracing':
        return '#a78bfa';
      case 'port_waveguide':
        return '#34d399';
      case 'damping':
        return '#fb7185';
      case 'driver_motor':
      case 'driver_cone':
        return '#cbd5e1';
      default:
        return '#94a3b8';
    }
  }
</script>

{#if activeCab}
  {@const st = activeCab.structural}
  <div class="cad-panel">
    <!-- TOP CABINET SELECTOR & MATERIAL THICKNESS SCORECARD -->
    <div class="cad-header-card">
      <div class="cab-top-row">
        <div>
          <div class="eyebrow">SOLID FINITE-THICKNESS CAD · STRUCTURAL MECHANICS · BOM CUTLIST</div>
          <h3>{activeCab.title}</h3>
          <p class="cab-sub">{activeCab.subtitle}</p>
        </div>

        {#if cabinets.length > 1}
          <div class="cab-tabs">
            {#each cabinets as cm, idx}
              <button
                class:active={selectedCabIdx === idx}
                onclick={() => onSelectCab?.(idx)}
              >
                {cm.title.split('(')[0].trim()}
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <div class="metrics-strip">
        <div class="m-chip">
          <span>Outer Shell Wall</span>
          <strong>{st.wall_thickness_mm.toFixed(1)} mm</strong>
          <small>{st.enclosure_material_name}</small>
        </div>
        <div class="m-chip">
          <span>Front Baffle + Rebate</span>
          <strong>{st.baffle_thickness_mm.toFixed(1)} mm</strong>
          <small>{st.rebate_depth_mm.toFixed(1)} mm CNC flush rebate · {st.baffle_material_name}</small>
        </div>
        <div class="m-chip">
          <span>Partitions &amp; Bracing</span>
          <strong>{st.partition_thickness_mm.toFixed(1)} / {st.brace_thickness_mm.toFixed(1)} mm</strong>
          <small>{st.brace_count} internal braces · {st.joinery_label}</small>
        </div>
        <div class="m-chip">
          <span>Flexural Rigidity D</span>
          <strong>{st.flexural_rigidity_nm.toFixed(0)} N·m</strong>
          <small>E = {st.youngs_modulus_gpa.toFixed(1)} GPa · ρ = {st.density_kg_m3.toFixed(0)} kg/m³ · η = {st.loss_factor_eta.toFixed(3)}</small>
        </div>
        <div class="m-chip">
          <span>Dry Mass Breakdown</span>
          <strong>{st.total_mass_kg.toFixed(1)} kg ({(st.total_mass_kg * 2.20462).toFixed(1)} lb)</strong>
          <small>Panels {st.woodwork_mass_kg.toFixed(1)} kg + Drivers {st.drivers_mass_kg.toFixed(1)} kg</small>
        </div>
        <div class="m-chip">
          <span>Acoustic Volume Budget</span>
          <strong>{st.net_internal_air_volume_l.toFixed(1)} L net</strong>
          <small>Gross {st.gross_external_volume_l.toFixed(0)} L − Walls {(st.shell_wall_displacement_l + st.internal_partitions_displacement_l).toFixed(1)} L</small>
        </div>
      </div>
    </div>

    <!-- 2D ORTHOGRAPHIC ENGINEERING CROSS-SECTION BLUEPRINTS -->
    <div class="blueprint-card">
      <div class="bp-toolbar">
        <div>
          <h4>2D Orthographic CAD Cross-Sections (True Millimeter Wall Thicknesses)</h4>
          <span class="bp-hint">Tap or hover any cross-hatched panel, horn partition, waveguide, or motor to inspect exact thickness &amp; stock size</span>
        </div>
        <div class="bp-seg">
          <button class:active={blueprintMode === 'dual'} onclick={() => (blueprintMode = 'dual')}>
            Side + Front Dual
          </button>
          <button class:active={blueprintMode === 'side_yz'} onclick={() => (blueprintMode = 'side_yz')}>
            Side Section (Y–Z)
          </button>
          <button class:active={blueprintMode === 'plan_xy'} onclick={() => (blueprintMode = 'plan_xy')}>
            Plan Section (X–Y)
          </button>
          <button class:active={blueprintMode === 'front_xz'} onclick={() => (blueprintMode = 'front_xz')}>
            Front CNC (X–Z)
          </button>
        </div>
      </div>

      <div class="bp-grid" class:dual={visibleBlueprints.length > 1}>
        {#each visibleBlueprints as bp (bp.view_id)}
          {@const sw = strokeWidthFor(bp)}
          {@const fs = fontSizeFor(bp)}
          <div class="bp-pane">
            <div class="bp-pane-hdr">
              <strong>{bp.title}</strong>
              <span>{bp.plane_caption}</span>
            </div>

            <svg class="bp-svg" viewBox={viewBoxFor(bp)} role="img" aria-label={bp.title}>
              <defs>
                <!-- 13-Ply Baltic Birch veneer hatch -->
                <pattern id="hatch-birch" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
                  <rect width="10" height="10" fill="#d4a36a" fill-opacity="0.28" />
                  <line x1="0" y1="2.5" x2="10" y2="2.5" stroke="#eab676" stroke-width="0.9" stroke-opacity="0.7" />
                  <line x1="0" y1="7.5" x2="10" y2="7.5" stroke="#9c6b3b" stroke-width="0.7" stroke-opacity="0.65" />
                </pattern>
                <!-- High-Density MDF / HDF acoustic fiber hatch -->
                <pattern id="hatch-mdf" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
                  <rect width="8" height="8" fill="#b99066" fill-opacity="0.26" />
                  <line x1="0" y1="4" x2="8" y2="4" stroke="#d9b38c" stroke-width="0.8" stroke-dasharray="2 2" />
                </pattern>
                <!-- CNC 6061-T6 Aluminum 45° double metal hatch -->
                <pattern id="hatch-alu" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <rect width="12" height="12" fill="#60a5fa" fill-opacity="0.22" />
                  <line x1="0" y1="3" x2="12" y2="3" stroke="#bae6fd" stroke-width="0.9" />
                  <line x1="0" y1="6" x2="12" y2="6" stroke="#93c5fd" stroke-width="0.6" />
                </pattern>
                <!-- Porous acoustic mineral wool / foam cross-hatch -->
                <pattern id="hatch-damping" width="9" height="9" patternUnits="userSpaceOnUse">
                  <rect width="9" height="9" fill="#38bdf8" fill-opacity="0.14" />
                  <path d="M0,0 L9,9 M9,0 L0,9" stroke="#38bdf8" stroke-width="0.65" stroke-opacity="0.55" />
                </pattern>
                <!-- Steel / Magnet section hatch -->
                <pattern id="hatch-steel" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <rect width="8" height="8" fill="#64748b" fill-opacity="0.38" />
                  <line x1="0" y1="4" x2="8" y2="4" stroke="#cbd5e1" stroke-width="0.8" />
                </pattern>
                <marker id="cad-arrow" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill="#38bdf8" />
                </marker>
              </defs>

              <!-- Subtle millimeter CAD background grid -->
              {#each [-400, -300, -200, -100, 0, 100, 200, 300, 400] as gx}
                {#if gx >= bp.bounds_mm[0] && gx <= bp.bounds_mm[1]}
                  <line
                    x1={gx}
                    y1={-bp.bounds_mm[3]}
                    x2={gx}
                    y2={-bp.bounds_mm[2]}
                    stroke="#1e293b"
                    stroke-width={sw * 0.45}
                  />
                {/if}
              {/each}

              <!-- Cross-section polygons -->
              {#each bp.polygons as poly}
                {@const isHi = hoveredPartId !== '' && poly.part_id === hoveredPartId}
                <polygon
                  role="img"
                  aria-label={poly.label}
                  points={polyPointsAttr(poly.points_mm)}
                  fill={fillUrlFor(poly.material_kind, poly.color_hex, poly.is_dashed)}
                  stroke={isHi ? '#fbbf24' : poly.color_hex}
                  stroke-width={isHi ? sw * 2.1 : sw}
                  stroke-dasharray={poly.is_dashed ? `${sw * 4} ${sw * 2.5}` : undefined}
                  onpointerdown={() => {
                    hoveredPartId = poly.part_id;
                    hoveredPolyLabel = poly.label;
                  }}
                  onpointerenter={(e) => {
                    if (e.pointerType === 'mouse') {
                      hoveredPartId = poly.part_id;
                      hoveredPolyLabel = poly.label;
                    }
                  }}
                  onpointerleave={(e) => {
                    if (e.pointerType === 'mouse') {
                      hoveredPartId = '';
                      hoveredPolyLabel = '';
                    }
                  }}
                >
                  <title>{poly.label}</title>
                </polygon>
              {/each}

              <!-- Acoustic horn/port centerline paths -->
              {#each bp.paths as pth}
                <polyline
                  points={polyPointsAttr(pth.points_mm)}
                  fill="none"
                  stroke={pth.color_hex}
                  stroke-width={sw * 1.45}
                  stroke-dasharray={pth.dashed ? `${sw * 4.5} ${sw * 2.8}` : undefined}
                  marker-end={pth.arrow_end ? 'url(#cad-arrow)' : undefined}
                />
              {/each}

              <!-- Millimeter engineering dimension lines -->
              {#each bp.dimensions as dim}
                {@const [u0, v0] = dim.p0_mm}
                {@const [u1, v1] = dim.p1_mm}
                {@const horiz = Math.abs(v1 - v0) < Math.abs(u1 - u0)}
                {#if horiz}
                  {@const yd = -v0 - dim.offset_mm}
                  <line x1={u0} y1={-v0} x2={u0} y2={yd} stroke="#475569" stroke-width={sw * 0.65} />
                  <line x1={u1} y1={-v1} x2={u1} y2={yd} stroke="#475569" stroke-width={sw * 0.65} />
                  <line x1={u0} y1={yd} x2={u1} y2={yd} stroke="#94a3b8" stroke-width={sw * 0.85} />
                  <text
                    x={0.5 * (u0 + u1)}
                    y={yd + fs * 1.15}
                    fill="#cbd5e1"
                    font-size={fs}
                    text-anchor="middle"
                    font-family="ui-monospace, SFMono-Regular, monospace"
                  >
                    {dim.label}
                  </text>
                {:else}
                  {@const xd = u0 + dim.offset_mm}
                  <line x1={u0} y1={-v0} x2={xd} y2={-v0} stroke="#475569" stroke-width={sw * 0.65} />
                  <line x1={u1} y1={-v1} x2={xd} y2={-v1} stroke="#475569" stroke-width={sw * 0.65} />
                  <line x1={xd} y1={-v0} x2={xd} y2={-v1} stroke="#94a3b8" stroke-width={sw * 0.85} />
                  <text
                    x={xd - fs * 0.55}
                    y={-0.5 * (v0 + v1)}
                    fill="#cbd5e1"
                    font-size={fs}
                    text-anchor="middle"
                    dominant-baseline="middle"
                    transform={`rotate(-90 ${xd - fs * 0.55} ${-0.5 * (v0 + v1)})`}
                    font-family="ui-monospace, SFMono-Regular, monospace"
                  >
                    {dim.label}
                  </text>
                {/if}
              {/each}

              <!-- Engineering callout labels -->
              {#each bp.labels as lbl}
                <text
                  x={lbl.pos_mm[0]}
                  y={-lbl.pos_mm[1]}
                  fill={lbl.color_hex}
                  stroke="#090d16"
                  stroke-width={sw * 2.4}
                  paint-order="stroke"
                  text-anchor="middle"
                  dominant-baseline="middle"
                  font-size={fs * 0.88}
                  font-weight="600"
                  font-family="ui-monospace, SFMono-Regular, monospace"
                >
                  {lbl.text}
                </text>
              {/each}
            </svg>
          </div>
        {/each}
      </div>

      {#if inspectedSubmesh || hoveredPolyLabel}
        <div class="bp-inspect-bar">
          {#if inspectedSubmesh}
            <div class="bpi-main">
              <i class="sw" style={`background:${inspectedSubmesh.color_hex}`}></i>
              <strong>{inspectedSubmesh.name}</strong>
              <span class="bpi-chip">{inspectedSubmesh.thickness_mm.toFixed(1)} mm</span>
              <span class="bpi-chip">
                {inspectedSubmesh.cut_dims_mm[0].toFixed(0)} × {inspectedSubmesh.cut_dims_mm[1].toFixed(0)} mm
              </span>
              <span class="bpi-chip">{inspectedSubmesh.mass_kg.toFixed(2)} kg</span>
              <span class="bpi-mat">{inspectedSubmesh.material_name}</span>
            </div>
            <div class="bpi-sub">{inspectedSubmesh.notes}</div>
          {:else}
            <div class="bpi-main">
              <strong>{hoveredPolyLabel}</strong>
            </div>
          {/if}
          <button
            class="bpi-close"
            aria-label="Clear part selection"
            onclick={() => {
              hoveredPartId = '';
              hoveredPolyLabel = '';
            }}
          >
            ✕
          </button>
        </div>
      {/if}
    </div>

    <!-- KIRCHHOFF-MINDLIN PLATE BENDING MODAL RESONANCE & WALL COLORATION -->
    {#if st.modal_freqs_hz?.length > 0}
      <LineChart
        title="Kirchhoff–Mindlin Panel Bending Modal Coloration (dB re Direct Acoustic Output)"
        subtitle={`Wall thickness h³ flexural stiffness + internal bracing shifts fundamental panel mode f₁₁ from ${st.unbraced_f11_hz.toFixed(0)} Hz → ${st.braced_f11_hz.toFixed(0)} Hz (Low-freq STL floor: ${st.panel_stl_low_freq_db.toFixed(1)} dB)`}
        freqsHz={st.modal_freqs_hz}
        yLabel="Wall Radiation (dB rel)"
        yMin={-65}
        yMax={-5}
        height={195}
        refLines={[
          { value: -30, label: '-30 dB Studio Audibility Threshold', color: '#38bdf8' },
        ]}
        series={colorationSeries}
      />
    {/if}

    <!-- BILL OF MATERIALS & CNC PANEL CUTLIST TABLE -->
    <div class="bom-card">
      <div class="bom-hdr">
        <h4>Bill of Materials &amp; CNC Panel Cutlist ({activeCab.submeshes.length} Solid Sub-Assemblies)</h4>
        <span>Finish: {st.finish_label}</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Part / Sub-Assembly &amp; CNC Joinery</th>
              <th>Layer</th>
              <th>Material</th>
              <th class="num">Thick</th>
              <th class="num">Stock L×W (mm)</th>
              <th class="num">Mass</th>
            </tr>
          </thead>
          <tbody>
            {#each activeCab.submeshes as sm}
              <tr
                class:hi={hoveredPartId !== '' && sm.part_id === hoveredPartId}
                onpointerdown={() => {
                  hoveredPartId = sm.part_id;
                  hoveredPolyLabel = sm.name;
                }}
                onpointerenter={(e) => {
                  if (e.pointerType === 'mouse') {
                    hoveredPartId = sm.part_id;
                    hoveredPolyLabel = sm.name;
                  }
                }}
                onpointerleave={(e) => {
                  if (e.pointerType === 'mouse') {
                    hoveredPartId = '';
                    hoveredPolyLabel = '';
                  }
                }}
              >
                <td class="td-part">
                  <div class="part-cell">
                    <i class="sw" style={`background:${sm.color_hex}`}></i>
                    <strong>{sm.name}</strong>
                  </div>
                  <div class="notes-sub">{sm.notes}</div>
                </td>
                <td class="td-layer">
                  <span
                    class="layer-pill"
                    style={`border-color:${layerBadgeColor(sm.layer)};color:${layerBadgeColor(sm.layer)}`}
                  >
                    {sm.layer.replace('_', ' ')}
                  </span>
                </td>
                <td class="mat-col">{sm.material_name}</td>
                <td class="num mono td-metric" data-label="Thick">
                  <strong>{sm.thickness_mm.toFixed(1)} mm</strong>
                </td>
                <td class="num mono td-metric" data-label="Stock">
                  {sm.cut_dims_mm[0].toFixed(0)} × {sm.cut_dims_mm[1].toFixed(0)} mm
                </td>
                <td class="num mono td-metric" data-label="Mass">
                  {sm.mass_kg.toFixed(2)} kg
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  </div>
{/if}

<style>
  .cad-panel {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .cad-header-card,
  .blueprint-card,
  .bom-card {
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 11px 13px;
  }
  .cab-top-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 10px;
    flex-wrap: wrap;
  }
  .eyebrow {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: var(--accent);
    margin-bottom: 2px;
  }
  h3 {
    margin: 0;
    font-size: 15px;
    color: var(--text-0);
  }
  .cab-sub {
    margin: 2px 0 0;
    font-size: 11.5px;
    color: var(--text-2);
  }
  .cab-tabs {
    display: inline-flex;
    background: var(--bg-0);
    border: 1px solid var(--border);
    border-radius: 7px;
    padding: 2px;
    gap: 3px;
  }
  .cab-tabs button {
    background: transparent;
    border: none;
    color: var(--text-2);
    font-size: 11.5px;
    font-weight: 600;
    padding: 5px 10px;
    border-radius: 5px;
    cursor: pointer;
  }
  .cab-tabs button.active {
    background: rgba(56, 189, 248, 0.16);
    color: #38bdf8;
  }
  .metrics-strip {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 7px;
  }
  .m-chip {
    background: var(--bg-0);
    border: 1px solid rgba(148, 163, 184, 0.14);
    border-radius: 7px;
    padding: 7px 9px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .m-chip span {
    font-size: 10.5px;
    color: var(--text-2);
  }
  .m-chip strong {
    font-size: 13.5px;
    color: #f8fafc;
    font-variant-numeric: tabular-nums;
  }
  .m-chip small {
    font-size: 10px;
    color: #94a3b8;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .bp-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 8px;
    flex-wrap: wrap;
  }
  h4 {
    margin: 0;
    font-size: 12.5px;
    color: var(--text-0);
  }
  .bp-hint {
    font-size: 11px;
    color: var(--text-2);
  }
  .bp-seg {
    display: inline-flex;
    background: var(--bg-0);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 2px;
    gap: 2px;
  }
  .bp-seg button {
    background: transparent;
    border: none;
    color: var(--text-2);
    font-size: 11px;
    font-weight: 600;
    padding: 4px 8px;
    border-radius: 4px;
    cursor: pointer;
  }
  .bp-seg button.active {
    background: rgba(52, 211, 153, 0.16);
    color: #34d399;
  }
  .bp-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 8px;
  }
  .bp-grid.dual {
    grid-template-columns: 1.15fr 0.85fr;
  }
  .bp-pane {
    background: #050912;
    border: 1px solid #1e293b;
    border-radius: 8px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .bp-pane-hdr {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 5px 9px;
    background: rgba(15, 23, 42, 0.85);
    border-bottom: 1px solid #1e293b;
    font-size: 11px;
  }
  .bp-pane-hdr strong {
    color: #e2e8f0;
  }
  .bp-pane-hdr span {
    color: #94a3b8;
    font-size: 10px;
  }
  .bp-svg {
    width: 100%;
    height: 290px;
    display: block;
  }
  .bom-hdr {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 7px;
    font-size: 11px;
    color: var(--text-2);
  }
  .table-wrap {
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 11.2px;
  }
  th {
    text-align: left;
    padding: 5px 5px;
    color: var(--text-2);
    font-weight: 600;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
    font-size: 10.6px;
  }
  td {
    padding: 5px 5px;
    border-bottom: 1px solid rgba(148, 163, 184, 0.09);
    color: var(--text-1);
  }
  td:first-child {
    max-width: 225px;
  }
  tr.hi td {
    background: rgba(251, 191, 36, 0.09);
  }
  .part-cell {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
  }
  .sw {
    display: inline-block;
    width: 9px;
    height: 9px;
    border-radius: 2px;
    flex-shrink: 0;
  }
  .layer-pill {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 99px;
    border: 1px solid;
    font-size: 9.5px;
    font-weight: 600;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .mono {
    font-family: ui-monospace, SFMono-Regular, monospace;
    white-space: nowrap;
  }
  .mat-col {
    font-size: 10.3px;
    color: var(--text-1);
    max-width: 132px;
    line-height: 1.25;
  }
  .notes-sub {
    color: var(--text-2);
    font-size: 10px;
    margin-top: 2px;
    padding-left: 15px;
    line-height: 1.3;
  }
  .bp-inspect-bar {
    margin-top: 8px;
    padding: 8px 10px;
    background: rgba(15, 23, 42, 0.92);
    border: 1px solid rgba(251, 191, 36, 0.55);
    border-radius: 7px;
    position: relative;
    padding-right: 32px;
  }
  .bpi-main {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    font-size: 11.5px;
    color: #f8fafc;
  }
  .bpi-chip {
    background: rgba(56, 189, 248, 0.14);
    color: #38bdf8;
    border-radius: 4px;
    padding: 1px 6px;
    font-size: 10.5px;
    font-weight: 600;
    font-family: ui-monospace, SFMono-Regular, monospace;
  }
  .bpi-mat {
    color: #cbd5e1;
    font-size: 10.5px;
  }
  .bpi-sub {
    margin-top: 3px;
    font-size: 10.5px;
    color: var(--text-2);
  }
  .bpi-close {
    position: absolute;
    top: 6px;
    right: 6px;
    background: transparent;
    border: none;
    color: var(--text-2);
    font-size: 13px;
    padding: 4px 6px;
    cursor: pointer;
  }

  @media (max-width: 768px) {
    .cad-header-card,
    .blueprint-card,
    .bom-card {
      padding: 10px 11px;
    }
    .cab-tabs {
      width: 100%;
      overflow-x: auto;
      scrollbar-width: none;
    }
    .cab-tabs button {
      flex: 1;
      white-space: nowrap;
      padding: 7px 10px;
    }
    .metrics-strip {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .bp-seg {
      width: 100%;
      overflow-x: auto;
      scrollbar-width: none;
    }
    .bp-seg button {
      flex: 1;
      white-space: nowrap;
      padding: 6px 9px;
    }
    .bp-grid.dual {
      grid-template-columns: 1fr;
    }
    .bp-svg {
      height: 265px;
    }
    .bom-hdr {
      flex-direction: column;
      align-items: flex-start;
      gap: 3px;
    }
  }

  @media (max-width: 680px) {
    thead {
      display: none;
    }
    table,
    tbody {
      display: block;
      width: 100%;
    }
    tr {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 5px 8px;
      background: var(--bg-0);
      border: 1px solid rgba(148, 163, 184, 0.14);
      border-radius: 8px;
      padding: 8px 10px;
      margin-bottom: 7px;
    }
    tr.hi {
      border-color: #fbbf24;
      background: rgba(251, 191, 36, 0.08);
    }
    td {
      border: none;
      padding: 0;
      max-width: none !important;
    }
    .td-part {
      grid-column: 1 / 2;
    }
    .td-layer {
      grid-column: 2 / 3;
      justify-self: end;
      align-self: start;
    }
    .mat-col {
      grid-column: 1 / -1;
      font-size: 11px;
      color: #93c5fd;
      padding-left: 15px;
    }
    .td-metric {
      grid-column: 1 / -1;
      display: flex;
      justify-content: space-between;
      align-items: center;
      text-align: left;
      padding: 2px 0 0 15px;
      font-size: 11px;
    }
    .td-metric::before {
      content: attr(data-label);
      color: var(--text-2);
      font-family: Inter, -apple-system, sans-serif;
      font-size: 10.5px;
    }
  }
</style>
