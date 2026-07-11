import { PhotoEditor, type EditorSnapshot } from '$lib/editor/photo-editor';

export const EDITOR_CONTEXT_KEY = Symbol('editor');

export function createEditorState() {
  const editor = new PhotoEditor();
  let snapshot = $state<EditorSnapshot>(editor.getSnapshot());

  const unsubscribe = editor.subscribe((next) => {
    snapshot = next;
  });

  // Expose snapshot via getter so Svelte components can read `ctx.snapshot`
  // inside $derived / $effect. Never destructure snapshot — that freezes the
  // initial value and breaks the UI after loadFile().
  return {
    get snapshot() {
      return snapshot;
    },
    get editor() {
      return editor;
    },
    destroy() {
      unsubscribe();
      editor.destroy();
    },
  };
}

export type EditorState = ReturnType<typeof createEditorState>;