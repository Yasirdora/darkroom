<script lang="ts">
  import { onDestroy } from 'svelte';
  import { getEditorContext } from '$lib/state/context';

  const ctx = getEditorContext();

  let message = $state<string | null>(null);
  let visible = $state(false);
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let clearTimer: ReturnType<typeof setTimeout> | null = null;

  const FEEDBACK_DURATION_MS = 3600;
  const FADE_MS = 220;

  const dismiss = () => {
    visible = false;
    if (clearTimer) clearTimeout(clearTimer);
    clearTimer = setTimeout(() => {
      message = null;
      clearTimer = null;
    }, FADE_MS);
  };

  const show = (text: string) => {
    message = text;
    visible = false;
    requestAnimationFrame(() => {
      visible = true;
    });

    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      hideTimer = null;
      dismiss();
    }, FEEDBACK_DURATION_MS);
  };

  $effect(() => {
    const summary = ctx.snapshot.autoToneSummary;
    if (!summary) return;
    show(summary);
    ctx.editor.clearAutoToneSummary();
  });

  onDestroy(() => {
    if (hideTimer) clearTimeout(hideTimer);
    if (clearTimer) clearTimeout(clearTimer);
  });
</script>

{#if message}
  <div
    class="canvas-feedback"
    class:is-active={visible}
    role="status"
    aria-live="polite"
  >
    {message}
  </div>
{/if}