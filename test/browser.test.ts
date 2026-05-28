import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DarkroomError } from '../src/errors.js';
import { DARKROOM_LIMITS } from '../src/limits.js';
import type { PixelBuffer } from '../src/types.js';
import {
  decodeImageFile,
  pixelBufferFromImageBitmap,
  pixelBufferFromImageData,
  pixelBufferToImageData,
} from '../src/browser/index.js';

class NodeImageData {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;

  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}

const originalImageData = globalThis.ImageData;
const originalOffscreenCanvas = globalThis.OffscreenCanvas;
const originalCreateImageBitmap = globalThis.createImageBitmap;

beforeEach(() => {
  Object.defineProperty(globalThis, 'ImageData', {
    configurable: true,
    value: NodeImageData,
    writable: true,
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, 'ImageData', {
    configurable: true,
    value: originalImageData,
    writable: true,
  });
  Object.defineProperty(globalThis, 'OffscreenCanvas', {
    configurable: true,
    value: originalOffscreenCanvas,
    writable: true,
  });
  Object.defineProperty(globalThis, 'createImageBitmap', {
    configurable: true,
    value: originalCreateImageBitmap,
    writable: true,
  });
  vi.restoreAllMocks();
});

const pngHeader = (width: number, height: number): Uint8Array => {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
};

const fakeFile = (bytes: Uint8Array, type = 'image/png'): File => ({
  size: bytes.length,
  type,
  slice: (start?: number, end?: number) => ({
    arrayBuffer: async () => bytes.slice(start, end).buffer,
  }),
} as unknown as File);

describe('browser adapter', () => {
  it('is import-safe in a runtime without document or canvas globals', async () => {
    expect(await import('../src/browser/index.js')).toHaveProperty('decodeImageFile');
  });

  it('defensively copies ImageData in both directions', () => {
    const pixels = new Uint8ClampedArray([10, 20, 30, 40]);
    const buffer = pixelBufferFromImageData(new ImageData(pixels, 1, 1));
    pixels[0] = 255;
    expect(buffer.data[0]).toBe(10);

    const image = pixelBufferToImageData(buffer);
    image.data[1] = 255;
    expect(buffer.data[1]).toBe(20);
  });

  it('validates a malformed buffer before constructing ImageData', () => {
    const malformed = { width: 1, height: 1, data: new Uint8ClampedArray(3) } as PixelBuffer;
    expect(() => pixelBufferToImageData(malformed)).toThrow(DarkroomError);
  });

  it('rejects encoded image byte and pixel limits before browser allocation', async () => {
    const oversizedFile = {
      size: DARKROOM_LIMITS.maxImageBytes + 1,
      type: 'image/png',
    } as File;
    await expect(decodeImageFile(oversizedFile)).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT_EXCEEDED',
    });

    const oversizedDimensions = fakeFile(pngHeader(4_000, 4_000));
    await expect(decodeImageFile(oversizedDimensions)).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT_EXCEEDED',
    });
    expect(globalThis.createImageBitmap).toBeUndefined();
  });

  it('reports decoded bitmap pixel limits without allocating a canvas', () => {
    const createCanvas = vi.fn();
    Object.defineProperty(globalThis, 'OffscreenCanvas', {
      configurable: true,
      value: createCanvas,
      writable: true,
    });

    const bitmap = {
      width: DARKROOM_LIMITS.maxImagePixels,
      height: 2,
    } as ImageBitmap;

    expect(() => pixelBufferFromImageBitmap(bitmap)).toThrowError(
      expect.objectContaining({ code: 'RESOURCE_LIMIT_EXCEEDED' }),
    );
    expect(createCanvas).not.toHaveBeenCalled();
  });

  it('preserves decoded bitmap resource-limit errors through decodeImageFile', async () => {
    const bitmap = {
      width: DARKROOM_LIMITS.maxImagePixels,
      height: 2,
      close: vi.fn(),
    } as unknown as ImageBitmap;
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      value: vi.fn().mockResolvedValue(bitmap),
      writable: true,
    });
    const createCanvas = vi.fn();
    Object.defineProperty(globalThis, 'OffscreenCanvas', {
      configurable: true,
      value: createCanvas,
      writable: true,
    });

    await expect(decodeImageFile(fakeFile(pngHeader(1, 1)))).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT_EXCEEDED',
    });
    expect(createCanvas).not.toHaveBeenCalled();
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it('reports default conversion when a requested none-conversion retry is not applied', async () => {
    const bitmap = { width: 1, height: 1, close: vi.fn() } as unknown as ImageBitmap;
    const createBitmap = vi.fn()
      .mockRejectedValueOnce(new Error('colorSpaceConversion option unsupported'))
      .mockResolvedValueOnce(bitmap);
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      value: createBitmap,
      writable: true,
    });

    class TestCanvas {
      getContext(): OffscreenCanvasRenderingContext2D {
        return {
          drawImage: vi.fn(),
          getImageData: () => new ImageData(new Uint8ClampedArray([7, 8, 9, 255]), 1, 1),
        } as unknown as OffscreenCanvasRenderingContext2D;
      }
    }
    Object.defineProperty(globalThis, 'OffscreenCanvas', {
      configurable: true,
      value: TestCanvas,
      writable: true,
    });

    const decoded = await decodeImageFile(fakeFile(pngHeader(1, 1)), {
      colorSpaceConversion: 'none',
    });
    expect(decoded.colorSpaceConversionApplied).toBe('default');
    expect([...decoded.buffer.data]).toEqual([7, 8, 9, 255]);
    expect(createBitmap).toHaveBeenCalledTimes(2);
    expect(createBitmap.mock.calls[0][1]).toMatchObject({ colorSpaceConversion: 'none' });
    expect(createBitmap.mock.calls[1][1]).not.toHaveProperty('colorSpaceConversion');
    expect(bitmap.close).toHaveBeenCalledOnce();
  });
});
