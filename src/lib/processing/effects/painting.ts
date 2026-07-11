import { clampByte } from '../../core/math';
import { parseCssColor } from '../color';

const mix = (base: number, tint: number, amount: number) =>
  clampByte(base * (1 - amount) + tint * amount);

export const applyPainting = (
  source: ImageData,
  intensity: number,
  color1 = '#f6d7b0',
  color2 = '#4a5d7a',
): ImageData => {
  const amount = intensity / 100;
  const { width, height, data } = source;
  const output = new Uint8ClampedArray(data);
  const primary = parseCssColor(color1);
  const secondary = parseCssColor(color2);

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = (y * width + x) * 4;
      const left = (y * width + (x - 1)) * 4;
      const right = (y * width + (x + 1)) * 4;
      const up = ((y - 1) * width + x) * 4;
      const down = ((y + 1) * width + x) * 4;

      const edge =
        Math.abs(data[right] - data[left]) +
        Math.abs(data[down] - data[up]) +
        Math.abs(data[right + 1] - data[left + 1]) +
        Math.abs(data[down + 1] - data[up + 1]) +
        Math.abs(data[right + 2] - data[left + 2]) +
        Math.abs(data[down + 2] - data[up + 2]);

      const smoothR = (data[left] + data[right] + data[up] + data[down]) / 4;
      const smoothG = (data[left + 1] + data[right + 1] + data[up + 1] + data[down + 1]) / 4;
      const smoothB = (data[left + 2] + data[right + 2] + data[up + 2] + data[down + 2]) / 4;

      const paintAmount = Math.min(1, amount * 0.75);
      const edgeAmount = Math.min(1, (edge / 900) * amount);

      let r = mix(data[index], smoothR, paintAmount);
      let g = mix(data[index + 1], smoothG, paintAmount);
      let b = mix(data[index + 2], smoothB, paintAmount);

      r = mix(r, primary.r, edgeAmount * 0.35);
      g = mix(g, primary.g, edgeAmount * 0.35);
      b = mix(b, primary.b, edgeAmount * 0.35);

      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      const shadowMix = Math.max(0, 1 - luma / 255) * amount * 0.2;
      r = mix(r, secondary.r, shadowMix);
      g = mix(g, secondary.g, shadowMix);
      b = mix(b, secondary.b, shadowMix);

      output[index] = r;
      output[index + 1] = g;
      output[index + 2] = b;
      output[index + 3] = data[index + 3];
    }
  }

  return new ImageData(output, width, height);
};