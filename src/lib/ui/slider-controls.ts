/** Binds range inputs to visual fill tracks and value callbacks. */

export const updateSliderFill = (input: HTMLInputElement): void => {
  const min = Number(input.min);
  const max = Number(input.max);
  const value = Number(input.value);
  const host = input.closest('.range') as HTMLElement | null;
  if (!host) return;

  input.setAttribute('aria-valuemin', String(min));
  input.setAttribute('aria-valuemax', String(max));
  input.setAttribute('aria-valuenow', String(value));

  host.style.setProperty('--value', String(value));
  host.style.setProperty('--min', String(min));
  host.style.setProperty('--max', String(max));

  if (min < 0) {
    const zero = ((0 - min) / (max - min)) * 100;
    const position = ((value - min) / (max - min)) * 100;
    host.classList.add('range-bipolar');
    host.style.setProperty('--zero', `${zero}%`);
    if (value >= 0) {
      host.style.setProperty('--fill-start', `${zero}%`);
      host.style.setProperty('--fill-end', `${position}%`);
    } else {
      host.style.setProperty('--fill-start', `${position}%`);
      host.style.setProperty('--fill-end', `${zero}%`);
    }
    return;
  }

  host.classList.remove('range-bipolar');
  host.style.setProperty('--fill', `${((value - min) / (max - min)) * 100}%`);
};

export const bindRangeInput = (
  input: HTMLInputElement,
  handlers: {
    onInput: (value: number) => void;
    onCommit: (value: number) => void;
    defaultValue?: number;
    onReset?: (value: number) => void;
    onScrubStart?: () => void;
    onScrubEnd?: () => void;
  },
): void => {
  let isScrubbing = false;

  const run = (commit: boolean) => {
    updateSliderFill(input);
    const value = Number(input.value);
    if (commit) handlers.onCommit(value);
    else handlers.onInput(value);
  };

  const reset = () => {
    if (handlers.defaultValue === undefined) return;
    input.value = String(handlers.defaultValue);
    updateSliderFill(input);
    if (handlers.onReset) {
      handlers.onReset(handlers.defaultValue);
    } else {
      handlers.onCommit(handlers.defaultValue);
    }
  };

  const finishScrub = () => {
    if (!isScrubbing) return;
    isScrubbing = false;
    window.removeEventListener('pointerup', finishScrub);
    window.removeEventListener('pointercancel', finishScrub);
    handlers.onScrubEnd?.();
  };

  const startScrub = () => {
    if (isScrubbing) return;
    isScrubbing = true;
    handlers.onScrubStart?.();
    window.addEventListener('pointerup', finishScrub);
    window.addEventListener('pointercancel', finishScrub);
  };

  input.addEventListener('pointerdown', startScrub);

  input.addEventListener('input', () => {
    // Keyboard edits (arrow keys) never fire pointerdown — open a scrub
    // "interaction" here so history capture works for them too.
    startScrub();
    run(false);
  });
  input.addEventListener('change', () => {
    // Commit before ending the scrub so interaction-scoped history sees the
    // final value.
    run(true);
    finishScrub();
  });
  input.addEventListener('pointerup', finishScrub);
  input.addEventListener('pointercancel', finishScrub);

  input.addEventListener('dblclick', (event) => {
    event.preventDefault();
    reset();
  });

  const row = input.closest('.control-row');
  row?.addEventListener('dblclick', (event) => {
    if (event.target === input) return;
    event.preventDefault();
    reset();
  });

  updateSliderFill(input);
};

export const syncAllSliders = (root: ParentNode): void => {
  root.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach(updateSliderFill);
};