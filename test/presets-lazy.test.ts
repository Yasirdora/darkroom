import { describe, expect, it, vi } from 'vitest';

const buildLutSpy = vi.hoisted(() => vi.fn());

vi.mock('../src/lut.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lut.js')>();
  return {
    ...actual,
    buildLut: (...args: Parameters<typeof actual.buildLut>) => {
      buildLutSpy();
      return actual.buildLut(...args);
    },
  };
});

import { compilePreset, presets } from '../src/presets/index.js';

describe('preset loading', () => {
  it('does not compile LUTs while importing or reading metadata', () => {
    expect(presets).toHaveLength(60);
    expect(presets.map((preset) => preset.id)).toContain('tealOrange');
    expect(buildLutSpy).not.toHaveBeenCalled();
  });

  it('compiles exactly the requested preset on demand', () => {
    const look = compilePreset('tealOrange', { lutSize: 17 });
    expect(look.lut.size).toBe(17);
    expect(buildLutSpy).toHaveBeenCalledTimes(1);
  });
});
