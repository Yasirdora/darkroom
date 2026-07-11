<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';

  interface Props {
    title: string;
    collapsed?: boolean;
    badge?: string;
    groupClass?: string;
    children: Snippet;
    actions?: Snippet;
  }

  let {
    title,
    collapsed = $bindable(false),
    badge,
    groupClass = '',
    children,
    actions,
  }: Props = $props();

  const toggle = () => {
    collapsed = !collapsed;
  };

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggle();
    }
  };
</script>

<div class="control-group {groupClass}" class:is-collapsed={collapsed}>
  <div
    class="control-group-head"
    data-toggle-group
    role="button"
    tabindex="0"
    aria-expanded={!collapsed}
    onclick={toggle}
    onkeydown={onKeydown}
  >
    <div class="control-group-title-wrap">
      <Icon name="chevronDown" class="chevron-icon" />
      <span class="control-group-title">{title}</span>
      {#if badge}
        <span class="control-value">{badge}</span>
      {/if}
    </div>
    {#if actions}
      <div
        class="control-group-actions"
        role="presentation"
        onclick={(event) => event.stopPropagation()}
        onkeydown={(event) => event.stopPropagation()}
      >
        {@render actions()}
      </div>
    {/if}
  </div>
  <div class="control-group-body">
    {@render children()}
  </div>
</div>