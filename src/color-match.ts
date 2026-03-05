import { assertPixelBuffer, clonePixelBuffer } from './buffer.js';
import { clampByte, lerp } from './math.js';
import type { ColorMatchStats, PixelBuffer } from './types.js';

/**
 * Reference-image color matching — statistical color transfer in lαβ space
 * (Reinhard, Ashikhmin, Gooch & Shirley, "Color Transfer between Images").
 *
 * lαβ is a log-space opponent-color representation whose axes are nearly
 * decorrelated for natural images, so matching mean and standard deviation
 * per axis transfers the reference's palette, warmth, and contrast without
 * the hue twisting that naive per-RGB-channel matching produces.
 *
 * Pure math — safe to run inside the pipeline worker (no DOM).
 */

// Reinhard's RGB→LMS matrix (assumes display-referred RGB).
const RGB_TO_LMS = [
  0.3811, 0.5783, 0.0402,
  0.1967, 0.7244, 0.0782,
  0.0241, 0.1288, 0.8444,
] as const;

const LMS_TO_RGB = [
  4.4679, -3.5873, 0.1193,
  -1.2186, 2.3809, -0.1624,
  0.0497, -0.2439, 1.2045,
] as const;

const SQRT3 = Math.sqrt(3);
const SQRT6 = Math.sqrt(6);
const SQRT2 = Math.sqrt(2);

/** Guards log10(0); ~half a code value in 0-255 space. */
const EPS = 0.002;

const rgbToLab = (r: number, g: number, b: number): [number, number, number] => {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;

  const L = Math.log10(Math.max(EPS, RGB_TO_LMS[0] * rn + RGB_TO_LMS[1] * gn + RGB_TO_LMS[2] * bn));
  const M = Math.log10(Math.max(EPS, RGB_TO_LMS[3] * rn + RGB_TO_LMS[4] * gn + RGB_TO_LMS[5] * bn));
  const S = Math.log10(Math.max(EPS, RGB_TO_LMS[6] * rn + RGB_TO_LMS[7] * gn + RGB_TO_LMS[8] * bn));

  return [
    (L + M + S) / SQRT3,
    (L + M - 2 * S) / SQRT6,
    (L - M) / SQRT2,
  ];
};

const labToRgb = (l: number, a: number, bb: number): [number, number, number] => {
  const c1 = l / SQRT3;
  const c2 = a / SQRT6;
  const c3 = bb / SQRT2;

  const L = Math.pow(10, c1 + c2 + c3);
  const M = Math.pow(10, c1 + c2 - c3);
  const S = Math.pow(10, c1 - 2 * c2);

  return [
    (LMS_TO_RGB[0] * L + LMS_TO_RGB[1] * M + LMS_TO_RGB[2] * S) * 255,
    (LMS_TO_RGB[3] * L + LMS_TO_RGB[4] * M + LMS_TO_RGB[5] * S) * 255,
    (LMS_TO_RGB[6] * L + LMS_TO_RGB[7] * M + LMS_TO_RGB[8] * S) * 255,
  ];
};

/**
 * Computes per-axis mean and standard deviation in lαβ space.
 * Samples with a stride on large images — statistics converge long before
 * every pixel is visited.
 */
export const computeColorMatchStats = (source: PixelBuffer): ColorMatchStats => {
  assertPixelBuffer(source);
  const { data } = source;
  const pixelCount = data.length / 4;
  // Aim for ~40k samples.
  const stride = Math.max(1, Math.floor(pixelCount / 40000)) * 4;

  let totalWeight = 0;
  const sum = [0, 0, 0];
  const sumSq = [0, 0, 0];

  const accumulate = (step: number): void => {
    for (let i = 0; i < data.length; i += step) {
      const weight = data[i + 3] / 255;
      if (weight === 0) continue;

      const lab = rgbToLab(data[i], data[i + 1], data[i + 2]);
      for (let c = 0; c < 3; c += 1) {
        sum[c] += lab[c] * weight;
        sumSq[c] += lab[c] * lab[c] * weight;
      }
      totalWeight += weight;
    }
  };

  accumulate(stride);
  if (totalWeight === 0 && stride > 4) {
    // A regular stride can land entirely on transparent texels. Fall back to
    // a complete pass before declaring a reference invalid.
    accumulate(4);
  }

  const mean: [number, number, number] = [0, 0, 0];
  const std: [number, number, number] = [0, 0, 0];
  if (totalWeight === 0) {
    return { mean, std, sampleWeight: 0 };
  }

  for (let c = 0; c < 3; c += 1) {
    mean[c] = sum[c] / totalWeight;
    std[c] = Math.sqrt(Math.max(0, sumSq[c] / totalWeight - mean[c] * mean[c]));
  }

  return { mean, std, sampleWeight: totalWeight };
};

const hasUsableStats = (stats: ColorMatchStats): boolean =>
  Number.isFinite(stats.sampleWeight) &&
  stats.sampleWeight > 0 &&
  [...stats.mean, ...stats.std].every(Number.isFinite);

/**
 * Transfers the reference statistics onto the source image.
 * `strength` is 0–100; 100 = full match.
 */
export const applyColorMatch = (
  source: PixelBuffer,
  reference: ColorMatchStats,
  strength: number,
): PixelBuffer => {
  assertPixelBuffer(source);
  const amount = Number.isFinite(strength)
    ? Math.max(0, Math.min(1, strength / 100))
    : 0;
  if (amount <= 0 || !hasUsableStats(reference)) return source;

  const srcStats = computeColorMatchStats(source);
  if (!hasUsableStats(srcStats)) return source;

  // Per-axis scale, clamped so a nearly-flat source or reference can't
  // explode contrast (e.g. matching a colorful photo to a monochrome frame).
  const scale = [0, 0, 0];
  for (let c = 0; c < 3; c += 1) {
    const s = reference.std[c] / Math.max(srcStats.std[c], 1e-4);
    scale[c] = Math.max(0.25, Math.min(4, s));
  }

  const output = clonePixelBuffer(source);
  const { data } = output;

  for (let i = 0; i < data.length; i += 4) {
    // Preserve hidden RGB exactly. Besides being unnecessary work, changing
    // transparent texels can create color fringes after later resampling.
    if (data[i + 3] === 0) continue;

    const lab = rgbToLab(data[i], data[i + 1], data[i + 2]);
    const matched: [number, number, number] = [0, 0, 0];
    for (let c = 0; c < 3; c += 1) {
      matched[c] = (lab[c] - srcStats.mean[c]) * scale[c] + reference.mean[c];
    }
    const [r, g, b] = labToRgb(matched[0], matched[1], matched[2]);

    data[i] = clampByte(lerp(data[i], r, amount));
    data[i + 1] = clampByte(lerp(data[i + 1], g, amount));
    data[i + 2] = clampByte(lerp(data[i + 2], b, amount));
  }

  return output;
};
