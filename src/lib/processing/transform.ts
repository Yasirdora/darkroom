import { ImageBuffer } from '../core/image-buffer';
import type { CropRect, Transform } from '../core/types';

const hasRotationOrFlip = (transform: Transform): boolean =>
  transform.rotation !== 0 || transform.flipH || transform.flipV;

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
type AnyContext2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * Creates a 2D canvas that works both on the main thread and inside a Web
 * Worker (where `document` does not exist). The full-resolution export
 * pipeline runs in a worker, so transforms must not touch the DOM.
 */
const createCanvas = (width: number, height: number): AnyCanvas => {
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  return new OffscreenCanvas(width, height);
};

const getContext = (canvas: AnyCanvas): AnyContext2D => {
  const context = (canvas as HTMLCanvasElement).getContext('2d', {
    willReadFrequently: true,
  }) as AnyContext2D | null;
  if (!context) {
    throw new Error('Canvas 2D is not available.');
  }
  return context;
};

const drawToCanvas = (source: ImageBuffer): AnyCanvas => {
  const canvas = createCanvas(source.width, source.height);
  getContext(canvas).putImageData(source.toImageData(), 0, 0);
  return canvas;
};

const canvasToBuffer = (canvas: AnyCanvas): ImageBuffer => {
  const imageData = getContext(canvas).getImageData(0, 0, canvas.width, canvas.height);
  return ImageBuffer.fromImageData(imageData);
};

export const fullCropRect = (): CropRect => ({
  x: 0,
  y: 0,
  width: 1,
  height: 1,
});

export const cropsNearlyEqual = (a: CropRect, b: CropRect, epsilon = 0.0005): boolean =>
  Math.abs(a.x - b.x) < epsilon &&
  Math.abs(a.y - b.y) < epsilon &&
  Math.abs(a.width - b.width) < epsilon &&
  Math.abs(a.height - b.height) < epsilon;

/**
 * Largest centered crop of `targetAspect` (width÷height in pixels) that fits the frame.
 */
export const largestCropForAspect = (
  frameAspect: number,
  targetAspect: number,
): CropRect => {
  let width: number;
  let height: number;

  if (frameAspect >= targetAspect) {
    height = 1;
    width = targetAspect / frameAspect;
  } else {
    width = 1;
    height = frameAspect / targetAspect;
  }

  return {
    x: (1 - width) / 2,
    y: (1 - height) / 2,
    width,
    height,
  };
};

/**
 * Fits an existing crop to a target pixel aspect ratio.
 * `frameAspect` is the displayed image width÷height (after rotation).
 */
export const constrainCropToAspect = (
  crop: CropRect,
  targetAspect: number | null,
  frameAspect: number,
): CropRect => {
  if (!targetAspect || frameAspect <= 0) {
    return crop;
  }

  const currentPixelAspect = (crop.width / crop.height) * frameAspect;
  const relativeError = Math.abs(currentPixelAspect - targetAspect) / targetAspect;
  if (relativeError < 0.002) {
    return crop;
  }

  let width = crop.width;
  let height = crop.height;
  let x = crop.x;
  let y = crop.y;

  if (currentPixelAspect > targetAspect) {
    width = (crop.height * targetAspect) / frameAspect;
    x += (crop.width - width) / 2;
  } else if (currentPixelAspect < targetAspect) {
    height = (crop.width * frameAspect) / targetAspect;
    y += (crop.height - height) / 2;
  }

  return {
    x: Math.max(0, Math.min(1 - width, x)),
    y: Math.max(0, Math.min(1 - height, y)),
    width: Math.min(1, width),
    height: Math.min(1, height),
  };
};

const applyRotationAndFlip = (source: ImageBuffer, transform: Transform): ImageBuffer => {
  if (!hasRotationOrFlip(transform)) {
    return source.clone();
  }

  const sourceCanvas = drawToCanvas(source);
  // Normalize to 0..359 — JS `%` keeps the sign of negative rotations.
  const rotation = ((transform.rotation % 360) + 360) % 360;
  const swap = rotation === 90 || rotation === 270;
  const rotated = createCanvas(
    swap ? source.height : source.width,
    swap ? source.width : source.height,
  );

  const rotatedContext = getContext(rotated);
  rotatedContext.translate(rotated.width / 2, rotated.height / 2);
  rotatedContext.rotate((rotation * Math.PI) / 180);
  rotatedContext.scale(transform.flipH ? -1 : 1, transform.flipV ? -1 : 1);
  rotatedContext.drawImage(sourceCanvas, -source.width / 2, -source.height / 2);

  return canvasToBuffer(rotated);
};

const applyCropRect = (source: ImageBuffer, crop: CropRect): ImageBuffer => {
  const sx = Math.max(0, Math.min(source.width - 1, Math.round(crop.x * source.width)));
  const sy = Math.max(0, Math.min(source.height - 1, Math.round(crop.y * source.height)));
  const sw = Math.max(1, Math.min(source.width - sx, Math.round(crop.width * source.width)));
  const sh = Math.max(1, Math.min(source.height - sy, Math.round(crop.height * source.height)));

  const cropped = createCanvas(sw, sh);
  const croppedContext = getContext(cropped);

  const sourceCanvas = drawToCanvas(source);
  croppedContext.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvasToBuffer(cropped);
};

/**
 * Applies rotation and flips for live preview.
 * Crop is overlay-only until the user clicks Apply Crop.
 */
export const applyTransform = (source: ImageBuffer, transform: Transform): ImageBuffer =>
  applyRotationAndFlip(source, transform);

/**
 * Applies rotation, flips, and crop — used when baking the crop into pixels.
 */
export const applyTransformForExport = (source: ImageBuffer, transform: Transform): ImageBuffer => {
  let current = applyRotationAndFlip(source, transform);
  if (transform.crop) {
    current = applyCropRect(current, transform.crop);
  }
  return current;
};

/** Bakes the current transform into pixel data and resets transform state. */
export const bakeTransform = (
  source: ImageBuffer,
  transform: Transform,
): { buffer: ImageBuffer; transform: Transform } => {
  const buffer = applyTransformForExport(source, transform);
  return {
    buffer,
    transform: {
      rotation: 0,
      flipH: false,
      flipV: false,
      crop: null,
      aspectRatio: 'free',
    },
  };
};