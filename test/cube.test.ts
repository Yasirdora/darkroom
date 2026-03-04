import { describe, expect, it } from 'vitest';

import { formatCube, parseCube } from '../src/cube.js';
import { DARKROOM_LIMITS } from '../src/limits.js';

const constantCube = (size: number): string => [
  'TITLE "Constant"',
  `LUT_3D_SIZE ${size}`,
  'DOMAIN_MIN -0.25 0 0.125',
  'DOMAIN_MAX 1.25 0.75 1.5',
  '0.25 0.5 0.75\n'.repeat(size ** 3).trimEnd(),
].join('\n');

const identityTwoCube = [
  'TITLE "Identity Two"',
  'LUT_3D_SIZE 2',
  'DOMAIN_MIN -1 -2 -3',
  'DOMAIN_MAX 1 2 3',
  '0 0 0',
  '1 0 0',
  '0 1 0',
  '1 1 0',
  '0 0 1',
  '1 0 1',
  '0 1 1',
  '1 1 1',
].join('\n');

describe('.cube compatibility', () => {
  it.each([2, 16, 32, 64, 65])('imports a common %i-cube into a supported Float32 grid', (sourceSize) => {
    const lut = parseCube(constantCube(sourceSize));
    expect(lut.size).toBe(65);
    expect(lut.data).toBeInstanceOf(Float32Array);
    expect(lut.data).toHaveLength(65 ** 3 * 3);
    expect(lut.domainMin).toEqual([-0.25, 0, 0.125]);
    expect(lut.domainMax).toEqual([1.25, 0.75, 1.5]);
    expect([...lut.data.slice(0, 3)]).toEqual([0.25, 0.5, 0.75]);
    expect([...lut.data.slice(-3)]).toEqual([0.25, 0.5, 0.75]);
  }, 30_000);

  it('resamples in the declared input domain and honors an explicit target size', () => {
    const lut = parseCube(identityTwoCube, { size: 17 });
    const midpoint = (8 + 8 * 17 + 8 * 17 * 17) * 3;
    expect(lut.size).toBe(17);
    expect(lut.domainMin).toEqual([-1, -2, -3]);
    expect(lut.domainMax).toEqual([1, 2, 3]);
    expect(lut.data[midpoint]).toBeCloseTo(0.5, 6);
    expect(lut.data[midpoint + 1]).toBeCloseTo(0.5, 6);
    expect(lut.data[midpoint + 2]).toBeCloseTo(0.5, 6);
  });

  it('round-trips title, domains and data through the formatter', () => {
    const first = parseCube(identityTwoCube, { size: 17 });
    const second = parseCube(formatCube(first), { size: 17 });
    expect(second.title).toBe(first.title);
    expect(second.domainMin).toEqual(first.domainMin);
    expect(second.domainMax).toEqual(first.domainMax);
    expect(second.data).toEqual(first.data);
  });

  it('rejects malformed, oversized and unsupported target inputs before unsafe allocation', () => {
    expect(() => parseCube('LUT_3D_SIZE 1')).toThrow('between 2 and 65');
    expect(() => parseCube('LUT_3D_SIZE 66')).toThrow('between 2 and 65');
    expect(() => parseCube('LUT_3D_SIZE 2\n0 0 0')).toThrow('Expected 8 color rows');
    expect(() => parseCube(identityTwoCube, { size: 32 as 17 })).toThrow('Unsupported target');
    expect(DARKROOM_LIMITS.maxCubeTextCodeUnits).toBeGreaterThanOrEqual(
      constantCube(65).length,
    );
  });
});
