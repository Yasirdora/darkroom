<script lang="ts">
  import AdjustmentSection from './AdjustmentSection.svelte';
  import ColorMatchSection from './ColorMatchSection.svelte';
  import CurveEditorPanel from './CurveEditorPanel.svelte';
  import InputProfileSection from './InputProfileSection.svelte';
  import Collapsible from '$lib/components/shared/Collapsible.svelte';
  import { ADJUSTMENT_GROUPS } from '$lib/editor/constants';
  interface Props {
    onGreyPick?: () => void;
    greyPickActive?: boolean;
  }

  let { onGreyPick, greyPickActive = false }: Props = $props();

</script>

<div data-panel="adjust">
  <InputProfileSection {onGreyPick} {greyPickActive} />

  {#each ADJUSTMENT_GROUPS as group (group.title)}
    <AdjustmentSection {group} />
  {/each}

  <Collapsible title="Curves">
    <CurveEditorPanel />
  </Collapsible>

  <ColorMatchSection />
</div>