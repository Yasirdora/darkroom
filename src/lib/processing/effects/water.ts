import { clampByte } from '../../core/math';

const sample = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
): [number, number, number, number] => {
  const sx = Math.min(width - 1, Math.max(0, Math.round(x)));
  const sy = Math.min(height - 1, Math.max(0, Math.round(y)));
  const index = (sy * width + sx) * 4;
  return [data[index], data[index + 1], data[index + 2], data[index + 3]];
};

export const applyWater = (source: ImageData, intensity: number): ImageData => {
  const amount = intensity / 100;
  const { width, height, data } = source;
  const output = new Uint8ClampedArray(data.length);
  const amplitude = 12 * amount;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offsetX = Math.sin(y * 0.04) * amplitude;
      const offsetY = Math.cos(x * 0.04) * amplitude * 0.5;
      const [r, g, b, a] = sample(data, width, height, x + offsetX, y + offsetY);
      const index = (y * width + x) * 4;
      output[index] = clampByte(r);
      output[index + 1] = clampByte(g);
      output[index + 2] = clampByte(b);
      output[index + 3] = a;
    }
  }

  return new ImageData(output, width, height);
};