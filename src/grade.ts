import { DarkroomError } from './errors.js';
import { normalizeGradeCurve } from './curve-validation.js';
import { ensureLut3D } from './lut.js';
import { clamp, finiteOr } from './math.js';
import type {
  Adjustments,
  ColorMatchStats,
  CurvePoint,
  Curves,
  EffectId,
  EffectOptions,
  Grade,
  GrainSpec,
  Look,
  QualifierConfig,
  Transform,
} from './types.js';

type AdjustmentRange = Readonly<{ min: number; max: number; step: number }>;

export const DEFAULT_ADJUSTMENTS: Adjustments = Object.freeze({
  exposure: 0,
  brightness: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  saturation: 0,
  vibrance: 0,
  hue: 0,
  temperature: 0,
  tint: 0,
  clarity: 0,
  vignette: 0,
  grain: 0,
  sepia: 0,
  sharpen: 0,
});

export const ADJUSTMENT_RANGES: Readonly<Record<keyof Adjustments, AdjustmentRange>> =
  Object.freeze({
    exposure: Object.freeze({ min: -100, max: 100, step: 1 }),
    brightness: Object.freeze({ min: -100, max: 100, step: 1 }),
    contrast: Object.freeze({ min: -100, max: 100, step: 1 }),
    highlights: Object.freeze({ min: -100, max: 100, step: 1 }),
    shadows: Object.freeze({ min: -100, max: 100, step: 1 }),
    whites: Object.freeze({ min: -100, max: 100, step: 1 }),
    blacks: Object.freeze({ min: -100, max: 100, step: 1 }),
    saturation: Object.freeze({ min: -100, max: 100, step: 1 }),
    vibrance: Object.freeze({ min: -50, max: 50, step: 1 }),
    hue: Object.freeze({ min: -180, max: 180, step: 1 }),
    temperature: Object.freeze({ min: -100, max: 100, step: 1 }),
    tint: Object.freeze({ min: -100, max: 100, step: 1 }),
    clarity: Object.freeze({ min: -100, max: 100, step: 1 }),
    vignette: Object.freeze({ min: 0, max: 100, step: 1 }),
    grain: Object.freeze({ min: 0, max: 100, step: 1 }),
    sepia: Object.freeze({ min: 0, max: 100, step: 1 }),
    sharpen: Object.freeze({ min: -100, max: 100, step: 1 }),
  });

export const DEFAULT_QUALIFIER: QualifierConfig = Object.freeze({
  enabled: false,
  hueMin: 0,
  hueMax: 360,
  satMin: 0,
  satMax: 1,
  lumMin: 0,
  lumMax: 1,
  hueSoft: 8,
  satSoft: 0.1,
  lumSoft: 0.1,
  spatialType: 'none',
  spatialX: 0.5,
  spatialY: 0.5,
  spatialWidth: 1,
  spatialHeight: 1,
  spatialRotation: 0,
  spatialFeather: 0.1,
  invert: false,
});

export const DEFAULT_TRANSFORM: Transform = Object.freeze({
  rotation: 0,
  flipH: false,
  flipV: false,
  crop: null,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const normalizedNumber = (
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number => clamp(finiteOr(value, fallback), minimum, maximum);

const normalizeAdjustments = (input: unknown): Adjustments => {
  const record = isRecord(input) ? input : {};
  const normalized = {} as Record<keyof Adjustments, number>;
  for (const key of Object.keys(DEFAULT_ADJUSTMENTS) as Array<keyof Adjustments>) {
    const range = ADJUSTMENT_RANGES[key];
    normalized[key] = normalizedNumber(record[key], DEFAULT_ADJUSTMENTS[key], range.min, range.max);
  }
  return Object.freeze(normalized) as Adjustments;
};

const normalizeCurves = (input: unknown): Curves => {
  const record = isRecord(input) ? input : {};
  const output: { master?: readonly CurvePoint[]; r?: readonly CurvePoint[]; g?: readonly CurvePoint[]; b?: readonly CurvePoint[] } = {};
  for (const channel of ['master', 'r', 'g', 'b'] as const) {
    const curve = normalizeGradeCurve(record[channel]);
    if (curve) output[channel] = curve;
  }
  return Object.freeze(output);
};

const normalizeQualifier = (input: unknown): QualifierConfig => {
  const record = isRecord(input) ? input : {};
  const spatialType = record.spatialType;
  return Object.freeze({
    enabled: typeof record.enabled === 'boolean' ? record.enabled : DEFAULT_QUALIFIER.enabled,
    hueMin: normalizedNumber(record.hueMin, DEFAULT_QUALIFIER.hueMin, 0, 360),
    hueMax: normalizedNumber(record.hueMax, DEFAULT_QUALIFIER.hueMax, 0, 360),
    satMin: normalizedNumber(record.satMin, DEFAULT_QUALIFIER.satMin, 0, 1),
    satMax: normalizedNumber(record.satMax, DEFAULT_QUALIFIER.satMax, 0, 1),
    lumMin: normalizedNumber(record.lumMin, DEFAULT_QUALIFIER.lumMin, 0, 1),
    lumMax: normalizedNumber(record.lumMax, DEFAULT_QUALIFIER.lumMax, 0, 1),
    hueSoft: normalizedNumber(record.hueSoft, DEFAULT_QUALIFIER.hueSoft, 0, 180),
    satSoft: normalizedNumber(record.satSoft, DEFAULT_QUALIFIER.satSoft, 0, 1),
    lumSoft: normalizedNumber(record.lumSoft, DEFAULT_QUALIFIER.lumSoft, 0, 1),
    spatialType:
      spatialType === 'linear'
      || spatialType === 'ellipse'
      || spatialType === 'radial'
      || spatialType === 'none'
        ? spatialType
        : DEFAULT_QUALIFIER.spatialType,
    spatialX: normalizedNumber(record.spatialX, DEFAULT_QUALIFIER.spatialX, 0, 1),
    spatialY: normalizedNumber(record.spatialY, DEFAULT_QUALIFIER.spatialY, 0, 1),
    spatialWidth: normalizedNumber(record.spatialWidth, DEFAULT_QUALIFIER.spatialWidth, 0, 4),
    spatialHeight: normalizedNumber(record.spatialHeight, DEFAULT_QUALIFIER.spatialHeight, 0, 4),
    spatialRotation: normalizedNumber(record.spatialRotation, DEFAULT_QUALIFIER.spatialRotation, -360, 360),
    spatialFeather: normalizedNumber(record.spatialFeather, DEFAULT_QUALIFIER.spatialFeather, 0, 1),
    invert: typeof record.invert === 'boolean' ? record.invert : DEFAULT_QUALIFIER.invert,
  });
};

const normalizeStats = (input: unknown): ColorMatchStats | null => {
  if (!isRecord(input) || !Array.isArray(input.mean) || !Array.isArray(input.std)) return null;
  if (input.mean.length !== 3 || input.std.length !== 3) return null;
  const mean = input.mean.map(Number);
  const std = input.std.map(Number);
  const sampleWeight = Number(input.sampleWeight);
  if (
    mean.some((value) => !Number.isFinite(value))
    || std.some((value) => !Number.isFinite(value) || value < 0)
    || !Number.isFinite(sampleWeight)
    || sampleWeight <= 0
  ) return null;
  return Object.freeze({
    mean: Object.freeze(mean) as unknown as readonly [number, number, number],
    std: Object.freeze(std) as unknown as readonly [number, number, number],
    sampleWeight,
  });
};

const normalizeColorMatch = (input: unknown): Grade['colorMatch'] => {
  if (!isRecord(input)) return null;
  const stats = normalizeStats(input.stats);
  if (!stats) return null;
  return Object.freeze({
    stats,
    intensity: normalizedNumber(input.intensity, 80, 0, 100),
  });
};

const normalizeGrain = (input: unknown): GrainSpec | undefined => {
  if (!isRecord(input)) return undefined;
  return Object.freeze({
    amount: normalizedNumber(input.amount, 0, 0, 100),
    warmth: normalizedNumber(input.warmth, 0, 0, 1),
    size: normalizedNumber(input.size, 0, 0, 1),
  });
};

const normalizeLook = (input: unknown): Look | null => {
  if (!isRecord(input) || !isRecord(input.lut)) return null;
  const lut = ensureLut3D(input.lut as unknown as Parameters<typeof ensureLut3D>[0]);
  const grain = normalizeGrain(input.grain);
  return Object.freeze({ lut, ...(grain ? { grain } : {}) });
};

const EFFECT_IDS = new Set<EffectId>([
  'pixelate', 'blur', 'posterize', 'water', 'halftone', 'vhs', 'painting',
]);

const normalizeEffectOptions = (input: unknown): EffectOptions => {
  const record = isRecord(input) ? input : {};
  const options: Record<string, string | number | boolean> = {};
  const finiteFields = {
    blurRadius: [0, 256],
    blurThreshold: [0, 255],
    pixelSize: [1, 512],
    posterizeLevels: [2, 256],
    halftoneAngle: [-360, 360],
    halftoneFrequency: [1, 512],
    paintingStrength: [0, 100],
    waterWavelength: [1, 512],
    waterCaustics: [0, 100],
  } as const;
  for (const [key, bounds] of Object.entries(finiteFields)) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      options[key] = clamp(value, bounds[0], bounds[1]);
    }
  }
  if (record.blurMode === 'box' || record.blurMode === 'gaussian' || record.blurMode === 'bilateral' || record.blurMode === 'bokeh') options.blurMode = record.blurMode;
  if (typeof record.pixelateDither === 'boolean') options.pixelateDither = record.pixelateDither;
  if (typeof record.posterizeDither === 'boolean') options.posterizeDither = record.posterizeDither;
  if (record.halftoneShape === 'circle' || record.halftoneShape === 'line' || record.halftoneShape === 'ellipse') options.halftoneShape = record.halftoneShape;
  if (record.vhsProfile === 'consumer' || record.vhsProfile === 'pro' || record.vhsProfile === 'degraded') options.vhsProfile = record.vhsProfile;
  if (typeof record.color1 === 'string' && record.color1.length <= 64) options.color1 = record.color1;
  if (typeof record.color2 === 'string' && record.color2.length <= 64) options.color2 = record.color2;
  return Object.freeze(options) as EffectOptions;
};

const normalizeEffect = (input: unknown): Grade['effect'] => {
  if (!isRecord(input) || typeof input.id !== 'string' || !EFFECT_IDS.has(input.id as EffectId)) {
    return null;
  }
  return Object.freeze({
    id: input.id as EffectId,
    intensity: normalizedNumber(input.intensity, 100, 0, 100),
    options: normalizeEffectOptions(input.options),
  });
};

const normalizeTransform = (input: unknown): Transform => {
  const record = isRecord(input) ? input : {};
  const rotation = record.rotation;
  const cropRecord = isRecord(record.crop) ? record.crop : null;
  const width = cropRecord
    ? normalizedNumber(cropRecord.width, 1, Number.EPSILON, 1)
    : 1;
  const height = cropRecord
    ? normalizedNumber(cropRecord.height, 1, Number.EPSILON, 1)
    : 1;
  const constrainedCrop = cropRecord
    ? Object.freeze({
        x: normalizedNumber(cropRecord.x, 0, 0, 1 - width),
        y: normalizedNumber(cropRecord.y, 0, 0, 1 - height),
        width,
        height,
      })
    : null;
  return Object.freeze({
    rotation: rotation === 90 || rotation === 180 || rotation === 270 ? rotation : 0,
    flipH: typeof record.flipH === 'boolean' ? record.flipH : false,
    flipV: typeof record.flipV === 'boolean' ? record.flipV : false,
    crop: constrainedCrop,
  });
};

export const normalizeGrade = (input: unknown = {}): Grade => {
  if (input !== undefined && input !== null && !isRecord(input)) {
    throw new DarkroomError('INVALID_GRADE', 'Grade input must be an object.');
  }
  const record = isRecord(input) ? input : {};
  return Object.freeze({
    adjustments: normalizeAdjustments(record.adjustments),
    curves: normalizeCurves(record.curves),
    qualifier: normalizeQualifier(record.qualifier),
    colorMatch: normalizeColorMatch(record.colorMatch),
    look: normalizeLook(record.look),
    lookIntensity: normalizedNumber(record.lookIntensity, 100, 0, 100),
    effect: normalizeEffect(record.effect),
    transform: normalizeTransform(record.transform),
  });
};

export const createDefaultGrade = (): Grade => normalizeGrade();
