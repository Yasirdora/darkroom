import { DarkroomError } from './errors.js';
import { DARKROOM_LIMITS } from './limits.js';
import { clamp, lerp } from './math.js';
import type { PixelBuffer, PixelBufferInput } from './types.js';

const validatedBuffers = new WeakSet<object>();

const validateDimensions = (width: number, height: number, maxPixels: number): number => {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new DarkroomError('INVALID_DIMENSIONS', 'Pixel dimensions must be positive safe integers.');
  }
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > maxPixels) {
    throw new DarkroomError(
      'RESOURCE_LIMIT_EXCEEDED',
      `Pixel buffer exceeds the ${maxPixels.toLocaleString('en-US')} pixel limit.`,
    );
  }
  return pixels;
};

/** Cheap structural validation for public processing functions; does not copy pixels. */
export const assertPixelBuffer = (input: PixelBuffer): void => {
  if (typeof input !== 'object' || input === null || !(input.data instanceof Uint8ClampedArray)) {
    throw new DarkroomError('BUFFER_LENGTH_MISMATCH', 'Expected an RGBA Uint8ClampedArray pixel buffer.');
  }
  const pixels = validateDimensions(input.width, input.height, DARKROOM_LIMITS.maxImagePixels);
  if (input.data.length !== pixels * 4) {
    throw new DarkroomError('BUFFER_LENGTH_MISMATCH', 'Pixel buffer data length does not match dimensions.');
  }
};

export const createPixelBuffer = (
  input: PixelBufferInput,
  options: { readonly maxPixels?: number } = {},
): PixelBuffer => {
  const maxPixels = options.maxPixels ?? DARKROOM_LIMITS.maxImagePixels;
  if (!Number.isSafeInteger(maxPixels) || maxPixels <= 0) {
    throw new DarkroomError('INVALID_DIMENSIONS', 'maxPixels must be a positive safe integer.');
  }
  const pixels = validateDimensions(input.width, input.height, maxPixels);
  if (input.data.length !== pixels * 4) {
    throw new DarkroomError(
      'BUFFER_LENGTH_MISMATCH',
      `Expected ${pixels * 4} RGBA channel values, received ${input.data.length}.`,
    );
  }

  return adoptPixelBuffer({
    width: input.width,
    height: input.height,
    data: new Uint8ClampedArray(input.data),
  });
};

/** Internal ownership-transfer helper for freshly allocated engine buffers. */
export const adoptPixelBuffer = (input: {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}): PixelBuffer => {
  const pixels = validateDimensions(input.width, input.height, DARKROOM_LIMITS.maxImagePixels);
  if (input.data.length !== pixels * 4) {
    throw new DarkroomError('BUFFER_LENGTH_MISMATCH', 'Owned RGBA data length is invalid.');
  }
  const buffer = Object.freeze({ width: input.width, height: input.height, data: input.data });
  validatedBuffers.add(buffer);
  return buffer;
};

export const ensurePixelBuffer = (input: PixelBuffer): PixelBuffer =>
  validatedBuffers.has(input) ? input : createPixelBuffer(input);

export const clonePixelBuffer = (source: PixelBuffer): PixelBuffer => {
  assertPixelBuffer(source);
  return adoptPixelBuffer({
    width: source.width,
    height: source.height,
    data: new Uint8ClampedArray(source.data),
  });
};

/** Pure, alpha-correct bilinear resize suitable for Node, browsers and workers. */
export const resizePixelBuffer = (
  source: PixelBuffer,
  width: number,
  height: number,
): PixelBuffer => {
  validateDimensions(source.width, source.height, DARKROOM_LIMITS.maxImagePixels);
  validateDimensions(width, height, DARKROOM_LIMITS.maxImagePixels);
  if (source.data.length !== source.width * source.height * 4) {
    throw new DarkroomError('BUFFER_LENGTH_MISMATCH', 'Source RGBA data length is invalid.');
  }
  if (source.width === width && source.height === height) return clonePixelBuffer(source);

  const output = new Uint8ClampedArray(width * height * 4);
  const scaleX = source.width / width;
  const scaleY = source.height / height;

  for (let y = 0; y < height; y += 1) {
    const sourceY = clamp((y + 0.5) * scaleY - 0.5, 0, source.height - 1);
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(source.height - 1, y0 + 1);
    const ty = sourceY - y0;

    for (let x = 0; x < width; x += 1) {
      const sourceX = clamp((x + 0.5) * scaleX - 0.5, 0, source.width - 1);
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(source.width - 1, x0 + 1);
      const tx = sourceX - x0;
      const indices = [
        (y0 * source.width + x0) * 4,
        (y0 * source.width + x1) * 4,
        (y1 * source.width + x0) * 4,
        (y1 * source.width + x1) * 4,
      ];
      const weights = [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty];
      const destination = (y * width + x) * 4;
      let alpha = 0;
      let red = 0;
      let green = 0;
      let blue = 0;

      for (let sample = 0; sample < 4; sample += 1) {
        const index = indices[sample];
        const a = source.data[index + 3] / 255;
        const weight = weights[sample];
        alpha += a * weight;
        red += source.data[index] * a * weight;
        green += source.data[index + 1] * a * weight;
        blue += source.data[index + 2] * a * weight;
      }

      output[destination + 3] = Math.round(alpha * 255);
      if (alpha > 0) {
        output[destination] = Math.round(red / alpha);
        output[destination + 1] = Math.round(green / alpha);
        output[destination + 2] = Math.round(blue / alpha);
      } else {
        // Preserve a deterministic interpolation of hidden RGB without allowing it to bleed.
        const topR = lerp(source.data[indices[0]], source.data[indices[1]], tx);
        const bottomR = lerp(source.data[indices[2]], source.data[indices[3]], tx);
        const topG = lerp(source.data[indices[0] + 1], source.data[indices[1] + 1], tx);
        const bottomG = lerp(source.data[indices[2] + 1], source.data[indices[3] + 1], tx);
        const topB = lerp(source.data[indices[0] + 2], source.data[indices[1] + 2], tx);
        const bottomB = lerp(source.data[indices[2] + 2], source.data[indices[3] + 2], tx);
        output[destination] = Math.round(lerp(topR, bottomR, ty));
        output[destination + 1] = Math.round(lerp(topG, bottomG, ty));
        output[destination + 2] = Math.round(lerp(topB, bottomB, ty));
      }
    }
  }

  return adoptPixelBuffer({ width, height, data: output });
};

export const resizeToFit = (source: PixelBuffer, maxDimension: number): PixelBuffer => {
  assertPixelBuffer(source);
  if (!Number.isSafeInteger(maxDimension) || maxDimension <= 0) {
    throw new DarkroomError('INVALID_DIMENSIONS', 'maxDimension must be a positive integer.');
  }
  const longest = Math.max(source.width, source.height);
  if (longest <= maxDimension) return clonePixelBuffer(source);
  const scale = maxDimension / longest;
  return resizePixelBuffer(
    source,
    Math.max(1, Math.round(source.width * scale)),
    Math.max(1, Math.round(source.height * scale)),
  );
};
