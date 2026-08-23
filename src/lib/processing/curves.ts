import { clamp, clampByte } from '../core/math';
import type { CurvePoint, Curves } from '../core/types';
import { luma as filmLuma } from './filters/film-model';

/**
 * Pro-grade curves engine (reuses film-model tone logic patterns).
 * Supports master (luma) + per-channel point curves with optional cubic Bézier handles.
 * Points are normalized [0,1]. Applied in scene-linear-ish space for quality.
 * Returns a new ImageData (CPU path; WebGL will use LUT texture version).
 */

function sortPoints(pts: CurvePoint[]): CurvePoint[] {
  return [...pts].sort((a, b) => a.x - b.x);
}

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

export function interpolateCurve(x: number, points: CurvePoint[]): number {
  if (!points || points.length === 0) return x;
  const sorted = sortPoints(points);

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
}

function applyCurveToValue(v: number, curve?: CurvePoint[]): number {
  if (!curve || curve.length < 2) return v;
  const xn = clamp(v / 255, 0, 1);
  const yn = interpolateCurve(xn, curve);
  return clampByte(yn * 255);
}

/**
 * Apply curves to an ImageData. Master affects luminance then recombine.
 * For simplicity and quality: per-channel + optional master (applied to each after rgb adjust).
 */
export const applyCurves = (source: ImageData, curves: Curves): ImageData => {
  const { width, height, data } = source;
  const output = new Uint8ClampedArray(data.length);

  const hasMaster = curves.master && curves.master.length >= 2;
  const hasR = curves.r && curves.r.length >= 2;
  const hasG = curves.g && curves.g.length >= 2;
  const hasB = curves.b && curves.b.length >= 2;

  if (!hasMaster && !hasR && !hasG && !hasB) {
    return new ImageData(new Uint8ClampedArray(data), width, height);
  }

  for (let i = 0; i < data.length; i += 4) {
    let r = data[i];
    let g = data[i + 1];
    let b = data[i + 2];

    // Per channel first
    if (hasR) r = applyCurveToValue(r, curves.r);
    if (hasG) g = applyCurveToValue(g, curves.g);
    if (hasB) b = applyCurveToValue(b, curves.b);

    // Master curve: a luminance offset applied equally to all three channels.
    //
    // Equally, and that is the whole point. The offset used to be weighted
    // 0.9 red, 1.05 green, 0.85 blue, described as a warm bias matching how a
    // print responds to exposure. It did not do that. Warm and cool is the
    // red-to-blue axis, and those weights make *green* the outlier — the
    // green-to-magenta axis, which is tint. Pushing the curve up tinted the
    // picture green and pushing it down tinted it magenta, by as much as 20
    // code values on a neutral grey.
    //
    // A master curve is the one control that must not change hue. It is what
    // people reach for to move tone without touching colour, and every serious
    // tool keeps it neutral; the per-channel curves are where colour lives.
    //
    // The print behaviour the old comment was reaching for is real, and it now
    // exists where it belongs — in the film model's print stage, applied to
    // looks rather than baked invisibly into a tonal control.
    if (hasMaster) {
      const lm = filmLuma(r, g, b);
      const masterY = applyCurveToValue(lm, curves.master);
      const delta = masterY - lm;
      r = clampByte(r + delta);
      g = clampByte(g + delta);
      b = clampByte(b + delta);
    }

    output[i] = clampByte(r);
    output[i + 1] = clampByte(g);
    output[i + 2] = clampByte(b);
    output[i + 3] = data[i + 3];
  }

  return new ImageData(output, width, height);
};

/** Utility: generate simple S-curve (with Bézier handles) */
export const makeDefaultSCurve = (strength = 0.5): CurvePoint[] => {
  // strength currently unused for shape (kept for API compat); returns nice default S
  clamp(strength, 0, 1);
  return [
    { x: 0, y: 0 },
    { x: 0.25, y: 0.18, handleOutX: 0.38, handleOutY: 0.22 },
    { x: 0.5, y: 0.5, handleInX: 0.35, handleInY: 0.32, handleOutX: 0.65, handleOutY: 0.68 },
    { x: 0.75, y: 0.82, handleInX: 0.62, handleInY: 0.72, handleOutX: 0.82, handleOutY: 0.88 },
    { x: 1, y: 1 },
  ];
};

export const identityCurve = (): CurvePoint[] => [{ x: 0, y: 0 }, { x: 1, y: 1 }];