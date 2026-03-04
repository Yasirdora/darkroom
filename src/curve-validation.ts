import { DarkroomError } from './errors.js';
import { DARKROOM_LIMITS } from './limits.js';
import { clamp } from './math.js';
import type { CurvePoint, Curves } from './types.js';

const CURVE_CHANNELS = ['master', 'r', 'g', 'b'] as const;
const CURVE_HANDLE_KEYS = [
  'handleOutX',
  'handleOutY',
  'handleInX',
  'handleInY',
] as const;

type CurveValidationMode = 'normalize' | 'strict';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const invalidCurve = (message: string): never => {
  throw new DarkroomError('INVALID_GRADE', message);
};

const normalizedCoordinate = (
  value: unknown,
  label: string,
  mode: CurveValidationMode,
): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return invalidCurve(`${label} must be a finite number.`);
  }
  if (mode === 'strict' && (value < 0 || value > 1)) {
    return invalidCurve(`${label} must be between 0 and 1.`);
  }
  return mode === 'normalize' ? clamp(value, 0, 1) : value;
};

const parseCurvePoint = (
  value: unknown,
  index: number,
  mode: CurveValidationMode,
): CurvePoint => {
  if (!isRecord(value)) {
    return invalidCurve(`Curve point ${index} must be an object.`);
  }

  const point: Record<string, number> = {
    x: normalizedCoordinate(value.x, `Curve point ${index}.x`, mode),
    y: normalizedCoordinate(value.y, `Curve point ${index}.y`, mode),
  };
  for (const key of CURVE_HANDLE_KEYS) {
    if (value[key] === undefined) continue;
    point[key] = normalizedCoordinate(value[key], `Curve point ${index}.${key}`, mode);
  }
  return Object.freeze(point) as unknown as CurvePoint;
};

const parseCurvePoints = (
  value: unknown,
  mode: CurveValidationMode,
): readonly CurvePoint[] => {
  if (!Array.isArray(value)) {
    return invalidCurve('Curve data must be an array of points.');
  }
  if (value.length > DARKROOM_LIMITS.maxCurvePoints) {
    return invalidCurve(`A curve may contain at most ${DARKROOM_LIMITS.maxCurvePoints} points.`);
  }

  const sorted = value
    .map((point, index) => parseCurvePoint(point, index, mode))
    .sort((left, right) => left.x - right.x);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].x - sorted[index - 1].x < 0.000_001) {
      return invalidCurve('Curve point x values must be unique.');
    }
    const left = sorted[index - 1];
    const right = sorted[index];
    const outgoingX = left.handleOutX ?? left.x;
    const incomingX = right.handleInX ?? right.x;
    if (
      outgoingX < left.x
      || outgoingX > right.x
      || incomingX < left.x
      || incomingX > right.x
      || outgoingX > incomingX
    ) {
      return invalidCurve(
        'Curve handle x values must be monotonic and remain inside their segment.',
      );
    }
  }
  return Object.freeze(sorted);
};

/** Normalize one optional grade curve while preserving the existing grade-input policy. */
export const normalizeGradeCurve = (value: unknown): readonly CurvePoint[] | undefined => {
  if (!Array.isArray(value) || value.length < 2) return undefined;
  return parseCurvePoints(value, 'normalize');
};

/** Validate untrusted curve points at a direct public processing boundary. */
export const validateCurvePoints = (value: unknown): readonly CurvePoint[] =>
  parseCurvePoints(value, 'strict');

/** Validate and sort every supplied channel at the direct applyCurves boundary. */
export const validateCurves = (value: unknown): Curves => {
  if (!isRecord(value)) {
    return invalidCurve('Curves must be an object.');
  }
  const output: {
    master?: readonly CurvePoint[];
    r?: readonly CurvePoint[];
    g?: readonly CurvePoint[];
    b?: readonly CurvePoint[];
  } = {};
  for (const channel of CURVE_CHANNELS) {
    if (value[channel] === undefined) continue;
    output[channel] = validateCurvePoints(value[channel]);
  }
  return Object.freeze(output);
};
