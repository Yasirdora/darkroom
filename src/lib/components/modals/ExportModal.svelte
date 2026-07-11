<script lang="ts">
  import RangeInput from '$lib/components/shared/RangeInput.svelte';
  import { DEFAULT_EXPORT_SETTINGS } from '$lib/editor/constants';
  import type { ExportFormat, ExportSettings } from '$lib/core/types';

  interface Props {
    open?: boolean;
    onconfirm?: (settings: ExportSettings) => void;
    oncancel?: () => void;
  }

  let { open = $bindable(false), onconfirm, oncancel }: Props = $props();

  let format = $state<ExportFormat>(DEFAULT_EXPORT_SETTINGS.format);
  let quality = $state(DEFAULT_EXPORT_SETTINGS.quality);
  let scale = $state(DEFAULT_EXPORT_SETTINGS.scale);

  let dialogEl = $state<HTMLDivElement | null>(null);
  let formatSelectEl = $state<HTMLSelectElement | null>(null);
  let previousFocus: HTMLElement | null = null;

  const showQuality = $derived(format !== 'png');

  const focusableSelector =
    'button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

  const getFocusableElements = (): HTMLElement[] => {
    if (!dialogEl) return [];
    return Array.from(dialogEl.querySelectorAll<HTMLElement>(focusableSelector)).filter(
      (element) => !element.hidden && element.offsetParent !== null,
    );
  };

  const resetSettings = () => {
    format = DEFAULT_EXPORT_SETTINGS.format;
    quality = DEFAULT_EXPORT_SETTINGS.quality;
    scale = DEFAULT_EXPORT_SETTINGS.scale;
  };

  const close = (confirmed: boolean) => {
    if (!open) return;
    open = false;

    if (confirmed) {
      onconfirm?.({ format, quality, scale });
    } else {
      oncancel?.();
    }

    previousFocus?.focus();
    previousFocus = null;
  };

  const handleOverlayClick = (event: MouseEvent) => {
    if (event.target === event.currentTarget) close(false);
  };

  const handleDialogKeyDown = (event: KeyboardEvent) => {
    if (!open || event.key !== 'Tab') return;
    const focusable = getFocusableElements();
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const handleWindowKeyDown = (event: KeyboardEvent) => {
    if (!open || event.key !== 'Escape') return;
    event.preventDefault();
    close(false);
  };

  $effect(() => {
    if (!open) return;

    resetSettings();
    previousFocus = document.activeElement as HTMLElement | null;

    const focusTimer = window.requestAnimationFrame(() => {
      formatSelectEl?.focus();
    });

    window.addEventListener('keydown', handleWindowKeyDown);

    return () => {
      window.cancelAnimationFrame(focusTimer);
      window.removeEventListener('keydown', handleWindowKeyDown);
    };
  });
</script>

<div
  class="export-modal-overlay"
  class:is-open={open}
  role="presentation"
  onclick={handleOverlayClick}
>
  <div
    bind:this={dialogEl}
    class="export-modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby="export-title"
    tabindex="-1"
    onkeydown={handleDialogKeyDown}
  >
    <header class="export-modal-head">
      <h2 id="export-title">Export Image</h2>
      <button
        type="button"
        class="export-modal-close"
        aria-label="Close export dialog"
        onclick={() => close(false)}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </header>

    <div class="export-modal-body">
      <label class="export-field">
        <span>Format</span>
        <select bind:this={formatSelectEl} bind:value={format} aria-label="Export format">
          <option value="png">PNG — lossless</option>
          <option value="jpeg">JPEG — smaller file</option>
          <option value="webp">WebP — modern</option>
        </select>
      </label>

      {#if showQuality}
        <RangeInput
          value={quality}
          min={60}
          max={100}
          step={1}
          label="Quality"
          defaultValue={DEFAULT_EXPORT_SETTINGS.quality}
          oninput={(value) => {
            quality = value;
          }}
          oncommit={(value) => {
            quality = value;
          }}
        />
      {/if}

      <label class="export-field">
        <span>Scale</span>
        <select
          value={String(scale)}
          aria-label="Export scale"
          onchange={(event) => {
            scale = Number((event.currentTarget as HTMLSelectElement).value);
          }}
        >
          <option value="1">100% — full resolution</option>
          <option value="0.75">75%</option>
          <option value="0.5">50%</option>
          <option value="0.25">25%</option>
        </select>
      </label>
    </div>

    <footer class="export-modal-foot">
      <button type="button" class="foot-btn foot-btn-secondary" onclick={() => close(false)}>
        Cancel
      </button>
      <button type="button" class="foot-btn foot-btn-primary" onclick={() => close(true)}>
        Export
      </button>
    </footer>
  </div>
</div>