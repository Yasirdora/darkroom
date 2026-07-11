<script lang="ts">
  interface Props {
    open?: boolean;
    title: string;
    body: string;
    onclose?: () => void;
  }

  let { open = $bindable(false), title, body, onclose }: Props = $props();

  let dialogEl = $state<HTMLDivElement | null>(null);
  let closeButtonEl = $state<HTMLButtonElement | null>(null);
  let previousFocus: HTMLElement | null = null;

  const close = () => {
    if (!open) return;
    open = false;
    onclose?.();
    previousFocus?.focus();
    previousFocus = null;
  };

  const handleOverlayClick = (event: MouseEvent) => {
    if (event.target === event.currentTarget) close();
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (!open || event.key !== 'Escape') return;
    event.preventDefault();
    close();
  };

  $effect(() => {
    if (!open) return;

    previousFocus = document.activeElement as HTMLElement | null;

    const focusTimer = window.requestAnimationFrame(() => {
      closeButtonEl?.focus();
    });

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.cancelAnimationFrame(focusTimer);
      window.removeEventListener('keydown', handleKeyDown);
    };
  });
</script>

{#if open}
  <div
    class="app-dialog-overlay"
    role="presentation"
    onclick={handleOverlayClick}
  >
    <div
      bind:this={dialogEl}
      class="app-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="app-dialog-title"
      tabindex="-1"
    >
      <h2 id="app-dialog-title" class="app-dialog-title">{title}</h2>
      <div class="app-dialog-body">
        {@html body}
      </div>
      <div class="app-dialog-actions">
        <button
          bind:this={closeButtonEl}
          type="button"
          class="app-dialog-btn"
          onclick={close}
        >
          OK
        </button>
      </div>
    </div>
  </div>
{/if}