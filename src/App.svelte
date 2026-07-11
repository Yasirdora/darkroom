<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { AspectRatioId, CompareMode, TabId } from '$lib/core/types';
  import { CanvasRenderer } from '$lib/core/canvas-renderer';
  import { fullCropRect } from '$lib/processing/transform';
  import { getInputProfileSpec } from '$lib/processing/input-profile';
  import { PhotoEditor } from '$lib/editor/photo-editor';
  import { createEditorState } from '$lib/state/editor.svelte';
  import { setEditorContext } from '$lib/state/context';
  import { ABOUT_HTML, CONTACT_HTML, HELP_HTML, SHORTCUTS_HTML } from '$lib/constants/dialogs';
  import CanvasToolbar from '$lib/components/canvas/CanvasToolbar.svelte';
  import CanvasStage from '$lib/components/canvas/CanvasStage.svelte';
  import InspectorPane from '$lib/components/layout/InspectorPane.svelte';
  import AppMenu from '$lib/components/modals/AppMenu.svelte';
  import AppDialog from '$lib/components/modals/AppDialog.svelte';
  import ExportModal from '$lib/components/modals/ExportModal.svelte';
  import {
    VIEW_ZOOM_DEFAULT,
    VIEW_ZOOM_STEP,
    clampViewZoom,
  } from '$lib/ui/canvas-view';

  const editorState = createEditorState();
  setEditorContext(editorState);
  const editor = editorState.editor;

  let activeTab = $state<TabId>('adjust');
  let viewZoom = $state(VIEW_ZOOM_DEFAULT);
  let compareMode = $state<CompareMode>('off');
  let holdCompareActive = $state(false);
  let isCropping = $state(false);
  let isPickingGrey = $state(false);
  let isDragging = $state(false);
  let uploadInput = $state<HTMLInputElement | null>(null);
  let uploadGeneration = $state(0);
  let tabScrollPositions = $state(new Map<TabId, number>());

  let loaderVisible = $state(false);
  let loaderFading = $state(false);
  let loaderText = $state('Processing');

  let toastMessage = $state<string | null>(null);
  let toastError = $state(false);
  let toastTimer = $state<ReturnType<typeof setTimeout> | null>(null);

  let exportOpen = $state(false);
  let dialogOpen = $state(false);
  let dialogTitle = $state('');
  let dialogBody = $state('');

  const hasImage = $derived(editorState.snapshot.hasImage);
  const isScrubbing = $derived(editorState.snapshot.isLiveEditing);
  const canUndo = $derived(editorState.snapshot.canUndo);
  const canRedo = $derived(editorState.snapshot.canRedo);

  onDestroy(() => {
    if (toastTimer) clearTimeout(toastTimer);
    editorState.destroy();
  });

  if (import.meta.hot) {
    import.meta.hot.dispose(() => editorState.destroy());
  }

  PhotoEditor.prewarm();

  const hideLoader = () => {
    loaderVisible = false;
    loaderFading = false;
  };

  const showToast = (message: string, isError = false) => {
    toastMessage = message;
    toastError = isError;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastMessage = null;
      toastTimer = null;
    }, 4200);
  };

  const openPicker = () => uploadInput?.click();

  const handleUpload = async (file: File) => {
    void ++uploadGeneration;
    isPickingGrey = false;
    loaderVisible = true;
    loaderFading = false;
    loaderText = 'Opening…';

    try {
      await editor.loadFile(file);
      viewZoom = VIEW_ZOOM_DEFAULT;
      hideLoader();

      const snap = editor.getSnapshot();
      if (snap.inputProfileAutoDetected) {
        const spec = getInputProfileSpec(snap.state.inputProfile);
        showToast(`Input profile auto-detected: ${spec.label}`);
      }
    } catch (error) {
      hideLoader();
      const message = error instanceof Error ? error.message : 'Unable to open image.';
      showToast(message, true);
    }
  };

  const loadSample = async (name: string) => {
    loaderVisible = true;
    loaderFading = false;
    loaderText = 'Downloading sample…';
    try {
      const response = await fetch(`images/samples/${name}.jpg`);
      if (!response.ok) throw new Error(`Failed to fetch sample: ${response.statusText}`);
      const blob = await response.blob();
      const file = new File([blob], `${name.replace('_', ' ')}.jpg`, { type: 'image/jpeg' });
      await handleUpload(file);
    } catch (error) {
      hideLoader();
      const message = error instanceof Error ? error.message : 'Unable to load sample.';
      showToast(message, true);
    }
  };

  const startHoldCompare = () => {
    if (!hasImage || compareMode === 'split') return;
    compareMode = 'hold';
    holdCompareActive = true;
  };

  const endHoldCompare = () => {
    if (compareMode !== 'hold') return;
    compareMode = 'off';
    holdCompareActive = false;
  };

  const toggleSplitCompare = () => {
    if (!hasImage) return;
    if (holdCompareActive) holdCompareActive = false;
    if (compareMode === 'hold') compareMode = 'off';
    compareMode = compareMode === 'split' ? 'off' : 'split';
  };

  const toggleCropMode = (active: boolean) => {
    if (active && !hasImage) return;
    isPickingGrey = false;
    isCropping = active;
    if (active) {
      const { transform } = editor.getSnapshot().state;
      if (!transform.crop) editor.setCrop(fullCropRect(), false);
    }
  };

  const setActiveTab = (tab: TabId) => {
    isPickingGrey = false;
    if (isCropping) toggleCropMode(false);
    if (activeTab !== tab) {
      const next = new Map(tabScrollPositions);
      next.set(activeTab, 0);
      tabScrollPositions = next;
    }
    activeTab = tab;
  };

  const startGreyPick = () => {
    isPickingGrey = true;
    showToast('Click a neutral grey area on the image (input profile view, no adjustments)');
  };

  const onCanvasClick = (event: MouseEvent) => {
    if (!isPickingGrey) return;
    const canvas = event.currentTarget as HTMLCanvasElement;
    if (!editor.getGreyPickPreview()) {
      isPickingGrey = false;
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const cx = (event.clientX - rect.left) / rect.width;
    const cy = (event.clientY - rect.top) / rect.height;
    editor.pickInputExposureFromNormalized(cx, cy);
    isPickingGrey = false;
    showToast('Input exposure set from grey pick');
  };

  const openExport = async () => {
    isPickingGrey = false;
    exportOpen = true;
  };

  const handleExportConfirm = async (settings: import('$lib/core/types').ExportSettings) => {
    const ready = await editor.ensureFullResolution();
    if (!ready) {
      showToast('Full-resolution render did not finish. Try again.', true);
      return;
    }

    const buffer = editor.getExportBuffer(settings);
    if (!buffer) {
      showToast('Image is not ready to export yet.', true);
      return;
    }

    const mime =
      settings.format === 'png'
        ? 'image/png'
        : settings.format === 'jpeg'
          ? 'image/jpeg'
          : 'image/webp';

    const exportCanvas = document.createElement('canvas');
    const exportRenderer = new CanvasRenderer(exportCanvas);
    exportRenderer.draw(buffer);

    try {
      const blob = await exportRenderer.exportBlob(mime, settings.quality / 100);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `coloristic-darkroom-${Date.now()}.${settings.format === 'jpeg' ? 'jpg' : settings.format}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Export failed.';
      showToast(message, true);
    }
  };

  const showDialog = (title: string, body: string) => {
    dialogTitle = title;
    dialogBody = body;
    dialogOpen = true;
  };

  const handleMenuAction = (action: 'about' | 'help' | 'shortcuts' | 'contact') => {
    switch (action) {
      case 'about':
        showDialog('About Coloristic Darkroom', ABOUT_HTML);
        break;
      case 'help':
        showDialog('Help', HELP_HTML);
        break;
      case 'shortcuts':
        showDialog('Keyboard Shortcuts', SHORTCUTS_HTML);
        break;
      case 'contact':
        showDialog('Contact', CONTACT_HTML);
        break;
    }
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA') {
      return;
    }

    const mod = event.metaKey || event.ctrlKey;

    if (mod && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) editor.redo();
      else editor.undo();
      return;
    }

    if (mod && event.key.toLowerCase() === 'e') {
      event.preventDefault();
      void openExport();
      return;
    }

    if (event.key.toLowerCase() === 'c' && hasImage) {
      event.preventDefault();
      toggleCropMode(!isCropping);
      return;
    }

    if (event.key.toLowerCase() === 's' && hasImage) {
      event.preventDefault();
      toggleSplitCompare();
      return;
    }

    if (event.key.toLowerCase() === 'r' && hasImage) {
      event.preventDefault();
      editor.rotateCCW(true);
      return;
    }

    if (event.key === ' ' && hasImage && compareMode !== 'split') {
      event.preventDefault();
      if (!holdCompareActive) startHoldCompare();
      return;
    }

    if (event.key === '1') setActiveTab('adjust');
    if (event.key === '2') setActiveTab('filters');

    if (hasImage && (event.key === '=' || event.key === '+')) {
      event.preventDefault();
      viewZoom = clampViewZoom(viewZoom + VIEW_ZOOM_STEP);
      return;
    }

    if (hasImage && event.key === '-') {
      event.preventDefault();
      viewZoom = clampViewZoom(viewZoom - VIEW_ZOOM_STEP);
      return;
    }

    if (hasImage && mod && event.key === '0') {
      event.preventDefault();
      viewZoom = VIEW_ZOOM_DEFAULT;
      return;
    }
  };

  const handleKeyUp = (event: KeyboardEvent) => {
    if (event.key === ' ' && holdCompareActive && compareMode === 'hold') {
      event.preventDefault();
      endHoldCompare();
    }
  };

</script>

<svelte:window onkeydown={handleKeyDown} onkeyup={handleKeyUp} />

<div class="workspace-shell" class:has-image={hasImage} class:is-scrubbing={isScrubbing}>
  <section class="canvas-pane" class:is-dragging={isDragging}>
    <CanvasToolbar
      {hasImage}
      compareActive={holdCompareActive}
      splitActive={compareMode === 'split'}
      cropActive={isCropping}
      {canUndo}
      {canRedo}
      onCrop={() => toggleCropMode(!isCropping)}
      onSplit={toggleSplitCompare}
      onCompareStart={startHoldCompare}
      onCompareEnd={endHoldCompare}
      onUndo={() => editor.undo()}
      onRedo={() => editor.redo()}
    >
      {#snippet start()}
        <AppMenu onaction={handleMenuAction} />
      {/snippet}
    </CanvasToolbar>

    <CanvasStage
      {viewZoom}
      {compareMode}
      {isCropping}
      {isPickingGrey}
      bind:isDragging
      {loaderVisible}
      {loaderFading}
      {loaderText}
      onOpen={openPicker}
      onLoadSample={loadSample}
      onDropFile={handleUpload}
      {onCanvasClick}
      onCropToggle={toggleCropMode}
      onAspectChange={(aspect: AspectRatioId) => editor.setAspectRatio(aspect, true)}
      onRotateCcw={() => editor.rotateCCW(true)}
      onRotateCw={() => editor.rotateCW(true)}
      onFlipH={() => editor.flipHorizontal(true)}
      onFlipV={() => editor.flipVertical(true)}
      onResetCrop={() => {
        editor.resetCrop(true);
        toggleCropMode(false);
      }}
      onApplyCrop={async () => {
        await editor.applyCrop(true);
        toggleCropMode(false);
      }}
      onViewZoomChange={(zoom) => {
        viewZoom = zoom;
      }}
    />
  </section>

  <InspectorPane
    bind:activeTab
    onTabChange={setActiveTab}
    {toastMessage}
    {toastError}
    greyPickActive={isPickingGrey}
    onGreyPick={startGreyPick}
    onOpen={openPicker}
    onExport={openExport}
  />
</div>

<input
  type="file"
  accept="image/*"
  class="sr-only"
  bind:this={uploadInput}
  onchange={async (e) => {
  const file = (e.currentTarget as HTMLInputElement).files?.[0];
  if (file) await handleUpload(file);
  (e.currentTarget as HTMLInputElement).value = '';
}} />

<ExportModal bind:open={exportOpen} onconfirm={handleExportConfirm} />
<AppDialog bind:open={dialogOpen} title={dialogTitle} body={dialogBody} />