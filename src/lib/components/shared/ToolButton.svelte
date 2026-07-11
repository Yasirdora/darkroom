<script lang="ts">
  import Icon from './Icon.svelte';
  import type { IconName } from '$lib/icons';

  interface Props {
    icon: IconName;
    label: string;
    active?: boolean;
    disabled?: boolean;
    title?: string;
    onclick?: (event: MouseEvent) => void;
  }

  let {
    icon,
    label,
    active = false,
    disabled = false,
    title,
    onclick,
  }: Props = $props();
</script>

<button
  type="button"
  class="tool-btn"
  class:is-active={active}
  {disabled}
  title={title ?? label}
  aria-label={label}
  {onclick}
>
  <Icon name={icon} />
</button>