<script lang="ts">
  import type { TabId } from '$lib/core/types';

  interface Props {
    activeTab: TabId;
    onTabChange: (tab: TabId) => void;
  }

  let { activeTab, onTabChange }: Props = $props();

  let railEl = $state<HTMLDivElement | null>(null);
  let adjustBtn = $state<HTMLButtonElement | null>(null);
  let filtersBtn = $state<HTMLButtonElement | null>(null);
  let indicatorLeft = $state(0);
  let indicatorWidth = $state(0);
  let indicatorReady = $state(false);

  const updateIndicator = () => {
    const activeBtn = activeTab === 'adjust' ? adjustBtn : filtersBtn;
    if (!railEl || !activeBtn) {
      indicatorReady = false;
      return;
    }

    const railRect = railEl.getBoundingClientRect();
    const btnRect = activeBtn.getBoundingClientRect();
    indicatorLeft = btnRect.left - railRect.left;
    indicatorWidth = btnRect.width;
    indicatorReady = true;
  };

  $effect(() => {
    activeTab;
    queueMicrotask(updateIndicator);
  });

  $effect(() => {
    if (!railEl) return;

    const observer = new ResizeObserver(() => updateIndicator());
    observer.observe(railEl);
    window.addEventListener('resize', updateIndicator);

    updateIndicator();

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateIndicator);
    };
  });
</script>

<div class="tab-rail tab-rail-2" bind:this={railEl} role="tablist" aria-label="Inspector panels">
  <div
    class="tab-rail-indicator"
    style:left="{indicatorLeft}px"
    style:width="{indicatorWidth}px"
    style:opacity={indicatorReady ? 1 : 0}
    aria-hidden="true"
  ></div>

  <button
    bind:this={adjustBtn}
    type="button"
    class="tab-rail-btn"
    class:is-active={activeTab === 'adjust'}
    role="tab"
    aria-selected={activeTab === 'adjust'}
    onclick={() => onTabChange('adjust')}
  >
    Adjust
  </button>

  <button
    bind:this={filtersBtn}
    type="button"
    class="tab-rail-btn"
    class:is-active={activeTab === 'filters'}
    role="tab"
    aria-selected={activeTab === 'filters'}
    onclick={() => onTabChange('filters')}
  >
    Filters
  </button>
</div>