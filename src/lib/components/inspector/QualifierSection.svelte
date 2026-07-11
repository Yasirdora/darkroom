<script lang="ts">
  import RangeInput from '$lib/components/shared/RangeInput.svelte';
  import type { QualifierConfig } from '$lib/core/types';
  import { DEFAULT_QUALIFIER } from '$lib/editor/constants';
  import { QUALIFIER_ENABLE_HUE_DEFAULTS } from '$lib/processing/qualifiers';
  import { getEditorContext } from '$lib/state/context';

  const ctx = getEditorContext();
  const editor = ctx.editor;

  const hasImage = $derived(ctx.snapshot.hasImage);
  const filterId = $derived(ctx.snapshot.state.filterId);
  const qualifier = $derived(ctx.snapshot.state.qualifier);
  const filterActive = $derived(filterId !== 'none');

  const hueMin = $derived(qualifier.hueMin ?? DEFAULT_QUALIFIER.hueMin!);
  const hueMax = $derived(qualifier.hueMax ?? DEFAULT_QUALIFIER.hueMax!);

  const updateQualifier = (partial: Partial<QualifierConfig>, recordHistory: boolean) => {
    editor.setQualifier({ ...ctx.snapshot.state.qualifier, ...partial }, recordHistory);
  };
</script>

<div class="qualifier-section">
  <label class="qualifier-toggle">
    <input
      type="checkbox"
      class="qualifier-toggle-input"
      checked={qualifier.enabled}
      disabled={!hasImage || !filterActive}
      onchange={(event) =>
        editor.setQualifierEnabled((event.currentTarget as HTMLInputElement).checked, true)}
    />
    <span class="qualifier-toggle-track" aria-hidden="true"></span>
    <span class="qualifier-toggle-label">Hue qualifier</span>
  </label>

  {#if qualifier.enabled}
    <div class="qual-row">
      <RangeInput
        value={hueMin}
        min={0}
        max={360}
        step={1}
        variant="hue"
        label="Hue min"
        disabled={!hasImage || !filterActive}
        defaultValue={QUALIFIER_ENABLE_HUE_DEFAULTS.hueMin}
        onscrubstart={() => editor.beginInteraction()}
        onscrubend={() => editor.endInteraction()}
        oninput={(value) => updateQualifier({ hueMin: value }, false)}
        oncommit={(value) => updateQualifier({ hueMin: value }, true)}
      />
      <RangeInput
        value={hueMax}
        min={0}
        max={360}
        step={1}
        variant="hue"
        label="Hue max"
        disabled={!hasImage || !filterActive}
        defaultValue={QUALIFIER_ENABLE_HUE_DEFAULTS.hueMax}
        onscrubstart={() => editor.beginInteraction()}
        onscrubend={() => editor.endInteraction()}
        oninput={(value) => updateQualifier({ hueMax: value }, false)}
        oncommit={(value) => updateQualifier({ hueMax: value }, true)}
      />
    </div>
  {/if}
</div>