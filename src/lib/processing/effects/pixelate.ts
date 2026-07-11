export const applyPixelate = (source: ImageData, blockSize: number): ImageData => {
  const size = Math.max(2, Math.round(blockSize));
  const { width, height, data } = source;
  const output = new Uint8ClampedArray(data);

  for (let y = 0; y < height; y += size) {
    for (let x = 0; x < width; x += size) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;

      for (let py = y; py < Math.min(y + size, height); py += 1) {
        for (let px = x; px < Math.min(x + size, width); px += 1) {
          const index = (py * width + px) * 4;
          r += data[index];
          g += data[index + 1];
          b += data[index + 2];
          a += data[index + 3];
          count += 1;
        }
      }

      const avgR = Math.round(r / count);
      const avgG = Math.round(g / count);
      const avgB = Math.round(b / count);
      const avgA = Math.round(a / count);

      for (let py = y; py < Math.min(y + size, height); py += 1) {
        for (let px = x; px < Math.min(x + size, width); px += 1) {
          const index = (py * width + px) * 4;
          output[index] = avgR;
          output[index + 1] = avgG;
          output[index + 2] = avgB;
          output[index + 3] = avgA;
        }
      }
    }
  }

  return new ImageData(output, width, height);
};