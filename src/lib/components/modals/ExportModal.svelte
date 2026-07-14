<script lang="ts">
  import RangeInput from '$lib/components/shared/RangeInput.svelte';
  import { DEFAULT_EXPORT_SETTINGS } from '$lib/editor/constants';
  import type { ExportFormat, ExportKind, ExportSettings } from '$lib/core/types';

  interface Props {
    open?: boolean;
    canExportLut?: boolean;
    lutWarnings?: string[];
    shareGradeUrl?: string | null;
    onconfirm?: (settings: ExportSettings) => void;
    oncancel?: () => void;
    oncopyshare?: () => void;
  }

  let {
    open = $bindable(false),
    canExportLut = true,
    lutWarnings = [],
    shareGradeUrl = null,
    onconfirm,
    oncancel,
    oncopyshare,
  }: Props = $props();

  let kind = $state<ExportKind>(DEFAULT_EXPORT_SETTINGS.kind);
  let format = $state<ExportFormat>(DEFAULT_EXPORT_SETTINGS.format);
  let quality = $state(DEFAULT_EXPORT_SETTINGS.quality);
  let scale = $state(DEFAULT_EXPORT_SETTINGS.scale);
  let shareCopied = $state(false);

  let dialogEl = $state<HTMLDivElement | null>(null);
  let formatSelectEl = $state<HTMLSelectElement | null>(null);
  let previousFocus: HTMLElement | null = null;

  const showQuality = $derived(kind === 'image' && format !== 'png');
  const showImageOptions = $derived(kind === 'image');
  const exportLabel = $derived(kind === 'lut' ? 'Download .cube' : 'Export');
  const modalTitle = $derived(kind === 'lut' ? 'Export LUT' : 'Export Image');

  const focusableSelector =
    'button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

  const getFocusableElements = (): HTMLElement[] => {
    if (!dialogEl) return [];
    return Array.from(dialogEl.querySelectorAll<HTMLElement>(focusableSelector)).filter(
      (element) => !element.hidden && element.offsetParent !== null,
    );
  };

  const resetSettings = () => {
    kind = DEFAULT_EXPORT_SETTINGS.kind;
    format = DEFAULT_EXPORT_SETTINGS.format;
    quality = DEFAULT_EXPORT_SETTINGS.quality;
    scale = DEFAULT_EXPORT_SETTINGS.scale;
    shareCopied = false;
  };

  const close = (confirmed: boolean) => {
    if (!open) return;
    open = false;

    if (confirmed) {
      onconfirm?.({ kind, format, quality, scale });
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

  const copyShareLink = async () => {
    if (!shareGradeUrl) return;
    try {
      await navigator.clipboard.writeText(shareGradeUrl);
      shareCopied = true;
      oncopyshare?.();
      window.setTimeout(() => {
        shareCopied = false;
      }, 2200);
    } catch {
      shareCopied = false;
    }
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
      <h2 id="export-title">{modalTitle}</h2>
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
        <span>Export type</span>
        <select
          bind:value={kind}
          aria-label="Export type"
        >
          <option value="image">Image (PNG / JPEG / WebP)</option>
          <option value="lut" disabled={!canExportLut}>3D LUT (.cube)</option>
        </select>
      </label>

      {#if kind === 'lut'}
        <p class="export-note">
          64³ LUT for Resolve, Premiere, and FCP. Assumes Rec.709/sRGB input unless your NLE applies an input transform.
        </p>
        {#if lutWarnings.length > 0}
          <ul class="export-warnings">
            {#each lutWarnings as warning (warning)}
              <li>{warning}</li>
            {/each}
          </ul>
        {/if}
      {:else}
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
      {/if}

      {#if shareGradeUrl}
        <div class="export-share">
          <p class="export-share-label">Share this grade</p>
          <div class="export-share-row">
            <input
              class="export-share-input"
              type="text"
              readonly
              value={shareGradeUrl}
              aria-label="Shareable grade URL"
            />
            <button
              type="button"
              class="foot-btn foot-btn-secondary export-share-copy"
              onclick={copyShareLink}
            >
              {shareCopied ? 'Copied' : 'Copy link'}
            </button>
          </div>
        </div>
      {/if}
    </div>

    <footer class="export-modal-foot">
      <button type="button" class="foot-btn foot-btn-secondary" onclick={() => close(false)}>
        Cancel
      </button>
      <button
        type="button"
        class="foot-btn foot-btn-primary"
        disabled={kind === 'lut' && !canExportLut}
        onclick={() => close(true)}
      >
        {exportLabel}
      </button>
    </footer>
  </div>
</div>

<style>
  .export-note {
    margin: 0;
    font-size: 12px;
    line-height: 1.5;
    color: var(--inspector-muted);
    font-weight: 400;
  }

  .export-warnings {
    margin: 0;
    padding-left: 1.1rem;
    font-size: 11px;
    line-height: 1.45;
    color: #fbbf24;
    font-weight: 400;
  }

  .export-share {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding-top: var(--space-1);
    border-top: 1px solid var(--inspector-border);
  }

  .export-share-label {
    margin: 0;
    font-size: 12px;
    font-weight: 600;
    color: var(--inspector-muted);
  }

  .export-share-row {
    display: flex;
    gap: var(--space-2);
  }

  .export-share-input {
    flex: 1;
    min-width: 0;
    min-height: 38px;
    padding: 0 var(--space-3);
    border-radius: var(--radius-sm);
    border: 1px solid var(--inspector-border);
    background: rgba(255, 255, 255, 0.04);
    color: var(--inspector-text);
    font-size: 11px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  .export-share-copy {
    min-width: 88px;
    flex-shrink: 0;
  }
</style>