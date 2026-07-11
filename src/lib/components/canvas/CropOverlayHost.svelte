<script lang="ts">
  import type { CropRect } from '$lib/core/types';
  import { CropOverlay } from '$lib/ui/crop-overlay';

  interface Props {
    visible: boolean;
    crop: CropRect;
    aspectRatio: number | null;
    frameAspect: number;
    onCropChange: (crop: CropRect) => void;
  }

  let { visible, crop, aspectRatio, frameAspect, onCropChange }: Props = $props();

  let container = $state<HTMLElement | null>(null);
  let overlay = $state<CropOverlay | null>(null);

  $effect(() => {
    if (!container) return;
    const instance = new CropOverlay(container);
    instance.setCommitHandler(onCropChange);
    overlay = instance;
    return () => {
      instance.setVisible(false);
    };
  });

  $effect(() => {
    overlay?.setVisible(visible);
  });

  $effect(() => {
    if (!overlay || !visible) return;
    overlay.setAspectLock(aspectRatio, frameAspect);
    if (!overlay.isDragging()) {
      overlay.setCrop(crop);
    }
  });
</script>

<div class="crop-overlay-root" bind:this={container} hidden={!visible}></div>