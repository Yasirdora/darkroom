import { adoptPixelBuffer, assertPixelBuffer } from './buffer.js';
import type { CropRect, PixelBuffer, Transform } from './types.js';

const hasPixelTransform = (transform: Transform): boolean =>
  transform.rotation !== 0 || transform.flipH || transform.flipV;

export const fullCropRect = (): CropRect => Object.freeze({ x: 0, y: 0, width: 1, height: 1 });

export const cropsNearlyEqual = (
  left: CropRect,
  right: CropRect,
  epsilon = 0.0005,
): boolean =>
  Math.abs(left.x - right.x) < epsilon
  && Math.abs(left.y - right.y) < epsilon
  && Math.abs(left.width - right.width) < epsilon
  && Math.abs(left.height - right.height) < epsilon;

export const largestCropForAspect = (frameAspect: number, targetAspect: number): CropRect => {
  if (!Number.isFinite(frameAspect) || frameAspect <= 0 || !Number.isFinite(targetAspect) || targetAspect <= 0) {
    return fullCropRect();
  }
  const width = frameAspect >= targetAspect ? targetAspect / frameAspect : 1;
  const height = frameAspect >= targetAspect ? 1 : frameAspect / targetAspect;
  return Object.freeze({ x: (1 - width) / 2, y: (1 - height) / 2, width, height });
};

export const constrainCropToAspect = (
  crop: CropRect,
  targetAspect: number | null,
  frameAspect: number,
): CropRect => {
  if (!targetAspect || targetAspect <= 0 || frameAspect <= 0) return Object.freeze({ ...crop });
  const currentAspect = (crop.width / crop.height) * frameAspect;
  let { x, y, width, height } = crop;
  if (currentAspect > targetAspect) {
    width = (height * targetAspect) / frameAspect;
    x += (crop.width - width) / 2;
  } else if (currentAspect < targetAspect) {
    height = (width * frameAspect) / targetAspect;
    y += (crop.height - height) / 2;
  }
  width = Math.min(1, Math.max(Number.EPSILON, width));
  height = Math.min(1, Math.max(Number.EPSILON, height));
  return Object.freeze({
    x: Math.max(0, Math.min(1 - width, x)),
    y: Math.max(0, Math.min(1 - height, y)),
    width,
    height,
  });
};

const rotateAndFlip = (source: PixelBuffer, transform: Transform): PixelBuffer => {
  if (!hasPixelTransform(transform)) return source;
  const swapsAxes = transform.rotation === 90 || transform.rotation === 270;
  const width = swapsAxes ? source.height : source.width;
  const height = swapsAxes ? source.width : source.height;
  const output = new Uint8ClampedArray(width * height * 4);

  for (let outputY = 0; outputY < height; outputY += 1) {
    for (let outputX = 0; outputX < width; outputX += 1) {
      let flippedX: number;
      let flippedY: number;
      switch (transform.rotation) {
        case 90:
          flippedX = outputY;
          flippedY = source.height - 1 - outputX;
          break;
        case 180:
          flippedX = source.width - 1 - outputX;
          flippedY = source.height - 1 - outputY;
          break;
        case 270:
          flippedX = source.width - 1 - outputY;
          flippedY = outputX;
          break;
        default:
          flippedX = outputX;
          flippedY = outputY;
      }
      const sourceX = transform.flipH ? source.width - 1 - flippedX : flippedX;
      const sourceY = transform.flipV ? source.height - 1 - flippedY : flippedY;
      const sourceOffset = (sourceY * source.width + sourceX) * 4;
      const outputOffset = (outputY * width + outputX) * 4;
      output.set(source.data.subarray(sourceOffset, sourceOffset + 4), outputOffset);
    }
  }
  return adoptPixelBuffer({ width, height, data: output });
};

const cropPixels = (source: PixelBuffer, crop: CropRect): PixelBuffer => {
  if (cropsNearlyEqual(crop, fullCropRect())) return source;
  const startX = Math.max(0, Math.min(source.width - 1, Math.round(crop.x * source.width)));
  const startY = Math.max(0, Math.min(source.height - 1, Math.round(crop.y * source.height)));
  const width = Math.max(1, Math.min(source.width - startX, Math.round(crop.width * source.width)));
  const height = Math.max(1, Math.min(source.height - startY, Math.round(crop.height * source.height)));
  const output = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceStart = ((startY + y) * source.width + startX) * 4;
    output.set(source.data.subarray(sourceStart, sourceStart + width * 4), y * width * 4);
  }
  return adoptPixelBuffer({ width, height, data: output });
};

export const applyTransform = (
  source: PixelBuffer,
  transform: Transform,
  includeCrop = false,
): PixelBuffer => {
  assertPixelBuffer(source);
  const transformed = rotateAndFlip(source, transform);
  return includeCrop && transform.crop ? cropPixels(transformed, transform.crop) : transformed;
};
