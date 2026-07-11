<script lang="ts">
  import { ICONS, type IconName } from '$lib/icons';

  interface Props {
    name: IconName;
    class?: string;
  }

  let { name, class: className = '' }: Props = $props();

  const markup = $derived(
    className
      ? ICONS[name].replace('<svg ', `<svg class="${className}" `)
      : ICONS[name],
  );
</script>

{@html markup}