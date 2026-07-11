/** Keeps custom range track fill aligned with the native thumb position. */

const THUMB_PX = 14;

const valueToRatio = (value: number, min: number, max: number): number =>
  (value - min) / (max - min);

/** Map a 0–1 ratio to a fill % that matches WebKit/Moz thumb centering. */
const ratioToPercent = (ratio: number, trackWidth: number): number => {
  if (trackWidth <= THUMB_PX) return ratio * 100;
  const centerPx = ratio * (trackWidth - THUMB_PX) + THUMB_PX / 2;
  return (centerPx / trackWidth) * 100;
};

export const updateSliderFill = (input: HTMLInputElement): void => {
  const min = Number(input.min);
  const max = Number(input.max);
  const value = Number(input.value);
  const host = input.closest('.range') as HTMLElement | null;
  if (!host) return;

  const trackWidth = host.clientWidth;
  if (trackWidth <= 0 || max <= min) return;

  input.setAttribute('aria-valuemin', String(min));
  input.setAttribute('aria-valuemax', String(max));
  input.setAttribute('aria-valuenow', String(value));

  host.style.setProperty('--value', String(value));
  host.style.setProperty('--min', String(min));
  host.style.setProperty('--max', String(max));

  const ratio = valueToRatio(value, min, max);

  if (min < 0) {
    const zeroRatio = valueToRatio(0, min, max);
    const zero = ratioToPercent(zeroRatio, trackWidth);
    const position = ratioToPercent(ratio, trackWidth);
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
  host.style.setProperty('--fill', `${ratioToPercent(ratio, trackWidth)}%`);
};

export const rangeFill = (node: HTMLInputElement): { destroy: () => void } => {
  const onUpdate = () => updateSliderFill(node);

  onUpdate();
  node.addEventListener('input', onUpdate);
  node.addEventListener('change', onUpdate);

  return {
    destroy() {
      node.removeEventListener('input', onUpdate);
      node.removeEventListener('change', onUpdate);
    },
  };
};