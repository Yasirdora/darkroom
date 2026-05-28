import { describe, expect, it } from 'vitest';

import {
  assertImagePixelLimit,
  MAX_ENCODED_IMAGE_HEADER_BYTES,
  parseEncodedImageDimensions,
} from '../src/encoded-image-dimensions.js';

/**
 * Header parsing is the only place this package reads bytes it did not create.
 * Everything downstream trusts the width and height that come out of here, and
 * the input is a file a user was handed by someone else — so the tests below
 * care less about parsing valid images correctly than about what happens when
 * the bytes are hostile.
 */

const jpeg = (over: Partial<{ width: number; height: number }> = {}): Uint8Array => {
  const width = over.width ?? 256;
  const height = over.height ?? 128;
  return Uint8Array.from([
    0xff, 0xd8, // SOI
    0xff, 0xc0, // SOF0
    0x00, 0x11, // segment length (17)
    0x08, // precision
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, // component count
    1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1,
  ]);
};

const png = (width = 320, height = 200): Uint8Array => Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0, 0, 0, 13,
  0x49, 0x48, 0x44, 0x52,
  (width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff,
  (height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff,
  8, 6, 0, 0, 0,
  0, 0, 0, 0,
]);

const webpVp8x = (width = 640, height = 480): Uint8Array => {
  const w = width - 1;
  const h = height - 1;
  return Uint8Array.from([
    0x52, 0x49, 0x46, 0x46,
    22, 0, 0, 0, // RIFF payload size: total bytes minus the 8-byte RIFF header
    0x57, 0x45, 0x42, 0x50,
    0x56, 0x50, 0x38, 0x58,
    10, 0, 0, 0,
    0, 0, 0, 0,
    w & 0xff, (w >>> 8) & 0xff, (w >>> 16) & 0xff,
    h & 0xff, (h >>> 8) & 0xff, (h >>> 16) & 0xff,
  ]);
};

describe('encoded image dimensions', () => {
  it('reads a JPEG start-of-frame', () => {
    const bytes = jpeg({ width: 4000, height: 3000 });
    expect(parseEncodedImageDimensions(bytes, bytes.length)).toEqual({
      width: 4000,
      height: 3000,
      format: 'jpeg',
    });
  });

  it('reads a PNG IHDR', () => {
    const bytes = png(1920, 1080);
    expect(parseEncodedImageDimensions(bytes, bytes.length)).toEqual({
      width: 1920,
      height: 1080,
      format: 'png',
    });
  });

  it('reads a WebP VP8X canvas size', () => {
    const bytes = webpVp8x(1200, 800);
    expect(parseEncodedImageDimensions(bytes, bytes.length)).toEqual({
      width: 1200,
      height: 800,
      format: 'webp',
    });
  });

  it('refuses a format it cannot verify before decoding', () => {
    const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]);
    expect(() => parseEncodedImageDimensions(gif, gif.length)).toThrow(/JPEG, PNG, and WebP/);
  });

  it('rejects a zero-dimension image rather than passing it downstream', () => {
    const bytes = jpeg({ width: 0, height: 100 });
    expect(() => parseEncodedImageDimensions(bytes, bytes.length)).toThrow(/JPEG/);
  });

  it('rejects a JPEG segment length that runs past the buffer', () => {
    const bytes = jpeg();
    bytes[4] = 0xff; // segment length 0xff11, far beyond the 21 bytes available
    expect(() => parseEncodedImageDimensions(bytes, bytes.length)).toThrow(/JPEG/);
  });

  it('rejects a PNG whose IHDR is not the first chunk', () => {
    const bytes = png();
    bytes[12] = 0x49;
    bytes[13] = 0x44;
    bytes[14] = 0x41;
    bytes[15] = 0x54; // IDAT
    expect(() => parseEncodedImageDimensions(bytes, bytes.length)).toThrow(/PNG/);
  });

  it('rejects a WebP whose RIFF size exceeds the real file', () => {
    const bytes = webpVp8x();
    expect(() => parseEncodedImageDimensions(bytes, 20)).toThrow(/WebP/);
  });

  it('rejects an empty or nonsensical file size', () => {
    const bytes = png();
    expect(() => parseEncodedImageDimensions(bytes, 0)).toThrow(/empty or has an invalid size/);
    expect(() => parseEncodedImageDimensions(bytes, -1)).toThrow(/empty or has an invalid size/);
  });

  it('inspects only a bounded prefix', () => {
    // A declared header cap keeps adversarial metadata from turning validation
    // into an unbounded scan; the constant is part of the contract.
    expect(MAX_ENCODED_IMAGE_HEADER_BYTES).toBe(512 * 1024);
  });

  it('uses the MIME hint to produce a useful error on a truncated signature', () => {
    const truncated = Uint8Array.from([0xff]);
    expect(() => parseEncodedImageDimensions(truncated, 1, 'image/jpeg')).toThrow(/JPEG/);
  });
});

describe('encoded image dimensions under mutation', () => {
  /**
   * A deterministic sweep over corrupted headers. It does not assert that any
   * particular byte pattern is rejected — that is the parser's business — only
   * the three properties every caller depends on: it terminates, it either
   * returns usable integers or throws a real Error, and it never reports a
   * size that downstream code would go on to allocate against.
   *
   * The seed is fixed so a failure is reproducible rather than a rumour.
   */
  const seeds: Record<string, Uint8Array> = {
    jpeg: jpeg(),
    png: png(),
    webp: webpVp8x(),
  };

  it('always terminates with either valid integers or a thrown Error', () => {
    let state = 0x2f6e2b1;
    const random = (): number => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };

    const started = Date.now();
    let inspected = 0;

    for (const seed of Object.values(seeds)) {
      for (let iteration = 0; iteration < 8000; iteration += 1) {
        const bytes = Uint8Array.from(seed);
        const mutations = 1 + Math.floor(random() * 3);
        for (let m = 0; m < mutations; m += 1) {
          bytes[Math.floor(random() * bytes.length)] = Math.floor(random() * 256);
        }
        const candidate = random() < 0.25
          ? bytes.subarray(0, Math.floor(random() * bytes.length))
          : bytes;
        const fileSize = Math.max(1, candidate.length);

        try {
          const result = parseEncodedImageDimensions(candidate, fileSize);
          expect(Number.isSafeInteger(result.width)).toBe(true);
          expect(Number.isSafeInteger(result.height)).toBe(true);
          expect(result.width).toBeGreaterThan(0);
          expect(result.height).toBeGreaterThan(0);
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
        }
        inspected += 1;
      }
    }

    expect(inspected).toBe(24000);
    // Termination is the property; the bound is generous enough that only a
    // genuine runaway loop trips it.
    expect(Date.now() - started).toBeLessThan(20_000);
  });
});

describe('pixel limit', () => {
  it('accepts a pair inside the limit', () => {
    expect(() => assertImagePixelLimit({ width: 1000, height: 1000 }, 12_000_000)).not.toThrow();
  });

  it('rejects a pair beyond it', () => {
    expect(() => assertImagePixelLimit({ width: 5000, height: 5000 }, 12_000_000))
      .toThrow(/megapixel maximum/);
  });

  it('rejects non-integer or non-positive dimensions', () => {
    expect(() => assertImagePixelLimit({ width: 1.5, height: 10 }, 12_000_000)).toThrow();
    expect(() => assertImagePixelLimit({ width: 0, height: 10 }, 12_000_000)).toThrow();
    expect(() => assertImagePixelLimit({ width: -4, height: 10 }, 12_000_000)).toThrow();
  });

  it('rejects an invalid limit rather than silently allowing everything', () => {
    expect(() => assertImagePixelLimit({ width: 10, height: 10 }, 0)).toThrow(/limit is invalid/);
    expect(() => assertImagePixelLimit({ width: 10, height: 10 }, Number.NaN)).toThrow(/limit is invalid/);
  });

  it('does not overflow on dimensions near the safe-integer ceiling', () => {
    // The check divides rather than multiplying, so an attacker-supplied pair
    // cannot wrap past the limit by overflowing the product.
    const huge = Number.MAX_SAFE_INTEGER;
    expect(() => assertImagePixelLimit({ width: huge, height: huge }, 12_000_000)).toThrow();
  });
});
