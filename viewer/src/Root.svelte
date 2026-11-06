<script lang="ts">
  import HomeStudio from './home/HomeStudio.svelte';

  type Tab = 'room' | 'speaker' | 'build' | 'print' | 'parts' | 'learn';
  function parse(): { mode: 'home' | 'lab'; tab: Tab } {
    const h = location.hash.replace(/^#/, '');
    if (h.startsWith('lab')) return { mode: 'lab', tab: 'room' };
    const t = h.split('/')[1] as Tab | undefined;
    return { mode: 'home', tab: t && ['room', 'speaker', 'build', 'print', 'parts', 'learn'].includes(t) ? t : 'room' };
  }
  let route = $state(parse());

  // The Lab (Three.js, WASM, big simulation bundles) only loads when opened.
  let LabApp = $state<typeof import('./App.svelte').default | null>(null);
  $effect(() => {
    if (route.mode === 'lab' && !LabApp) import('./App.svelte').then((m) => (LabApp = m.default));
  });

  function openLab() {
    history.pushState(null, '', '#lab');
    route = { mode: 'lab', tab: route.tab };
  }
  function openHome() {
    history.pushState(null, '', '#home/' + route.tab);
    route = { mode: 'home', tab: route.tab };
  }
  window.addEventListener('popstate', () => (route = parse()));
</script>

{#if route.mode === 'home'}
  <HomeStudio onOpenLab={openLab} initialTab={route.tab} />
{:else if LabApp}
  <LabApp onHome={openHome} />
{:else}
  <div style="padding:40px;color:#8b9dc3">Loading the Acoustics Lab…</div>
{/if}
