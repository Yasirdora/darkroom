import { ImageBuffer } from '../core/image-buffer';
import type { EditState, QualifierConfig } from '../core/types';
import { clampByte } from '../core/math';
import { rgbToHsl } from './color';

// Local soften — separable box blur (O(n·r)) for preview-sized masks.
function softenMask(mask: Float32Array, w: number, h: number, radius: number): Float32Array {
  if (radius < 1) return mask;
  const r = Math.max(1, Math.floor(radius));
  const tmp = new Float32Array(mask.length);
  const out = new Float32Array(mask.length);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let cnt = 0;
      for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx;
        if (xx >= 0 && xx < w) {
          sum += mask[y * w + xx];
          cnt++;
        }
      }
      tmp[y * w + x] = cnt ? sum / cnt : 0;
    }
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let cnt = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy >= 0 && yy < h) {
          sum += tmp[yy * w + x];
          cnt++;
        }
      }
      out[y * w + x] = cnt ? sum / cnt : 0;
    }
  }

  return out;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function buildHSLMask(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  cfg: QualifierConfig,
): Float32Array {
  const mask = new Float32Array(width * height);
  const {
    hueMin = 0,
    hueMax = 360,
    satMin = 0,
    satMax = 1,
    lumMin = 0,
    lumMax = 1,
    hueSoft = 8,
    satSoft = 0.1,
    lumSoft = 0.1,
  } = cfg;

  const hSoft = Math.max(0.1, hueSoft);
  const sSoft = Math.max(0.001, satSoft);
  const lSoft = Math.max(0.001, lumSoft);

  const softStep = (v: number, lo: number, hi: number, soft: number): number => {
    if (v >= lo && v <= hi) return 1;
    const dist = v < lo ? lo - v : v - hi;
    return Math.max(0, 1 - dist / soft);
  };

  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    const hsl = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    const hVal = hsl.h;

    let hMask: number;
    if (hueMin > hueMax) {
      if (hVal >= hueMin || hVal <= hueMax) {
        hMask = 1;
      } else {
        const dist = Math.min(hueMin - hVal, hVal - hueMax);
        hMask = Math.max(0, 1 - dist / hSoft);
      }
    } else {
      hMask = softStep(hVal, hueMin, hueMax, hSoft);
    }

    const sMask = softStep(hsl.s, satMin, satMax, sSoft);
    const lMask = softStep(hsl.l, lumMin, lumMax, lSoft);
    mask[p] = clamp01(hMask * sMask * lMask);
  }

  return mask;
}

function buildSpatialMask(width: number, height: number, cfg: QualifierConfig): Float32Array {
  const mask = new Float32Array(width * height);
  const {
    spatialType = 'none',
    spatialX = 0.5,
    spatialY = 0.5,
    spatialWidth = 1,
    spatialHeight = 1,
    spatialRotation = 0,
    spatialFeather = 0.1,
  } = cfg;

  if (spatialType === 'none') {
    mask.fill(1);
    return mask;
  }

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

  return softenMask(mask, width, height, Math.max(1, Math.round(feather * 0.25)));
}

/** True when an enabled qualifier can change filter/effect output. */
export function qualifierAffectsPipeline(state: EditState): boolean {
  if (!state.qualifier?.enabled) return false;
  return state.filterId !== 'none' || state.effectId !== 'none';
}

/** True when the hue range selects the entire wheel (no selective effect). */
export function isFullHueSelection(cfg: QualifierConfig): boolean {
  return (cfg.hueMin ?? 0) <= 0 && (cfg.hueMax ?? 360) >= 360;
}

/** Starting hue range applied when the user first enables the qualifier. */
export const QUALIFIER_ENABLE_HUE_DEFAULTS = {
  hueMin: 0,
  hueMax: 80,
} as const;

function maskFeatherRadius(cfg: QualifierConfig, width: number, height: number): number {
  if ((cfg.spatialType ?? 'none') !== 'none') {
    return Math.max(1, Math.round((cfg.spatialFeather ?? 0.08) * Math.min(width, height) * 0.15));
  }
  // Hue-only: feather in pixels derived from hue softness (degrees), not image size.
  return Math.max(1, Math.round((cfg.hueSoft ?? 8) * 0.4));
}

/** Main entry: build soft qualifier mask for image. */
export function buildQualifierMask(
  source: ImageBuffer,
  cfg: QualifierConfig,
): Float32Array {
  if (!cfg.enabled) {
    const m = new Float32Array(source.width * source.height);
    m.fill(1);
    return m;
  }

  const { data } = source;
  const w = source.width;
  const h = source.height;

  const hslMask = buildHSLMask(data, w, h, cfg);
  const spatMask = buildSpatialMask(w, h, cfg);

  const mask = new Float32Array(w * h);
  for (let i = 0; i < mask.length; i += 1) {
    mask[i] = clamp01(hslMask[i] * spatMask[i]);
  }

  const feather = maskFeatherRadius(cfg, w, h);
  const softened = softenMask(mask, w, h, feather);

  if (cfg.invert) {
    for (let i = 0; i < softened.length; i += 1) softened[i] = 1 - softened[i];
  }

  return softened;
}

/** Apply mask to a buffer (modulates filter/effect strength). */
export function applyWithMask(
  source: ImageBuffer,
  processed: ImageBuffer,
  mask: Float32Array,
  strength = 1,
): ImageBuffer {
  const out = source.clone();
  const sdata = source.data;
  const pdata = processed.data;
  const odata = out.data;
  const amt = clamp01(strength);

  for (let i = 0, p = 0; i < odata.length; i += 4, p += 1) {
    const m = mask[p] * amt;
    if (m <= 0.001) continue;
    odata[i] = clampByte(lerp(sdata[i], pdata[i], m));
    odata[i + 1] = clampByte(lerp(sdata[i + 1], pdata[i + 1], m));
    odata[i + 2] = clampByte(lerp(sdata[i + 2], pdata[i + 2], m));
    odata[i + 3] = sdata[i + 3];
  }

  return out;
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}