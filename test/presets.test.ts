import { describe, expect, it } from 'vitest';

import { createPixelBuffer } from '../src/buffer.js';
import { DarkroomError } from '../src/errors.js';
import { applyFilmGrain, applyLook } from '../src/look.js';
import * as presetApi from '../src/presets/index.js';
import {
  compilePreset,
  getPreset,
  isPresetId,
  presets,
  type PresetCategory,
  type PresetId,
} from '../src/presets/index.js';

const EXPECTED_CATEGORIES = new Set<PresetCategory>([
  'portrait',
  'film-color',
  'cinema',
  'social',
  'classic',
  'monochrome',
]);

const EXPECTED_FEATURED_CINEMA = new Set<PresetId>([
  'tealOrange',
  'bleachBypass',
  'goldenHour',
  'moodyDesat',
  'noirTeal',
  'sunsetGlow',
  'forestMist',
  'copperTone',
]);

const fnv1a = (data: Float32Array): string => {
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
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

describe('preset catalog', () => {
  it('publishes exactly 60 unique, non-identity preset IDs', () => {
    const ids = presets.map((preset) => preset.id);
    expect(ids).toHaveLength(60);
    expect(new Set(ids).size).toBe(60);
    expect(ids).not.toContain('none');
  });

  it('uses only neutral categories and one canonical cinema tag', () => {
    expect(new Set(presets.map((preset) => preset.category))).toEqual(EXPECTED_CATEGORIES);

    const featured = presets
      .filter((preset) => preset.tags.includes('featured-cinema'))
      .map((preset) => preset.id);
    expect(new Set(featured)).toEqual(EXPECTED_FEATURED_CINEMA);
  });

  it('exposes deeply immutable metadata without rendering builders', () => {
    expect(Object.isFrozen(presets)).toBe(true);

    for (const preset of presets) {
      expect(Object.isFrozen(preset)).toBe(true);
      expect(Object.isFrozen(preset.tags)).toBe(true);
      expect('buildLut' in preset).toBe(false);
      expect('response' in preset).toBe(false);
    }

    const first = presets[0] as unknown as { label: string; tags: string[] };
    expect(() => {
      first.label = 'mutated';
    }).toThrow(TypeError);
    expect(() => first.tags.push('mutated')).toThrow(TypeError);
  });

  it('keeps internal catalog diagnostics out of the public entry', () => {
    expect(presetApi).not.toHaveProperty('PRESET_CATALOG_ISOLATION_SENTINEL');
    expect(Object.keys(presetApi).sort()).toEqual([
      'compilePreset',
      'getPreset',
      'isPresetId',
      'presets',
    ]);
  });

  it('validates and resolves IDs without manufacturing unknown presets', () => {
    for (const preset of presets) {
      expect(isPresetId(preset.id)).toBe(true);
      expect(getPreset(preset.id)).toBe(preset);
    }

    for (const candidate of ['none', '', 'PORTRA400', '__proto__', 42, null, undefined]) {
      expect(isPresetId(candidate)).toBe(false);
    }
    expect(getPreset('missing')).toBeUndefined();
  });
});

describe('preset compilation', () => {
  it('compiles every preset into a finite normalized 17-cube', () => {
    for (const preset of presets) {
      const look = compilePreset(preset.id, { lutSize: 17 });
      expect(look.lut.size).toBe(17);
      expect(look.lut.title).toBe(preset.label);
      expect(look.lut.data).toHaveLength(17 ** 3 * 3);
      expect(look.lut.data.every((value) => Number.isFinite(value))).toBe(true);
      expect(look.lut.data.every((value) => value >= 0 && value <= 1)).toBe(true);
      expect(Object.isFrozen(look)).toBe(true);
      if (look.grain) expect(Object.isFrozen(look.grain)).toBe(true);
    }
  }, 20_000);

  it('supports 17, 33, and 65 cubes and defaults to the parity-oriented 65-cube', () => {
    expect(compilePreset('magicNatural', { lutSize: 17 }).lut.size).toBe(17);
    expect(compilePreset('magicNatural', { lutSize: 33 }).lut.size).toBe(33);
    expect(compilePreset('magicNatural').lut.size).toBe(65);
  }, 15_000);

  it('returns fresh deterministic LUT data and stable grain metadata', () => {
    const first = compilePreset('portra400', { lutSize: 17 });
    const second = compilePreset('portra400', { lutSize: 17 });

    expect(first).not.toBe(second);
    expect(first.lut.data).not.toBe(second.lut.data);
    expect(first.lut.data).toEqual(second.lut.data);
    expect(first.grain).toEqual({ amount: 18, warmth: 0.55, size: 0.45 });
    expect(second.grain).toEqual(first.grain);
  });

  it('preserves alpha and legacy visible-pixel grain behavior', () => {
    const source = createPixelBuffer({
      width: 3,
      height: 1,
      data: [100, 110, 120, 255, 50, 60, 70, 128, 10, 20, 30, 0],
    });
    const look = compilePreset('portra400', { lutSize: 17 });
    expect(look.grain).toEqual({ amount: 18, warmth: 0.55, size: 0.45 });

    const grainOnly = applyFilmGrain(source, look.grain!, 100);
    expect([...grainOnly.data]).toEqual([
      103, 112, 121, 255,
      49, 59, 69, 128,
      10, 20, 30, 0,
    ]);

    const rendered = applyLook(source, look, 100);
    expect([rendered.data[3], rendered.data[7], rendered.data[11]]).toEqual([255, 128, 0]);
    expect([...rendered.data.slice(8, 12)]).toEqual([10, 20, 30, 0]);
  });

  it('locks representative rendering output against accidental catalog drift', () => {
    const hashes = Object.fromEntries(
      (['portra400', 'tealOrange', 'magicNatural', 'noirHigh'] as const).map((id) => [
        id,
        fnv1a(compilePreset(id, { lutSize: 17 }).lut.data),
      ]),
    );

    expect(hashes).toEqual({
      portra400: '719bbc03',
      tealOrange: '37b18448',
      magicNatural: '6c9044fd',
      noirHigh: 'dc4942b7',
    });
  });

  it('rejects invalid IDs and options with a stable package error', () => {
    const invalidCalls: Array<() => unknown> = [
      () => compilePreset('missing' as PresetId, { lutSize: 17 }),
      () => compilePreset(null as unknown as PresetId, { lutSize: 17 }),
      () => compilePreset('portra400', null as never),
      () => compilePreset('portra400', [] as never),
      () => compilePreset('portra400', { unknown: true } as never),
      () => compilePreset('portra400', { lutSize: 16 } as never),
      () => compilePreset('portra400', { lutSize: Number.NaN } as never),
      () => compilePreset('portra400', { lutSize: '17' } as never),
    ];
    for (const call of invalidCalls) expectInvalidGrade(call);
  });
});
