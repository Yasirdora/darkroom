import { describe, expect, it } from 'vitest';

import {
  adoptPixelBuffer,
  assertPixelBuffer,
  clonePixelBuffer,
  createPixelBuffer,
  ensurePixelBuffer,
  resizePixelBuffer,
  resizeToFit,
} from '../src/buffer.js';
import { DarkroomError } from '../src/errors.js';
import type { PixelBuffer } from '../src/types.js';

/**
 * Every public processing function takes one of these, and each one trusts that
 * `width * height * 4 === data.length`. That invariant is the only thing
 * standing between a malformed input and an out-of-bounds read in a tight
 * pixel loop, so it is worth pinning from both directions: what must be
 * accepted, and what must be refused.
 */

const solid = (
  width: number,
  height: number,
  rgba: [number, number, number, number],
): PixelBuffer => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = rgba[0];
    data[index + 1] = rgba[1];
    data[index + 2] = rgba[2];
    data[index + 3] = rgba[3];
  }
  return createPixelBuffer({ width, height, data });
};

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return error instanceof DarkroomError ? error.code : `not-a-DarkroomError:${String(error)}`;
  }
  return 'did-not-throw';
};

describe('pixel buffer construction', () => {
  it('copies the caller’s data rather than aliasing it', () => {
    const source = new Uint8ClampedArray([1, 2, 3, 4]);
    const buffer = createPixelBuffer({ width: 1, height: 1, data: source });
    source[0] = 255;
    expect(buffer.data[0]).toBe(1);
  });

  it('accepts any ArrayLike, not only a Uint8ClampedArray', () => {
    const buffer = createPixelBuffer({ width: 1, height: 1, data: [10, 20, 30, 40] });
    expect(buffer.data).toBeInstanceOf(Uint8ClampedArray);
    expect([...buffer.data]).toEqual([10, 20, 30, 40]);
  });

  it('clamps out-of-range channel values the way the RGBA contract implies', () => {
    const buffer = createPixelBuffer({ width: 1, height: 1, data: [300, -20, 12.6, 255] });
    expect([...buffer.data]).toEqual([255, 0, 13, 255]);
  });

  it('freezes the result so a consumer cannot reshape it', () => {
    const buffer = solid(1, 1, [0, 0, 0, 255]);
    expect(Object.isFrozen(buffer)).toBe(true);
  });

  it('rejects a data length that disagrees with the dimensions', () => {
    expect(codeOf(() => createPixelBuffer({ width: 2, height: 2, data: [0, 0, 0, 0] })))
      .toBe('BUFFER_LENGTH_MISMATCH');
  });

  it('rejects non-integer, zero and negative dimensions', () => {
    for (const dims of [{ width: 0, height: 1 }, { width: 1, height: -1 }, { width: 1.5, height: 2 }]) {
      expect(codeOf(() => createPixelBuffer({ ...dims, data: [] }))).toBe('INVALID_DIMENSIONS');
    }
  });

  it('rejects a pixel count beyond the limit', () => {
    expect(codeOf(() => createPixelBuffer({ width: 5000, height: 5000, data: [] }, { maxPixels: 100 })))
      .toBe('RESOURCE_LIMIT_EXCEEDED');
  });

  it('rejects a nonsensical maxPixels rather than treating it as unlimited', () => {
    expect(codeOf(() => createPixelBuffer({ width: 1, height: 1, data: [0, 0, 0, 0] }, { maxPixels: 0 })))
      .toBe('INVALID_DIMENSIONS');
  });
});

describe('validation helpers', () => {
  it('assertPixelBuffer refuses anything that is not an RGBA buffer', () => {
    for (const bad of [null, undefined, 42, 'buffer', {}, { width: 1, height: 1, data: [0, 0, 0, 0] }]) {
      expect(codeOf(() => assertPixelBuffer(bad as unknown as PixelBuffer)))
        .toBe('BUFFER_LENGTH_MISMATCH');
    }
  });

  it('ensurePixelBuffer returns an already-validated buffer untouched', () => {
    const buffer = solid(2, 2, [1, 2, 3, 4]);
    expect(ensurePixelBuffer(buffer)).toBe(buffer);
  });

  it('ensurePixelBuffer revalidates and copies a hand-built object', () => {
    const handmade: PixelBuffer = {
      width: 1,
      height: 1,
      data: new Uint8ClampedArray([9, 9, 9, 255]),
    };
    const ensured = ensurePixelBuffer(handmade);
    expect(ensured).not.toBe(handmade);
    expect([...ensured.data]).toEqual([9, 9, 9, 255]);
  });

  it('adoptPixelBuffer takes ownership without copying', () => {
    const data = new Uint8ClampedArray([1, 2, 3, 4]);
    const buffer = adoptPixelBuffer({ width: 1, height: 1, data });
    expect(buffer.data).toBe(data);
  });

  it('adoptPixelBuffer still refuses an inconsistent length', () => {
    expect(codeOf(() => adoptPixelBuffer({ width: 2, height: 1, data: new Uint8ClampedArray(4) })))
      .toBe('BUFFER_LENGTH_MISMATCH');
  });

  it('clonePixelBuffer produces an independent copy', () => {
    const original = solid(2, 1, [5, 6, 7, 255]);
    const copy = clonePixelBuffer(original);
    expect(copy).not.toBe(original);
    expect(copy.data).not.toBe(original.data);
    expect([...copy.data]).toEqual([...original.data]);
  });
});

describe('resizing', () => {
  it('returns an equal copy when the size is unchanged', () => {
    const original = solid(3, 3, [10, 20, 30, 255]);
    const same = resizePixelBuffer(original, 3, 3);
    expect(same).not.toBe(original);
    expect([...same.data]).toEqual([...original.data]);
  });

  it('preserves a solid colour through a downscale', () => {
    const original = solid(8, 8, [200, 100, 50, 255]);
    const smaller = resizePixelBuffer(original, 4, 4);
    expect(smaller.width).toBe(4);
    expect(smaller.height).toBe(4);
    for (let index = 0; index < smaller.data.length; index += 4) {
      expect(smaller.data[index]).toBe(200);
      expect(smaller.data[index + 1]).toBe(100);
      expect(smaller.data[index + 2]).toBe(50);
      expect(smaller.data[index + 3]).toBe(255);
    }
  });

  it('does not let a transparent pixel bleed its colour into an opaque neighbour', () => {
    /* The resize weights colour by alpha before averaging. Without that, a
       fully transparent red pixel would drag a neighbouring opaque white one
       toward pink — the classic halo around a resized cut-out. */
    const data = new Uint8ClampedArray([
      255, 0, 0, 0, 255, 255, 255, 255,
      255, 0, 0, 0, 255, 255, 255, 255,
    ]);
    const source = createPixelBuffer({ width: 2, height: 2, data });
    const resized = resizePixelBuffer(source, 1, 2);
    for (let index = 0; index < resized.data.length; index += 4) {
      // Alpha averages to half; the surviving colour must be the opaque white,
      // not a blend with the invisible red.
      expect(resized.data[index]).toBe(255);
      expect(resized.data[index + 1]).toBe(255);
      expect(resized.data[index + 2]).toBe(255);
    }
  });

  it('keeps a fully transparent image transparent', () => {
    const original = solid(4, 4, [120, 130, 140, 0]);
    const resized = resizePixelBuffer(original, 2, 2);
    for (let index = 3; index < resized.data.length; index += 4) {
      expect(resized.data[index]).toBe(0);
    }
  });

  it('rejects an invalid target size', () => {
    const original = solid(2, 2, [0, 0, 0, 255]);
    expect(codeOf(() => resizePixelBuffer(original, 0, 2))).toBe('INVALID_DIMENSIONS');
    expect(codeOf(() => resizePixelBuffer(original, 2, -3))).toBe('INVALID_DIMENSIONS');
  });

  it('resizeToFit leaves an image already within bounds alone', () => {
    const original = solid(10, 5, [1, 2, 3, 255]);
    const fitted = resizeToFit(original, 20);
    expect(fitted.width).toBe(10);
    expect(fitted.height).toBe(5);
    expect(fitted).not.toBe(original);
  });

  it('resizeToFit scales the longest edge and keeps the aspect ratio', () => {
    const original = solid(100, 50, [1, 2, 3, 255]);
    const fitted = resizeToFit(original, 20);
    expect(fitted.width).toBe(20);
    expect(fitted.height).toBe(10);
  });

  it('resizeToFit never collapses a very thin image to zero', () => {
    const original = solid(1000, 3, [1, 2, 3, 255]);
    const fitted = resizeToFit(original, 10);
    expect(fitted.width).toBe(10);
    expect(fitted.height).toBeGreaterThanOrEqual(1);
  });

  it('resizeToFit rejects a nonsensical bound', () => {
    const original = solid(4, 4, [0, 0, 0, 255]);
    expect(codeOf(() => resizeToFit(original, 0))).toBe('INVALID_DIMENSIONS');
    expect(codeOf(() => resizeToFit(original, 2.5))).toBe('INVALID_DIMENSIONS');
  });
});
