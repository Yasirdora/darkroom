<script lang="ts">
  import type { HistogramData } from '$lib/core/types';
  import { HistogramView } from '$lib/ui/histogram-view';

  interface Props {
    data: HistogramData | null;
  }

  let { data }: Props = $props();

  let wrapEl = $state<HTMLDivElement | null>(null);
  let canvasEl = $state<HTMLCanvasElement | null>(null);
  let view: HistogramView | null = null;
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

    view = new HistogramView(canvasEl);
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

<div class="histogram-canvas-wrap" bind:this={wrapEl}>
  <canvas bind:this={canvasEl} class="histogram-canvas" aria-hidden="true"></canvas>
</div>