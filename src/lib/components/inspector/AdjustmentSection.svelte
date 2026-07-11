<script lang="ts">
  import Collapsible from '$lib/components/shared/Collapsible.svelte';
  import RangeInput from '$lib/components/shared/RangeInput.svelte';
  import type { Adjustments } from '$lib/core/types';
  import {
    ADJUSTMENT_CONTROLS,
    ADJUSTMENT_RANGES,
    DEFAULT_ADJUSTMENTS,
  } from '$lib/editor/constants';
  import { getEditorContext } from '$lib/state/context';

  interface Props {
    group: {
      title: string;
      keys: Array<keyof Adjustments>;
    };
  }

  let { group }: Props = $props();

  const ctx = getEditorContext();
  const editor = ctx.editor;

  let sliderEpoch = $state(0);

  const hasImage = $derived(ctx.snapshot.hasImage);
  const adjustments = $derived(ctx.snapshot.state.adjustments);

  const controls = $derived(
    group.keys
      .map((key) => ADJUSTMENT_CONTROLS.find((item) => item.key === key))
      .filter((item): item is (typeof ADJUSTMENT_CONTROLS)[number] => item !== undefined),
  );

  const hasNonDefault = $derived(
    group.keys.some((key) => adjustments[key] !== DEFAULT_ADJUSTMENTS[key]),
  );

  const showAutoTone = $derived(group.title === 'Light');
  const showAutoWb = $derived(group.title === 'Color');

  const resetGroup = () => {
    editor.endInteraction();
    const partial = Object.fromEntries(
      group.keys.map((key) => [key, DEFAULT_ADJUSTMENTS[key]]),
    ) as Partial<Adjustments>;
    editor.setAdjustments(partial, true);
    sliderEpoch += 1;
  };

  const runAutoTone = async () => {
    await editor.autoEnhance(true);
  };

  const runAutoWb = () => {
    editor.autoWhiteBalance(true);
  };
</script>

<Collapsible title={group.title} collapsed={group.title === 'Detail'}>
  {#snippet actions()}
    {#if showAutoTone}
      <button
        type="button"
        class="reset-pill reset-pill-accent u-mr-6"
        disabled={!hasImage}
        title="Smart Auto Tone: analyzes exposure, contrast, color balance, and scene content to set a balanced starting grade."
        onclick={runAutoTone}
      >
        Auto Tone
      </button>
    {/if}
    {#if showAutoWb}
      <button
        type="button"
        class="reset-pill reset-pill-accent"
        disabled={!hasImage}
        title="Auto White Balance: finds near-neutral areas and sets Temperature and Tint."
        onclick={runAutoWb}
      >
        Auto WB
      </button>
    {/if}
    <button
      type="button"
      class="reset-pill"
      disabled={!hasImage || !hasNonDefault}
      onclick={resetGroup}
    >
      Reset
    </button>
  {/snippet}

  {#each controls as control (`${control.key}-${sliderEpoch}`)}
    {@const range = ADJUSTMENT_RANGES[control.key]}
    <RangeInput
      value={adjustments[control.key]}
      min={range.min}
      max={range.max}
      step={range.step}
      label={control.label}
      variant={control.variant}
      disabled={!hasImage}
      defaultValue={DEFAULT_ADJUSTMENTS[control.key]}
      onscrubstart={() => {
        editor.beginInteraction();
        editor.setLiveEditing(true);
      }}
      onscrubend={() => {
        editor.setLiveEditing(false);
        editor.endInteraction();
      }}
      oninput={(value) => editor.setAdjustments({ [control.key]: value }, false)}
      oncommit={(value) => editor.setAdjustments({ [control.key]: value }, false)}
      onreset={(value) => editor.resetAdjustment(control.key, true)}
    />
  {/each}
</Collapsible>