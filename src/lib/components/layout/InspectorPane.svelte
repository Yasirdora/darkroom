<script lang="ts">
  import AdjustPanel from '$lib/components/inspector/AdjustPanel.svelte';
  import FilterPanel from '$lib/components/inspector/FilterPanel.svelte';
  import InspectorFooter from '$lib/components/inspector/InspectorFooter.svelte';
  import TabRail from '$lib/components/inspector/TabRail.svelte';
  import ScopePanel from '$lib/components/inspector/ScopePanel.svelte';
  import type { TabId } from '$lib/core/types';
  import { getEditorContext } from '$lib/state/context';
  import { onMount } from 'svelte';

  interface Props {
    activeTab?: TabId;
    onTabChange?: (tab: TabId) => void;
    toastMessage?: string | null;
    toastError?: boolean;
    greyPickActive?: boolean;
    onGreyPick?: () => void;
    onOpen: () => void;
    onExport: () => void;
  }

  let {
    activeTab = $bindable('adjust'),
    onTabChange,
    toastMessage = null,
    toastError = false,
    greyPickActive = false,
    onGreyPick,
    onOpen,
    onExport,
  }: Props = $props();

  const ctx = getEditorContext();

  let scopesCollapsed = $state(false);

  const hasImage = $derived(ctx.snapshot.hasImage);

  onMount(() => {
    if (window.innerWidth <= 820) scopesCollapsed = true;
  });

  const handleTabChange = (tab: TabId) => {
    activeTab = tab;
    onTabChange?.(tab);
  };
</script>

<aside class="inspector-pane" aria-label="Inspector">
  <header class="inspector-head">
    <ScopePanel bind:collapsed={scopesCollapsed} />

    <TabRail {activeTab} onTabChange={handleTabChange} />
  </header>

  <div class="inspector-body">
    <div
      class="inspector-section"
      id="panel-adjust"
      data-panel="adjust"
      role="tabpanel"
      aria-labelledby="tab-adjust"
      hidden={activeTab !== 'adjust'}
    >
      <AdjustPanel {onGreyPick} {greyPickActive} />
    </div>

    <div
      class="inspector-section"
      id="panel-filters"
      data-panel="filters"
      role="tabpanel"
      aria-labelledby="tab-filters"
      hidden={activeTab !== 'filters'}
    >
      <FilterPanel />
    </div>
  </div>

  <InspectorFooter
    {toastMessage}
    {toastError}
    {hasImage}
    {onOpen}
    {onExport}
  />
</aside>