import { describe, expect, it } from 'vitest';

import { createPixelBuffer } from '../src/buffer.js';
import { DarkroomError } from '../src/errors.js';
import { applyEffect } from '../src/effects.js';
import type { EffectId, EffectSpec, PixelBuffer } from '../src/types.js';

const fixture = (): PixelBuffer => {
  const width = 9;
  const height = 7;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = (x * 29 + y * 11) % 256;
      data[offset + 1] = (x * 7 + y * 37 + 40) % 256;
      data[offset + 2] = (x * 43 + y * 13 + 90) % 256;
      data[offset + 3] = 255;
    }
  }
  return createPixelBuffer({ width, height, data });
};

const fnv1a = (bytes: Uint8ClampedArray): string => {
  let value = 0x811c9dc5;
  for (const byte of bytes) {
    value ^= byte;
    value = Math.imul(value, 0x01000193);
  }
  return (value >>> 0).toString(16).padStart(8, '0');
};

const expectInvalidGrade = (operation: () => unknown): void => {
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(DarkroomError);
  expect((thrown as DarkroomError).code).toBe('INVALID_GRADE');
};

describe('default effect compatibility', () => {
  const intensity = 63;
  // Captured from the last application-owned implementations before package
  // extraction. Keeping these self-contained prevents package tests from
  // depending on legacy source that the application is free to remove.
  const legacyHashes: Readonly<Record<EffectId, string>> = {
    pixelate: '46d9ab2a',
    blur: 'ec7f058d',
    posterize: '988f2296',
    water: '43929026',
    halftone: '2a733d3f',
    vhs: '1dcdf131',
    painting: '35c877b7',
  };

  it.each(Object.entries(legacyHashes) as Array<[EffectId, string]>)
  ('preserves the established %s default', (id, expectedHash) => {
    const source = fixture();
    const actual = applyEffect(source, { id, intensity, options: {} });
    expect(fnv1a(actual.data)).toBe(expectedHash);
    expect(actual.data.filter((_value, index) => index % 4 === 3)).toEqual(
      source.data.filter((_value, index) => index % 4 === 3),
    );
  });

  it('implements the advanced dither and halftone-shape options instead of ignoring them', () => {
    const source = fixture();
    expect(applyEffect(source, {
      id: 'pixelate', intensity: 100, options: { pixelSize: 3, pixelateDither: true },
    }).data).not.toEqual(applyEffect(source, {
      id: 'pixelate', intensity: 100, options: { pixelSize: 3, pixelateDither: false },
    }).data);
    expect(applyEffect(source, {
      id: 'posterize', intensity: 100, options: { posterizeLevels: 5, posterizeDither: true },
    }).data).not.toEqual(applyEffect(source, {
      id: 'posterize', intensity: 100, options: { posterizeLevels: 5, posterizeDither: false },
    }).data);
    expect(applyEffect(source, {
      id: 'halftone', intensity: 100, options: { halftoneFrequency: 5, halftoneShape: 'line' },
    }).data).not.toEqual(applyEffect(source, {
      id: 'halftone', intensity: 100, options: { halftoneFrequency: 5, halftoneShape: 'circle' },
    }).data);
  });

  it('rejects malformed effect specifications before the zero-intensity no-op path', () => {
    const source = fixture();
    const invalidEffects: unknown[] = [
      null,
      [],
      {},
      { id: 'unknown', intensity: 100, options: {} },
      { id: 'blur', intensity: Number.NaN, options: {} },
      { id: 'blur', intensity: 0 },
      { id: 'blur', intensity: 0, options: null },
      { id: 'blur', intensity: 0, options: [] },
      { id: 'blur', intensity: 0, options: { blurMode: 'unknown' } },
      { id: 'blur', intensity: 0, options: { blurRadius: 'wide' } },
      { id: 'pixelate', intensity: 0, options: { pixelSize: Number.POSITIVE_INFINITY } },
      { id: 'pixelate', intensity: 0, options: { pixelSize: 513 } },
      { id: 'blur', intensity: 0, options: { unsupported: true } },
      { id: 'halftone', intensity: 0, options: { color1: 'not-a-color' } },
      { id: 'halftone', intensity: 0, options: { color2: '#12' } },
    ];
    for (const effect of invalidEffects) {
      expectInvalidGrade(() => applyEffect(source, effect as EffectSpec));
    }
    expect(applyEffect(source, { id: 'blur', intensity: 0, options: {} })).toBe(source);
    expect(applyEffect(source, {
      id: 'halftone', intensity: 0, options: { color1: '#abc', color2: 'rgba(1, 2, 3, 0.5)' },
    })).toBe(source);
  });
});
