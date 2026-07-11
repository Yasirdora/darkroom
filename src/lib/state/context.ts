import { getContext, setContext } from 'svelte';
import { EDITOR_CONTEXT_KEY, type EditorState } from './editor.svelte';

export function setEditorContext(state: EditorState): void {
  setContext(EDITOR_CONTEXT_KEY, state);
}

export function getEditorContext(): EditorState {
  return getContext<EditorState>(EDITOR_CONTEXT_KEY);
}