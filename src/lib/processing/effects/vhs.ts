import { clampByte, seededNoise } from '../../core/math';

export const applyVhs = (source: ImageData, intensity: number): ImageData => {
  const amount = intensity / 100;
  const { width, height, data } = source;
  const output = new Uint8ClampedArray(data.length);

  for (let y = 0; y < height; y += 1) {
    const scanline = y % 3 === 0 ? 0.9 : 1;
    const wave = Math.sin(y * 0.08) * 3 * amount;

    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const shift = Math.round(4 * amount);
      const redIndex = (y * width + Math.min(width - 1, Math.max(0, x - shift))) * 4;
      const blueIndex = (y * width + Math.min(width - 1, Math.max(0, x + shift))) * 4;

      let r = data[redIndex] * scanline;
      let g = data[index + 1] * scanline;
      let b = data[blueIndex + 2] * scanline;

      const noise = seededNoise(index * 0.19 + y * 0.07 + 31) * 30 * amount;
      r += noise + wave;
      g += noise;
      b += noise - wave;

      output[index] = clampByte(r);
      output[index + 1] = clampByte(g);
      output[index + 2] = clampByte(b);
      output[index + 3] = data[index + 3];
    }
  }

  return new ImageData(output, width, height);
};