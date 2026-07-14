import { ImageBuffer } from '../core/image-buffer';
import type { VectorscopeData } from '../core/types';

/** BT.709 chroma range mapped to scope edges (Resolve-style square scope). */
export const VECTORSCOPE_CHROMA_RANGE = 0.34;

export const VECTORSCOPE_SIZE = 96;

/**
 * Rec.709 skin-tone reference line (Cb/Cr offset from neutral gray).
 * Anchors derived from representative skin RGBs across lightness range.
 */
export const SKIN_TONE_LINE = {
  light: { cb: -0.091, cr: 0.109 },
  dark: { cb: -0.044, cr: 0.058 },
} as const;

/** BT.709 full-range RGB [0–255] → centered Cb/Cr offsets. */
export const rgbToCbCrOffset = (
  r: number,
  g: number,
  b: number,
): { cb: number; cr: number } => {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const y = 0.2126 * rn + 0.7152 * gn + 0.0722 * bn;
  return {
    cb: (bn - y) / 1.8556,
    cr: (rn - y) / 1.5748,
  };
};

export const computeVectorscope = (
  source: ImageBuffer,
  size = VECTORSCOPE_SIZE,
): VectorscopeData => {
  const bins = new Uint32Array(size * size);
  const { data } = source;
  let peak = 0;

  const step = data.length > 4_000_000 ? 16 : data.length > 1_500_000 ? 8 : 4;
  const range = VECTORSCOPE_CHROMA_RANGE;
  const half = size - 1;

  for (let index = 0; index < data.length; index += 4 * step) {
    const alpha = data[index + 3];
    if (alpha < 8) continue;

    const { cb, cr } = rgbToCbCrOffset(data[index], data[index + 1], data[index + 2]);
    const x = Math.round((cb / range + 1) * 0.5 * half);
    const y = Math.round((-cr / range + 1) * 0.5 * half);

    if (x < 0 || x >= size || y < 0 || y >= size) continue;

    const offset = y * size + x;
    bins[offset] += 1;
    peak = Math.max(peak, bins[offset]);
  }

  return { bins, size, peak };
};