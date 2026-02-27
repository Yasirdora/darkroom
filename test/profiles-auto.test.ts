import { describe, expect, it } from 'vitest';

import { applyAdjustments } from '../src/adjustments.js';
import { computeAutoEnhance, computeAutoWhiteBalance } from '../src/auto-enhance.js';
import { createPixelBuffer } from '../src/buffer.js';
import { ADJUSTMENT_RANGES, DEFAULT_ADJUSTMENTS } from '../src/grade.js';
import { analyzeImage } from '../src/image-analysis.js';
import {
  INPUT_PROFILES,
  INPUT_PROFILE_GROUPS,
  applyInputProfile,
  coerceInputProfile,
  decodeToLinearValue,
  getInputProfileSpec,
  getProfileTypicalEI,
  getRecommendedInputExposure,
  getSceneLinearLuminance,
} from '../src/profiles.js';
import type { InputProfileId, PixelBuffer } from '../src/types.js';

const solid = (
  width: number,
  height: number,
  pixel: readonly [number, number, number, number],
): PixelBuffer => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set(pixel, offset);
  return createPixelBuffer({ width, height, data });
};

const ramp = (): PixelBuffer => {
  const width = 32;
  const height = 16;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const base = 55 + Math.round(x / (width - 1) * 125);
      data[offset] = base + Math.round(y / (height - 1) * 8);
      data[offset + 1] = base;
      data[offset + 2] = base - 5;
      data[offset + 3] = (x === 0 && y === 0) ? 0 : 255;
    }
  }
  data.set([249, 3, 251, 0], 0);
  return createPixelBuffer({ width, height, data });
};

describe('input-profile reference transforms', () => {
  it('publishes an immutable, unique and grouped profile catalog', () => {
    const ids = INPUT_PROFILES.map((profile) => profile.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('standard');
    expect(ids).toContain('arri-logc3');
    expect(Object.isFrozen(INPUT_PROFILES)).toBe(true);
    expect(INPUT_PROFILES.every(Object.isFrozen)).toBe(true);
    expect(new Set(INPUT_PROFILES.map((profile) => profile.group))).toEqual(
      new Set(INPUT_PROFILE_GROUPS.map((group) => group.id)),
    );
  });

  it('has finite reference endpoints and luminance for every supported profile', () => {
    for (const { id } of INPUT_PROFILES) {
      for (const value of [0, 18, 128, 235, 255]) {
        expect(Number.isFinite(decodeToLinearValue(value, id))).toBe(true);
      }
      expect(Number.isFinite(getSceneLinearLuminance(64, 128, 192, id))).toBe(true);
    }
    expect(decodeToLinearValue(0, 'standard')).toBe(0);
    expect(decodeToLinearValue(255, 'standard')).toBe(1);
    expect(decodeToLinearValue(255, 'rec709')).toBeCloseTo(1, 12);
  });

  it.each<readonly [InputProfileId, number, number]>([
    ['red-log3g10', 1 / 3, 0.000_01],
    ['s-log3', 420 / 1023, 0.000_01],
    ['bmd-film-gen5', 0.383562, 0.000_05],
    ['davinci-intermediate', 0.336043, 0.000_05],
    // Full-range formula value; camera legal/waveform code values differ.
    ['c-log3', 0.3309579104, 0.000_001],
    ['v-log', 0.4233, 0.000_5],
  ])('decodes the documented %s 18%%-grey reference', (profile, encoded, tolerance) => {
    expect(Math.abs(decodeToLinearValue(encoded * 255, profile) - 0.18)).toBeLessThan(tolerance);
  });

  it('normalizes every profile to finite bytes while preserving alpha and hidden RGB', () => {
    const source = createPixelBuffer({
      width: 3,
      height: 1,
      data: [32, 64, 96, 255, 128, 128, 128, 128, 7, 8, 9, 0],
    });
    const before = new Uint8ClampedArray(source.data);
    expect(applyInputProfile(source, 'standard')).toBe(source);
    for (const { id } of INPUT_PROFILES) {
      const output = applyInputProfile(source, id, id === 'standard' ? { exposureStops: 0.5 } : {});
      expect(output.data).toHaveLength(source.data.length);
      expect([...output.data].every(Number.isFinite)).toBe(true);
      expect([output.data[3], output.data[7], output.data[11]]).toEqual([255, 128, 0]);
      expect([...output.data.slice(8, 12)]).toEqual([7, 8, 9, 0]);
    }
    expect(source.data).toEqual(before);
  });

  it('applies relative-linear exposure monotonically and supports shoulder bypass', () => {
    const source = solid(1, 1, [96, 96, 96, 255]);
    const darker = applyInputProfile(source, 'standard', { exposureStops: -1 });
    const brighter = applyInputProfile(source, 'standard', { exposureStops: 1 });
    expect(darker.data[0]).toBeLessThan(source.data[0]);
    expect(brighter.data[0]).toBeGreaterThan(source.data[0]);
    expect(applyInputProfile(source, 's-log3', { linearMode: true }).data)
      .not.toEqual(applyInputProfile(source, 's-log3', { linearMode: false }).data);
  });

  it('keeps stable profile metadata and legacy ID coercion', () => {
    expect(coerceInputProfile('log-c')).toBe('arri-logc3');
    expect(coerceInputProfile('missing')).toBe('standard');
    expect(getInputProfileSpec('s-log3').id).toBe('s-log3');
    expect(getRecommendedInputExposure('s-log3')).toBe(0);
    expect(getProfileTypicalEI('s-log3')).toContain('800');
    expect(getProfileTypicalEI('standard')).toBeNull();
  });
});

describe('automatic correction', () => {
  it('returns finite, bounded suggestions without mutating the source', () => {
    const source = ramp();
    const before = new Uint8ClampedArray(source.data);
    const result = computeAutoEnhance(source);
    expect(result.summary.length).toBeGreaterThan(0);
    for (const [key, value] of Object.entries(result.adjustments) as Array<
      [keyof typeof result.adjustments, number]
    >) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(ADJUSTMENT_RANGES[key].min);
      expect(value).toBeLessThanOrEqual(ADJUSTMENT_RANGES[key].max);
    }
    expect(source.data).toEqual(before);
  });

  it('suggests more exposure for a dark field than a bright field', () => {
    const dark = computeAutoEnhance(solid(20, 20, [35, 35, 35, 255]));
    const bright = computeAutoEnhance(solid(20, 20, [220, 220, 220, 255]));
    expect(dark.adjustments.exposure).toBeGreaterThan(bright.adjustments.exposure);
  });

  it('detects an already neutral field and reduces a warm cast', () => {
    expect(computeAutoWhiteBalance(solid(16, 16, [128, 128, 128, 255]))).toMatchObject({
      temperature: 0,
      tint: 0,
    });

    const warm = solid(16, 16, [180, 120, 80, 255]);
    const correction = computeAutoWhiteBalance(warm);
    expect(Math.abs(correction.temperature) + Math.abs(correction.tint)).toBeGreaterThan(0);
    const corrected = applyAdjustments(warm, {
      ...DEFAULT_ADJUSTMENTS,
      temperature: correction.temperature,
      tint: correction.tint,
    });
    const before = analyzeImage(warm).rgb;
    const after = analyzeImage(corrected).rgb;
    const spread = (channels: readonly number[]): number => Math.max(...channels) - Math.min(...channels);
    expect(spread([after.meanR, after.meanG, after.meanB])).toBeLessThan(
      spread([before.meanR, before.meanG, before.meanB]),
    );
  });

  it('keeps transparent input canonical and finite', () => {
    const source = solid(4, 4, [200, 50, 10, 0]);
    const whiteBalance = computeAutoWhiteBalance(source);
    const enhance = computeAutoEnhance(source);
    expect(Number.isFinite(whiteBalance.temperature)).toBe(true);
    expect(Number.isFinite(whiteBalance.tint)).toBe(true);
    expect(Object.values(enhance.adjustments).every(Number.isFinite)).toBe(true);
  });
});
