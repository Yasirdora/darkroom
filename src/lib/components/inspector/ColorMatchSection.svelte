<script lang="ts">
  import Collapsible from '$lib/components/shared/Collapsible.svelte';
  import RangeInput from '$lib/components/shared/RangeInput.svelte';
  import { DEFAULT_COLOR_MATCH } from '$lib/editor/constants';
  import { getEditorContext } from '$lib/state/context';

  const ctx = getEditorContext();
  const editor = ctx.editor;

  let fileInput = $state<HTMLInputElement | null>(null);

  const hasImage = $derived(ctx.snapshot.hasImage);
  const colorMatch = $derived(ctx.snapshot.state.colorMatch);
  const hasReference = $derived(colorMatch.stats !== null);

  const openFilePicker = () => {
    fileInput?.click();
  };

  const handleFileChange = async (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    await editor.setColorMatchReference(file, true);
  };

  const clearReference = () => {
    editor.clearColorMatch(true);
  };
</script>

<input
  bind:this={fileInput}
  type="file"
  accept="image/*"
  hidden
  aria-hidden="true"
  tabindex={-1}
  onchange={handleFileChange}
/>

<Collapsible title="Color Match">
  {#snippet actions()}
    {#if hasReference}
      <button type="button" class="text-btn" disabled={!hasImage} onclick={clearReference}>
        Clear
      </button>
    {/if}
  {/snippet}

  <button
    type="button"
    class="reset-pill reset-pill-accent"
    disabled={!hasImage}
    onclick={openFilePicker}
  >
    {hasReference ? 'Replace reference' : 'Upload reference'}
  </button>

  {#if hasReference && colorMatch.refThumb}
    <div class="color-match-ref">
      <img class="color-match-thumb" src={colorMatch.refThumb} alt="" />
      <span class="color-match-name">{colorMatch.refName ?? 'Reference image'}</span>
    </div>
  {/if}

  <RangeInput
    value={colorMatch.strength}
    min={0}
    max={100}
    step={1}
    label="Match strength"
    disabled={!hasImage || !hasReference}
    defaultValue={DEFAULT_COLOR_MATCH.strength}
    onscrubstart={() => editor.beginInteraction()}
    onscrubend={() => editor.endInteraction()}
    oninput={(value) => editor.setColorMatchStrength(value, false)}
    oncommit={(value) => editor.setColorMatchStrength(value, true)}
  />
</Collapsible>