import { ImageBuffer } from '../core/image-buffer';
import type { HistogramData } from '../core/types';

export const computeHistogram = (source: ImageBuffer): HistogramData => {
  const { data } = source;
  const r = new Uint32Array(256);
  const g = new Uint32Array(256);
  const b = new Uint32Array(256);
  const luminance = new Uint32Array(256);
  let peak = 0;

  for (let index = 0; index < data.length; index += 4) {
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];

    r[red] += 1;
    g[green] += 1;
    b[blue] += 1;

    const lum = Math.round(red * 0.2126 + green * 0.7152 + blue * 0.0722);
    luminance[lum] += 1;
    peak = Math.max(peak, r[red], g[green], b[blue], luminance[lum]);
  }

  return { r, g, b, luminance, peak };
};