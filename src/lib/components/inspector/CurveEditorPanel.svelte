<script lang="ts">
  import { untrack } from 'svelte';
  import { CurveEditor } from '$lib/ui/curve-editor';
  import { getEditorContext } from '$lib/state/context';

  let mountEl = $state<HTMLDivElement | null>(null);
  let curveEditor: CurveEditor | null = null;
  let curveInteracting = false;

  const ctx = getEditorContext();
  const editor = ctx.editor;
  const curves = $derived(ctx.snapshot.state.curves);
  const hasImage = $derived(ctx.snapshot.hasImage);

  const finishCurveInteraction = () => {
    if (!curveInteracting) return;
    curveInteracting = false;
    editor.endInteraction();
  };

  // Mount once — do NOT read `curves` here or the editor is recreated on every drag.
  $effect(() => {
    if (!mountEl) return;

    const instance = new CurveEditor(mountEl, (next) => {
      if (!curveInteracting) {
        editor.beginInteraction();
        curveInteracting = true;
      }
      editor.setCurves(next, false);
    });

    untrack(() => {
      instance.setCurves(curves);
    });

    curveEditor = instance;

    window.addEventListener('pointerup', finishCurveInteraction);
    window.addEventListener('pointercancel', finishCurveInteraction);

    return () => {
      window.removeEventListener('pointerup', finishCurveInteraction);
      window.removeEventListener('pointercancel', finishCurveInteraction);
      finishCurveInteraction();
      instance.destroy();
      curveEditor = null;
    };
  });

  // Sync undo/redo/external changes only — skip while the user is dragging.
  $effect(() => {
    if (!curveEditor || curveInteracting) return;
    curveEditor.setCurves(curves);
  });
</script>

<div
  class="curve-editor-mount"
  bind:this={mountEl}
  aria-label="Tone curves"
  aria-disabled={!hasImage}
  class:is-disabled={!hasImage}
></div>

<style>
  .curve-editor-mount.is-disabled {
    opacity: 0.45;
    pointer-events: none;
  }
</style>