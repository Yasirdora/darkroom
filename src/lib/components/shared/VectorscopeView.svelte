<script lang="ts">
  import type { VectorscopeData } from '$lib/core/types';
  import { VectorscopeView } from '$lib/ui/vectorscope-view';

  interface Props {
    data: VectorscopeData | null;
  }

  let { data }: Props = $props();

  let wrapEl = $state<HTMLDivElement | null>(null);
  let canvasEl = $state<HTMLCanvasElement | null>(null);
  let view: VectorscopeView | null = null;
  let lastPeak = 0;

  const syncCanvasSize = () => {
    if (!wrapEl || !canvasEl) return;
    const width = Math.max(1, Math.round(wrapEl.clientWidth));
    const height = Math.max(1, Math.round(wrapEl.clientHeight || 88));
    if (canvasEl.width !== width || canvasEl.height !== height) {
      canvasEl.width = width;
      canvasEl.height = height;
    }
  };

  $effect(() => {
    if (!canvasEl) return;

    view = new VectorscopeView(canvasEl);
    syncCanvasSize();

    const observer = new ResizeObserver(() => {
      syncCanvasSize();
      view?.draw(data);
    });

    if (wrapEl) observer.observe(wrapEl);

    return () => {
      observer.disconnect();
      view = null;
    };
  });

  $effect(() => {
    if (!view) return;

    const peak = data?.peak ?? 0;
    if (peak > 0 && (lastPeak === 0 || peak > lastPeak * 3 || lastPeak > peak * 3)) {
      view.reset();
    }
    lastPeak = peak;

    syncCanvasSize();
    view.draw(data);
  });
</script>

<div class="vectorscope-canvas-wrap" bind:this={wrapEl}>
  <canvas bind:this={canvasEl} class="vectorscope-canvas" aria-hidden="true"></canvas>
</div>