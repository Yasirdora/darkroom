<script lang="ts">
  import Icon from '$lib/components/shared/Icon.svelte';
  import { ASPECT_RATIOS } from '$lib/editor/constants';
  import type { AspectRatioId } from '$lib/core/types';

  interface Props {
    visible: boolean;
    aspectRatio: AspectRatioId;
    disabled?: boolean;
    onAspectChange: (aspect: AspectRatioId) => void;
    onRotateCCW: () => void;
    onRotateCW: () => void;
    onFlipH: () => void;
    onFlipV: () => void;
    onCancel: () => void;
    onApply: () => void;
  }

  let {
    visible,
    aspectRatio,
    disabled = false,
    onAspectChange,
    onRotateCCW,
    onRotateCW,
    onFlipH,
    onFlipV,
    onCancel,
    onApply,
  }: Props = $props();

  const handleAspectChange = (event: Event) => {
    const value = (event.currentTarget as HTMLSelectElement).value as AspectRatioId;
    onAspectChange(value);
  };
</script>

{#if visible}
  <div class="floating-crop-bar" role="toolbar" aria-label="Crop tools">
    <div class="crop-bar-section">
      <span class="crop-bar-label" id="crop-aspect-label">Aspect</span>
      <select
        class="crop-aspect-select"
        value={aspectRatio}
        {disabled}
        aria-labelledby="crop-aspect-label"
        onchange={handleAspectChange}
      >
        {#each ASPECT_RATIOS as ratio (ratio.id)}
          <option value={ratio.id}>{ratio.label}</option>
        {/each}
      </select>
    </div>

    <div class="crop-bar-divider" aria-hidden="true"></div>

    <div class="crop-bar-section" role="group" aria-label="Transform">
      <button
        type="button"
        class="crop-icon-btn"
        title="Rotate left (R)"
        aria-label="Rotate left"
        {disabled}
        onclick={onRotateCCW}
      >
        <Icon name="rotateCCW" />
      </button>
      <button
        type="button"
        class="crop-icon-btn"
        title="Rotate right"
        aria-label="Rotate right"
        {disabled}
        onclick={onRotateCW}
      >
        <Icon name="rotateCW" />
      </button>
      <button
        type="button"
        class="crop-icon-btn"
        title="Flip horizontal"
        aria-label="Flip horizontal"
        {disabled}
        onclick={onFlipH}
      >
        <Icon name="flipH" />
      </button>
      <button
        type="button"
        class="crop-icon-btn"
        title="Flip vertical"
        aria-label="Flip vertical"
        {disabled}
        onclick={onFlipV}
      >
        <Icon name="flipV" />
      </button>
    </div>

    <div class="crop-bar-divider" aria-hidden="true"></div>

    <div class="crop-bar-actions">
      <button
        type="button"
        class="crop-btn-cancel"
        title="Cancel crop"
        aria-label="Cancel crop"
        {disabled}
        onclick={onCancel}
      >
        Cancel
      </button>
      <button
        type="button"
        class="crop-btn-apply"
        title="Apply crop"
        aria-label="Apply crop"
        {disabled}
        onclick={onApply}
      >
        Apply
      </button>
    </div>
  </div>
{/if}