<script lang="ts">
  import QualifierSection from './QualifierSection.svelte';
  import RangeInput from '$lib/components/shared/RangeInput.svelte';
  import type { FilterCategory, FilterId } from '$lib/core/types';
  import { DEFAULT_EDIT_STATE } from '$lib/editor/constants';
  import { FILTER_CATEGORIES, FILTER_PRESETS } from '$lib/processing/filters';
  import { buildFilterThumbnails } from '$lib/ui/preset-thumbnails';
  import { getEditorContext } from '$lib/state/context';

  const ctx = getEditorContext();
  const editor = ctx.editor;

  let thumbnails = $state<Partial<Record<FilterId, string>>>({});

  const hasImage = $derived(ctx.snapshot.hasImage);
  const filterId = $derived(ctx.snapshot.state.filterId);
  const filterIntensity = $derived(ctx.snapshot.state.filterIntensity);

  const categories = $derived(
    FILTER_CATEGORIES.map((category) => ({
      ...category,
      presets: FILTER_PRESETS.filter(
        (preset) => preset.id !== 'none' && preset.category === category.id,
      ),
    })).filter((category) => category.presets.length > 0),
  );

  const nonePreset = $derived(FILTER_PRESETS.find((preset) => preset.id === 'none'));

  $effect(() => {
    if (!hasImage) {
      thumbnails = {};
      return;
    }

    const source = editor.getSourcePreview();
    if (!source) return;

    let cancelled = false;

    buildFilterThumbnails(source, (id, dataUrl) => {
      if (cancelled) return;
      thumbnails = { ...thumbnails, [id]: dataUrl };
    })
      .then((result) => {
        if (!cancelled) thumbnails = result;
      })
      .catch(() => {
        if (!cancelled) thumbnails = {};
      });

    return () => {
      cancelled = true;
    };
  });

  const selectFilter = (id: FilterId) => {
    editor.setFilter(id, true);
  };

  const badgeClass = (category: FilterCategory): string =>
    `preset-thumb-badge preset-thumb-badge--${category}`;
</script>

<div data-panel="filters">
  {#if nonePreset}
    <div class="filter-none-row">
      <button
        type="button"
        class="preset-card preset-card-inline"
        class:is-selected={filterId === 'none'}
        disabled={!hasImage}
        onclick={() => selectFilter('none')}
      >
        <span class="preset-name">{nonePreset.label}</span>
      </button>
    </div>
  {/if}

  <div class="filter-catalog">
    {#each categories as category (category.id)}
      <section class="filter-category">
        <h3 class="filter-category-title">{category.label}</h3>
        <div class="preset-wall">
          {#each category.presets as preset (preset.id)}
            {@const thumb = thumbnails[preset.id]}
            <button
              type="button"
              class="preset-card"
              class:is-selected={filterId === preset.id}
              disabled={!hasImage}
              title={preset.description}
              onclick={() => selectFilter(preset.id)}
            >
              <div
                class="preset-thumb"
                class:has-image={!!thumb}
                data-thumb={thumb ?? undefined}
                style:background-image={thumb ? `url(${thumb})` : undefined}
              >
                <div class="preset-thumb-fallback" aria-hidden="true"></div>
                <span class={badgeClass(preset.category)} aria-hidden="true"></span>
              </div>
              <span class="preset-name">{preset.label}</span>
            </button>
          {/each}
        </div>
      </section>
    {/each}
  </div>

  <div class="filter-adjust-panel" hidden={filterId === 'none'}>
    <RangeInput
      value={filterIntensity}
      min={0}
      max={100}
      step={1}
      label="Filter intensity"
      disabled={!hasImage || filterId === 'none'}
      defaultValue={DEFAULT_EDIT_STATE.filterIntensity}
      onscrubstart={() => editor.beginInteraction()}
      onscrubend={() => editor.endInteraction()}
      oninput={(value) => editor.setFilterIntensity(value, false)}
      oncommit={(value) => editor.setFilterIntensity(value, false)}
    />

    <QualifierSection />
  </div>
</div>