<script lang="ts">
  import { on } from 'svelte/events';

  export type MenuAction = 'about' | 'help' | 'shortcuts' | 'contact';

  const MENU_ITEMS: Array<{ id: MenuAction; label: string; separatorBefore?: boolean }> = [
    { id: 'about', label: 'About Coloristic Darkroom' },
    { id: 'help', label: 'Help', separatorBefore: true },
    { id: 'shortcuts', label: 'Keyboard Shortcuts' },
    { id: 'contact', label: 'Contact' },
  ];

  interface Props {
    onaction?: (action: MenuAction) => void;
  }

  let { onaction }: Props = $props();

  let anchorEl = $state<HTMLDivElement | null>(null);
  let triggerEl = $state<HTMLButtonElement | null>(null);
  let menuEl = $state<HTMLDivElement | null>(null);
  let isOpen = $state(false);

  const open = () => {
    isOpen = true;
    requestAnimationFrame(() => {
      menuEl?.querySelector<HTMLButtonElement>('.app-menu-item')?.focus();
    });
  };

  const close = () => {
    isOpen = false;
  };

  const toggle = (event: MouseEvent) => {
    event.stopPropagation();
    if (isOpen) close();
    else open();
  };

  const selectAction = (action: MenuAction) => {
    close();
    onaction?.(action);
  };

  const handleDocumentPointerDown = (event: PointerEvent) => {
    if (!isOpen || !anchorEl) return;
    const target = event.target as Node;
    if (!anchorEl.contains(target)) close();
  };

  const handleDocumentKeyDown = (event: KeyboardEvent) => {
    if (!isOpen || event.key !== 'Escape') return;
    event.preventDefault();
    close();
    triggerEl?.focus();
  };

  $effect(() => {
    if (!isOpen) return;

    const cleanups = [
      on(document, 'pointerdown', handleDocumentPointerDown),
      on(document, 'keydown', handleDocumentKeyDown),
    ];

    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  });
</script>

<div class="app-menu-anchor" class:is-open={isOpen} bind:this={anchorEl}>
  <button
    bind:this={triggerEl}
    type="button"
    class="app-menu-trigger"
    aria-haspopup="menu"
    aria-expanded={isOpen}
    aria-label="Coloristic Darkroom application menu"
    onclick={toggle}
  >
    <svg
      class="product-mark"
      width="28"
      height="28"
      viewBox="0 0 66 66"
      fill="none"
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width="66" height="66" rx="9" fill="#fff" />
      <rect x="41.75" y="16.75" width="7.5" height="7.5" stroke="#000" stroke-width="7.5" />
    </svg>
    <span class="product-brand">Coloristic</span>
    <span class="product-edition">Darkroom</span>
  </button>

  <div
    bind:this={menuEl}
    class="app-menu"
    role="menu"
    hidden={!isOpen}
    aria-hidden={!isOpen}
  >
    {#each MENU_ITEMS as item (item.id)}
      {#if item.separatorBefore}
        <div class="app-menu-separator" role="separator"></div>
      {/if}
      <button
        type="button"
        class="app-menu-item"
        role="menuitem"
        onclick={() => selectAction(item.id)}
      >
        {item.label}
      </button>
    {/each}
  </div>
</div>