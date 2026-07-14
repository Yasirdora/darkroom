<script lang="ts">
  import Collapsible from '$lib/components/shared/Collapsible.svelte';
  import HistogramView from '$lib/components/shared/HistogramView.svelte';
  import VectorscopeView from '$lib/components/shared/VectorscopeView.svelte';
  import { getEditorContext } from '$lib/state/context';

  type ScopeMode = 'histogram' | 'vectorscope';

  interface Props {
    collapsed?: boolean;
  }

  let { collapsed = $bindable(false) }: Props = $props();

  const ctx = getEditorContext();
  const histogram = $derived(ctx.snapshot.histogram);
  const vectorscope = $derived(ctx.snapshot.vectorscope);

  let mode = $state<ScopeMode>('histogram');
</script>

<Collapsible title="Scopes" bind:collapsed>
  {#snippet actions()}
    <div class="scope-mode-tabs" role="tablist" aria-label="Scope display mode">
      <button
        type="button"
        role="tab"
        class="scope-mode-tab"
        class:is-active={mode === 'histogram'}
        aria-selected={mode === 'histogram'}
        onclick={() => {
          mode = 'histogram';
        }}
      >
        Histogram
      </button>
      <button
        type="button"
        role="tab"
        class="scope-mode-tab"
        class:is-active={mode === 'vectorscope'}
        aria-selected={mode === 'vectorscope'}
        onclick={() => {
          mode = 'vectorscope';
        }}
      >
        Vectorscope
      </button>
    </div>
  {/snippet}

  <div
    class="scope-panel-body"
    role="tabpanel"
    aria-label={mode === 'histogram' ? 'RGB histogram' : 'Vectorscope with skin-tone line'}
  >
    {#if mode === 'histogram'}
      <HistogramView data={histogram} />
    {:else}
      <VectorscopeView data={vectorscope} />
    {/if}
  </div>
</Collapsible>