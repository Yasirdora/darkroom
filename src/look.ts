import { adoptPixelBuffer, assertPixelBuffer } from './buffer.js';
import { applyLut } from './lut.js';
import { clamp, clampByte, seededNoise } from './math.js';
import type { GrainSpec, Look, PixelBuffer } from './types.js';

/** Apply deterministic, alpha-preserving film grain from a generic look. */
export const applyFilmGrain = (
  source: PixelBuffer,
  grain: GrainSpec,
  intensity = 100,
): PixelBuffer => {
  assertPixelBuffer(source);
  const amount = clamp(Number.isFinite(grain.amount) ? grain.amount : 0, 0, 100) / 100
    * clamp(Number.isFinite(intensity) ? intensity : 0, 0, 100) / 100;
  if (amount <= 0.001) return source;
  // GrainSpec intentionally preserves the app's established preset semantics.
  const warmth = clamp(Number.isFinite(grain.warmth) ? grain.warmth : 0, 0, 1);
  const size = clamp(Number.isFinite(grain.size) ? grain.size : 0, 0, 1);
  const output = new Uint8ClampedArray(source.data);
  const scale = 0.6 + size * 1.4;
  for (let index = 0; index < output.length; index += 4) {
    if (source.data[index + 3] === 0) continue;
    const x = (index / 4) % source.width;
    const y = Math.floor(index / 4 / source.width);
    const seed = x * 0.91 * scale + y * 1.37 * scale + index * 0.17;
    const noise = seededNoise(seed) * 42 * amount;
    output[index] = clampByte(output[index] + noise * warmth);
    output[index + 1] = clampByte(output[index + 1] + noise * 0.35);
    output[index + 2] = clampByte(output[index + 2] + noise * (1 - warmth) * 0.5);
  }
  return adoptPixelBuffer({ width: source.width, height: source.height, data: output });
};

export const applyLook = (
  source: PixelBuffer,
  look: Look,
  intensity = 100,
): PixelBuffer => {
  assertPixelBuffer(source);
  const normalizedIntensity = clamp(Number.isFinite(intensity) ? intensity : 0, 0, 100);
  let output = applyLut(source, look.lut, normalizedIntensity);
  if (look.grain && normalizedIntensity > 0) {
    output = applyFilmGrain(output, look.grain, normalizedIntensity);
  }
  return output;
};
