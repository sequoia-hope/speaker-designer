<script lang="ts">
  import type { DesignEncyclopediaDatabase } from '../types';
  import { findDesignDossier } from '../designDatabase';

  interface Props {
    database: DesignEncyclopediaDatabase;
    activeSimId: string;
    onSelectSimulation: (id: string) => void;
    onOpenParametric: () => void;
    onOpenCad: () => void;
    onOpenPlots: (
      tab: 'response' | 'spinorama' | 'impedance' | 'nonlinear' | 'calibration'
    ) => void;
  }

  let {
    database,
    activeSimId,
    onSelectSimulation,
    onOpenParametric,
    onOpenCad,
    onOpenPlots,
  }: Props = $props();

  let subView = $state<'dossier' | 'catalog' | 'topologies'>('dossier');
  let searchQuery = $state<string>('');
  let categoryFilter = $state<'all' | 'studio' | 'horn' | 'edm' | 'cal'>('all');
  let topoKindFilter = $state<'all' | 'enclosure' | 'sub_array'>('all');

  const activeDossier = $derived(
    findDesignDossier(database, activeSimId) ?? database.designs[0] ?? null
  );

  const filteredDesigns = $derived.by(() => {
    const q = searchQuery.trim().toLowerCase();
    return database.designs.filter((d) => {
      if (categoryFilter === 'studio' && !d.design_id.includes('studio') && !d.design_id.includes('mastering')) {
        return false;
      }
      if (
        categoryFilter === 'horn' &&
        !d.design_id.includes('subwoofer-coupling') &&
        !d.design_id.includes('tapped-horn')
      ) {
        return false;
      }
      if (
        categoryFilter === 'edm' &&
        !d.design_id.includes('outdoor-edm') &&
        !d.design_id.includes('festival')
      ) {
        return false;
      }
      if (categoryFilter === 'cal' && !d.design_id.includes('calibration')) {
        return false;
      }
      if (!q) return true;
      return (
        d.short_name.toLowerCase().includes(q) ||
        d.archetype.toLowerCase().includes(q) ||
        d.family_badge.toLowerCase().includes(q) ||
        d.physics_principle.toLowerCase().includes(q) ||
        d.why_it_sounds_distinct.toLowerCase().includes(q) ||
        d.heritage_inspirations.some((h) => h.toLowerCase().includes(q))
      );
    });
  });

  const filteredTopologies = $derived.by(() => {
    const q = searchQuery.trim().toLowerCase();
    return database.topologies.filter((t) => {
      if (topoKindFilter !== 'all' && t.kind !== topoKindFilter) return false;
      if (!q) return true;
      return (
        t.name.toLowerCase().includes(q) ||
        t.mechanism_summary.toLowerCase().includes(q) ||
        t.when_to_choose.toLowerCase().includes(q)
      );
    });
  });
</script>

<div class="db-panel">
  <!-- SUB-MODE SWITCHER -->
  <div class="db-toolbar">
    <div class="db-modes" role="tablist" aria-label="Design Encyclopedia Views">
      <button
        class:active={subView === 'dossier'}
        onclick={() => (subView = 'dossier')}
      >
        🔍 Active Design Dossier
      </button>
      <button
        class:active={subView === 'catalog'}
        onclick={() => (subView = 'catalog')}
      >
        🗂 All {database.designs.length} Designs
      </button>
      <button
        class:active={subView === 'topologies'}
        onclick={() => (subView = 'topologies')}
      >
        🧭 Topologies &amp; Arrays ({database.topologies.length})
      </button>
    </div>

    {#if subView !== 'dossier'}
      <input
        type="search"
        class="db-search"
        aria-label="Search speaker designs and acoustic topologies"
        placeholder="Search horns, cardioid, Linkwitz, MTM, Danley…"
        bind:value={searchQuery}
      />
    {/if}
  </div>

  {#if subView === 'dossier' && activeDossier}
    <article class="dossier-card">
      <div class="dossier-hdr">
        <div>
          <div class="badge-row">
            <span class="fam-badge">{activeDossier.family_badge}</span>
            <span class="id-badge">{activeDossier.design_id}</span>
          </div>
          <h3>{activeDossier.short_name} — {activeDossier.archetype}</h3>
          <p class="use-case"><strong>Target Deployment:</strong> {activeDossier.use_case}</p>
        </div>

        <div class="quick-actions">
          <button class="act-btn primary" onclick={onOpenParametric}>
            🎛 Tune in Parametric Lab
          </button>
          <button class="act-btn" onclick={onOpenCad}>
            🪚 Inspect CAD &amp; BOM
          </button>
        </div>
      </div>

      <div class="spec-strip">
        <div class="spec-cell">
          <span class="sp-lbl">Operating Bandwidth</span>
          <strong>{activeDossier.bandwidth_spec}</strong>
        </div>
        <div class="spec-cell">
          <span class="sp-lbl">3D Radiation &amp; Directivity</span>
          <strong>{activeDossier.radiation_pattern}</strong>
        </div>
        <div class="spec-cell">
          <span class="sp-lbl">Acoustic Output Class</span>
          <strong>{activeDossier.efficiency_class}</strong>
        </div>
      </div>

      <div class="prose-grid">
        <div class="prose-box">
          <h4>⚡ Core Electro-Acoustic Physics Principle</h4>
          <p>{activeDossier.physics_principle}</p>
        </div>
        <div class="prose-box highlight">
          <h4>🎧 Why It Sounds &amp; Measures Distinct</h4>
          <p>{activeDossier.why_it_sounds_distinct}</p>
        </div>
      </div>

      <div class="pros-cons-grid">
        <div class="list-box strengths">
          <h4>✓ Engineering Strengths</h4>
          <ul>
            {#each activeDossier.strengths as s}
              <li>{s}</li>
            {/each}
          </ul>
        </div>
        <div class="list-box tradeoffs">
          <h4>⚖ Physical Trade-Offs &amp; Constraints</h4>
          <ul>
            {#each activeDossier.tradeoffs as t}
              <li>{t}</li>
            {/each}
          </ul>
        </div>
      </div>

      <div class="meta-grid">
        <div class="meta-box">
          <h4>🪵 Structural Material &amp; Bracing Rationale</h4>
          <p>{activeDossier.material_rationale}</p>
        </div>
        <div class="meta-box">
          <h4>🏛 Real-World Acoustic Heritage &amp; Inspirations</h4>
          <ul class="heritage-list">
            {#each activeDossier.heritage_inspirations as h}
              <li>{h}</li>
            {/each}
          </ul>
        </div>
      </div>

      <div class="experiments-box">
        <div class="exp-hdr">
          <h4>🔬 Try These Interactive Simulator Experiments</h4>
          <div class="plot-jumps">
            <button onclick={() => onOpenPlots('response')}>SPL &amp; Coupling →</button>
            <button onclick={() => onOpenPlots('spinorama')}>Spinorama →</button>
            <button onclick={() => onOpenPlots('impedance')}>Z_rad Loading →</button>
            <button onclick={() => onOpenPlots('nonlinear')}>Excursion &amp; THD →</button>
          </div>
        </div>
        <ol>
          {#each activeDossier.simulator_experiments as exp}
            <li>{exp}</li>
          {/each}
        </ol>
      </div>
    </article>
  {:else if subView === 'catalog'}
    <div class="filter-pills">
      <button class:active={categoryFilter === 'all'} onclick={() => (categoryFilter = 'all')}>
        All ({database.designs.length})
      </button>
      <button class:active={categoryFilter === 'studio'} onclick={() => (categoryFilter = 'studio')}>
        Studio &amp; Mastering
      </button>
      <button class:active={categoryFilter === 'horn'} onclick={() => (categoryFilter = 'horn')}>
        Horns &amp; Sub Coupling
      </button>
      <button class:active={categoryFilter === 'edm'} onclick={() => (categoryFilter = 'edm')}>
        Outdoor EDM Systems
      </button>
      <button class:active={categoryFilter === 'cal'} onclick={() => (categoryFilter = 'cal')}>
        Bayesian Calibration
      </button>
    </div>

    <div class="catalog-grid">
      {#each filteredDesigns as item (item.design_id)}
        {@const isCurrent = item.design_id === activeSimId}
        <div class="cat-card" class:current={isCurrent}>
          <div class="cat-top">
            <span class="fam-badge">{item.family_badge}</span>
            {#if isCurrent}
              <span class="active-pill">Loaded</span>
            {/if}
          </div>
          <h4>{item.short_name}</h4>
          <div class="cat-arch">{item.archetype}</div>
          <p class="cat-phys">{item.physics_principle}</p>
          <div class="cat-specs">
            <span><strong>BW:</strong> {item.bandwidth_spec}</span>
            <span><strong>Pattern:</strong> {item.radiation_pattern}</span>
          </div>
          <div class="cat-actions">
            <button
              class="load-btn"
              onclick={() => {
                onSelectSimulation(item.design_id);
                subView = 'dossier';
              }}
            >
              {isCurrent ? 'View Full Dossier' : 'Load in Simulator →'}
            </button>
            {#if isCurrent}
              <button class="tune-mini-btn" onclick={onOpenParametric}>🎛 Tune</button>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {:else}
    <div class="filter-pills">
      <button class:active={topoKindFilter === 'all'} onclick={() => (topoKindFilter = 'all')}>
        All Topologies ({database.topologies.length})
      </button>
      <button
        class:active={topoKindFilter === 'enclosure'}
        onclick={() => (topoKindFilter = 'enclosure')}
      >
        Enclosure Loading (7)
      </button>
      <button
        class:active={topoKindFilter === 'sub_array'}
        onclick={() => (topoKindFilter = 'sub_array')}
      >
        Multi-Subwoofer Arrays (4)
      </button>
    </div>

    <div class="topo-grid">
      {#each filteredTopologies as topo (topo.id)}
        <div class="topo-card">
          <div class="cat-top">
            <span class="fam-badge" class:array-badge={topo.kind === 'sub_array'}>
              {topo.kind === 'sub_array' ? 'Multi-Sub Array' : 'Enclosure Loading'}
            </span>
          </div>
          <h4>{topo.name}</h4>
          <p class="topo-mech">{topo.mechanism_summary}</p>
          <div class="topo-kv">
            <div><span>Roll-Off / Passband:</span> <strong>{topo.rolloff_slope}</strong></div>
            <div><span>Sensitivity Class:</span> <strong>{topo.typical_sensitivity}</strong></div>
            <div><span>Group Delay:</span> <strong>{topo.group_delay_profile}</strong></div>
            <div><span>Rear Rejection:</span> <strong>{topo.rear_rejection}</strong></div>
          </div>
          <p class="topo-when"><strong>When to Choose:</strong> {topo.when_to_choose}</p>
          <div class="topo-examples">
            <span class="ex-lbl">Example Presets:</span>
            {#each topo.example_design_ids as exId}
              {@const exEntry = findDesignDossier(database, exId)}
              <button
                class="ex-chip"
                class:current={exId === activeSimId}
                onclick={() => {
                  onSelectSimulation(exId);
                  subView = 'dossier';
                }}
              >
                {exEntry ? exEntry.short_name : exId} →
              </button>
            {/each}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .db-panel {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .db-toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 6px 8px;
  }
  .db-modes {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }
  .db-modes button {
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-2);
    font-size: 11.5px;
    font-weight: 600;
    padding: 5px 10px;
    border-radius: 6px;
    cursor: pointer;
  }
  .db-modes button.active {
    background: rgba(56, 189, 248, 0.15);
    border-color: rgba(56, 189, 248, 0.5);
    color: var(--text-0);
  }
  .db-search {
    flex: 1;
    min-width: 200px;
    background: var(--bg-0);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 5px 10px;
    color: var(--text-0);
    font-size: 12px;
  }

  .dossier-card {
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: 9px;
    padding: 13px 15px;
    display: flex;
    flex-direction: column;
    gap: 11px;
  }
  .dossier-hdr {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
    flex-wrap: wrap;
  }
  .badge-row {
    display: flex;
    align-items: center;
    gap: 7px;
    margin-bottom: 5px;
    flex-wrap: wrap;
  }
  .fam-badge {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    background: rgba(56, 189, 248, 0.16);
    color: var(--accent);
    padding: 2px 8px;
    border-radius: 99px;
  }
  .fam-badge.array-badge {
    background: rgba(167, 139, 250, 0.18);
    color: #c4b5fd;
  }
  .id-badge {
    font-size: 10.5px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--text-2);
  }
  .dossier-hdr h3 {
    margin: 0;
    font-size: 15px;
    line-height: 1.3;
  }
  .use-case {
    margin: 4px 0 0;
    font-size: 11.5px;
    color: var(--text-1);
  }
  .quick-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .act-btn {
    background: var(--bg-2);
    border: 1px solid var(--border);
    color: var(--text-0);
    border-radius: 6px;
    padding: 6px 11px;
    font-size: 11.5px;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
  }
  .act-btn.primary {
    background: rgba(52, 211, 153, 0.16);
    border-color: var(--emerald);
    color: var(--emerald);
  }

  .spec-strip {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
  }
  .spec-cell {
    background: var(--bg-0);
    border: 1px solid var(--border);
    border-radius: 7px;
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .sp-lbl {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-2);
    font-weight: 700;
  }
  .spec-cell strong {
    font-size: 11.5px;
    color: var(--text-0);
    line-height: 1.35;
  }

  .prose-grid,
  .pros-cons-grid,
  .meta-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 9px;
  }
  .prose-box,
  .list-box,
  .meta-box,
  .experiments-box {
    background: var(--bg-0);
    border: 1px solid var(--border);
    border-radius: 7px;
    padding: 10px 12px;
  }
  .prose-box.highlight {
    border-left: 3px solid var(--accent);
  }
  .list-box.strengths {
    border-left: 3px solid var(--emerald);
  }
  .list-box.tradeoffs {
    border-left: 3px solid var(--amber);
  }
  .prose-box h4,
  .list-box h4,
  .meta-box h4,
  .experiments-box h4 {
    margin: 0 0 6px;
    font-size: 12px;
    color: var(--text-0);
  }
  .prose-box p,
  .meta-box p {
    margin: 0;
    font-size: 11.5px;
    line-height: 1.48;
    color: var(--text-1);
  }
  .list-box ul,
  .heritage-list,
  .experiments-box ol {
    margin: 0;
    padding-left: 17px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 11.4px;
    line-height: 1.42;
    color: var(--text-1);
  }

  .exp-hdr {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 6px;
  }
  .exp-hdr h4 {
    margin: 0;
  }
  .plot-jumps {
    display: flex;
    gap: 5px;
    flex-wrap: wrap;
  }
  .plot-jumps button {
    background: var(--bg-2);
    border: 1px solid var(--border);
    color: var(--accent);
    border-radius: 5px;
    padding: 3px 8px;
    font-size: 10.5px;
    font-weight: 600;
    cursor: pointer;
  }

  .filter-pills {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .filter-pills button {
    background: var(--bg-1);
    border: 1px solid var(--border);
    color: var(--text-2);
    border-radius: 99px;
    padding: 4px 11px;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
  }
  .filter-pills button.active {
    background: rgba(56, 189, 248, 0.16);
    border-color: var(--accent);
    color: var(--text-0);
  }

  .catalog-grid,
  .topo-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(265px, 1fr));
    gap: 9px;
  }
  .cat-card,
  .topo-card {
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 11px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .cat-card.current {
    border-color: rgba(56, 189, 248, 0.65);
    background: rgba(56, 189, 248, 0.05);
  }
  .cat-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 6px;
  }
  .active-pill {
    font-size: 9.5px;
    font-weight: 700;
    background: rgba(52, 211, 153, 0.18);
    color: var(--emerald);
    padding: 1px 7px;
    border-radius: 99px;
  }
  .cat-card h4,
  .topo-card h4 {
    margin: 0;
    font-size: 13.5px;
  }
  .cat-arch {
    font-size: 11px;
    color: var(--accent);
    font-weight: 600;
  }
  .cat-phys,
  .topo-mech {
    margin: 0;
    font-size: 11.2px;
    color: var(--text-1);
    line-height: 1.42;
    flex: 1;
  }
  .cat-specs,
  .topo-kv {
    background: var(--bg-0);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 6px 8px;
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 10.8px;
    color: var(--text-1);
  }
  .topo-kv span {
    color: var(--text-2);
  }
  .topo-when {
    margin: 0;
    font-size: 11px;
    color: var(--text-1);
    line-height: 1.38;
  }
  .cat-actions {
    display: flex;
    gap: 6px;
    margin-top: 2px;
  }
  .load-btn {
    flex: 1;
    background: rgba(56, 189, 248, 0.14);
    border: 1px solid rgba(56, 189, 248, 0.5);
    color: var(--accent);
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 11.5px;
    font-weight: 600;
    cursor: pointer;
  }
  .tune-mini-btn {
    background: rgba(52, 211, 153, 0.15);
    border: 1px solid var(--emerald);
    color: var(--emerald);
    border-radius: 6px;
    padding: 6px 9px;
    font-size: 11.5px;
    font-weight: 600;
    cursor: pointer;
  }
  .topo-examples {
    display: flex;
    align-items: center;
    gap: 5px;
    flex-wrap: wrap;
    margin-top: 2px;
  }
  .ex-lbl {
    font-size: 10.5px;
    color: var(--text-2);
  }
  .ex-chip {
    background: var(--bg-0);
    border: 1px solid var(--border);
    color: var(--accent);
    border-radius: 99px;
    padding: 2px 8px;
    font-size: 10.5px;
    font-weight: 600;
    cursor: pointer;
  }
  .ex-chip.current {
    border-color: var(--emerald);
    color: var(--emerald);
  }

  @media (max-width: 900px) {
    .spec-strip,
    .prose-grid,
    .pros-cons-grid,
    .meta-grid,
    .catalog-grid,
    .topo-grid {
      grid-template-columns: 1fr;
    }
    .db-search {
      width: 100%;
      min-width: 0;
    }
  }

  @media (pointer: coarse) {
    .db-search {
      font-size: 16px;
    }
  }
</style>
