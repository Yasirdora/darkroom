<script lang="ts">
  import type { SliderVariant } from '$lib/core/types';
  import { updateSliderFill } from '$lib/actions/range-fill';
  import { tick } from 'svelte';

  interface Props {
    value: number;
    min: number;
    max: number;
    step: number;
    variant?: SliderVariant;
    label: string;
    disabled?: boolean;
    defaultValue?: number;
    oninput: (value: number) => void;
    oncommit: (value: number) => void;
    onscrubstart?: () => void;
    onscrubend?: () => void;
    onreset?: (value: number) => void;
  }

  let {
    value,
    min,
    max,
    step,
    variant = 'default',
    label,
    disabled = false,
    defaultValue,
    oninput,
    oncommit,
    onscrubstart,
    onscrubend,
    onreset,
  }: Props = $props();

  let inputEl = $state<HTMLInputElement | null>(null);
  let isScrubbing = false;
  let scrubDisplay = $state<number | null>(null);
  let inputFrame: number | null = null;
  let activePointerId: number | null = null;
  let fillGeneration = 0;

  const formatValueForInput = (v: number): string => {
    if (Number.isInteger(step)) return String(Math.round(v));
    const decimals = (step.toString().split('.')[1] ?? '').length;
    return v.toFixed(decimals);
  };

  const formatDisplay = (v: number) => {
    if (min < 0 && v > 0) return `+${formatValueForInput(v)}`;
    return formatValueForInput(v);
  };

  const displayValue = $derived(formatDisplay(scrubDisplay ?? value));

  const scheduleFillUpdate = () => {
    const gen = ++fillGeneration;
    void tick().then(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (gen !== fillGeneration || !inputEl || isScrubbing) return;
          updateSliderFill(inputEl);
        });
      });
    });
  };

  const syncFromProps = () => {
    if (!inputEl || isScrubbing) return;
    const next = formatValueForInput(value);
    if (inputEl.value !== next) {
      inputEl.value = next;
    }
    scheduleFillUpdate();
  };

  $effect(() => {
    void value;
    void min;
    void max;
    void step;
    if (disabled && isScrubbing) finishScrub();
    syncFromProps();
  });

  $effect(() => {
    if (!inputEl) return;
    const host = inputEl.closest('.range');
    if (!host) return;

    const resizeObserver = new ResizeObserver(() => {
      if (!isScrubbing && inputEl) updateSliderFill(inputEl);
    });
    resizeObserver.observe(host);

    const intersectionObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) syncFromProps();
      },
      { threshold: 0.01 },
    );
    intersectionObserver.observe(host);

    return () => {
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
    };
  });

  const scheduleInput = (next: number) => {
    if (inputFrame !== null) cancelAnimationFrame(inputFrame);
    inputFrame = requestAnimationFrame(() => {
      inputFrame = null;
      oninput(next);
    });
  };

  const releasePointer = () => {
    if (inputEl && activePointerId !== null && inputEl.hasPointerCapture(activePointerId)) {
      try {
        inputEl.releasePointerCapture(activePointerId);
      } catch {
        /* pointer may already be released */
      }
    }
    activePointerId = null;
  };

  const finishScrub = () => {
    if (!isScrubbing) return;
    isScrubbing = false;
    scrubDisplay = null;
    window.removeEventListener('pointerup', finishScrub);
    window.removeEventListener('pointercancel', finishScrub);
    window.removeEventListener('blur', finishScrub);
    releasePointer();
    onscrubend?.();
    if (inputEl) updateSliderFill(inputEl);
  };

  const startScrub = () => {
    if (isScrubbing || disabled) return;
    isScrubbing = true;
    onscrubstart?.();
    window.addEventListener('pointerup', finishScrub);
    window.addEventListener('pointercancel', finishScrub);
    window.addEventListener('blur', finishScrub);
  };

  const handlePointerDown = (event: PointerEvent) => {
    if (disabled) return;
    startScrub();
    activePointerId = event.pointerId;
    try {
      inputEl?.setPointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
  };

  const run = (commit: boolean) => {
    if (!inputEl || disabled) return;
    const next = Number(inputEl.value);
    scrubDisplay = next;
    updateSliderFill(inputEl);
    if (commit) {
      if (inputFrame !== null) {
        cancelAnimationFrame(inputFrame);
        inputFrame = null;
      }
      oncommit(next);
    } else {
      scheduleInput(next);
    }
  };

  const reset = () => {
    if (defaultValue === undefined || !inputEl || disabled) return;
    finishScrub();
    const next = formatValueForInput(defaultValue);
    inputEl.value = next;
    scrubDisplay = null;
    updateSliderFill(inputEl);
    oninput(defaultValue);
    if (onreset) onreset(defaultValue);
    else oncommit(defaultValue);
  };
</script>

<div
  class="control-row"
  role="group"
  title={defaultValue !== undefined ? 'Double-click to reset' : undefined}
  ondblclick={(event) => {
    if (event.target === inputEl) return;
    event.preventDefault();
    reset();
  }}
>
  <div class="control-row-head">
    <span class="control-label">{label}</span>
    <span class="control-value">{displayValue}</span>
  </div>
  <div class="range range-{variant}">
    <div class="range-track"></div>
    <div class="range-fill"></div>
    <input
      bind:this={inputEl}
      type="range"
      {min}
      {max}
      {step}
      {disabled}
      aria-label={label}
      onpointerdown={handlePointerDown}
      oninput={() => {
        if (!isScrubbing) startScrub();
        run(false);
      }}
      onchange={() => {
        run(true);
        finishScrub();
      }}
      ondblclick={(event) => {
        event.preventDefault();
        reset();
      }}
    />
  </div>
</div>