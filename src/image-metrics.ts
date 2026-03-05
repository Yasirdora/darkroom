import { rgbToHsl } from './color.js';

export const isSkinTone = (r: number, g: number, b: number): boolean => {
  const { h, s, l } = rgbToHsl(r, g, b);
  if (s < 0.05 || s > 0.75 || l < 0.05 || l > 0.85) return false;
  return (h >= 0 && h <= 50) || h >= 335;
};

export const skinToneWeight = (r: number, g: number, b: number): number => {
  const { h, s, l } = rgbToHsl(r, g, b);
  const window = (value: number, minimum: number, maximum: number, softness: number): number => {
    if (value >= minimum && value <= maximum) return 1;
    const distance = value < minimum ? minimum - value : value - maximum;
    return Math.max(0, 1 - distance / softness);
  };
  const hueWeight = h <= 50 || h >= 335
    ? 1
    : Math.max(0, 1 - Math.min(h - 50, 335 - h) / 14);
  return hueWeight * window(s, 0.05, 0.75, 0.1) * window(l, 0.05, 0.85, 0.1);
};
