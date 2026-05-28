import { assertPixelBuffer, createPixelBuffer } from '../buffer.js';
import {
  assertImagePixelLimit,
  MAX_ENCODED_IMAGE_HEADER_BYTES,
  parseEncodedImageDimensions,
} from '../encoded-image-dimensions.js';
import { asDarkroomError, DarkroomError } from '../errors.js';
import { DARKROOM_LIMITS } from '../limits.js';
import type { PixelBuffer } from '../types.js';

export type DecodeColorSpaceConversion = 'default' | 'none';

export interface DecodeImageFileOptions {
  readonly colorSpaceConversion?: DecodeColorSpaceConversion;
}

export interface DecodedImageFile {
  readonly buffer: PixelBuffer;
  readonly orientationBaked: true;
  /** Option used by the successful decode call; browser conformance still applies. */
  readonly colorSpaceConversionApplied: DecodeColorSpaceConversion;
}

type CanvasLike = HTMLCanvasElement | OffscreenCanvas;
type ContextLike = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const assertBrowserImagePixelLimit = (
  dimensions: Readonly<{ width: number; height: number }>,
): void => {
  try {
    assertImagePixelLimit(dimensions, DARKROOM_LIMITS.maxImagePixels);
  } catch (error) {
    throw asDarkroomError(
      error,
      'RESOURCE_LIMIT_EXCEEDED',
      'Image dimensions exceed the decoded pixel limit.',
    );
  }
};

const createCanvas = (width: number, height: number): CanvasLike => {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw new DarkroomError('CANVAS_UNAVAILABLE', 'Canvas 2D is unavailable in this runtime.');
};

const getContext = (canvas: CanvasLike): ContextLike => {
  const context = canvas.getContext('2d', { willReadFrequently: true }) as ContextLike | null;
  if (!context) throw new DarkroomError('CANVAS_UNAVAILABLE', 'Canvas 2D context is unavailable.');
  return context;
};

export const pixelBufferFromImageData = (imageData: ImageData): PixelBuffer =>
  createPixelBuffer({ width: imageData.width, height: imageData.height, data: imageData.data });

export const pixelBufferToImageData = (buffer: PixelBuffer): ImageData => {
  assertPixelBuffer(buffer);
  return new ImageData(new Uint8ClampedArray(buffer.data), buffer.width, buffer.height);
};

export const pixelBufferFromImageBitmap = (bitmap: ImageBitmap): PixelBuffer => {
  assertBrowserImagePixelLimit(bitmap);
  const canvas = createCanvas(bitmap.width, bitmap.height);
  const context = getContext(canvas);
  context.drawImage(bitmap, 0, 0);
  return pixelBufferFromImageData(context.getImageData(0, 0, bitmap.width, bitmap.height));
};

export const decodeImageFile = async (
  file: File,
  options: DecodeImageFileOptions = {},
): Promise<DecodedImageFile> => {
  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    throw new DarkroomError('UNSUPPORTED_IMAGE', 'Image file is empty or has an invalid size.');
  }
  if (file.size > DARKROOM_LIMITS.maxImageBytes) {
    throw new DarkroomError('RESOURCE_LIMIT_EXCEEDED', 'Image file exceeds the encoded byte limit.');
  }
  const mimeType = file.type.trim().toLowerCase();
  if (!['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(mimeType)) {
    throw new DarkroomError('UNSUPPORTED_IMAGE', 'Only JPEG, PNG and WebP images are supported.');
  }

  try {
    const headerSize = Math.min(
      file.size,
      MAX_ENCODED_IMAGE_HEADER_BYTES,
      DARKROOM_LIMITS.maxEncodedHeaderBytes,
    );
    const header = new Uint8Array(await file.slice(0, headerSize).arrayBuffer());
    const dimensions = parseEncodedImageDimensions(header, file.size, mimeType);
    assertBrowserImagePixelLimit(dimensions);

    const requested = options.colorSpaceConversion ?? 'default';
    let applied = requested;
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file, {
        imageOrientation: 'from-image',
        colorSpaceConversion: requested,
      });
    } catch {
      applied = 'default';
      try {
        bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch {
        bitmap = await createImageBitmap(file);
      }
    }
    try {
      return Object.freeze({
        buffer: pixelBufferFromImageBitmap(bitmap),
        orientationBaked: true as const,
        colorSpaceConversionApplied: applied,
      });
    } finally {
      bitmap.close();
    }
  } catch (error) {
    throw asDarkroomError(error, 'DECODE_FAILED', 'Unable to decode image file.');
  }
};
