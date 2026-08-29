import { clampByte } from '../core/math';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Hsl {
  h: number;
  s: number;
  l: number;
}

export const hexToRgb = (hex: string): Rgb => {
  const normalized = hex.replace('#', '');
  const value =
    normalized.length === 3
      ? normalized
          .split('')
          .map((char) => char + char)
          .join('')
      : normalized.padStart(6, '0').slice(0, 6);

  const parse = (slice: string): number => {
    const parsed = parseInt(slice, 16);
    return Number.isNaN(parsed) ? 0 : parsed; // guard invalid hex input
  };

  return {
    r: parse(value.slice(0, 2)),
    g: parse(value.slice(2, 4)),
    b: parse(value.slice(4, 6)),
  };
};

/** Chroma below which a pixel is treated as neutral, in 0–1 units. */
const CHROMA_FLOOR = 2 / 255;
/** Chroma at or above which a pixel's hue is taken at face value. */
const CHROMA_FULL = 10 / 255;

/**
 * How much a pixel's hue can be trusted, 0–1, from its chroma.
 *
 * Below two code values of chroma a pixel is grey and its hue is whatever
 * rounding left behind; by ten it is carrying real colour. Any effect that
 * acts on hue has to fade out across that span, or it turns noise into a
 * cast — an ungated vibrance put a grey card at (145,111,111).
 *
 * Gate on chroma rather than HSL saturation: saturation divides by lightness,
 * so a dark pixel carrying two code values of chroma reports as 9% saturated.
 */
export const chromaConfidence = (r: number, g: number, b: number): number => {
  const chroma = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
  const t = Math.min(1, Math.max(0, (chroma - CHROMA_FLOOR) / (CHROMA_FULL - CHROMA_FLOOR)));
  return t * t * (3 - 2 * t);
};

export const rgbToHsl = (r: number, g: number, b: number): Hsl => {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;

  let h = 0;
  const l = (max + min) / 2;
  // Clamp: float rounding can yield s = 1.0000000000000002 on fully
  // saturated colors, and downstream math (e.g. pow(1 - s, 1.5)) turns that
  // into NaN → black pixels.
  const s = delta === 0 ? 0 : Math.min(1, delta / (1 - Math.abs(2 * l - 1)));

  if (delta !== 0) {
    switch (max) {
      case rn:
        h = ((gn - bn) / delta) % 6;
        break;
      case gn:
        h = (bn - rn) / delta + 2;
        break;
      default:
        h = (rn - gn) / delta + 4;
        break;
    }
    h *= 60;
    if (h < 0) h += 360;
  }

  return { h, s, l };
};

export const hslToRgb = (h: number, s: number, l: number): Rgb => {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;

  let rp = 0;
  let gp = 0;
  let bp = 0;

  if (h < 60) [rp, gp, bp] = [c, x, 0];
  else if (h < 120) [rp, gp, bp] = [x, c, 0];
  else if (h < 180) [rp, gp, bp] = [0, c, x];
  else if (h < 240) [rp, gp, bp] = [0, x, c];
  else if (h < 300) [rp, gp, bp] = [x, 0, c];
  else [rp, gp, bp] = [c, 0, x];

  return {
    r: clampByte((rp + m) * 255),
    g: clampByte((gp + m) * 255),
    b: clampByte((bp + m) * 255),
  };
};

export const parseCssColor = (value: string): Rgb => {
  if (value.startsWith('#')) {
    return hexToRgb(value);
  }
  return { r: 255, g: 255, b: 255 };
};

