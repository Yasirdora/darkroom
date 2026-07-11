import { clampByte } from '../../core/math';
import { parseCssColor } from '../color';

export const applyHalftone = (
  source: ImageData,
  intensity: number,
  dotColor = '#111111',
  background = '#f4f4f4',
): ImageData => {
  const amount = intensity / 100;
  const { width, height, data } = source;
  const output = new Uint8ClampedArray(data.length);
  const fg = parseCssColor(dotColor);
  const bg = parseCssColor(background);
  const spacing = Math.max(4, Math.round(10 - amount * 6));

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const luma =
        0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2];
      const cellX = x % spacing;
      const cellY = y % spacing;
      const centerX = spacing / 2;
      const centerY = spacing / 2;
      const distance = Math.hypot(cellX - centerX, cellY - centerY);
      const radius = (1 - luma / 255) * (spacing * 0.45) * amount;
      const useDot = distance <= radius;

      output[index] = clampByte(useDot ? fg.r : bg.r);
      output[index + 1] = clampByte(useDot ? fg.g : bg.g);
      output[index + 2] = clampByte(useDot ? fg.b : bg.b);
      output[index + 3] = 255;
    }
  }

  return new ImageData(output, width, height);
};