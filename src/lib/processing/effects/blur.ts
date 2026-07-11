import { clampByte } from '../../core/math';

/**
 * Pro blur suite (web-optimized high bar).
 * - box (fast legacy)
 * - gaussian approx (iterated box)
 * - bilateral (edge preserving, pro skin/detail)
 * - bokeh (highlight aware shaped)
 */
export const applyBoxBlur = (source: ImageData, radius: number): ImageData => {
  if (radius <= 0) return cloneImageData(source);
  return separableBox(source, radius);
};

function cloneImageData(src: ImageData): ImageData {
  return new ImageData(new Uint8ClampedArray(src.data), src.width, src.height);
}

function separableBox(src: ImageData, radius: number): ImageData {
  const { width, height, data } = src;
  const out = new Uint8ClampedArray(data.length);
  const tmp = new Float32Array(data.length);
  const ws = radius * 2 + 1;

  // H
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = -radius; k <= radius; k++) {
        const sx = Math.min(width - 1, Math.max(0, x + k));
        const i = (y * width + sx) * 4;
        r += data[i]; g += data[i + 1]; b += data[i + 2]; a += data[i + 3];
      }
      const o = (y * width + x) * 4;
      tmp[o] = r / ws; tmp[o + 1] = g / ws; tmp[o + 2] = b / ws; tmp[o + 3] = a / ws;
    }
  }
  // V
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = -radius; k <= radius; k++) {
        const sy = Math.min(height - 1, Math.max(0, y + k));
        const i = (sy * width + x) * 4;
        r += tmp[i]; g += tmp[i + 1]; b += tmp[i + 2]; a += tmp[i + 3];
      }
      const o = (y * width + x) * 4;
      out[o] = clampByte(r / ws); out[o + 1] = clampByte(g / ws);
      out[o + 2] = clampByte(b / ws); out[o + 3] = clampByte(a / ws);
    }
  }
  return new ImageData(out, width, height);
}

/** Gaussian approx by 3x box passes (fast, good enough). */
export function applyGaussianBlur(src: ImageData, radius: number): ImageData {
  if (radius <= 0) return cloneImageData(src);
  let c = separableBox(src, radius);
  c = separableBox(c, Math.max(1, Math.floor(radius * 0.8)));
  c = separableBox(c, Math.max(1, Math.floor(radius * 0.6)));
  return c;
}

/** Bilateral: edge preserving (sigma spatial + color). Pro for skin/detail. */
export function applyBilateralBlur(src: ImageData, radius: number, sigmaColor = 25): ImageData {
  if (radius <= 0) return cloneImageData(src);
  const { width, height, data } = src;
  const out = new Uint8ClampedArray(data.length);
  const r2 = radius * radius;
  const sc2 = 2 * sigmaColor * sigmaColor;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const cr = data[o], cg = data[o + 1], cb = data[o + 2];
      let wr = 0, wg = 0, wb = 0, wa = 0, wsum = 0;

      for (let dy = -radius; dy <= radius; dy++) {
        const sy = Math.min(height - 1, Math.max(0, y + dy));
        for (let dx = -radius; dx <= radius; dx++) {
          const sx = Math.min(width - 1, Math.max(0, x + dx));
          const i = (sy * width + sx) * 4;
          const dr = data[i] - cr, dg = data[i + 1] - cg, db = data[i + 2] - cb;
          const dc = dr * dr + dg * dg + db * db;
          const ws = Math.exp(-(dx * dx + dy * dy) / (2 * r2));
          const wc = Math.exp(-dc / sc2);
          const w = ws * wc;
          wr += data[i] * w; wg += data[i + 1] * w; wb += data[i + 2] * w; wa += data[i + 3] * w;
          wsum += w;
        }
      }
      if (wsum <= 1e-6) {
        out[o] = data[o];
        out[o + 1] = data[o + 1];
        out[o + 2] = data[o + 2];
        out[o + 3] = data[o + 3];
      } else {
        out[o] = clampByte(wr / wsum);
        out[o + 1] = clampByte(wg / wsum);
        out[o + 2] = clampByte(wb / wsum);
        out[o + 3] = clampByte(wa / wsum);
      }
    }
  }
  return new ImageData(out, width, height);
}

/** Bokeh-ish: box + highlight lift (cheap lens feel). */
export function applyBokehBlur(src: ImageData, radius: number, threshold = 200): ImageData {
  const base = applyGaussianBlur(src, radius);
  const { data: bd } = base;
  const out = new Uint8ClampedArray(bd);
  for (let i = 0; i < bd.length; i += 4) {
    const lum = (bd[i] * 0.2126 + bd[i + 1] * 0.7152 + bd[i + 2] * 0.0722);
    if (lum > threshold) {
      const boost = (lum - threshold) / (255 - threshold) * 0.6;
      out[i] = clampByte(bd[i] + boost * 40);
      out[i + 1] = clampByte(bd[i + 1] + boost * 32);
      out[i + 2] = clampByte(bd[i + 2] + boost * 28);
    }
  }
  return new ImageData(out, src.width, src.height);
}