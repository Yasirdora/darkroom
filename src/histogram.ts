import { assertPixelBuffer } from './buffer.js';
import type { HistogramData, PixelBuffer } from './types.js';

export const computeHistogram = (source: PixelBuffer): HistogramData => {
  assertPixelBuffer(source);
  const { data } = source;
  const r = new Uint32Array(256);
  const g = new Uint32Array(256);
  const b = new Uint32Array(256);
  const luminance = new Uint32Array(256);

  // HistogramData intentionally uses integer bins. Accumulate alpha coverage
  // in floating point first, then quantize once per bin. This keeps fully
  // opaque histograms byte-for-byte compatible while preventing hidden RGB in
  // transparent pixels from affecting the scopes.
  const weightedR = new Float64Array(256);
  const weightedG = new Float64Array(256);
  const weightedB = new Float64Array(256);
  const weightedLuminance = new Float64Array(256);

  for (let index = 0; index < data.length; index += 4) {
    const weight = data[index + 3] / 255;
    if (weight === 0) continue;

    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];

    weightedR[red] += weight;
    weightedG[green] += weight;
    weightedB[blue] += weight;

    const lum = Math.round(red * 0.2126 + green * 0.7152 + blue * 0.0722);
    weightedLuminance[lum] += weight;
  }

  let peak = 0;
  for (let value = 0; value < 256; value += 1) {
    r[value] = Math.round(weightedR[value]);
    g[value] = Math.round(weightedG[value]);
    b[value] = Math.round(weightedB[value]);
    luminance[value] = Math.round(weightedLuminance[value]);
    peak = Math.max(peak, r[value], g[value], b[value], luminance[value]);
  }

  return { r, g, b, luminance, peak };
};
