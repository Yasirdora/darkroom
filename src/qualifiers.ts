import { adoptPixelBuffer, assertPixelBuffer } from './buffer.js';
import { DarkroomError } from './errors.js';
import { clampByte } from './math.js';
import { rgbToHsl } from './color.js';
import type { PixelBuffer, QualifierConfig } from './types.js';

// Local soften — separable running-window blur. Work remains O(pixels), even
// when untrusted/imported qualifier data contains an excessively large radius.
function softenMask(mask: Float32Array, w: number, h: number, radius: number): Float32Array {
  if (mask.length === 0 || w <= 0 || h <= 0) return mask;

  const maximumUsefulRadius = Math.max(w, h) - 1;
  const r = normalizeRadius(radius, maximumUsefulRadius);
  if (r < 1) return mask;

  const out = new Float32Array(mask.length);

  // As with image blur, sweep along the longer dimension so temporary memory
  // is bounded to one Float64 running-sum line on the shorter dimension.
  if (h <= w) softenMaskByColumns(mask, out, w, h, r);
  else softenMaskByRows(mask, out, w, h, r);

  return out;
}

function softenMaskByColumns(
  mask: Float32Array,
  out: Float32Array,
  width: number,
  height: number,
  radius: number,
): void {
  const horizontalSums = new Float64Array(height);
  let left = 0;
  let right = Math.min(width - 1, radius);

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let sum = 0;
    for (let x = left; x <= right; x += 1) sum += mask[row + x];
    horizontalSums[y] = sum;
  }

  for (let x = 0; x < width; x += 1) {
    let top = 0;
    let bottom = Math.min(height - 1, radius);
    let verticalSum = 0;
    for (let y = top; y <= bottom; y += 1) verticalSum += horizontalSums[y];

    const horizontalCount = right - left + 1;
    for (let y = 0; y < height; y += 1) {
      out[y * width + x] = verticalSum / (horizontalCount * (bottom - top + 1));

      const nextTop = Math.max(0, y + 1 - radius);
      const nextBottom = Math.min(height - 1, y + 1 + radius);
      if (nextTop > top) {
        verticalSum -= horizontalSums[top];
        top = nextTop;
      }
      if (nextBottom > bottom) {
        bottom = nextBottom;
        verticalSum += horizontalSums[bottom];
      }
    }

    if (x + 1 === width) continue;

    const nextLeft = Math.max(0, x + 1 - radius);
    const nextRight = Math.min(width - 1, x + 1 + radius);
    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      if (nextLeft > left) horizontalSums[y] -= mask[row + left];
      if (nextRight > right) horizontalSums[y] += mask[row + nextRight];
    }
    left = nextLeft;
    right = nextRight;
  }
}

function softenMaskByRows(
  mask: Float32Array,
  out: Float32Array,
  width: number,
  height: number,
  radius: number,
): void {
  const verticalSums = new Float64Array(width);
  let top = 0;
  let bottom = Math.min(height - 1, radius);

  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let y = top; y <= bottom; y += 1) sum += mask[y * width + x];
    verticalSums[x] = sum;
  }

  for (let y = 0; y < height; y += 1) {
    let left = 0;
    let right = Math.min(width - 1, radius);
    let horizontalSum = 0;
    for (let x = left; x <= right; x += 1) horizontalSum += verticalSums[x];

    const verticalCount = bottom - top + 1;
    for (let x = 0; x < width; x += 1) {
      out[y * width + x] = horizontalSum / (verticalCount * (right - left + 1));

      const nextLeft = Math.max(0, x + 1 - radius);
      const nextRight = Math.min(width - 1, x + 1 + radius);
      if (nextLeft > left) {
        horizontalSum -= verticalSums[left];
        left = nextLeft;
      }
      if (nextRight > right) {
        right = nextRight;
        horizontalSum += verticalSums[right];
      }
    }

    if (y + 1 === height) continue;

    const nextTop = Math.max(0, y + 1 - radius);
    const nextBottom = Math.min(height - 1, y + 1 + radius);
    for (let x = 0; x < width; x += 1) {
      if (nextTop > top) verticalSums[x] -= mask[top * width + x];
      if (nextBottom > bottom) verticalSums[x] += mask[nextBottom * width + x];
    }
    top = nextTop;
    bottom = nextBottom;
  }
}

const normalizeRadius = (value: number, maximum: number): number => {
  if (maximum <= 0 || Number.isNaN(value) || value === Number.NEGATIVE_INFINITY) return 0;
  if (value === Number.POSITIVE_INFINITY) return maximum;
  return Math.min(maximum, Math.max(0, Math.floor(value)));
};

const clamp01 = (value: number): number => {
  if (Number.isNaN(value) || value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
};
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const finiteInRange = (
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const candidate = value ?? fallback;
  if (Number.isNaN(candidate)) return fallback;
  if (candidate === Number.POSITIVE_INFINITY) return maximum;
  if (candidate === Number.NEGATIVE_INFINITY) return minimum;
  return clamp(candidate, minimum, maximum);
};

const createUniformMask = (length: number, value: number): Float32Array => {
  const mask = new Float32Array(length);
  if (value !== 0) mask.fill(value);
  return mask;
};

function buildHSLMask(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  cfg: QualifierConfig,
): Float32Array {
  const mask = new Float32Array(width * height);
  const hueMin = finiteInRange(cfg.hueMin, 0, 0, 360);
  const hueMax = finiteInRange(cfg.hueMax, 360, 0, 360);
  const satMin = finiteInRange(cfg.satMin, 0, 0, 1);
  const satMax = finiteInRange(cfg.satMax, 1, 0, 1);
  const lumMin = finiteInRange(cfg.lumMin, 0, 0, 1);
  const lumMax = finiteInRange(cfg.lumMax, 1, 0, 1);
  const hSoft = finiteInRange(cfg.hueSoft, 8, 0.1, 360);
  const sSoft = finiteInRange(cfg.satSoft, 0.1, 0.001, 1);
  const lSoft = finiteInRange(cfg.lumSoft, 0.1, 0.001, 1);

  const softStep = (v: number, lo: number, hi: number, soft: number): number => {
    if (v >= lo && v <= hi) return 1;
    const dist = v < lo ? lo - v : v - hi;
    return Math.max(0, 1 - dist / soft);
  };

  const circularDistance = (left: number, right: number): number => {
    const difference = Math.abs(left - right);
    return Math.min(difference, 360 - difference);
  };

  const hueBoundary = (value: number): number => value === 360 ? 0 : value;
  const fullHueRange = hueMin <= 0 && hueMax >= 360;

  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    // Hidden RGB in fully transparent texels is arbitrary encoder padding. It
    // must never seed a colored qualifier and then feather into visible pixels.
    if (data[i + 3] === 0) {
      mask[p] = 0;
      continue;
    }

    const hsl = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    const hVal = hsl.h;

    let hMask: number;
    const insideHueRange = hueMin > hueMax
      ? hVal >= hueMin || hVal <= hueMax
      : hVal >= hueMin && hVal <= hueMax;
    if (fullHueRange || insideHueRange) {
      hMask = 1;
    } else {
      const distance = Math.min(
        circularDistance(hVal, hueBoundary(hueMin)),
        circularDistance(hVal, hueBoundary(hueMax)),
      );
      hMask = Math.max(0, 1 - distance / hSoft);
    }

    const sMask = softStep(hsl.s, satMin, satMax, sSoft);
    const lMask = softStep(hsl.l, lumMin, lumMax, lSoft);
    mask[p] = clamp01(hMask * sMask * lMask);
  }

  return mask;
}

function buildSpatialMask(
  width: number,
  height: number,
  cfg: QualifierConfig,
): Float32Array | null {
  const spatialType = cfg.spatialType ?? 'none';
  if (spatialType === 'none') return null;

  const mask = new Float32Array(width * height);
  const spatialX = finiteInRange(cfg.spatialX, 0.5, 0, 1);
  const spatialY = finiteInRange(cfg.spatialY, 0.5, 0, 1);
  const spatialWidth = finiteInRange(cfg.spatialWidth, 1, 0, 4);
  const spatialHeight = finiteInRange(cfg.spatialHeight, 1, 0, 4);
  const spatialRotation = finiteInRange(cfg.spatialRotation, 0, -360, 360);
  const spatialFeather = finiteInRange(cfg.spatialFeather, 0.1, 0, 1);

  const cx = spatialX * width;
  const cy = spatialY * height;
  const rx = (spatialWidth * width) / 2;
  const ry = (spatialHeight * height) / 2;
  const feather = Math.max(1, spatialFeather * Math.min(width, height) * 0.5);
  const rot = (spatialRotation * Math.PI) / 180;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      const rxRot = dx * cos - dy * sin;
      const ryRot = dx * sin + dy * cos;

      let val = 0;
      if (spatialType === 'ellipse' || spatialType === 'radial') {
        const nx = rxRot / Math.max(rx, 1);
        const ny = ryRot / Math.max(ry, 1);
        const d = Math.sqrt(nx * nx + ny * ny);
        val = 1 - clamp(d, 0, 1);
      } else if (spatialType === 'linear') {
        const d = (rxRot / Math.max(rx, 1) + 1) * 0.5;
        val = clamp(d, 0, 1);
      }

      const f = clamp((val * (rx + ry)) / Math.max(feather, 1), 0, 1);
      mask[y * width + x] = clamp01(val * f * 1.2);
    }
  }

  // The combined HSL/spatial mask is feathered once in buildQualifierMask.
  // A second blur here used to soften spatial selections twice and doubled work.
  return mask;
}

/** True when the hue range selects the entire wheel. */
export function isFullHueSelection(cfg: QualifierConfig): boolean {
  return (cfg.hueMin ?? 0) <= 0 && (cfg.hueMax ?? 360) >= 360;
}

/**
 * True when every qualifier dimension passes every pixel unchanged.
 * A full hue range alone is not an identity when saturation, luminance,
 * spatial selection, or inversion is active.
 */
export function isIdentityQualifier(cfg: QualifierConfig): boolean {
  return (
    isFullHueSelection(cfg) &&
    (cfg.satMin ?? 0) <= 0 &&
    (cfg.satMax ?? 1) >= 1 &&
    (cfg.lumMin ?? 0) <= 0 &&
    (cfg.lumMax ?? 1) >= 1 &&
    (cfg.spatialType ?? 'none') === 'none' &&
    cfg.invert !== true
  );
}

/** True when an enabled qualifier can change a rendered look or effect. */
export function qualifierAffectsPipeline(
  qualifier: QualifierConfig,
  hasSelectiveStage = true,
): boolean {
  return hasSelectiveStage && qualifier.enabled && !isIdentityQualifier(qualifier);
}

/** Starting hue range applied when the user first enables the qualifier. */
export const QUALIFIER_ENABLE_HUE_DEFAULTS = {
  hueMin: 0,
  hueMax: 80,
} as const;

function maskFeatherRadius(cfg: QualifierConfig, width: number, height: number): number {
  if ((cfg.spatialType ?? 'none') !== 'none') {
    const feather = finiteInRange(cfg.spatialFeather, 0.08, 0, 1);
    return Math.max(1, Math.round(feather * Math.min(width, height) * 0.15));
  }
  // Hue-only: feather in pixels derived from hue softness (degrees), not image size.
  return Math.max(1, Math.round(finiteInRange(cfg.hueSoft, 8, 0, 360) * 0.4));
}

/** Main entry: build soft qualifier mask for image. */
export function buildQualifierMask(
  source: PixelBuffer,
  cfg: QualifierConfig,
): Float32Array {
  assertPixelBuffer(source);
  if (!cfg.enabled) {
    return createUniformMask(source.width * source.height, 1);
  }

  const { data } = source;
  const w = source.width;
  const h = source.height;

  if (isIdentityQualifier(cfg)) return createUniformMask(w * h, 1);

  const mask = buildHSLMask(data, w, h, cfg);
  const spatMask = buildSpatialMask(w, h, cfg);

  if (spatMask) {
    for (let i = 0; i < mask.length; i += 1) {
      mask[i] = clamp01(mask[i] * spatMask[i]);
    }
  }

  const feather = maskFeatherRadius(cfg, w, h);
  const softened = softenMask(mask, w, h, feather);

  if (cfg.invert) {
    for (let i = 0; i < softened.length; i += 1) softened[i] = 1 - softened[i];
  }

  // Feathering and inversion can assign a non-zero mask to an invisible texel.
  // Keep those entries inert so masked effects also preserve hidden RGB.
  for (let pixel = 0; pixel < softened.length; pixel += 1) {
    if (data[pixel * 4 + 3] === 0) softened[pixel] = 0;
  }

  return softened;
}

/** Apply mask to a buffer (modulates filter/effect strength). */
export function applyWithMask(
  source: PixelBuffer,
  processed: PixelBuffer,
  mask: Float32Array,
  strength = 1,
): PixelBuffer {
  assertPixelBuffer(source);
  assertPixelBuffer(processed);
  if (!(mask instanceof Float32Array)) {
    throw new DarkroomError('INVALID_DIMENSIONS', 'Qualifier mask must be a Float32Array.');
  }
  if (
    source.width !== processed.width ||
    source.height !== processed.height ||
    mask.length !== source.width * source.height
  ) {
    throw new DarkroomError('INVALID_DIMENSIONS', 'Mask inputs must have matching dimensions.');
  }

  if (source === processed) return source;

  const sdata = source.data;
  const pdata = processed.data;
  const amt = clamp01(strength);
  if (amt <= 0.001) return source;

  let odata: Uint8ClampedArray | null = null;

  for (let i = 0, p = 0; i < sdata.length; i += 4, p += 1) {
    if (sdata[i + 3] === 0) continue;
    const m = clamp01(mask[p]) * amt;
    if (m <= 0.001) continue;
    odata ??= new Uint8ClampedArray(sdata);
    odata[i] = clampByte(lerp(sdata[i], pdata[i], m));
    odata[i + 1] = clampByte(lerp(sdata[i + 1], pdata[i + 1], m));
    odata[i + 2] = clampByte(lerp(sdata[i + 2], pdata[i + 2], m));
    odata[i + 3] = sdata[i + 3];
  }

  return odata ? adoptPixelBuffer({ width: source.width, height: source.height, data: odata }) : source;
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}
