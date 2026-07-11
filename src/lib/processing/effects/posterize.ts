import { clampByte } from '../../core/math';

export const applyPosterize = (source: ImageData, levels: number): ImageData => {
  const step = 255 / Math.max(2, Math.round(levels));
  const output = new Uint8ClampedArray(source.data.length);

  for (let index = 0; index < source.data.length; index += 4) {
    output[index] = clampByte(Math.round(source.data[index] / step) * step);
    output[index + 1] = clampByte(Math.round(source.data[index + 1] / step) * step);
    output[index + 2] = clampByte(Math.round(source.data[index + 2] / step) * step);
    output[index + 3] = source.data[index + 3];
  }

  return new ImageData(output, source.width, source.height);
};