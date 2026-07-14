<script lang="ts">
  import { CINEMA_LOOKS } from '$lib/constants/cinema-looks';
  import { COLORISTIC_FILM_URL } from '$lib/constants/site';
  import type { FilterId } from '$lib/core/types';

  interface Props {
    hasImage: boolean;
    activeId: FilterId;
    thumbnails: Partial<Record<FilterId, string>>;
    onselect: (id: FilterId) => void;
  }

  let { hasImage, activeId, thumbnails, onselect }: Props = $props();
</script>

<section class="cinema-looks-panel" aria-label="Cinema looks">
  <div class="cinema-looks-head">
    <div>
      <h3 class="cinema-looks-title">Cinema looks</h3>
      <p class="cinema-looks-sub">
        Curated DI presets — paired with
        <a href={COLORISTIC_FILM_URL} target="_blank" rel="noopener noreferrer">Coloristic Film</a>
      </p>
    </div>
  </div>

  <div class="cinema-looks-grid">
    {#each CINEMA_LOOKS as look (look.id)}
      {@const thumb = thumbnails[look.id]}
      <button
        type="button"
        class="cinema-look-card"
        class:is-selected={activeId === look.id}
        disabled={!hasImage}
        title={look.tagline}
        onclick={() => onselect(look.id)}
      >
        <div
          class="cinema-look-thumb"
          class:has-image={!!thumb}
          style:background-image={thumb ? `url(${thumb})` : undefined}
        >
          <div class="cinema-look-thumb-fallback" aria-hidden="true"></div>
        </div>
        <span class="cinema-look-name">{look.name}</span>
        <span class="cinema-look-tagline">{look.tagline}</span>
      </button>
    {/each}
  </div>
</section>