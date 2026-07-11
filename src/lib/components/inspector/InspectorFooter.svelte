<script lang="ts">
  import Icon from '$lib/components/shared/Icon.svelte';

  interface Props {
    toastMessage?: string | null;
    toastError?: boolean;
    hasImage?: boolean;
    onOpen: () => void;
    onExport: () => void;
  }

  let {
    toastMessage = null,
    toastError = false,
    hasImage = false,
    onOpen,
    onExport,
  }: Props = $props();
</script>

<footer class="inspector-foot">
  {#if toastMessage}
    <div class="app-toast" class:is-error={toastError} role="status">
      {toastMessage}
    </div>
  {/if}

  <div class="foot-actions">
    <button type="button" class="foot-btn foot-btn-secondary" onclick={onOpen}>
      <Icon name="open" />
      Open
    </button>
    <button
      type="button"
      class="foot-btn foot-btn-primary"
      disabled={!hasImage}
      onclick={onExport}
    >
      <Icon name="export" />
      Export
    </button>
  </div>
</footer>