<script lang="ts">
  interface Props {
    visible: boolean;
    fading: boolean;
    text: string;
  }

  let { visible, fading, text }: Props = $props();
</script>

<div
  class="image-loader"
  class:is-fading={fading}
  hidden={!visible}
  aria-hidden={!visible}
  role="status"
  aria-live="polite"
  aria-busy={visible && !fading}
>
  <div class="image-loader-spinner" aria-hidden="true"></div>
  <span class="image-loader-text">{text}</span>
</div>