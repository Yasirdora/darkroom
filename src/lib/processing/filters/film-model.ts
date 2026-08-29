import { clamp, clampByte, lerp } from '../../core/math';
import { chromaConfidence, hslToRgb, rgbToHsl } from '../color';
import { skinToneWeight } from '../image-analysis';
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

/**
 * The print stage: exposing the developed negative through a positive stock.
 *
 * This is where a film look gets its contrast, and leaving it out is why a
 * faithful negative simulation reads as flat. A colour negative scanned neutral
 * is *supposed* to look washed — that is what the orange-masked original is,
 * a low-contrast recording with the shape still to come. Printing it through
 * a positive stock is the step that puts the shape in, and it is the step
 * everyone means when they say "the Portra look".
 *
 * Measured before this existed: 48 of 52 colour looks had a neutral-axis slope
 * between 0.95 and 1.10, so Velvia and Portra were separated by less than one
 * notch of the contrast slider.
 */
export interface PrintProfile {
  /**
   * Steepness of the print's characteristic curve. 0 bypasses the stage.
   *
   * A logistic rather than a gamma, because a print rolls off at *both* ends —
   * paper has a maximum density and a base white, and neither is reached
   * abruptly. A gamma only shapes one end and clips the other.
   */
  contrast: number;
  /** The tone the curve pivots about. Below it goes down, above it goes up. */
  pivot: number;
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
  /** Print stage. Absent means the negative is shown unprinted. */
  print?: PrintProfile;
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
    // Continues from `toeLen`, where the toe left off — not from `toeLift`.
    //
    // The toe maps [0, toeLen] onto [toeLift, toeLen]: it lifts black and
    // arrives at the boundary carrying the input's own value. Restarting the
    // gamma segment at `toeLift` dropped the output by exactly
    // (toeLen − toeLift) at that boundary — around 13 code values on a typical
    // stock — and did it independently per channel, so the cliff came with a
    // colour fringe. It sat in the deep shadows, which is where a step of that
    // size shows most.
    const normalized = (x - toeLen) / Math.max(1 - toeLen, 0.001);
    x = toeLen + Math.pow(normalized, 1 / Math.max(gamma, 0.55)) * (1 - toeLen);
  }

  if (x > shoulder) {
    const excess = (x - shoulder) / Math.max(1 - shoulder, 0.001);
    const k = 1.6 + shoulderStr * 2.8;
    // Was `1 - exp(-k·excess)`, which leaves the shoulder with slope k — about
    // 2.6 on a default stock, against 1 immediately below it. Highlights
    // therefore *expanded* by more than a stop of local contrast at the onset
    // and only began compressing past the two-thirds mark, which is the
    // opposite of what a shoulder is for and put a step in every gradient
    // crossing it.
    //
    // This form leaves the shoulder with slope exactly 1, so it is C1 with the
    // segment below, and still arrives at white with the same value *and* the
    // same slope as the old curve — so the highlight rolloff each stock was
    // tuned for is preserved at the top even though the middle no longer lifts.
    //
    //   v(u)  = u − e⁻ᵏ·uᵖ,  p = eᵏ − k
    //   v(1)  = 1 − e⁻ᵏ        as before
    //   v'(0) = 1              continuous with the identity below
    //   v'(1) = k·e⁻ᵏ          as before
    //
    // Monotone for every k > 0: e⁻ᵏ·p = 1 − k·e⁻ᵏ < 1, so v' never reaches 0.
    const shape = excess - Math.exp(-k) * Math.pow(excess, Math.exp(k) - k);
    x = shoulder + (1 - shoulder) * shape;
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

/**
 * Saturation a tint needs in order to carry a given chroma at a given lightness.
 *
 * HSL chroma is `(1 - |2L - 1|) * S`, so a fixed saturation collapses toward
 * both ends of the scale. That made the split-tone stage weakest exactly where
 * it is supposed to act: the shadow weight reaches 1 below about L = 0.2, and
 * at L = 0.1 a full 0.14 tint could only move a pixel 2 codes. Stocks named for
 * their colour — "Pink lift", "Warm highlight glow" — were delivering six.
 *
 * Compensating by the same factor keeps the chroma a tint asks for roughly
 * constant across the tonal range. The floor stops the correction running away
 * near black and white, where a colour genuinely cannot be carried: there is no
 * saturation that makes a near-black pixel colourful, and pretending otherwise
 * would posterise the toe.
 */
const tintSaturation = (chroma: number, lightness: number): number => {
  const reach = Math.max(1 - Math.abs(2 * lightness - 1), 0.3);
  return Math.min(chroma / reach, 1);
};

/** Chroma the shadow and highlight tints aim for, before the stock's strength. */
const SHADOW_CHROMA = 0.34;
const HIGHLIGHT_CHROMA = 0.29;

const applyTiming = (
  r: number,
  g: number,
  b: number,
  profile: FilmStockProfile,
): [number, number, number] => {
  const lum = luma(r, g, b);
  const sW = (1 - smoothstep(50, 145, lum)) * profile.shadowTint;
  const hW = smoothstep(120, 225, lum) * profile.highlightTint;

  const l = lum / 255;

  // Applied unconditionally. A `> 0.001` guard here made the tint stop rather
  // than fade: it crossed that threshold at luma 137.4, putting a step in the
  // middle of a curve that has to be continuous everywhere. The step was worth
  // about 0.04 code values, which is small enough to hide and large enough to
  // be real. Both branches execute on the GPU regardless, so it bought nothing.
  {
    const tint = hslToRgb(profile.shadowHue, tintSaturation(SHADOW_CHROMA, l), l);
    r = lerp(r, tint.r, sW);
    g = lerp(g, tint.g, sW);
    b = lerp(b, tint.b, sW);
  }
  {
    const tint = hslToRgb(profile.highlightHue, tintSaturation(HIGHLIGHT_CHROMA, l), l);
    r = lerp(r, tint.r, hW);
    g = lerp(g, tint.g, hW);
    b = lerp(b, tint.b, hW);
  }
  return [r, g, b];
};

const SKIN_PRESERVE_BLEND = 0.4;

/** How far skin is allowed to drift in hue before the guard pulls it back. */
const SKIN_HUE_LIMIT = 15;

/** Signed shortest-arc hue difference, -180…180. */
const signedHueDelta = (a: number, b: number): number => {
  let delta = (a - b) % 360;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
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
  // Faded out as chroma does: hue is undefined at zero chroma and unreliable
  // near it, so an ungated boost amplifies rounding into colour. Without this
  // a neutral ramp through magicNatural flipped from cool to warm between
  // input 137 and 139, on a residual of a tenth of a code value.
  const vBoost = vibranceAmt * (1 - hsl.s) * chromaConfidence(r, g, b);
  hsl.s = clamp(hsl.s * sat + vBoost, 0, 1);

  // Feathered, not boolean. A hard `isSkinTone` cutoff flips between
  // neighbouring pixels: it put a three-code step into a magicSunset grey ramp
  // at input 98, where the pixel's saturation crosses the 0.05 edge, and left
  // the blue channel non-monotonic across it. On a face the same flip is the
  // blotchy contour `skinToneWeight` was written to avoid.
  const skin = skinPreserve ? skinToneWeight(r, g, b) : 0;

  // A soft limit rather than a snap. Returning the hue outright meant a pixel
  // drifting through 15° jumped the whole way back; this pulls back only the
  // excess, and only in proportion to how much like skin the pixel is.
  if (skin > 0) {
    const drift = signedHueDelta(hsl.h, originalHsl.h);
    const excess = Math.abs(drift) - SKIN_HUE_LIMIT;
    if (excess > 0) {
      hsl.h = (hsl.h - Math.sign(drift) * excess * skin + 360) % 360;
    }
  }

  const rgb = hslToRgb(hsl.h, hsl.s, hsl.l);
  // Full skin confidence keeps SKIN_PRESERVE_BLEND of the effect and feathers
  // smoothly to the whole of it away from skin.
  const keep = 1 - (1 - SKIN_PRESERVE_BLEND) * skin;
  return [lerp(r, rgb.r, keep), lerp(g, rgb.g, keep), lerp(b, rgb.b, keep)];
};

const applyHalation = (
  r: number,
  g: number,
  b: number,
  amount: number,
  warmth: number,
): [number, number, number] => {
  const mask = smoothstep(215, 250, luma(r, g, b)) * amount;
  // No early return: at mask = 0 the arithmetic below is already the identity,
  // and a threshold would only put a step where the halo starts.
  return [
    r + mask * 16 * warmth,
    g + mask * 6 * warmth,
    b - mask * 3 * (1 - warmth),
  ];
};

/** Renders one pixel through the full film emulation chain (exposure-aware). */
/**
 * Exposes one channel through the print stock.
 *
 * A logistic curve, normalised so that 0 and 1 land exactly on themselves. That
 * normalisation matters more than it looks: without it every print would also
 * be an exposure change, and a stock's carefully placed toe lift would move
 * every time its contrast was adjusted.
 *
 * Monotonic for any positive steepness, so it can never fold the tone scale
 * back on itself — the failure that turns a highlight darker than the midtone
 * beside it.
 */
const applyPrint = (value: number, print: PrintProfile): number => {
  if (print.contrast <= 1e-6) return value;
  const k = print.contrast;
  const p = print.pivot;
  const f = (x: number): number => 1 / (1 + Math.exp(-k * (x - p)));
  const lo = f(0);
  const hi = f(1);
  const span = hi - lo;
  if (span <= 1e-9) return value;
  return (f(value) - lo) / span;
};

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

  // Printed after the scan of the negative and before the lab's colour timing,
  // which is the order the darkroom works in: the print establishes the tonal
  // shape, then timing decides the balance printed into it.
  if (profile.print) {
    cr = applyPrint(cr / 255, profile.print) * 255;
    cg = applyPrint(cg / 255, profile.print) * 255;
    cb = applyPrint(cb / 255, profile.print) * 255;
  }

  const preserveSkin = profile.skinPreserve === true;
  const preTiming: [number, number, number] = [cr, cg, cb];
  [cr, cg, cb] = applyTiming(cr, cg, cb, profile);
  // Feathered for the same reason as the saturation stage: a boolean here put
  // a step wherever a face crossed the skin test.
  const timingSkin = preserveSkin ? skinToneWeight(r, g, b) : 0;
  if (timingSkin > 0) {
    const keep = 1 - (1 - SKIN_PRESERVE_BLEND) * timingSkin;
    cr = lerp(preTiming[0], cr, keep);
    cg = lerp(preTiming[1], cg, keep);
    cb = lerp(preTiming[2], cb, keep);
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