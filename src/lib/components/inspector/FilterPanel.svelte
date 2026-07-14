<script lang="ts">
  import CinemaLooksPanel from './CinemaLooksPanel.svelte';
  import QualifierSection from './QualifierSection.svelte';
  import RangeInput from '$lib/components/shared/RangeInput.svelte';
  import type { FilterCategory, FilterId } from '$lib/core/types';
  import { DEFAULT_EDIT_STATE } from '$lib/editor/constants';
  import { CINEMA_LOOK_IDS } from '$lib/constants/cinema-looks';
  import { FILTER_CATEGORIES, FILTER_PRESETS } from '$lib/processing/filters';
  import { readCubeFile } from '$lib/processing/cube-import';
  import { buildFilterThumbnails } from '$lib/ui/preset-thumbnails';
  import { getEditorContext } from '$lib/state/context';

  const ctx = getEditorContext();
  const editor = ctx.editor;

  let thumbnails = $state<Partial<Record<FilterId, string>>>({});
  let importInput = $state<HTMLInputElement | null>(null);
  let importError = $state<string | null>(null);

  const hasImage = $derived(ctx.snapshot.hasImage);
  const filterId = $derived(ctx.snapshot.state.filterId);
  const filterIntensity = $derived(ctx.snapshot.state.filterIntensity);
  const importedLut = $derived(ctx.snapshot.state.importedLut);

  const categories = $derived(
    FILTER_CATEGORIES.map((category) => ({
      ...category,
      presets: FILTER_PRESETS.filter(
        (preset) =>
          preset.id !== 'none' &&
          preset.category === category.id &&
          !CINEMA_LOOK_IDS.has(preset.id),
      ),
    })).filter((category) => category.presets.length > 0),
  );

  const nonePreset = $derived(FILTER_PRESETS.find((preset) => preset.id === 'none'));
  const showLookControls = $derived(filterId !== 'none' || importedLut !== null);

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
    importError = null;
    editor.setFilter(id, true);
  };

  const openImport = () => importInput?.click();

  const handleImport = async (file: File | undefined) => {
    importError = null;
    if (!file) return;

    try {
      const parsed = await readCubeFile(file);
      editor.importCubeLut(
        {
          title: parsed.title,
          data: parsed.data,
        },
        true,
      );
    } catch (error) {
      importError = error instanceof Error ? error.message : 'Unable to import .cube LUT.';
    }
  };

  const badgeClass = (category: FilterCategory): string =>
    `preset-thumb-badge preset-thumb-badge--${category}`;
</script>

<div data-panel="filters">
  <CinemaLooksPanel
    {hasImage}
    activeId={filterId}
    {thumbnails}
    onselect={selectFilter}
  />

  <section class="lut-import-panel" aria-label="LUT import">
    <div class="lut-import-head">
      <div>
        <h3 class="lut-import-title">Import LUT</h3>
        <p class="lut-import-sub">Load a .cube file from Resolve, Premiere, or PowerGrade</p>
      </div>
      <button
        type="button"
        class="foot-btn foot-btn-secondary lut-import-btn"
        disabled={!hasImage}
        onclick={openImport}
      >
        Import .cube
      </button>
    </div>

    {#if importedLut}
      <div class="lut-import-active">
        <span class="lut-import-name">{importedLut.title}</span>
        <button
          type="button"
          class="lut-import-clear"
          onclick={() => editor.clearImportedLut(true)}
        >
          Remove
        </button>
      </div>
    {/if}

    {#if importError}
      <p class="lut-import-error" role="alert">{importError}</p>
    {/if}
  </section>

  {#if nonePreset}
    <div class="filter-none-row">
      <button
        type="button"
        class="preset-card preset-card-inline"
        class:is-selected={filterId === 'none' && !importedLut}
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

  <div class="filter-adjust-panel" hidden={!showLookControls}>
    <RangeInput
      value={filterIntensity}
      min={0}
      max={100}
      step={1}
      label={importedLut ? 'LUT intensity' : 'Filter intensity'}
      disabled={!hasImage || !showLookControls}
      defaultValue={DEFAULT_EDIT_STATE.filterIntensity}
      onscrubstart={() => editor.beginInteraction()}
      onscrubend={() => editor.endInteraction()}
      oninput={(value) => editor.setFilterIntensity(value, false)}
      oncommit={(value) => editor.setFilterIntensity(value, false)}
    />

    <QualifierSection />
  </div>
</div>

<input
  type="file"
  accept=".cube,text/plain"
  class="sr-only"
  bind:this={importInput}
  onchange={async (event) => {
    const input = event.currentTarget as HTMLInputElement;
    await handleImport(input.files?.[0]);
    input.value = '';
  }}
/>