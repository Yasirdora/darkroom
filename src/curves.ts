import { adoptPixelBuffer, assertPixelBuffer } from './buffer.js';
import { luma } from './color.js';
import { validateCurvePoints, validateCurves } from './curve-validation.js';
import { DarkroomError } from './errors.js';
import { clamp, clampByte } from './math.js';
import type { CurvePoint, Curves, PixelBuffer } from './types.js';

/**
 * Point-curve engine for normalized channel and luma values.
 * Supports master (luma) + per-channel point curves with optional cubic Bézier handles.
 * Points are normalized to [0, 1]. Processing uses the encoded 8-bit RGB
 * values in `PixelBuffer`; callers that require a linear workflow must decode
 * the input first.
 */

/** Cubic Bézier helper */
function cubicBezier(t: number, p0: number, c0: number, c1: number, p1: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * c0 + 3 * u * t * t * c1 + t * t * t * p1;
}

/**
 * Solve for t in Bézier X given x. Uses true bisection — x(t) is monotonic on
 * a curve segment (handles are constrained within the segment), so bisection
 * always converges, unlike the previous fixed-step iteration which could
 * stall on steep handles.
 */
function solveBezierT(x: number, x0: number, x1: number, x2: number, x3: number, iterations = 24): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < iterations; i++) {
    const mid = (lo + hi) / 2;
    const val = cubicBezier(mid, x0, x1, x2, x3);
    if (Math.abs(val - x) < 0.00005) return mid;
    if (val < x) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

const interpolateValidatedCurve = (x: number, sorted: readonly CurvePoint[]): number => {
  if (sorted.length === 0) return x;

  // Clamp to first/last
  if (x <= sorted[0].x) return sorted[0].y;
  if (x >= sorted[sorted.length - 1].x) return sorted[sorted.length - 1].y;

  // Find segment
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const p0 = sorted[i];
    const p1 = sorted[i + 1];
    if (x >= p0.x && x <= p1.x) {
      const hasHandles =
        p0.handleOutX !== undefined ||
        p0.handleOutY !== undefined ||
        p1.handleInX !== undefined ||
        p1.handleInY !== undefined;

      if (hasHandles) {
        const hx0 = p0.handleOutX ?? p0.x;
        const hy0 = p0.handleOutY ?? p0.y;
        const hx1 = p1.handleInX ?? p1.x;
        const hy1 = p1.handleInY ?? p1.y;

        const t = solveBezierT(x, p0.x, hx0, hx1, p1.x);
        return cubicBezier(t, p0.y, hy0, hy1, p1.y);
      } else {
        // Linear fallback
        const t = (x - p0.x) / Math.max(p1.x - p0.x, 0.0001);
        return p0.y + (p1.y - p0.y) * t;
      }
    }
  }
  return x;
};

export function interpolateCurve(x: number, points: readonly CurvePoint[]): number {
  if (typeof x !== 'number' || !Number.isFinite(x)) {
    throw new DarkroomError('INVALID_GRADE', 'Curve input must be a finite number.');
  }
  return interpolateValidatedCurve(x, validateCurvePoints(points));
}

function applyCurveToValue(v: number, curve?: readonly CurvePoint[]): number {
  if (!curve || curve.length < 2) return v;
  const xn = clamp(v / 255, 0, 1);
  const yn = interpolateValidatedCurve(xn, curve);
  return clampByte(yn * 255);
}

/**
 * Apply curves to a pixel buffer. Master affects luminance then recombines.
 * For simplicity and quality: per-channel + optional master (applied to each after rgb adjust).
 */
export const applyCurves = (source: PixelBuffer, curves: Curves): PixelBuffer => {
  assertPixelBuffer(source);
  const validated = validateCurves(curves);
  const { width, height, data } = source;

  const hasMaster = validated.master && validated.master.length >= 2;
  const hasR = validated.r && validated.r.length >= 2;
  const hasG = validated.g && validated.g.length >= 2;
  const hasB = validated.b && validated.b.length >= 2;

  if (!hasMaster && !hasR && !hasG && !hasB) {
    return source;
  }

  const output = new Uint8ClampedArray(data.length);

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) {
      output.set(data.subarray(i, i + 4), i);
      continue;
    }
    let r = data[i];
    let g = data[i + 1];
    let b = data[i + 2];

    // Per channel first
    if (hasR) r = applyCurveToValue(r, validated.r);
    if (hasG) g = applyCurveToValue(g, validated.g);
    if (hasB) b = applyCurveToValue(b, validated.b);

    // Master curve (luma weighted or direct on channels for classic "master" feel)
    if (hasMaster) {
      const lm = luma(r, g, b);
      const masterY = applyCurveToValue(lm, validated.master);
      // Offset by delta (perceptual master curve lift)
      const delta = masterY - lm;
      r = clampByte(r + delta * 0.9);
      g = clampByte(g + delta * 1.05);
      b = clampByte(b + delta * 0.85);
    }

    output[i] = clampByte(r);
    output[i + 1] = clampByte(g);
    output[i + 2] = clampByte(b);
    output[i + 3] = data[i + 3];
  }

  return adoptPixelBuffer({ width, height, data: output });
};

/** Utility: generate simple S-curve (with Bézier handles) */
export const makeDefaultSCurve = (strength = 0.5): CurvePoint[] => {
  const amount = clamp(strength, 0, 1);
  const shadowY = 0.25 - 0.14 * amount;
  const highlightY = 0.75 + 0.14 * amount;
  return [
    { x: 0, y: 0 },
    { x: 0.25, y: shadowY, handleOutX: 0.38, handleOutY: shadowY + 0.04 },
    { x: 0.5, y: 0.5, handleInX: 0.35, handleInY: 0.32, handleOutX: 0.65, handleOutY: 0.68 },
    { x: 0.75, y: highlightY, handleInX: 0.62, handleInY: highlightY - 0.1, handleOutX: 0.82, handleOutY: highlightY + 0.06 },
    { x: 1, y: 1 },
  ];
};

export const identityCurve = (): CurvePoint[] => [{ x: 0, y: 0 }, { x: 1, y: 1 }];
