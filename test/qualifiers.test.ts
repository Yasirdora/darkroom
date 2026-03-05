import { describe, expect, it } from 'vitest';

import { createPixelBuffer } from '../src/buffer.js';
import { hslToRgb, rgbToHsl } from '../src/color.js';
import { DEFAULT_QUALIFIER } from '../src/grade.js';
import {
  applyWithMask,
  buildQualifierMask,
  isIdentityQualifier,
  qualifierAffectsPipeline,
} from '../src/qualifiers.js';
import type { PixelBuffer, QualifierConfig } from '../src/types.js';

type Pixel = readonly [number, number, number, number];

const pixelsToBuffer = (width: number, height: number, pixels: readonly Pixel[]): PixelBuffer =>
  createPixelBuffer({ width, height, data: pixels.flat() });
const repeated = (count: number, pixel: Pixel): Pixel[] =>
  Array.from({ length: count }, () => pixel);
const active = (partial: Partial<QualifierConfig> = {}): QualifierConfig => ({
  ...DEFAULT_QUALIFIER,
  enabled: true,
  hueSoft: 0.1,
  satSoft: 0.01,
  lumSoft: 0.01,
  ...partial,
});

describe('qualifier identity and masks', () => {
  it('requires every dimension and inversion to be neutral', () => {
    expect(isIdentityQualifier(active())).toBe(true);
    for (const qualifier of [
      active({ hueMin: 330, hueMax: 30 }),
      active({ satMin: 0.25 }),
      active({ lumMax: 0.75 }),
      active({ spatialType: 'ellipse' }),
      active({ invert: true }),
    ]) expect(isIdentityQualifier(qualifier)).toBe(false);
    const selective = active({ lumMax: 0.5 });
    expect(qualifierAffectsPipeline(selective, false)).toBe(false);
    expect(qualifierAffectsPipeline(selective, true)).toBe(true);
    expect(qualifierAffectsPipeline(active(), true)).toBe(false);
  });

  it('selects circular hue ranges and softens across the zero-degree seam', () => {
    const mask = buildQualifierMask(
      pixelsToBuffer(17, 1, [
        ...repeated(8, [220, 20, 20, 255]),
        ...repeated(9, [20, 20, 220, 255]),
      ]),
      active({ hueMin: 330, hueMax: 30 }),
    );
    expect(mask[0]).toBeCloseTo(1, 5);
    expect(mask.at(-1)).toBeCloseTo(0, 5);

    const red = hslToRgb(359, 1, 0.5);
    const actualHue = rgbToHsl(red.r, red.g, red.b).h;
    const distance = Math.min(actualHue, 360 - actualHue);
    const seam = buildQualifierMask(
      pixelsToBuffer(1, 1, [[red.r, red.g, red.b, 255]]),
      active({ hueMin: 0, hueMax: 80, hueSoft: 10 }),
    );
    expect(seam[0]).toBeCloseTo(1 - distance / 10, 3);
    expect(seam[0]).toBeGreaterThan(0.85);
  });

  it('applies saturation, luminance, spatial selection and inversion independently', () => {
    const saturation = buildQualifierMask(
      pixelsToBuffer(17, 1, [
        ...repeated(8, [120, 120, 120, 255]),
        ...repeated(9, [220, 20, 20, 255]),
      ]),
      active({ satMin: 0.8 }),
    );
    expect(saturation[0]).toBeCloseTo(0, 5);
    expect(saturation.at(-1)).toBeCloseTo(1, 5);

    const luminance = buildQualifierMask(
      pixelsToBuffer(17, 1, [
        ...repeated(8, [25, 25, 25, 255]),
        ...repeated(9, [230, 230, 230, 255]),
      ]),
      active({ lumMax: 0.2 }),
    );
    expect(luminance[0]).toBeCloseTo(1, 5);
    expect(luminance.at(-1)).toBeCloseTo(0, 5);

    const spatial = buildQualifierMask(
      pixelsToBuffer(21, 21, repeated(21 * 21, [180, 100, 60, 255])),
      active({
        spatialType: 'ellipse', spatialWidth: 0.4, spatialHeight: 0.4, spatialFeather: 0.02,
      }),
    );
    expect(spatial[10 * 21 + 10]).toBeGreaterThan(0.5);
    expect(spatial[0]).toBeCloseTo(0, 5);

    const normal = buildQualifierMask(
      pixelsToBuffer(17, 1, [...repeated(8, [220, 20, 20, 255]), ...repeated(9, [20, 20, 220, 255])]),
      active({ hueMin: 330, hueMax: 30 }),
    );
    const inverted = buildQualifierMask(
      pixelsToBuffer(17, 1, [...repeated(8, [220, 20, 20, 255]), ...repeated(9, [20, 20, 220, 255])]),
      active({ hueMin: 330, hueMax: 30, invert: true }),
    );
    for (let index = 0; index < normal.length; index += 1) {
      expect(normal[index] + inverted[index]).toBeCloseTo(1, 5);
    }
  });

  it('keeps hidden RGB inert even for inverted qualifiers', () => {
    const source = pixelsToBuffer(3, 1, [
      [20, 20, 220, 255], [220, 20, 20, 0], [20, 20, 220, 255],
    ]);
    const qualifier = active({ hueMin: 330, hueMax: 30, hueSoft: 1 });
    expect([...buildQualifierMask(source, qualifier)]).toEqual([0, 0, 0]);
    expect([...buildQualifierMask(source, { ...qualifier, invert: true })]).toEqual([1, 0, 1]);
  });

  it('bounds non-finite imported settings to a finite mask', () => {
    const source = pixelsToBuffer(32, 24, Array.from({ length: 32 * 24 }, (_value, index) => [
      index % 256, index * 3 % 256, index * 7 % 256, 255,
    ]));
    const mask = buildQualifierMask(source, active({
      hueMin: Number.NaN,
      hueMax: Number.POSITIVE_INFINITY,
      hueSoft: Number.POSITIVE_INFINITY,
      satSoft: Number.NaN,
      lumSoft: Number.NEGATIVE_INFINITY,
      spatialType: 'ellipse',
      spatialX: Number.NaN,
      spatialY: Number.POSITIVE_INFINITY,
      spatialWidth: Number.POSITIVE_INFINITY,
      spatialHeight: Number.NEGATIVE_INFINITY,
      spatialRotation: Number.POSITIVE_INFINITY,
      spatialFeather: Number.POSITIVE_INFINITY,
    }));
    expect(mask).toHaveLength(source.width * source.height);
    expect([...mask].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true);
  });

  it('returns uniform masks directly for disabled and identity qualifiers', () => {
    const source = pixelsToBuffer(2, 1, [[10, 20, 30, 255], [40, 50, 60, 128]]);
    expect([...buildQualifierMask(source, active())]).toEqual([1, 1]);
    expect([...buildQualifierMask(source, { ...active(), enabled: false })]).toEqual([1, 1]);
  });
});

describe('masked blending', () => {
  const source = pixelsToBuffer(2, 1, [[10, 20, 30, 17], [40, 50, 60, 231]]);
  const processed = pixelsToBuffer(2, 1, [[110, 120, 130, 255], [140, 150, 160, 0]]);

  it('reuses source for identity strength/empty masks and clamps non-finite values', () => {
    expect(applyWithMask(source, processed, new Float32Array([1, 1]), Number.NaN)).toBe(source);
    expect(applyWithMask(source, processed, new Float32Array([0, 0]), 1)).toBe(source);
    expect([...applyWithMask(
      source,
      processed,
      new Float32Array([Number.POSITIVE_INFINITY, Number.NaN]),
      Number.POSITIVE_INFINITY,
    ).data]).toEqual([110, 120, 130, 17, 40, 50, 60, 231]);
  });

  it('leaves fully transparent source texels and hidden RGB untouched', () => {
    const transparent = pixelsToBuffer(1, 1, [[10, 20, 30, 0]]);
    const opaque = pixelsToBuffer(1, 1, [[200, 210, 220, 255]]);
    expect(applyWithMask(transparent, opaque, new Float32Array([1]), 1)).toBe(transparent);
  });

  it('rejects dimension, mask-type and mask-length mismatches', () => {
    const wrong = pixelsToBuffer(1, 1, [[0, 0, 0, 255]]);
    expect(() => applyWithMask(source, wrong, new Float32Array([1, 1]))).toThrow();
    expect(() => applyWithMask(source, processed, new Float32Array([1]))).toThrow();
    expect(() => applyWithMask(source, processed, [1, 1] as unknown as Float32Array)).toThrow();
  });
});
