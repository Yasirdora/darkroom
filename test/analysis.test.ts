import { describe, expect, it } from 'vitest';

import { createPixelBuffer } from '../src/buffer.js';
import { applyColorMatch, computeColorMatchStats } from '../src/color-match.js';
import { computeHistogram } from '../src/histogram.js';
import { analyzeImage } from '../src/image-analysis.js';
import { computeVectorscope } from '../src/vectorscope.js';
import type { PixelBuffer } from '../src/types.js';

type Pixel = readonly [number, number, number, number];

const image = (pixels: readonly Pixel[], width = pixels.length): PixelBuffer => {
  if (pixels.length % width !== 0) throw new Error('Fixture pixels must fill complete rows.');
  return createPixelBuffer({
    width,
    height: pixels.length / width,
    data: pixels.flat(),
  });
};

const solidImage = (width: number, height: number, pixel: Pixel): PixelBuffer => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set(pixel, offset);
  return createPixelBuffer({ width, height, data });
};

const sumBins = (bins: Uint32Array): number => bins.reduce((sum, value) => sum + value, 0);

const expectFiniteTree = (value: unknown): void => {
  if (typeof value === 'number') {
    expect(Number.isFinite(value)).toBe(true);
  } else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) expectFiniteTree(child);
  }
};

describe('alpha-aware analysis', () => {
  it('excludes hidden RGB and alpha-weights histogram/scope density', () => {
    const histogram = computeHistogram(image([
      [255, 0, 0, 0],
      [0, 0, 255, 255],
      [120, 120, 120, 128],
      [120, 120, 120, 128],
    ]));
    expect(histogram.r[255]).toBe(0);
    expect(histogram.b[255]).toBe(1);
    expect(histogram.r[120]).toBe(1);

    // Scope sampling advances by four pixels for small images.
    const scope = computeVectorscope(image([
      [60, 120, 180, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0],
      [120, 120, 120, 128], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0],
      [120, 120, 120, 128], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0],
    ]), 16);
    expect(sumBins(scope.bins)).toBe(1);
    expect(scope.peak).toBe(1);
  });

  it('ignores hidden RGB and alpha-weights continuous statistics', () => {
    const visible = analyzeImage(image([[40, 80, 120, 255]]));
    const hidden = analyzeImage(image([[40, 80, 120, 255], [255, 0, 255, 0]]));
    expect(hidden.pixelCount).toBe(visible.pixelCount);
    expect(hidden.luminance).toEqual(visible.luminance);
    expect(hidden.rgb.meanR).toBe(visible.rgb.meanR);

    const alpha = 128 / 255;
    const weighted = analyzeImage(image([[100, 100, 100, 255], [200, 200, 200, 128]]));
    const mean = (100 + 200 * alpha) / (1 + alpha);
    expect(weighted.pixelCount).toBeCloseTo(1 + alpha, 12);
    expect(weighted.luminance.mean).toBeCloseTo(mean, 12);
    expect(weighted.rgb.meanR).toBeCloseTo(mean, 12);
    expect(weighted.rgb.meanG).toBeCloseTo(mean, 12);
    expect(weighted.rgb.meanB).toBeCloseTo(mean, 12);
  });

  it('alpha-weights color-match statistics and preserves hidden source RGB', () => {
    const dark = computeColorMatchStats(image([[32, 48, 64, 255]]));
    const light = computeColorMatchStats(image([[220, 210, 200, 255]]));
    const alpha = 128 / 255;
    const mixed = computeColorMatchStats(image([[32, 48, 64, 255], [220, 210, 200, 128]]));
    for (let channel = 0; channel < 3; channel += 1) {
      expect(mixed.mean[channel]).toBeCloseTo(
        (dark.mean[channel] + light.mean[channel] * alpha) / (1 + alpha),
        12,
      );
    }
    expect([...applyColorMatch(image([[12, 34, 56, 0]]), light, 100).data])
      .toEqual([12, 34, 56, 0]);
  });

  it('returns finite canonical results for fully transparent input', () => {
    const source = image([
      [255, 0, 0, 0], [0, 255, 0, 0], [0, 0, 255, 0], [255, 255, 255, 0],
    ], 2);
    const histogram = computeHistogram(source);
    expect(histogram.peak).toBe(0);
    expect(sumBins(histogram.r) + sumBins(histogram.g) + sumBins(histogram.b)).toBe(0);
    const scope = computeVectorscope(source);
    expect(scope.peak).toBe(0);
    expect(sumBins(scope.bins)).toBe(0);
    expect(computeColorMatchStats(source)).toEqual({
      mean: [0, 0, 0], std: [0, 0, 0], sampleWeight: 0,
    });
    const analysis = analyzeImage(source);
    expect(analysis.pixelCount).toBe(0);
    expect(analysis.scene).toEqual({
      profile: 'neutral', isHighKey: false, isLowKey: false,
      isBacklit: false, isVivid: false, confidence: 0,
    });
    expectFiniteTree(analysis);
  });

  it('rescans when a stride initially misses the only visible texel', () => {
    const pixels = Array.from(
      { length: 80_002 },
      (_value, index) => [100, 120, 140, index === 1 ? 255 : 0] as const,
    );
    const stats = computeColorMatchStats(image(pixels));
    expect(stats.sampleWeight).toBe(1);
    expect(stats.mean.some((value) => value !== 0)).toBe(true);
  });

  it('uses immutable no-op semantics for unusable color-match requests', () => {
    const source = image([[12, 34, 56, 255]]);
    expect(applyColorMatch(source, {
      mean: [0, 0, 0], std: [0, 0, 0], sampleWeight: 0,
    }, 100)).toBe(source);
    expect(applyColorMatch(source, computeColorMatchStats(source), Number.NaN)).toBe(source);
  });

  it('does not report false acutance for a uniform saturated field', () => {
    expect(analyzeImage(solidImage(9, 9, [0, 180, 0, 255])).content.acutance).toBe(0);
  });
});
