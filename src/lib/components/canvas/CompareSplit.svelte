<script lang="ts">
  import type { ImageBuffer } from '$lib/core/image-buffer';
  import { CompareSplitView } from '$lib/ui/compare-split';

  interface Props {
    visible: boolean;
    viewZoom: number;
    edited: ImageBuffer | null;
    original: ImageBuffer | null;
    fitTarget?: HTMLElement | null;
    onFrameSize?: (width: string, height: string) => void;
  }

  let {
    visible,
    viewZoom,
    edited,
    original,
    fitTarget = null,
    onFrameSize,
  }: Props = $props();

  let container = $state<HTMLElement | null>(null);
  let view = $state<CompareSplitView | null>(null);

  $effect(() => {
    if (!container) return;
    const instance = new CompareSplitView(container);
    view = instance;
    return () => {
      instance.clear();
    };
  });

  $effect(() => {
    view?.setFitTarget(fitTarget ?? null);
  });

  const notifyFrameSize = () => {
    const size = view?.getDisplaySize();
    if (size) onFrameSize?.(size.width, size.height);
  };

  $effect(() => {
    if (!view) return;
    view.setVisible(visible);
    void edited;
    void original;
    if (visible && edited && original) {
      view.draw(edited, original);
      notifyFrameSize();
    }
  });

  $effect(() => {
    void viewZoom;
    view?.setViewZoom(viewZoom);
    if (visible) notifyFrameSize();
  });

  $effect(() => {
    if (!visible || !view) return;
    void fitTarget;
    view.refit();
    notifyFrameSize();
  });
</script>

<div class="compare-split" class:is-active={visible} bind:this={container} hidden={!visible}></div>