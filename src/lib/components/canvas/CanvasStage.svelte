<script lang="ts">
  import type { AspectRatioId, CompareMode } from '$lib/core/types';
  import { ASPECT_RATIOS } from '$lib/editor/constants';
  import { fullCropRect } from '$lib/processing/transform';
  import { CanvasRenderer } from '$lib/core/canvas-renderer';
  import { getEditorContext } from '$lib/state/context';
  import HeroLanding from './HeroLanding.svelte';
  import ImageLoader from './ImageLoader.svelte';
  import CropBar from './CropBar.svelte';
  import CompareSplit from './CompareSplit.svelte';
  import CropOverlayHost from './CropOverlayHost.svelte';
  import CanvasFeedback from './CanvasFeedback.svelte';
  import CanvasZoomControl from './CanvasZoomControl.svelte';
  import {
    VIEW_ZOOM_DEFAULT,
    VIEW_ZOOM_STEP,
    clampViewZoom,
  } from '$lib/ui/canvas-view';

  interface Props {
    viewZoom: number;
    compareMode: CompareMode;
    isCropping: boolean;
    isPickingGrey: boolean;
    isDragging: boolean;
    loaderVisible: boolean;
    loaderFading: boolean;
    loaderText: string;
    onOpen: () => void;
    onLoadSample: (id: string) => void;
    onDropFile: (file: File) => void;
    onCanvasClick: (event: MouseEvent) => void;
    onCropToggle: (active: boolean) => void;
    onAspectChange: (aspect: AspectRatioId) => void;
    onRotateCcw: () => void;
    onRotateCw: () => void;
    onFlipH: () => void;
    onFlipV: () => void;
    onResetCrop: () => void;
    onApplyCrop: () => void;
    onViewZoomChange: (zoom: number) => void;
  }

  let {
    viewZoom,
    compareMode,
    isCropping,
    isPickingGrey,
    isDragging = $bindable(false),
    loaderVisible,
    loaderFading,
    loaderText,
    onOpen,
    onLoadSample,
    onDropFile,
    onCanvasClick,
    onCropToggle,
    onAspectChange,
    onRotateCcw,
    onRotateCw,
    onFlipH,
    onFlipV,
    onResetCrop,
    onApplyCrop,
    onViewZoomChange,
  }: Props = $props();

  const ctx = getEditorContext();
  const editor = ctx.editor;

  let canvasEl = $state<HTMLCanvasElement | null>(null);
  let backdropEl = $state<HTMLElement | null>(null);
  let scrollSurfaceEl = $state<HTMLElement | null>(null);
  let frameEl = $state<HTMLElement | null>(null);
  let stageEl = $state<HTMLElement | null>(null);
  let renderer = $state<CanvasRenderer | null>(null);
  let drawFrame = $state<number | null>(null);
  let zoomAnchor = { x: 0.5, y: 0.5 };

  const hasImage = $derived(ctx.snapshot.hasImage);
  const isRendering = $derived(ctx.snapshot.isRendering);
  const transform = $derived(ctx.snapshot.state.transform);
  const aspectLock = $derived(
    ASPECT_RATIOS.find((item) => item.id === transform.aspectRatio)?.ratio ?? null,
  );

  const splitEditedPreview = $derived.by(() => {
    ctx.snapshot;
    return editor.getCanvasPreview(isCropping);
  });

  const splitOriginalPreview = $derived.by(() => {
    ctx.snapshot;
    return editor.getCompareSourcePreview();
  });

  const syncCompareFrameSize = (width: string, height: string) => {
    if (!frameEl) return;
    frameEl.style.width = width;
    frameEl.style.height = height;
    syncScrollSurface();
    requestAnimationFrame(() => {
      applyZoomAnchor();
      captureZoomAnchor();
    });
  };

  $effect(() => {
    if (!canvasEl) return;
    const instance = new CanvasRenderer(canvasEl);
    instance.setViewZoom(viewZoom);
    renderer = instance;
  });

  const scheduleDraw = () => {
    if (drawFrame !== null) return;
    drawFrame = requestAnimationFrame(() => {
      drawFrame = null;
      paint();
    });
  };

  const syncFrameSize = () => {
    if (!frameEl || !canvasEl) return;
    const width = canvasEl.style.width || `${canvasEl.width}px`;
    const height = canvasEl.style.height || `${canvasEl.height}px`;
    frameEl.style.width = width;
    frameEl.style.height = height;
  };

  const captureZoomAnchor = () => {
    if (!backdropEl || !frameEl) return;

    const frameWidth = frameEl.offsetWidth;
    const frameHeight = frameEl.offsetHeight;
    if (frameWidth === 0 || frameHeight === 0) return;

    const viewportWidth = backdropEl.clientWidth;
    const viewportHeight = backdropEl.clientHeight;

    if (frameWidth <= viewportWidth && frameHeight <= viewportHeight) {
      zoomAnchor = { x: 0.5, y: 0.5 };
      return;
    }

    const surfaceWidth = scrollSurfaceEl?.offsetWidth ?? Math.max(viewportWidth, frameWidth);
    const surfaceHeight = scrollSurfaceEl?.offsetHeight ?? Math.max(viewportHeight, frameHeight);

    zoomAnchor = {
      x: (backdropEl.scrollLeft + viewportWidth / 2) / surfaceWidth,
      y: (backdropEl.scrollTop + viewportHeight / 2) / surfaceHeight,
    };
  };

  const syncScrollSurface = () => {
    if (!backdropEl || !scrollSurfaceEl || !frameEl) return;

    if (viewZoom <= VIEW_ZOOM_DEFAULT) {
      scrollSurfaceEl.style.width = '';
      scrollSurfaceEl.style.height = '';
      backdropEl.scrollLeft = 0;
      backdropEl.scrollTop = 0;
      return;
    }

    const viewportWidth = backdropEl.clientWidth;
    const viewportHeight = backdropEl.clientHeight;
    const frameWidth = frameEl.offsetWidth;
    const frameHeight = frameEl.offsetHeight;

    scrollSurfaceEl.style.width = `${Math.max(viewportWidth, frameWidth)}px`;
    scrollSurfaceEl.style.height = `${Math.max(viewportHeight, frameHeight)}px`;
  };

  const applyZoomAnchor = () => {
    if (!backdropEl || !scrollSurfaceEl) return;

    if (viewZoom <= VIEW_ZOOM_DEFAULT) {
      backdropEl.scrollLeft = 0;
      backdropEl.scrollTop = 0;
      zoomAnchor = { x: 0.5, y: 0.5 };
      return;
    }

    const viewportWidth = backdropEl.clientWidth;
    const viewportHeight = backdropEl.clientHeight;
    const surfaceWidth = scrollSurfaceEl.offsetWidth;
    const surfaceHeight = scrollSurfaceEl.offsetHeight;

    backdropEl.scrollLeft = Math.max(
      0,
      zoomAnchor.x * surfaceWidth - viewportWidth / 2,
    );
    backdropEl.scrollTop = Math.max(
      0,
      zoomAnchor.y * surfaceHeight - viewportHeight / 2,
    );
  };

  const syncZoomLayout = (preserveAnchor = true) => {
    if (!preserveAnchor) {
      zoomAnchor = { x: 0.5, y: 0.5 };
    }

    syncFrameSize();
    syncScrollSurface();

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        applyZoomAnchor();
        captureZoomAnchor();
      });
    });
  };

  const drawBuffer = (buffer: ReturnType<typeof editor.getPreviewBuffer>) => {
    if (!buffer || !renderer || !frameEl || !canvasEl) return;
    renderer.draw(buffer);
    syncZoomLayout();
  };

  const paint = () => {
    if (!renderer || !canvasEl) return;

    if (isPickingGrey) {
      const pickPreview = editor.getGreyPickPreview();
      if (pickPreview) {
        canvasEl.hidden = false;
        drawBuffer(pickPreview);
      }
      return;
    }

    if (compareMode === 'split') {
      canvasEl.hidden = true;
      return;
    }

    if (compareMode === 'hold') {
      const source = editor.getCompareSourcePreview();
      if (!source) return;
      canvasEl.hidden = false;
      drawBuffer(source);
      return;
    }

    const edited = editor.getCanvasPreview(isCropping);
    if (!edited) return;
    canvasEl.hidden = false;
    drawBuffer(edited);
  };

  $effect(() => {
    ctx.snapshot;
    compareMode;
    isCropping;
    isPickingGrey;
    scheduleDraw();
  });

  $effect.pre(() => {
    void viewZoom;
    captureZoomAnchor();
  });

  $effect(() => {
    void viewZoom;
    renderer?.setViewZoom(viewZoom);
    syncZoomLayout();
  });

  $effect(() => {
    const backdrop = backdropEl;
    if (!backdrop) return;

    const onScroll = () => captureZoomAnchor();
    backdrop.addEventListener('scroll', onScroll, { passive: true });
    return () => backdrop.removeEventListener('scroll', onScroll);
  });

  $effect(() => {
    if (!stageEl || !backdropEl) return;
    const observer = new ResizeObserver(() => {
      renderer?.setViewZoom(viewZoom);
      syncZoomLayout();
      scheduleDraw();
    });
    observer.observe(backdropEl);
    return () => observer.disconnect();
  });

  const handleWheel = (event: WheelEvent) => {
    if (!hasImage || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    captureZoomAnchor();
    const delta = event.deltaY < 0 ? VIEW_ZOOM_STEP : -VIEW_ZOOM_STEP;
    const next = clampViewZoom(viewZoom + delta);
    if (next !== viewZoom) onViewZoomChange(next);
  };

  const handleDragOver = (event: DragEvent) => {
    event.preventDefault();
    isDragging = true;
  };

  const handleDragLeave = () => {
    isDragging = false;
  };

  const handleDrop = (event: DragEvent) => {
    event.preventDefault();
    isDragging = false;
    const file = event.dataTransfer?.files?.[0];
    if (file) onDropFile(file);
  };
</script>

<div
  class="canvas-stage"
  class:has-image={hasImage}
  class:is-rendering={isRendering}
  class:is-dragging={isDragging}
  class:is-cropping={isCropping}
  class:is-split-compare={compareMode === 'split'}
  class:is-view-zoomed={viewZoom > 100}
  role="region"
  aria-label="Image canvas"
  bind:this={stageEl}
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  ondrop={handleDrop}
>
  <div
    class="canvas-backdrop"
    class:is-view-zoomed={viewZoom > 100}
    bind:this={backdropEl}
    onwheel={handleWheel}
  >
    <div class="canvas-scroll-surface" bind:this={scrollSurfaceEl}>
      <div class="canvas-frame" bind:this={frameEl}>
      <CompareSplit
        visible={compareMode === 'split' && hasImage}
        {viewZoom}
        edited={splitEditedPreview}
        original={splitOriginalPreview}
        fitTarget={backdropEl}
        onFrameSize={syncCompareFrameSize}
      />
      <canvas
        id="editor-canvas"
        bind:this={canvasEl}
        hidden={compareMode === 'split'}
        aria-label="Edited image preview"
        onclick={onCanvasClick}
        style:cursor={isPickingGrey ? 'crosshair' : undefined}
      ></canvas>
      <CropOverlayHost
        visible={isCropping && hasImage}
        crop={transform.crop ?? fullCropRect()}
        aspectRatio={aspectLock}
        frameAspect={editor.getCropFrameAspect()}
        onCropChange={(crop) => editor.setCrop(crop, false)}
      />
      </div>
    </div>
  </div>

  <div class="canvas-placeholder" class:is-hidden={hasImage}>
    <HeroLanding {onOpen} {onLoadSample} />
  </div>

  <div class="canvas-shimmer" hidden={!isRendering} aria-hidden="true"></div>

  <ImageLoader visible={loaderVisible} fading={loaderFading} text={loaderText} />

  <CanvasFeedback />

  {#if hasImage && !isCropping}
    <div class="canvas-zoom-overlay">
      <CanvasZoomControl zoom={viewZoom} onchange={onViewZoomChange} />
    </div>
  {/if}

  <CropBar
    visible={isCropping}
    aspectRatio={transform.aspectRatio}
    disabled={!hasImage}
    onAspectChange={onAspectChange}
    onRotateCCW={onRotateCcw}
    onRotateCW={onRotateCw}
    onFlipH={onFlipH}
    onFlipV={onFlipV}
    onCancel={() => onCropToggle(false)}
    onApply={onApplyCrop}
  />
</div>