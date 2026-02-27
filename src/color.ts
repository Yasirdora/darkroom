import { clamp, clampByte } from './math.js';

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

const CSS_RGB_COLOR_PATTERN = /^rgba?\(\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*,\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*,\s*([+-]?(?:\d+\.?\d*|\.\d+))(?:\s*,\s*[+-]?(?:\d+\.?\d*|\.\d+)\s*)?\)$/i;

/** Return whether a color uses the engine's supported hex or rgb(a) syntax. */
export const isSupportedCssColor = (value: string): boolean => {
  const normalized = value.trim();
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(normalized)
    || CSS_RGB_COLOR_PATTERN.test(normalized);
};

export const hexToRgb = (hex: string): Rgb => {
  const normalized = hex.trim().replace(/^#/, '');
  if (!/^(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(normalized)) return { r: 0, g: 0, b: 0 };
  const expanded = normalized.length === 3
    ? normalized.split('').map((character) => character.repeat(2)).join('')
    : normalized;
  return {
    r: Number.parseInt(expanded.slice(0, 2), 16),
    g: Number.parseInt(expanded.slice(2, 4), 16),
    b: Number.parseInt(expanded.slice(4, 6), 16),
  };
};

export const rgbToHsl = (r: number, g: number, b: number): Hsl => {
  const rn = clamp(r, 0, 255) / 255;
  const gn = clamp(g, 0, 255) / 255;
  const bn = clamp(b, 0, 255) / 255;
  const maximum = Math.max(rn, gn, bn);
  const minimum = Math.min(rn, gn, bn);
  const delta = maximum - minimum;
  const lightness = (maximum + minimum) / 2;

  if (delta === 0) return { h: 0, s: 0, l: lightness };

  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue: number;
  if (maximum === rn) hue = 60 * (((gn - bn) / delta) % 6);
  else if (maximum === gn) hue = 60 * ((bn - rn) / delta + 2);
  else hue = 60 * ((rn - gn) / delta + 4);
  if (hue < 0) hue += 360;
  return { h: hue, s: Number.isFinite(saturation) ? saturation : 0, l: lightness };
};

export const hslToRgb = (h: number, s: number, l: number): Rgb => {
  const hue = ((h % 360) + 360) % 360;
  const saturation = clamp(s, 0, 1);
  const lightness = clamp(l, 0, 1);
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const section = hue / 60;
  const secondary = chroma * (1 - Math.abs((section % 2) - 1));
  let red = 0;
  let green = 0;
  let blue = 0;

  if (section < 1) [red, green] = [chroma, secondary];
  else if (section < 2) [red, green] = [secondary, chroma];
  else if (section < 3) [green, blue] = [chroma, secondary];
  else if (section < 4) [green, blue] = [secondary, chroma];
  else if (section < 5) [red, blue] = [secondary, chroma];
  else [red, blue] = [chroma, secondary];

  const match = lightness - chroma / 2;
  return {
    r: clampByte((red + match) * 255),
    g: clampByte((green + match) * 255),
    b: clampByte((blue + match) * 255),
  };
};

export const parseCssColor = (value: string): Rgb => {
  const normalized = value.trim();
  if (normalized.startsWith('#')) return hexToRgb(normalized);
  const match = normalized.match(CSS_RGB_COLOR_PATTERN);
  if (!match) return { r: 0, g: 0, b: 0 };
  return {
    r: clampByte(Number(match[1])),
    g: clampByte(Number(match[2])),
    b: clampByte(Number(match[3])),
  };
};

export const luma = (r: number, g: number, b: number): number =>
  0.2126 * r + 0.7152 * g + 0.0722 * b;
