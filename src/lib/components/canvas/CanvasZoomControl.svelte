<script lang="ts">
  import { on } from 'svelte/events';
  import Icon from '$lib/components/shared/Icon.svelte';
  import {
    VIEW_ZOOM_DEFAULT,
    VIEW_ZOOM_MAX,
    VIEW_ZOOM_MIN,
    VIEW_ZOOM_STEP,
    clampViewZoom,
  } from '$lib/ui/canvas-view';

  interface Props {
    zoom: number;
    disabled?: boolean;
    onchange: (zoom: number) => void;
  }

  const PRESETS = [25, 50, 75, 100, 125, 150, 200].filter(
    (value) => value >= VIEW_ZOOM_MIN && value <= VIEW_ZOOM_MAX,
  );

  let { zoom, disabled = false, onchange }: Props = $props();

  let anchorEl = $state<HTMLDivElement | null>(null);
  let triggerEl = $state<HTMLButtonElement | null>(null);
  let menuEl = $state<HTMLDivElement | null>(null);
  let isOpen = $state(false);

  const isDefault = $derived(zoom === VIEW_ZOOM_DEFAULT);

  const step = (delta: number) => {
    onchange(clampViewZoom(zoom + delta));
  };

  const selectPreset = (value: number) => {
    onchange(clampViewZoom(value));
    close();
  };

  const open = () => {
    if (disabled) return;
    isOpen = true;
    requestAnimationFrame(() => {
      menuEl?.querySelector<HTMLButtonElement>('.zoom-bar-item')?.focus();
    });
  };

  const close = () => {
    isOpen = false;
  };

  const toggleMenu = (event: MouseEvent) => {
    event.stopPropagation();
    if (disabled) return;
    if (isOpen) close();
    else open();
  };

  const handleDocumentPointerDown = (event: PointerEvent) => {
    if (!isOpen || !anchorEl) return;
    const target = event.target as Node;
    if (!anchorEl.contains(target)) close();
  };

  const handleDocumentKeyDown = (event: KeyboardEvent) => {
    if (!isOpen || event.key !== 'Escape') return;
    event.preventDefault();
    close();
    triggerEl?.focus();
  };

  $effect(() => {
    if (!isOpen) return;

    const cleanups = [
      on(document, 'pointerdown', handleDocumentPointerDown),
      on(document, 'keydown', handleDocumentKeyDown),
    ];

    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  });

  const presetLabel = (value: number) =>
    value === VIEW_ZOOM_DEFAULT ? 'Fit' : `${value}%`;
</script>

<div
  class="zoom-bar"
  class:is-open={isOpen}
  class:is-disabled={disabled}
  bind:this={anchorEl}
>
  <button
    type="button"
    class="zoom-bar-btn"
    disabled={disabled || zoom <= VIEW_ZOOM_MIN}
    aria-label="Zoom out"
    title="Zoom out (−)"
    onclick={() => step(-VIEW_ZOOM_STEP)}
  >
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  </button>

  <button
    bind:this={triggerEl}
    type="button"
    class="zoom-bar-trigger"
    class:is-default={isDefault}
    disabled={disabled}
    aria-haspopup="menu"
    aria-expanded={isOpen}
    aria-label="Canvas zoom level"
    title="Choose zoom level · double-click for Fit"
    onclick={toggleMenu}
    ondblclick={(event) => {
      event.preventDefault();
      event.stopPropagation();
      if (disabled) return;
      onchange(VIEW_ZOOM_DEFAULT);
      close();
    }}
  >
    <span class="zoom-bar-value">{zoom}%</span>
    <Icon name="chevronDown" />
  </button>

  <button
    type="button"
    class="zoom-bar-btn"
    disabled={disabled || zoom >= VIEW_ZOOM_MAX}
    aria-label="Zoom in"
    title="Zoom in (+)"
    onclick={() => step(VIEW_ZOOM_STEP)}
  >
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  </button>

  <div
    bind:this={menuEl}
    class="zoom-bar-menu"
    role="menu"
    hidden={!isOpen}
    aria-hidden={!isOpen}
  >
    {#each PRESETS as preset (preset)}
      <button
        type="button"
        class="zoom-bar-item"
        class:is-active={zoom === preset}
        role="menuitemradio"
        aria-checked={zoom === preset}
        onclick={() => selectPreset(preset)}
      >
        {presetLabel(preset)}
        {#if preset === VIEW_ZOOM_DEFAULT}
          <span class="zoom-bar-item-hint">100%</span>
        {/if}
      </button>
    {/each}
  </div>
</div>