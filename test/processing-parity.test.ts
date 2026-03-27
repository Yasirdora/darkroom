import { describe, expect, it } from 'vitest';

import { applyAdjustments } from '../src/adjustments.js';
import { createPixelBuffer } from '../src/buffer.js';
import { applyCurves } from '../src/curves.js';
import { DEFAULT_ADJUSTMENTS, DEFAULT_QUALIFIER } from '../src/grade.js';
import { applyLut, createLut3D, resampleLut } from '../src/lut.js';
import { applyWithMask, buildQualifierMask } from '../src/qualifiers.js';
import { applyTransform } from '../src/transform.js';
import type { PixelBuffer } from '../src/types.js';

const fixture = (): PixelBuffer => {
  const width = 9;
  const height = 7;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      data[index] = (x * 29 + y * 11) % 256;
      data[index + 1] = (x * 7 + y * 37 + 40) % 256;
      data[index + 2] = (x * 43 + y * 13 + 90) % 256;
      data[index + 3] = 255;
    }
  }
  return createPixelBuffer({ width, height, data });
};

const fnv1a = (data: ArrayBufferView): string => {
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let value = 0x811c9dc5;
  for (const byte of bytes) {
    value ^= byte;
    value = Math.imul(value, 0x01000193);
  }
  return (value >>> 0).toString(16).padStart(8, '0');
};

describe('legacy processing characterization', () => {
  it('locks adjustment, curve, qualifier-mask and masked-blend behavior', () => {
    const source = fixture();
    const adjustments = {
      ...DEFAULT_ADJUSTMENTS,
      exposure: 12, brightness: -5, contrast: 18, highlights: -13, shadows: 22,
      whites: 7, blacks: -9, saturation: 16, vibrance: 12, hue: 8,
      temperature: 10, tint: -7, clarity: 20, vignette: 14, grain: 11,
      sepia: 9, sharpen: 13,
    };
    const curves = {
      master: [{ x: 0, y: 0.03 }, { x: 0.45, y: 0.52 }, { x: 1, y: 0.96 }],
      r: [{ x: 0, y: 0 }, { x: 0.6, y: 0.68 }, { x: 1, y: 1 }],
      g: [{ x: 0, y: 0.02 }, { x: 1, y: 0.98 }],
      b: [{ x: 0, y: 0.08 }, { x: 1, y: 0.92 }],
    };
    const qualifier = {
      ...DEFAULT_QUALIFIER,
      enabled: true,
      hueMin: 20,
      hueMax: 250,
      satMin: 0.08,
      satMax: 0.9,
      lumMin: 0.05,
      lumMax: 0.92,
      spatialType: 'ellipse' as const,
      spatialWidth: 0.75,
      spatialHeight: 0.65,
      spatialRotation: 23,
      spatialFeather: 0.2,
    };
    const mask = buildQualifierMask(source, qualifier);
    const processedData = Uint8ClampedArray.from(
      source.data,
      (value, index) => index % 4 === 3 ? value : 255 - value,
    );
    const processed = createPixelBuffer({
      width: source.width,
      height: source.height,
      data: processedData,
    });

    // Captured from the application-owned implementations immediately before
    // they were replaced by this package boundary.
    expect({
      adjustments: fnv1a(applyAdjustments(source, adjustments).data),
      curves: fnv1a(applyCurves(source, curves).data),
      qualifierMask: fnv1a(mask),
      qualifierBlend: fnv1a(applyWithMask(source, processed, mask, 0.7).data),
    }).toEqual({
      adjustments: '636d9920',
      curves: '1ad397a6',
      qualifierMask: 'df2bf493',
      qualifierBlend: '3508f107',
    });
  });

  it('rotates, flips and crops deterministically without Canvas', () => {
    const source = createPixelBuffer({
      width: 3,
      height: 2,
      data: [
        1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255,
        4, 0, 0, 255, 5, 0, 0, 255, 6, 0, 0, 255,
      ],
    });
    const rotated = applyTransform(source, {
      rotation: 90, flipH: false, flipV: false, crop: null,
    });
    expect([rotated.width, rotated.height]).toEqual([2, 3]);
    expect([...rotated.data.filter((_value, index) => index % 4 === 0)]).toEqual([4, 1, 5, 2, 6, 3]);

    const cropped = applyTransform(source, {
      rotation: 0,
      flipH: false,
      flipV: false,
      crop: { x: 1 / 3, y: 0, width: 2 / 3, height: 1 },
    }, true);
    expect([cropped.width, cropped.height]).toEqual([2, 2]);
    expect([...cropped.data.filter((_value, index) => index % 4 === 0)]).toEqual([2, 3, 5, 6]);
    expect(source.data[0]).toBe(1);
  });

  it('uses declared LUT domains, preserves alpha/hidden RGB and resamples without drift', () => {
    const size = 17;
    const data = new Float32Array(size ** 3 * 3);
    for (let blue = 0; blue < size; blue += 1) {
      for (let green = 0; green < size; green += 1) {
        for (let red = 0; red < size; red += 1) {
          const offset = (red + green * size + blue * size * size) * 3;
          data[offset] = red / (size - 1);
          data[offset + 1] = green / (size - 1);
          data[offset + 2] = blue / (size - 1);
        }
      }
    }
    const lut = createLut3D({
      size,
      data,
      domainMin: [-1, -1, -1],
      domainMax: [1, 1, 1],
      title: 'Domain identity',
    });
    data.fill(0); // createLut3D owns a defensive Float32 copy.
    const source = createPixelBuffer({
      width: 2,
      height: 1,
      data: [0, 0, 0, 128, 7, 8, 9, 0],
    });
    const before = new Uint8ClampedArray(source.data);
    const output = applyLut(source, lut, 100);
    expect([...output.data]).toEqual([128, 128, 128, 128, 7, 8, 9, 0]);
    expect(source.data).toEqual(before);

    const resampled = resampleLut(lut, 33);
    expect(resampled.domainMin).toEqual(lut.domainMin);
    expect(resampled.domainMax).toEqual(lut.domainMax);
    expect(resampled.title).toBe(lut.title);
    const midpoint = (16 + 16 * 33 + 16 * 33 * 33) * 3;
    expect([...resampled.data.slice(midpoint, midpoint + 3)]).toEqual([0.5, 0.5, 0.5]);
  });
});
