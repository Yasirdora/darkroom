import { clamp, clampByte, lerp } from '../../core/math';
import { hslToRgb, rgbToHsl } from '../color';
import { isSkinTone } from '../image-analysis';
import type { FilterCategory, FilterId } from '../../core/types';

export type ScannerProfile = 'frontier' | 'noritsu' | 'neutral' | 'ecn2' | 'ecp';

export interface ChannelCurve {
  /** Shadow toe length 0–0.25 */
  toe: number;
  /** Shadow lift 0–0.12 */
  toeLift: number;
  /** Midtone gamma (higher = flatter mids) */
  gamma: number;
  /** Shoulder onset 0.65–0.92 */
  shoulder: number;
  /** Highlight compression 0–1 */
  shoulderStr: number;
  /** Channel gain */
  gain: number;
}

export interface FilmGrainSpec {
  amount: number;
  warmth: number;
  size: number;
}

export interface FilmStockProfile {
  id: FilterId;
  label: string;
  category: FilterCategory;
  description: string;
  curves: { r: ChannelCurve; g: ChannelCurve; b: ChannelCurve };
  /** Emulsion dye cross-talk (identity + small deviations) */
  dyeMatrix: [[number, number, number], [number, number, number], [number, number, number]];
  scanner: ScannerProfile;
  /** Split-tone timing applied in density space */
  shadowHue: number;
  shadowTint: number;
  highlightHue: number;
  highlightTint: number;
  /** Exposure latitude — how much per-pixel exposure shifts the curve */
  latitude: number;
  saturation: number;
  vibrance: number;
  halation: number;
  halationWarmth: number;
  grain?: FilmGrainSpec;
  /** Stylized presets use a lighter pipeline */
  stylized?: boolean;
  /** Reduce saturation/tint shifts on skin-tone pixels */
  skinPreserve?: boolean;
}

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp((x - edge0) / Math.max(edge1 - edge0, 0.001), 0, 1);
  return t * t * (3 - 2 * t);
};

export const luma = (r: number, g: number, b: number): number =>
  0.2126 * r + 0.7152 * g + 0.0722 * b;

const exposureZones = (lum: number): { under: number; mid: number; over: number } => ({
  under: 1 - smoothstep(45, 100, lum),
  mid: smoothstep(70, 110, lum) * (1 - smoothstep(175, 215, lum)),
  over: smoothstep(195, 240, lum),
});

/** H&D characteristic curve with per-channel response. */
const applyCurve = (value: number, curve: ChannelCurve, under: number, over: number): number => {
  let x = clamp((value / 255) * curve.gain, 0, 1);

  const toeLen = curve.toe + under * 0.04;
  const toeLift = curve.toeLift + under * 0.03;
  const gamma = curve.gamma - over * 0.08;
  const shoulder = curve.shoulder - over * 0.06;
  const shoulderStr = curve.shoulderStr + over * 0.15;

  if (x < toeLen) {
    const t = x / Math.max(toeLen, 0.001);
    x = toeLift + t * t * (toeLen - toeLift);
  } else {
    const normalized = (x - toeLen) / Math.max(1 - toeLen, 0.001);
    x = toeLift + Math.pow(normalized, 1 / Math.max(gamma, 0.55)) * (1 - toeLift);
  }

  if (x > shoulder) {
    const excess = (x - shoulder) / Math.max(1 - shoulder, 0.001);
    x = shoulder + (1 - shoulder) * (1 - Math.exp(-excess * (1.6 + shoulderStr * 2.8)));
  }

  return clamp(x, 0, 1);
};

const applyDyeMatrix = (
  r: number,
  g: number,
  b: number,
  matrix: FilmStockProfile['dyeMatrix'],
): [number, number, number] => [
  r * matrix[0][0] + g * matrix[0][1] + b * matrix[0][2],
  r * matrix[1][0] + g * matrix[1][1] + b * matrix[1][2],
  r * matrix[2][0] + g * matrix[2][1] + b * matrix[2][2],
];

const applyScanner = (
  r: number,
  g: number,
  b: number,
  scanner: ScannerProfile,
  lum: number,
): [number, number, number] => {
  const shadowW = 1 - smoothstep(55, 150, lum);
  const highW = smoothstep(150, 230, lum);

  switch (scanner) {
    case 'frontier':
      return [
        r - shadowW * 4 + highW * 3,
        g + shadowW * 1,
        b + shadowW * 8 - highW * 2,
      ];
    case 'noritsu':
      return [
        r + shadowW * 6 + highW * 4,
        g + shadowW * 4 + highW * 2,
        b + shadowW * 2,
      ];
    case 'ecn2':
      return [
        r - shadowW * 6,
        g + shadowW * 2,
        b + shadowW * 12 - highW * 3,
      ];
    case 'ecp':
      return [r + highW * 2, g + highW * 1, b - shadowW * 2 + highW * 1];
    default:
      return [r, g, b];
  }
};

const applyTiming = (
  r: number,
  g: number,
  b: number,
  profile: FilmStockProfile,
): [number, number, number] => {
  const lum = luma(r, g, b);
  const sW = (1 - smoothstep(50, 145, lum)) * profile.shadowTint;
  const hW = smoothstep(120, 225, lum) * profile.highlightTint;

  if (sW > 0.001) {
    const tint = hslToRgb(profile.shadowHue, 0.3, lum / 255);
    r = lerp(r, tint.r, sW);
    g = lerp(g, tint.g, sW);
    b = lerp(b, tint.b, sW);
  }
  if (hW > 0.001) {
    const tint = hslToRgb(profile.highlightHue, 0.24, lum / 255);
    r = lerp(r, tint.r, hW);
    g = lerp(g, tint.g, hW);
    b = lerp(b, tint.b, hW);
  }
  return [r, g, b];
};

const SKIN_PRESERVE_BLEND = 0.4;

const hueDelta = (a: number, b: number): number => {
  let delta = Math.abs(a - b);
  if (delta > 180) delta = 360 - delta;
  return delta;
};

const applySaturation = (
  r: number,
  g: number,
  b: number,
  sat: number,
  vibranceAmt: number,
  skinPreserve = false,
): [number, number, number] => {
  const originalHsl = rgbToHsl(r, g, b);
  const hsl = { ...originalHsl };
  const vBoost = vibranceAmt * (1 - hsl.s);
  hsl.s = clamp(hsl.s * sat + vBoost, 0, 1);

  if (skinPreserve && isSkinTone(r, g, b) && hueDelta(hsl.h, originalHsl.h) > 15) {
    hsl.h = originalHsl.h;
  }

  const rgb = hslToRgb(hsl.h, hsl.s, hsl.l);
  let out: [number, number, number] = [rgb.r, rgb.g, rgb.b];

  if (skinPreserve && isSkinTone(r, g, b)) {
    out = [
      lerp(r, out[0], SKIN_PRESERVE_BLEND),
      lerp(g, out[1], SKIN_PRESERVE_BLEND),
      lerp(b, out[2], SKIN_PRESERVE_BLEND),
    ];
  }

  return out;
};

const applyHalation = (
  r: number,
  g: number,
  b: number,
  amount: number,
  warmth: number,
): [number, number, number] => {
  const mask = smoothstep(215, 250, luma(r, g, b)) * amount;
  if (mask < 0.001) return [r, g, b];
  return [
    r + mask * 16 * warmth,
    g + mask * 6 * warmth,
    b - mask * 3 * (1 - warmth),
  ];
};

/** Renders one pixel through the full film emulation chain (exposure-aware). */
export const renderFilmPixel = (
  r: number,
  g: number,
  b: number,
  profile: FilmStockProfile,
): [number, number, number] => {
  const lum = luma(r, g, b);
  const zones = exposureZones(lum);
  const lat = profile.latitude;

  const under = zones.under * lat;
  const over = zones.over * lat;

  let cr = applyCurve(r, profile.curves.r, under, over) * 255;
  let cg = applyCurve(g, profile.curves.g, under, over) * 255;
  let cb = applyCurve(b, profile.curves.b, under, over) * 255;

  [cr, cg, cb] = applyDyeMatrix(cr, cg, cb, profile.dyeMatrix);
  [cr, cg, cb] = applyScanner(cr, cg, cb, profile.scanner, lum);

  const preserveSkin = profile.skinPreserve === true;
  const preTiming: [number, number, number] = [cr, cg, cb];
  [cr, cg, cb] = applyTiming(cr, cg, cb, profile);
  if (preserveSkin && isSkinTone(r, g, b)) {
    cr = lerp(preTiming[0], cr, SKIN_PRESERVE_BLEND);
    cg = lerp(preTiming[1], cg, SKIN_PRESERVE_BLEND);
    cb = lerp(preTiming[2], cb, SKIN_PRESERVE_BLEND);
  }

  [cr, cg, cb] = applySaturation(
    cr,
    cg,
    cb,
    profile.saturation,
    profile.vibrance,
    preserveSkin,
  );
  [cr, cg, cb] = applyHalation(cr, cg, cb, profile.halation, profile.halationWarmth);

  return [clampByte(cr), clampByte(cg), clampByte(cb)];
};

export const curve = (
  partial: Partial<ChannelCurve> & Pick<ChannelCurve, 'gamma'>,
): ChannelCurve => ({
  toe: partial.toe ?? 0.08,
  toeLift: partial.toeLift ?? 0.03,
  gamma: partial.gamma,
  shoulder: partial.shoulder ?? 0.82,
  shoulderStr: partial.shoulderStr ?? 0.35,
  gain: partial.gain ?? 1,
});

export const dye = (
  r: [number, number, number],
  g: [number, number, number],
  b: [number, number, number],
): FilmStockProfile['dyeMatrix'] => [r, g, b];