<script lang="ts">
  import { home, saveHome } from './homeState.svelte';
  function set(v: 'living' | 'outdoor') {
    home.venue = v;
    saveHome();
  }
</script>

<div class="seg venue" role="group" aria-label="Venue">
  <button class:on={home.venue === 'living'} onclick={() => set('living')}>🛋️ Living room</button>
  <button class:on={home.venue === 'outdoor'} onclick={() => set('outdoor')}>🌲 Outdoor</button>
</div>

<style>
  .venue button {
    font-size: 13px;
  }
</style>
