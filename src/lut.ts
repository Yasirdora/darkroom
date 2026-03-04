import { adoptPixelBuffer, assertPixelBuffer } from './buffer.js';
import { DarkroomError } from './errors.js';
import { DARKROOM_LIMITS } from './limits.js';
import { clamp, lerp } from './math.js';
import type { Lut3D, Lut3DInput, LutSize, PixelBuffer } from './types.js';

const DEFAULT_DOMAIN_MIN = Object.freeze([0, 0, 0] as const);
const DEFAULT_DOMAIN_MAX = Object.freeze([1, 1, 1] as const);
const MAX_TITLE_LENGTH = 256;
const validatedLuts = new WeakSet<object>();

export type ByteColorTransform = (
  red: number,
  green: number,
  blue: number,
) => readonly [number, number, number];

export interface BuildLutOptions {
  readonly size?: LutSize;
  readonly title?: string;
}

export const isLutSize = (value: unknown): value is LutSize =>
  value === 17 || value === 33 || value === 65;

const normalizeDomain = (
  value: readonly [number, number, number] | undefined,
  fallback: readonly [number, number, number],
  name: string,
): readonly [number, number, number] => {
  const candidate = value ?? fallback;
  if (candidate.length !== 3 || candidate.some((channel) => !Number.isFinite(channel))) {
    throw new DarkroomError('INVALID_LUT', `${name} must contain three finite numbers.`);
  }
  return Object.freeze([candidate[0], candidate[1], candidate[2]] as const);
};

export const createLut3D = (input: Lut3DInput): Lut3D => {
  if (!isLutSize(input.size)) {
    throw new DarkroomError(
      'UNSUPPORTED_LUT_SIZE',
      `Supported 3D LUT sizes are ${DARKROOM_LIMITS.supportedLutSizes.join(', ')}.`,
    );
  }
  const expectedLength = input.size ** 3 * 3;
  if (input.data.length !== expectedLength) {
    throw new DarkroomError(
      'INVALID_LUT',
      `Expected ${expectedLength} LUT channel values, received ${input.data.length}.`,
    );
  }

  const data = new Float32Array(expectedLength);
  for (let index = 0; index < expectedLength; index += 1) {
    const value = Number(input.data[index]);
    if (!Number.isFinite(value)) {
      throw new DarkroomError('INVALID_LUT', `LUT channel ${index} is not finite.`);
    }
    data[index] = value;
  }

  const domainMin = normalizeDomain(input.domainMin, DEFAULT_DOMAIN_MIN, 'domainMin');
  const domainMax = normalizeDomain(input.domainMax, DEFAULT_DOMAIN_MAX, 'domainMax');
  for (let channel = 0; channel < 3; channel += 1) {
    if (domainMin[channel] >= domainMax[channel]) {
      throw new DarkroomError('INVALID_LUT', 'Each domainMin channel must be below domainMax.');
    }
  }

  const title = input.title?.trim();
  if (title && title.length > MAX_TITLE_LENGTH) {
    throw new DarkroomError('INVALID_LUT', `LUT title must not exceed ${MAX_TITLE_LENGTH} characters.`);
  }

  const lut: Lut3D = Object.freeze({
    size: input.size,
    data,
    domainMin,
    domainMax,
    ...(title ? { title } : {}),
  });
  validatedLuts.add(lut);
  return lut;
};

/**
 * Internal fast path for package-owned LUT allocations. The Float32Array is an
 * owned defensive copy but JavaScript cannot freeze typed-array elements;
 * callers must treat public LUT data as immutable as required by the contract.
 * Structured-cloned/unrecognized objects are validated and copied again.
 */
export const ensureLut3D = (input: Lut3D): Lut3D =>
  validatedLuts.has(input) ? input : createLut3D(input);

/** Build a normalized Float32 3D LUT from the legacy byte-domain transform contract. */
export const buildLut = (
  transform: ByteColorTransform,
  options: BuildLutOptions = {},
): Lut3D => {
  const size = options.size ?? 33;
  if (!isLutSize(size)) {
    throw new DarkroomError('UNSUPPORTED_LUT_SIZE', 'Unsupported LUT size.');
  }
  const data = new Float32Array(size ** 3 * 3);
  for (let blue = 0; blue < size; blue += 1) {
    for (let green = 0; green < size; green += 1) {
      for (let red = 0; red < size; red += 1) {
        const sourceRed = (red / (size - 1)) * 255;
        const sourceGreen = (green / (size - 1)) * 255;
        const sourceBlue = (blue / (size - 1)) * 255;
        const transformed = transform(sourceRed, sourceGreen, sourceBlue);
        if (
          transformed.length !== 3
          || transformed.some((channel) => !Number.isFinite(channel))
        ) {
          throw new DarkroomError('INVALID_LUT', 'LUT transform returned an invalid color.');
        }
        const offset = (red + green * size + blue * size * size) * 3;
        data[offset] = transformed[0] / 255;
        data[offset + 1] = transformed[1] / 255;
        data[offset + 2] = transformed[2] / 255;
      }
    }
  }
  return createLut3D({ size, data, ...(options.title ? { title: options.title } : {}) });
};

const sampleLutNormalized = (
  lut: Lut3D,
  red: number,
  green: number,
  blue: number,
): readonly [number, number, number] => {
  const normalized = [red, green, blue].map((channel, index) =>
    clamp(
      (channel - lut.domainMin[index]) / (lut.domainMax[index] - lut.domainMin[index]),
      0,
      1,
    ),
  );
  const maximum = lut.size - 1;
  const rf = normalized[0] * maximum;
  const gf = normalized[1] * maximum;
  const bf = normalized[2] * maximum;
  const r0 = Math.floor(rf);
  const g0 = Math.floor(gf);
  const b0 = Math.floor(bf);
  const r1 = Math.min(maximum, r0 + 1);
  const g1 = Math.min(maximum, g0 + 1);
  const b1 = Math.min(maximum, b0 + 1);
  const rt = rf - r0;
  const gt = gf - g0;
  const bt = bf - b0;

  const read = (r: number, g: number, b: number, channel: number): number =>
    lut.data[(r + g * lut.size + b * lut.size * lut.size) * 3 + channel];
  const interpolateChannel = (channel: number): number => {
    const c000 = read(r0, g0, b0, channel);
    const c100 = read(r1, g0, b0, channel);
    const c010 = read(r0, g1, b0, channel);
    const c110 = read(r1, g1, b0, channel);
    const c001 = read(r0, g0, b1, channel);
    const c101 = read(r1, g0, b1, channel);
    const c011 = read(r0, g1, b1, channel);
    const c111 = read(r1, g1, b1, channel);
    const lower = lerp(lerp(c000, c100, rt), lerp(c010, c110, rt), gt);
    const upper = lerp(lerp(c001, c101, rt), lerp(c011, c111, rt), gt);
    return lerp(lower, upper, bt);
  };
  return [interpolateChannel(0), interpolateChannel(1), interpolateChannel(2)];
};

export const applyLut = (
  source: PixelBuffer,
  lutInput: Lut3D,
  intensity = 100,
): PixelBuffer => {
  assertPixelBuffer(source);
  const lut = ensureLut3D(lutInput);
  const amount = clamp(Number.isFinite(intensity) ? intensity / 100 : 0, 0, 1);
  if (amount === 0) return source;
  const output = new Uint8ClampedArray(source.data);
  for (let index = 0; index < output.length; index += 4) {
    if (output[index + 3] === 0) continue;
    const [red, green, blue] = sampleLutNormalized(
      lut,
      output[index] / 255,
      output[index + 1] / 255,
      output[index + 2] / 255,
    );
    output[index] = Math.round(lerp(output[index], red * 255, amount));
    output[index + 1] = Math.round(lerp(output[index + 1], green * 255, amount));
    output[index + 2] = Math.round(lerp(output[index + 2], blue * 255, amount));
  }
  return adoptPixelBuffer({ width: source.width, height: source.height, data: output });
};

export const resampleLut = (sourceInput: Lut3D, size: LutSize): Lut3D => {
  const source = ensureLut3D(sourceInput);
  if (!isLutSize(size)) {
    throw new DarkroomError('UNSUPPORTED_LUT_SIZE', 'Unsupported LUT size.');
  }
  if (source.size === size) return createLut3D(source);
  const data = new Float32Array(size ** 3 * 3);
  for (let blue = 0; blue < size; blue += 1) {
    for (let green = 0; green < size; green += 1) {
      for (let red = 0; red < size; red += 1) {
        const sample = sampleLutNormalized(
          source,
          lerp(source.domainMin[0], source.domainMax[0], red / (size - 1)),
          lerp(source.domainMin[1], source.domainMax[1], green / (size - 1)),
          lerp(source.domainMin[2], source.domainMax[2], blue / (size - 1)),
        );
        const offset = (red + green * size + blue * size * size) * 3;
        data.set(sample, offset);
      }
    }
  }
  return createLut3D({
    size,
    data,
    domainMin: source.domainMin,
    domainMax: source.domainMax,
    ...(source.title ? { title: source.title } : {}),
  });
};
