<script lang="ts">
  import Collapsible from '$lib/components/shared/Collapsible.svelte';
  import RangeInput from '$lib/components/shared/RangeInput.svelte';
  import type { InputProfileId } from '$lib/core/types';
  import { DEFAULT_INPUT_EXPOSURE } from '$lib/editor/constants';
  import { getEditorContext } from '$lib/state/context';
  import {
    INPUT_PROFILE_GROUPS,
    INPUT_PROFILES,
    getInputProfileSpec,
    getProfileTypicalEI,
  } from '$lib/processing/input-profile';

  interface Props {
    onGreyPick?: () => void;
    greyPickActive?: boolean;
  }

  let { onGreyPick, greyPickActive = false }: Props = $props();

  const ctx = getEditorContext();
  const editor = ctx.editor;

  const profile = $derived(ctx.snapshot.state.inputProfile);
  const inputExposure = $derived(ctx.snapshot.state.inputExposure);
  const inputLinearMode = $derived(ctx.snapshot.state.inputLinearMode);
  const hasImage = $derived(ctx.snapshot.hasImage);
  const autoDetected = $derived(ctx.snapshot.inputProfileAutoDetected);

  const spec = $derived(getInputProfileSpec(profile));
  const typicalEI = $derived(getProfileTypicalEI(profile));

  const pipelineLabel = $derived.by(() => {
    if (inputLinearMode) return 'Encoded → Scene Linear → Linear Output';
    if (spec.group === 'log') return 'Log → Scene Linear → sRGB → Grade';
    if (spec.group === 'flat') return 'Flat → Scene Linear → Display → Grade';
    if (spec.group === 'wide') return 'Wide Gamut → sRGB → Grade';
    return 'Display Encoded → Grade';
  });

  const exposureDisplay = $derived(
    inputExposure > 0 ? `+${inputExposure.toFixed(2)}` : inputExposure.toFixed(2),
  );

  const profilesByGroup = $derived(
    INPUT_PROFILE_GROUPS.map((group) => ({
      ...group,
      profiles: INPUT_PROFILES.filter((item) => item.group === group.id),
    })).filter((group) => group.profiles.length > 0),
  );

  const handleProfileChange = (event: Event) => {
    const value = (event.currentTarget as HTMLSelectElement).value as InputProfileId;
    editor.setInputProfile(value, true);
  };

  const handleLinearModeChange = (event: Event) => {
    editor.setInputLinearMode((event.currentTarget as HTMLInputElement).checked, true);
  };
</script>

<Collapsible title="Input Profile" collapsed={true} groupClass="input-profile-card">
  {#snippet actions()}
    {#if autoDetected}
      <span class="input-profile-badge">Auto</span>
    {/if}
  {/snippet}

  <label class="input-profile-field">
    <span class="sr-only">Input profile</span>
    <select value={profile} disabled={!hasImage} onchange={handleProfileChange}>
      {#each profilesByGroup as group (group.id)}
        <optgroup label={group.label}>
          {#each group.profiles as item (item.id)}
            <option value={item.id}>{item.label}</option>
          {/each}
        </optgroup>
      {/each}
    </select>
  </label>

  <p class="input-profile-desc">
    {spec.description}
    {#if typicalEI}
      <span> · {typicalEI}</span>
    {/if}
  </p>

  <p class="pipeline-flow" aria-label="Processing pipeline">
    <span>{pipelineLabel}</span>
  </p>

  <div class="input-exposure-head">
    <span class="control-label">Input Exposure</span>
    <span class="control-value">{exposureDisplay} st</span>
  </div>

  <RangeInput
    value={inputExposure}
    min={-3}
    max={3}
    step={0.05}
    label="Input Exposure"
    variant="default"
    disabled={!hasImage}
    defaultValue={DEFAULT_INPUT_EXPOSURE}
    onscrubstart={() => editor.beginInteraction()}
    onscrubend={() => editor.endInteraction()}
    oninput={(value) => editor.setInputExposure(value, false)}
    oncommit={(value) => editor.setInputExposure(value, true)}
  />

  {#if onGreyPick}
    <button
      type="button"
      class="reset-pill reset-pill-accent"
      class:is-active={greyPickActive}
      disabled={!hasImage}
      onclick={onGreyPick}
    >
      {greyPickActive ? 'Click image to pick 18% grey…' : 'Pick 18% grey'}
    </button>
  {/if}

  <label class="linear-mode">
    <input
      type="checkbox"
      checked={inputLinearMode}
      disabled={!hasImage}
      onchange={handleLinearModeChange}
    />
    <span>Scene-linear output (bypass display rolloff)</span>
  </label>
</Collapsible>