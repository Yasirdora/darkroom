<script lang="ts">
  import { SAMPLE_IMAGES } from '$lib/constants/samples';
  import { HeroParticles } from '$lib/ui/hero-particles';

  interface Props {
    onOpen: () => void;
    onLoadSample: (id: string) => void;
  }

  let { onOpen, onLoadSample }: Props = $props();

  let containerEl = $state<HTMLDivElement | null>(null);
  let canvasEl = $state<HTMLCanvasElement | null>(null);
  let particles: HeroParticles | null = null;
  let resizeObserver: ResizeObserver | null = null;

  $effect(() => {
    if (!containerEl || !canvasEl) return;

    particles = new HeroParticles(canvasEl, containerEl);
    particles.start();

    resizeObserver = new ResizeObserver(() => {
      particles?.resize();
    });
    resizeObserver.observe(containerEl);

    return () => {
      resizeObserver?.disconnect();
      resizeObserver = null;
      particles?.destroy();
      particles = null;
    };
  });
</script>

<div class="hero-landing" bind:this={containerEl}>
  <div class="hero-canvas-wrap" aria-hidden="true">
    <canvas bind:this={canvasEl}></canvas>
  </div>

  <main class="hero-content">
    <p class="hero-eyebrow">Coloristic · Darkroom</p>
    <h1 class="hero-headline">Grade like a colorist</h1>
    <p class="hero-subheading">Entirely in your browser.</p>

    <div class="hero-actions">
      <button type="button" class="hero-cta" onclick={onOpen}>Open a photo</button>
      <span class="hero-hint">or drop a file anywhere</span>
    </div>

    <div class="hero-samples-section">
      <p class="hero-samples-title">Or try a sample image</p>
      <div class="hero-samples-grid">
        {#each SAMPLE_IMAGES as sample (sample.id)}
          <button
            type="button"
            class="sample-card"
            title={sample.title}
            aria-label={`Load sample: ${sample.label}`}
            onclick={() => onLoadSample(sample.id)}
          >
            <div class="sample-thumb-wrap">
              <img src={sample.src} alt={sample.label} loading="lazy" />
            </div>
            <span class="sample-label">{sample.label}</span>
          </button>
        {/each}
      </div>
    </div>
  </main>
</div>