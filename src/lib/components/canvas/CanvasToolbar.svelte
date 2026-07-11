<script lang="ts">
  import type { Snippet } from 'svelte';
  import ToolButton from '$lib/components/shared/ToolButton.svelte';
  import Icon from '$lib/components/shared/Icon.svelte';

  interface Props {
    hasImage: boolean;
    compareActive: boolean;
    splitActive: boolean;
    cropActive: boolean;
    canUndo: boolean;
    canRedo: boolean;
    onCrop: () => void;
    onSplit: () => void;
    onCompareStart: () => void;
    onCompareEnd: () => void;
    onUndo: () => void;
    onRedo: () => void;
    start?: Snippet;
  }

  let {
    hasImage,
    compareActive,
    splitActive,
    cropActive,
    canUndo,
    canRedo,
    onCrop,
    onSplit,
    onCompareStart,
    onCompareEnd,
    onUndo,
    onRedo,
    start,
  }: Props = $props();

  const handleCompareKeyDown = (event: KeyboardEvent) => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      onCompareStart();
    }
  };

  const handleCompareKeyUp = (event: KeyboardEvent) => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      onCompareEnd();
    }
  };

  const handleComparePointerLeave = (event: PointerEvent) => {
    if (event.buttons === 0) onCompareEnd();
  };
</script>

<header class="canvas-toolbar">
  <div class="canvas-toolbar-start">
    {#if start}
      {@render start()}
    {/if}
  </div>

  <div class="canvas-toolbar-end">
    <ToolButton
      icon="crop"
      label="Toggle crop mode"
      title="Crop photo (C)"
      active={cropActive}
      disabled={!hasImage}
      onclick={onCrop}
    />
    <ToolButton
      icon="split"
      label="Toggle split compare"
      title="Split compare (S)"
      active={splitActive}
      disabled={!hasImage}
      onclick={onSplit}
    />

    <!-- Hold-to-compare needs pointer lifecycle, not a single click -->
    <button
      type="button"
      class="tool-btn"
      class:is-active={compareActive}
      disabled={!hasImage}
      title="Hold to compare"
      aria-label="Hold to compare original"
      aria-pressed={compareActive}
      onpointerdown={onCompareStart}
      onpointerup={onCompareEnd}
      onpointerleave={handleComparePointerLeave}
      onpointercancel={onCompareEnd}
      onkeydown={handleCompareKeyDown}
      onkeyup={handleCompareKeyUp}
    >
      <Icon name="compare" />
    </button>

    <ToolButton
      icon="undo"
      label="Undo"
      title="Undo (⌘Z)"
      disabled={!canUndo}
      onclick={onUndo}
    />
    <ToolButton
      icon="redo"
      label="Redo"
      title="Redo (⌘⇧Z)"
      disabled={!canRedo}
      onclick={onRedo}
    />
  </div>
</header>