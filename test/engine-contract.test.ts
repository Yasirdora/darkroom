import { describe, expect, it } from 'vitest';

import {
  DarkroomError,
  DEFAULT_ADJUSTMENTS,
  DEFAULT_QUALIFIER,
  DEFAULT_TRANSFORM,
  applyAdjustments,
  applyColorMatch,
  applyCurves,
  applyFilmGrain,
  applyInputProfile,
  applyLook,
  applyLut,
  applyTransform,
  applyWithMask,
  analyzeImage,
  buildQualifierMask,
  clonePixelBuffer,
  computeColorMatchStats,
  computeHistogram,
  computeVectorscope,
  createLut3D,
  createPixelBuffer,
  decodeToLinearValue,
  getSceneLinearLuminance,
  interpolateCurve,
  normalizeGrade,
  render,
  renderForExport,
  resizeToFit,
} from '../src/index.js';
import type { PixelBuffer } from '../src/types.js';

const source = createPixelBuffer({
  width: 2,
  height: 1,
  data: [20, 40, 60, 255, 90, 80, 70, 128],
});

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

describe('public engine contract', () => {
  it('keeps no-op preview and export renders allocation-free and immutable', () => {
    const before = new Uint8ClampedArray(source.data);
    expect(render(source)).toBe(source);
    expect(renderForExport(source)).toBe(source);
    expect(source.data).toEqual(before);
  });

  it('does not build qualifier work for zero-strength selective stages', () => {
    const output = render(source, {
      qualifier: { enabled: true, hueMin: 200, hueMax: 240 },
      effect: { id: 'vhs', intensity: 0, options: {} },
    });
    expect(output).toBe(source);
  });

  it.each([
    ['histogram', (buffer: PixelBuffer) => computeHistogram(buffer)],
    ['vectorscope', (buffer: PixelBuffer) => computeVectorscope(buffer)],
    ['analysis', (buffer: PixelBuffer) => analyzeImage(buffer)],
    ['color-match statistics', (buffer: PixelBuffer) => computeColorMatchStats(buffer)],
    ['color-match application', (buffer: PixelBuffer) => applyColorMatch(buffer, {
      mean: [50, 0, 0], std: [1, 1, 1], sampleWeight: 1,
    }, 50)],
    ['input profile', (buffer: PixelBuffer) => applyInputProfile(buffer, 'standard')],
  ])('rejects a malformed pixel buffer in %s', (_name, operation) => {
    const malformed = {
      width: 2,
      height: 2,
      data: new Uint8ClampedArray(4),
    } as PixelBuffer;
    expect(() => operation(malformed)).toThrow(DarkroomError);
  });

  it('rejects invalid vectorscope allocation sizes', () => {
    for (const size of [0, -1, 1.5, Number.NaN, 513, Number.POSITIVE_INFINITY]) {
      expect(() => computeVectorscope(source, size)).toThrow(DarkroomError);
    }
  });

  it('validates malformed pixel data before LUT work', () => {
    const identity = createLut3D({
      size: 17,
      data: new Float32Array(17 ** 3 * 3),
    });
    const malformed = { width: 1, height: 1, data: new Uint8ClampedArray(3) } as PixelBuffer;
    expect(() => applyLut(malformed, identity)).toThrow(DarkroomError);
  });

  it('validates every exported buffer operation before an otherwise no-op path', () => {
    const malformed = { width: 2, height: 1, data: new Uint8ClampedArray(4) } as PixelBuffer;
    const lut = createLut3D({ size: 17, data: new Float32Array(17 ** 3 * 3) });
    const operations: ReadonlyArray<readonly [string, () => unknown]> = [
      ['clone', () => clonePixelBuffer(malformed)],
      ['resize-to-fit', () => resizeToFit(malformed, 100)],
      ['adjustments', () => applyAdjustments(malformed, DEFAULT_ADJUSTMENTS)],
      ['curves', () => applyCurves(malformed, {})],
      ['look', () => applyLook(malformed, { lut }, 0)],
      ['film grain', () => applyFilmGrain(malformed, { amount: 0, warmth: 0, size: 0 })],
      ['transform', () => applyTransform(malformed, DEFAULT_TRANSFORM)],
      ['qualifier mask', () => buildQualifierMask(malformed, DEFAULT_QUALIFIER)],
      ['masked source', () => applyWithMask(malformed, source, new Float32Array(2), 0)],
      ['masked processed', () => applyWithMask(source, malformed, new Float32Array(2), 0)],
    ];
    for (const [name, operation] of operations) {
      expect(operation, name).toThrow(DarkroomError);
    }
  });

  it('rejects malformed direct curve input with a stable error', () => {
    const invalidCurves: unknown[] = [
      null,
      { master: 'not-an-array' },
      { master: [{ x: 0, y: 0 }, { x: Number.NaN, y: 1 }] },
      { master: [{ x: 0, y: 0 }, { x: 1, y: Number.POSITIVE_INFINITY }] },
      { master: [{ x: 0, y: 0 }, { x: 1, y: 1, handleInX: Number.NaN }] },
      { master: [{ x: 0, y: 0 }, { x: 0, y: 1 }] },
      { master: [{ x: -0.01, y: 0 }, { x: 1, y: 1 }] },
      { master: [{ x: 0, y: 0, handleOutX: 0.8 }, { x: 1, y: 1, handleInX: 0.2 }] },
    ];
    const before = new Uint8ClampedArray(source.data);
    for (const curves of invalidCurves) {
      expectInvalidGrade(() => applyCurves(
        source,
        curves as Parameters<typeof applyCurves>[1],
      ));
    }
    expect(source.data).toEqual(before);
  });

  it('validates standalone curve interpolation before evaluating it', () => {
    expectInvalidGrade(() => interpolateCurve(Number.NaN, []));
    expectInvalidGrade(() => interpolateCurve(0.5, [
      { x: 0.25, y: 0 },
      { x: 0.25, y: 1 },
    ]));
    expectInvalidGrade(() => interpolateCurve(0.5, [
      { x: 0, y: 0 },
      { x: 1, y: 1, handleInY: Number.NEGATIVE_INFINITY },
    ]));
    expectInvalidGrade(() => interpolateCurve(0.5, [
      { x: 0, y: 0, handleOutX: 0.75 },
      { x: 1, y: 1, handleInX: 0.25 },
    ]));
    expect(interpolateCurve(0.5, [{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBe(0.5);
  });

  it('normalizes crop origins against positive final dimensions', () => {
    expect(normalizeGrade({
      transform: { crop: { x: 1, y: 1, width: 0.2, height: 0.3 } },
    }).transform.crop).toEqual({ x: 0.8, y: 0.7, width: 0.2, height: 0.3 });

    expect(normalizeGrade({
      transform: { crop: { x: -10, y: Number.NaN, width: 0.25, height: 0.5 } },
    }).transform.crop).toEqual({ x: 0, y: 0, width: 0.25, height: 0.5 });

    const tiny = normalizeGrade({
      transform: { crop: { x: 1, y: 1, width: 0, height: -1 } },
    }).transform.crop;
    expect(tiny).not.toBeNull();
    expect(tiny!.width).toBeGreaterThan(0);
    expect(tiny!.height).toBeGreaterThan(0);
    expect(tiny!.x + tiny!.width).toBeLessThanOrEqual(1);
    expect(tiny!.y + tiny!.height).toBeLessThanOrEqual(1);
  });

  it('validates the public encoded-byte/profile decoder', () => {
    expect(decodeToLinearValue(0, 'standard')).toBe(0);
    expect(decodeToLinearValue(255, 'standard')).toBe(1);
    for (const value of [-1, 256, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => decodeToLinearValue(value, 'standard')).toThrow(DarkroomError);
    }
    expect(() => decodeToLinearValue(128, 'unknown' as 'standard')).toThrow(DarkroomError);
    expect(() => getSceneLinearLuminance(Number.NaN, 0, 0, 'standard')).toThrow(DarkroomError);
    expect(() => getSceneLinearLuminance(0, 0, 0, 'unknown' as 'standard')).toThrow(DarkroomError);
  });

  it('validates profile options before the standard-profile no-op path', () => {
    expect(() => applyInputProfile(source, 'unknown' as 'standard')).toThrow(DarkroomError);
    for (const exposureStops of [-4, 4, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => applyInputProfile(source, 'standard', { exposureStops })).toThrow(DarkroomError);
    }
    expect(() => applyInputProfile(source, 'standard', {
      linearMode: 'yes' as unknown as boolean,
    })).toThrow(DarkroomError);
    expect(() => applyInputProfile(source, 'standard', null as never)).toThrow(DarkroomError);
  });
});
