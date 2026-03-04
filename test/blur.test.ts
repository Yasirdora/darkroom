import { describe, expect, it, vi } from 'vitest';

import { createPixelBuffer } from '../src/buffer.js';
import { applyEffect } from '../src/effects.js';
import type { PixelBuffer } from '../src/types.js';

const image = (width: number, height: number, opaque = false): PixelBuffer => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = (x * 37 + y * 11) % 256;
      data[offset + 1] = (x * 17 + y * 53) % 256;
      data[offset + 2] = (x * 71 + y * 7) % 256;
      data[offset + 3] = opaque ? 255 : (x * 29 + y * 41) % 256;
    }
  }
  return createPixelBuffer({ width, height, data });
};

const alphaValues = (value: PixelBuffer): number[] =>
  [...value.data].filter((_channel, index) => index % 4 === 3);

const blur = (
  source: PixelBuffer,
  blurMode: 'box' | 'gaussian' | 'bilateral' | 'bokeh',
  blurRadius: number,
  blurThreshold?: number,
): PixelBuffer => applyEffect(source, {
  id: 'blur',
  intensity: 100,
  options: { blurMode, blurRadius, ...(blurThreshold === undefined ? {} : { blurThreshold }) },
});

const naiveOpaqueBox = (source: PixelBuffer, radius: number): Uint8ClampedArray => {
  const horizontal = new Float32Array(source.width * source.height * 3);
  const output = new Uint8ClampedArray(source.data);
  const windowSize = radius * 2 + 1;
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const temporary = (y * source.width + x) * 3;
      for (let delta = -radius; delta <= radius; delta += 1) {
        const sampleX = Math.min(source.width - 1, Math.max(0, x + delta));
        const offset = (y * source.width + sampleX) * 4;
        horizontal[temporary] += source.data[offset] / windowSize;
        horizontal[temporary + 1] += source.data[offset + 1] / windowSize;
        horizontal[temporary + 2] += source.data[offset + 2] / windowSize;
      }
    }
  }
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const destination = (y * source.width + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        let sum = 0;
        for (let delta = -radius; delta <= radius; delta += 1) {
          const sampleY = Math.min(source.height - 1, Math.max(0, y + delta));
          sum += horizontal[(sampleY * source.width + x) * 3 + channel];
        }
        output[destination + channel] = Math.round(sum / windowSize);
      }
    }
  }
  return output;
};

describe('bounded public blur processing', () => {
  it('matches the established edge-replicating opaque box result', () => {
    for (const source of [image(5, 4, true), image(4, 5, true)]) {
      const actual = blur(source, 'box', 2).data;
      const expected = naiveOpaqueBox(source, 2);
      for (let index = 0; index < actual.length; index += 1) {
        expect(Math.abs(actual[index] - expected[index])).toBeLessThanOrEqual(1);
      }
    }
  });

  it('normalizes invalid radii and clamps enormous radii', () => {
    const source = image(8, 6);
    for (const mode of ['box', 'gaussian', 'bilateral', 'bokeh'] as const) {
      expect(blur(source, mode, Number.NaN).data).toEqual(source.data);
      expect(blur(source, mode, Number.NEGATIVE_INFINITY).data).toEqual(source.data);
    }
    expect(blur(source, 'box', Number.POSITIVE_INFINITY).data).toEqual(
      blur(source, 'box', 7).data,
    );
    expect(blur(source, 'box', Number.MAX_VALUE).data).toEqual(blur(source, 'box', 7).data);
  });

  it('bounds bilateral range work and extreme parameters', () => {
    const source = image(8, 6);
    const exponential = vi.spyOn(Math, 'exp');
    try {
      const result = blur(source, 'bilateral', Number.POSITIVE_INFINITY, Number.NaN);
      expect(exponential).toHaveBeenCalledTimes(4096);
      expect([...result.data].every(Number.isFinite)).toBe(true);
    } finally {
      exponential.mockRestore();
    }
  });

  it('preserves alpha in all modes and prevents transparent hidden-RGB bleed', () => {
    const source = createPixelBuffer({
      width: 5,
      height: 1,
      data: [
        255, 0, 255, 0,
        80, 100, 120, 255,
        80, 100, 120, 128,
        80, 100, 120, 255,
        0, 255, 0, 0,
      ],
    });
    for (const mode of ['box', 'gaussian', 'bilateral', 'bokeh'] as const) {
      const result = blur(source, mode, 1);
      for (let pixel = 1; pixel <= 3; pixel += 1) {
        expect([...result.data.slice(pixel * 4, pixel * 4 + 3)]).toEqual([80, 100, 120]);
      }
      expect(alphaValues(result)).toEqual(alphaValues(source));
    }
  });

  it('keeps constant fields constant across every blur mode', () => {
    const data = new Uint8ClampedArray(6 * 5 * 4);
    for (let index = 0; index < data.length; index += 4) {
      data.set([44, 88, 132, index % 8 === 0 ? 128 : 255], index);
    }
    const source = createPixelBuffer({ width: 6, height: 5, data });
    for (const mode of ['box', 'gaussian', 'bilateral', 'bokeh'] as const) {
      const result = blur(source, mode, 3);
      for (let index = 0; index < result.data.length; index += 4) {
        expect([...result.data.slice(index, index + 3)]).toEqual([44, 88, 132]);
      }
      expect(alphaValues(result)).toEqual(alphaValues(source));
    }
  });
});
