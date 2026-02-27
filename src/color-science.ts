import { clamp } from './math.js';

/**
 * Input-profile transfer-function and gamut-conversion utilities.
 *
 * All log profiles decode to scene-linear reflectance (0.18 = 18% grey).
 * Supported wide-gamut sources are converted to sRGB (D65) linear using
 * reference matrices derived from published camera-gamut primaries. These
 * matrices are approximations and do not replace a calibrated transform.
 *
 * The goal: deliver a consistent, grading-ready sRGB-linear image that
 * subsequent tools (adjustments + film emulation) can trust.
 */

/** IEC 61966-2-1 sRGB EOTF — encoded [0, 1] → scene-linear. */
export const srgbToLinear = (value: number): number => {
  if (value <= 0.04045) return value / 12.92;
  return Math.pow((value + 0.055) / 1.055, 2.4);
};

/** IEC 61966-2-1 sRGB OETF — scene-linear → encoded [0, 1]. */
export const linearToSrgb = (value: number): number => {
  const x = Math.max(0, value);
  if (x <= 0.0031308) return x * 12.92;
  return 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
};

/** Inverse Rec.709 camera OETF: encoded [0, 1] → relative linear light. */
export const rec709ToLinear = (value: number): number => {
  if (value < 0.081) return value / 4.5;
  return Math.pow((value + 0.099) / 1.099, 1 / 0.45);
};

/** Rec.709 camera OETF: relative linear light → encoded [0, 1]. */
export const linearToRec709 = (value: number): number => {
  const x = Math.max(0, value);
  if (x < 0.018) return x * 4.5;
  return 1.099 * Math.pow(x, 0.45) - 0.099;
};

/** Display P3 (D65) linear → sRGB (D65) linear, 3×3 row-major. */
const P3_LINEAR_TO_SRGB_LINEAR = [
  1.22494, -0.22494, 0.0,
  -0.042057, 1.042057, 0.0,
  -0.019637, -0.078636, 1.098273,
] as const;

export const p3LinearToSrgbLinear = (r: number, g: number, b: number): [number, number, number] => {
  const sr =
    P3_LINEAR_TO_SRGB_LINEAR[0] * r +
    P3_LINEAR_TO_SRGB_LINEAR[1] * g +
    P3_LINEAR_TO_SRGB_LINEAR[2] * b;
  const sg =
    P3_LINEAR_TO_SRGB_LINEAR[3] * r +
    P3_LINEAR_TO_SRGB_LINEAR[4] * g +
    P3_LINEAR_TO_SRGB_LINEAR[5] * b;
  const sb =
    P3_LINEAR_TO_SRGB_LINEAR[6] * r +
    P3_LINEAR_TO_SRGB_LINEAR[7] * g +
    P3_LINEAR_TO_SRGB_LINEAR[8] * b;
  return [sr, sg, sb];
};

/** ARRI LogC3 @ EI 800 — decodes to scene-linear exposure factor (18% grey = 0.18). */
export const arriLogC3ToLinear = (value: number): number => {
  const cut = 0.010591;
  const a = 5.555556;
  const b = 0.052272;
  const c = 0.24719;
  const d = 0.385537;
  const e = 5.367655;
  const f = 0.092809;
  const threshold = e * cut + f;

  if (value > threshold) {
    return (Math.pow(10, (value - d) / c) - b) / a;
  }
  return (value - f) / e;
};

/**
 * RED Log3G10 — official REDWideGamutRGB/Log3G10 white paper constants:
 * a = 0.224282, b = 155.975327, c = 0.01, g = 15.1927.
 * Encode: y = a·log10((x + c)·b + 1); 18% grey encodes to exactly 1/3.
 */
export const redLog3G10ToLinear = (value: number): number => {
  const a = 0.224282;
  const b = 155.975327;
  const c = 0.01;
  const g = 15.1927;
  const x = value < 0 ? value / g : (Math.pow(10, value / a) - 1) / b;
  return x - c;
};

/**
 * Sony S-Log3 — official Sony technical summary formula.
 * 18% grey encodes to 420/1023 ≈ 0.4106 and decodes back to 0.18.
 */
export const sLog3ToLinear = (value: number): number => {
  if (value >= 171.2102946929 / 1023) {
    return Math.pow(10, (value * 1023 - 420) / 261.5) * (0.18 + 0.01) - 0.01;
  }
  return (value * 1023 - 95) * 0.01125 / (171.2102946929 - 95);
};

/**
 * Blackmagic Film Gen 5 — official OETF⁻¹ from BMD Generation 5 Color Science (2021).
 * URSA Mini Pro 12K, Pocket 6K G2, Cinema 6K, PYXIS, etc.
 * 18% grey encodes to 0.383562; decodes back to 0.18 linear.
 */
export const bmdFilmGen5ToLinear = (value: number): number => {
  const logA = 0.08692876065491224;
  const logB = 0.005494072432257808;
  const logC = 0.5300133392291939;
  const linSlope = 8.283605932402494;
  const linOffset = 0.09246575342465753;
  const logCut = linSlope * 0.005 + linOffset;

  if (value < logCut) {
    return (value - linOffset) / linSlope;
  }
  return Math.exp((value - logC) / logA) - logB;
};

/**
 * Blackmagic Film Gen 4 — Pocket 6K / 4K Film curve (psychopath.io / Resolve, 2022).
 * BMPCC 4K, Pocket 6K (original), Pocket 4K Film Gen 4 color space.
 */
export const bmdFilmGen4ToLinear = (value: number): number => {
  const linSlope = 4.724515510884684;
  const linOffset = 0.07305940816299691;
  const logB = 0.027941380463157067;
  const logA = 0.15545874964938466;
  const logC = 0.6272665887366995;
  const logCut = 0.09650867241866573;

  if (value <= logCut) {
    return (value - linOffset) / linSlope;
  }
  return Math.exp((value - logC) / logA) - logB;
};

/**
 * Blackmagic Wide Gamut (Gen 4/5) linear → sRGB (D65) linear.
 * Calculated from Blackmagic Design's published Gen 5 primaries
 * R(0.7177215, 0.3171181) G(0.2280410, 0.8615690) B(0.1005841, −0.0820452), D65.
 */
const BMD_WG_TO_SRGB_LINEAR = [
   1.568445, -0.522716, -0.045729,
  -0.086361,  1.344976, -0.258615,
  -0.052043, -0.249147,  1.301189,
] as const;

export const bmdWideGamutToSrgbLinear = (
  r: number,
  g: number,
  b: number,
): [number, number, number] => {
  const sr =
    BMD_WG_TO_SRGB_LINEAR[0] * r +
    BMD_WG_TO_SRGB_LINEAR[1] * g +
    BMD_WG_TO_SRGB_LINEAR[2] * b;
  const sg =
    BMD_WG_TO_SRGB_LINEAR[3] * r +
    BMD_WG_TO_SRGB_LINEAR[4] * g +
    BMD_WG_TO_SRGB_LINEAR[5] * b;
  const sb =
    BMD_WG_TO_SRGB_LINEAR[6] * r +
    BMD_WG_TO_SRGB_LINEAR[7] * g +
    BMD_WG_TO_SRGB_LINEAR[8] * b;
  return [Math.max(0, sr), Math.max(0, sg), Math.max(0, sb)];
};

/**
 * DaVinci Intermediate — official Blackmagic "DaVinci Wide Gamut Intermediate"
 * white paper constants: A = 0.0075, B = 7, C = 0.07329248, M = 10.44426855,
 * LOG_CUT = 0.02740668. 18% grey encodes to ≈0.336043.
 */
export const davinciIntermediateToLinear = (value: number): number => {
  if (value > 0.02740668) {
    return Math.pow(2, value / 0.07329248 - 7) - 0.0075;
  }
  return value / 10.44426855;
};

/**
 * Canon C-Log3 — official Canon transfer characteristics (three segments).
 * In this formula's normalized full-range convention, 18% grey encodes to
 * 0.3309579104. Camera waveform/legal-range code values use a different
 * normalization and must not be compared as raw normalized bytes.
 */
export const cLog3ToLinear = (value: number): number => {
  if (value < 0.097465473) {
    return -(Math.pow(10, (0.12783901 - value) / 0.36726845) - 1) / 14.98325;
  }
  if (value <= 0.15277891) {
    return (value - 0.12512219) / 1.9754798;
  }
  return (Math.pow(10, (value - 0.12240537) / 0.36726845) - 1) / 14.98325;
};

/**
 * Panasonic V-Log — official V-Log/V-Gamut reference manual.
 * Linear segment: y = 5.6x + 0.125 (x < 0.01); 18% grey encodes to ≈0.4233.
 */
export const vLogToLinear = (value: number): number => {
  if (value < 0.181) {
    return (value - 0.125) / 5.6;
  }
  return Math.pow(10, (value - 0.598206) / 0.241514) - 0.00873;
};

/* ============================================================
   REFERENCE GAMUT APPROXIMATIONS (linear → linear)
   These matrices approximate conversion from the named camera gamut to sRGB
   D65 using published primaries and common colour-science references. They do
   not replace a calibrated color-management transform.
   ============================================================ */

/**
 * ARRI Alexa Wide Gamut 3 (AWG3) linear → sRGB linear.
 * Calculated from ARRI's published AWG3 primaries
 * R(0.6840, 0.3130) G(0.2210, 0.8480) B(0.0861, −0.1020), D65.
 */
const AWG3_TO_SRGB = [
   1.617523, -0.537287, -0.080237,
  -0.070573,  1.334613, -0.264040,
  -0.021102, -0.226954,  1.248056,
] as const;

export const awg3LinearToSrgbLinear = (r: number, g: number, b: number): [number, number, number] => {
  return applyMatrix(r, g, b, AWG3_TO_SRGB);
};

/**
 * RED WideGamutRGB linear → sRGB linear (for Log3G10).
 * Calculated from RED's published RWG primaries
 * R(0.780308, 0.304253) G(0.121595, 1.493994) B(0.095612, −0.084589), D65.
 */
const RED_WIDEGAMUT_TO_SRGB = [
   1.981976, -0.900432, -0.081544,
  -0.178143,  1.500468, -0.322325,
  -0.101796, -0.535263,  1.637059,
] as const;

export const redWideGamutToSrgbLinear = (r: number, g: number, b: number): [number, number, number] => {
  return applyMatrix(r, g, b, RED_WIDEGAMUT_TO_SRGB);
};

/**
 * Sony S-Gamut3.Cine linear → sRGB linear.
 * Calculated from Sony's published primaries
 * R(0.766, 0.275) G(0.225, 0.800) B(0.089, −0.087), D65.
 */
const SGAMUT3_CINE_TO_SRGB = [
   1.626947, -0.540139, -0.086809,
  -0.178516,  1.417941, -0.239425,
  -0.044436, -0.195920,  1.240356,
] as const;

export const sGamut3CineToSrgbLinear = (r: number, g: number, b: number): [number, number, number] => {
  return applyMatrix(r, g, b, SGAMUT3_CINE_TO_SRGB);
};

/**
 * DaVinci Wide Gamut linear → sRGB linear.
 * Calculated from Blackmagic Design's published DWG primaries
 * R(0.8000, 0.3130) G(0.1682, 0.9877) B(0.0790, −0.1155), D65.
 */
const DWG_TO_SRGB = [
   1.898615, -0.792176, -0.106439,
  -0.168949,  1.488976, -0.320027,
  -0.121539, -0.315676,  1.437215,
] as const;

export const dwgToSrgbLinear = (r: number, g: number, b: number): [number, number, number] => {
  return applyMatrix(r, g, b, DWG_TO_SRGB);
};

/**
 * Canon Cinema Gamut linear → sRGB linear.
 * Calculated from Canon's published primaries
 * R(0.740, 0.270) G(0.170, 1.140) B(0.080, −0.100), D65.
 */
const CINEMA_GAMUT_TO_SRGB = [
   1.923861, -0.798761, -0.125101,
  -0.204311,  1.495899, -0.291588,
  -0.023685, -0.420127,  1.443812,
] as const;

export const cinemaGamutToSrgbLinear = (r: number, g: number, b: number): [number, number, number] => {
  return applyMatrix(r, g, b, CINEMA_GAMUT_TO_SRGB);
};

/**
 * Panasonic V-Gamut linear → sRGB linear.
 * Calculated from Panasonic's published primaries
 * R(0.730, 0.280) G(0.165, 0.840) B(0.100, −0.030), D65.
 */
const V_GAMUT_TO_SRGB = [
   1.806576, -0.695697, -0.110879,
  -0.170090,  1.305955, -0.135865,
  -0.025206, -0.154468,  1.179674,
] as const;

export const vGamutToSrgbLinear = (r: number, g: number, b: number): [number, number, number] => {
  return applyMatrix(r, g, b, V_GAMUT_TO_SRGB);
};

/** Helper to apply 3x3 row-major matrix */
function applyMatrix(r: number, g: number, b: number, m: readonly number[]): [number, number, number] {
  const sr = m[0] * r + m[1] * g + m[2] * b;
  const sg = m[3] * r + m[4] * g + m[5] * b;
  const sb = m[6] * r + m[7] * g + m[8] * b;
  return [Math.max(0, sr), Math.max(0, sg), Math.max(0, sb)];
}

/**
 * "Flat" / picture profile (common in stills cameras and Lightroom "flat" exports).
 * Approximate inverse of a mild low-contrast curve: flat encodes *compress*
 * contrast around mid-grey, so decoding must *expand* it. Anchored at 18%
 * grey (0.18 stays 0.18) and black stays black.
 */
export const flatToLinear = (value: number): number => {
  const x = Math.max(0, srgbToLinear(value));
  return 0.18 * Math.pow(x / 0.18, 1.25);
};

/**
 * Scene-linear to display-encoded sRGB rendering transform.
 * This neutral transform is used after profile decoding and approximate gamut
 * conversion.
 *
 * - Applies the caller's exposure offset.
 * - Optionally applies a simple rational highlight shoulder.
 * - Applies the standard sRGB OETF.
 *
 * Designed so that the film emulation LUTs and creative adjustments
 * sit on top of a consistent processing base.
 */
export const sceneLinearToDisplay = (
  linear: number,
  exposureStops = 0,
  shoulder = 0.12
): number => {
  const gain = Math.pow(2, exposureStops);
  let x = Math.max(0, linear) * gain;

  // Simple highlight roll-off; this is not a calibrated CST.
  if (shoulder > 0) {
    x = x / (1 + x * shoulder);
  }

  return clamp(linearToSrgb(x), 0, 1);
};

/** Legacy alias kept for compatibility */
export const toneMapLogToDisplay = sceneLinearToDisplay;

/** For standard (non-log) sources — just linear → sRGB */
export const toneMapStandardToDisplay = (linear: number): number =>
  clamp(linearToSrgb(Math.max(0, linear)), 0, 1);
