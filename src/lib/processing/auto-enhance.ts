import type { Adjustments } from '../core/types';
import { clamp } from '../core/math';
import { ImageBuffer } from '../core/image-buffer';
import { DEFAULT_ADJUSTMENTS } from '../editor/constants';
import { analyzeImage, type ImageAnalysis, type SceneProfile } from './image-analysis';
import { applyAdjustments } from './adjustments';

const round = (value: number): number => Math.round(value);

export interface AutoEnhanceResult {
  adjustments: Adjustments;
  summary: string;
  suggestedCurve?: import('../core/types').Curves;
}

const SCENE_TARGETS: Record<
  SceneProfile,
  { median: number; span: number; contrastBias: number; satBias: number }
> = {
  portrait: { median: 120, span: 165, contrastBias: -4, satBias: -3 },
  landscape: { median: 125, span: 185, contrastBias: 5, satBias: 5 },
  sunset: { median: 118, span: 172, contrastBias: 1, satBias: -10 },
  night: { median: 105, span: 160, contrastBias: -3, satBias: 6 },
  indoor: { median: 118, span: 168, contrastBias: 1, satBias: 3 },
  backlit: { median: 115, span: 175, contrastBias: 3, satBias: 1 },
  'high-key': { median: 132, span: 155, contrastBias: -7, satBias: -5 },
  'low-key': { median: 108, span: 178, contrastBias: 4, satBias: 3 },
  neutral: { median: 123, span: 180, contrastBias: 0, satBias: 0 },
};

const computeExposure = (analysis: ImageAnalysis): number => {
  const { profile } = analysis.scene;
  const target = SCENE_TARGETS[profile].median;
  const median = Math.max(
    8,
    analysis.content.centerFocus > 0.11
      ? analysis.luminance.subjectWeightedMedian
      : analysis.luminance.p50,
  );

  // Exact solve: the exposure slider applies 2^(v/50) stops, so v = 50·log2(T/m)
  // brings the median to target in one step (clamped for predictability).
  let exposure = clamp(Math.log2(target / median) * 50, -48, 48);

  // Much more protective against blowing highlights
  const clip = analysis.clipping.highlightPct;
  if (clip > 1.2) {
    exposure = Math.min(exposure, profile === 'backlit' ? 9 : profile === 'sunset' ? 4 : -3);
  } else if (clip > 0.6) {
    exposure = Math.min(exposure, -1);
  }

  if (profile === 'night') {
    exposure = Math.max(exposure, clamp((90 - median) * 0.22, 0, 26));
  }

  if (profile === 'low-key') {
    exposure = Math.max(exposure, clamp((88 - median) * 0.15, 0, 14));
  }

  if (profile === 'high-key' && median > 148) {
    exposure = Math.min(exposure, -5);
  }

  return round(exposure);
};

const computeBrightness = (analysis: ImageAnalysis, exposure: number): number => {
  const median = analysis.luminance.p50;
  const perceptualGap =
    SCENE_TARGETS[analysis.scene.profile].median - median - exposure * 0.42;

  if (Math.abs(perceptualGap) < 6) return 0;

  let brightness = clamp(perceptualGap * 0.14, -12, 12);

  if (analysis.scene.profile === 'portrait') {
    brightness = clamp(brightness, -6, 8);
  }

  return round(brightness);
};

const computeContrast = (analysis: ImageAnalysis): number => {
  const { profile } = analysis.scene;
  const target = SCENE_TARGETS[profile];
  const span = analysis.color.dynamicRange;
  let contrast = clamp(((target.span - span) / target.span) * 48 + target.contrastBias, -22, 42);

  if (analysis.luminance.stdDev < 32) {
    contrast += clamp((34 - analysis.luminance.stdDev) * 0.55, 0, 14);
  }

  if (analysis.scene.isVivid) {
    contrast *= 0.72;
  }

  if (profile === 'portrait') {
    contrast = clamp(contrast, -8, 22);
  }

  if (profile === 'night') {
    contrast = Math.min(contrast, 18);
  }

  return round(contrast);
};

const computeHighlights = (analysis: ImageAnalysis): number => {
  const { p99, p95 } = analysis.luminance;
  const { highlightPct } = analysis.clipping;

  if (p99 < 242 && highlightPct < 0.15) return 0;

  let recovery = clamp((p99 - 235) * 0.65 + highlightPct * 7.5, 0, 52);

  if (analysis.scene.profile === 'sunset') {
    recovery *= 0.48;
  }
  if (analysis.scene.profile === 'high-key') {
    recovery *= 0.6;
  }
  if (p95 < 205 && highlightPct < 0.45) {
    recovery *= 0.35;
  }

  return round(-recovery);
};

const computeShadows = (analysis: ImageAnalysis): number => {
  const { p5, p1 } = analysis.luminance;
  const { shadowPct } = analysis.clipping;
  const { profile } = analysis.scene;

  if (p5 > 36 && shadowPct < 0.12 && profile !== 'backlit' && profile !== 'night') {
    return 0;
  }

  let shadows = clamp((28 - p5) * 1.05 + shadowPct * 5.5, 0, 48);

  if (profile === 'backlit' || profile === 'night') {
    shadows = Math.max(shadows, round(clamp((55 - p1) * 0.68, 10, 42)));
  }

  if (profile === 'high-key') shadows *= 0.45;
  if (profile === 'low-key') shadows = Math.min(shadows, 24);
  if (profile === 'portrait') shadows = clamp(shadows, 0, 32);

  return round(shadows);
};

const computeWhites = (analysis: ImageAnalysis): number => {
  const { p99, p95 } = analysis.luminance;

  if (p99 > 251) {
    return round(clamp((245 - p99) * 0.85, -32, 0));
  }

  if (p99 < 205 && p95 < 185 && analysis.scene.profile !== 'low-key') {
    return round(clamp((220 - p99) * 0.38, 0, 26));
  }

  return 0;
};

const computeBlacks = (analysis: ImageAnalysis): number => {
  const { p1, p5 } = analysis.luminance;
  const { profile } = analysis.scene;

  if (p1 < 5 && analysis.clipping.shadowPct > 0.35) {
    return round(clamp((p1 - 5) * 2.4, -20, 0));
  }

  if (p5 > 30 && profile !== 'low-key') {
    return round(clamp((p5 - 16) * 0.58, 0, 26));
  }

  if (profile === 'low-key' && p1 > 3) {
    return round(clamp((p1 - 10) * -0.9, -18, 0));
  }

  return 0;
};

/**
 * White balance via exact inversion of the adjustment model.
 *
 * 1. Estimate the illuminant color as a weighted blend of the most reliable
 *    signals available: near-neutral pixel average (best), bright-region
 *    average (white-patch), and midtone grey-world (fallback).
 * 2. Solve the temperature/tint slider values that exactly neutralize that
 *    estimate under the multiplicative gain model in adjustments.ts:
 *      temp t → r×1.35^t, b×1.35^(−t)   ⇒  (r/b) corrected by 1.35^(2t)
 *      tint v → g×1.25^v, r,b×1.25^(−v/2) ⇒ g/√(rb) corrected by 1.25^(1.5v)
 * 3. Damp only for creative intent (golden hour, skin, vivid scenes).
 */
const computeWhiteBalance = (
  analysis: ImageAnalysis,
): { temperature: number; tint: number } => {
  const { profile } = analysis.scene;
  const hasGoodNeutrals = analysis.rgb.neutralCount > analysis.pixelCount * 0.004;

  let estR = 0;
  let estG = 0;
  let estB = 0;
  let totalW = 0;
  const addEstimate = (r: number, g: number, b: number, w: number) => {
    if (w <= 0 || r < 8 || g < 8 || b < 8) return;
    estR += r * w;
    estG += g * w;
    estB += b * w;
    totalW += w;
  };

  // Estimator priority: strict neutrals (when a cast hasn't displaced them),
  // then the chroma-weighted soft-neutral average (robust to colored
  // subjects — this is the workhorse for strong casts), then bright-region
  // white-patch, and only as a last resort raw midtone grey-world.
  const hasSoftNeutrals = analysis.rgb.softNeutralWeight > analysis.pixelCount * 0.01;
  addEstimate(analysis.rgb.neutralR, analysis.rgb.neutralG, analysis.rgb.neutralB, hasGoodNeutrals ? 0.55 : 0);
  addEstimate(
    analysis.rgb.softNeutralR,
    analysis.rgb.softNeutralG,
    analysis.rgb.softNeutralB,
    hasSoftNeutrals ? (hasGoodNeutrals ? 0.35 : 0.85) : 0,
  );
  addEstimate(
    analysis.rgb.highlightR,
    analysis.rgb.highlightG,
    analysis.rgb.highlightB,
    hasGoodNeutrals || hasSoftNeutrals ? 0.1 : 0.4,
  );
  if (!hasGoodNeutrals && !hasSoftNeutrals) {
    addEstimate(analysis.rgb.midR, analysis.rgb.midG, analysis.rgb.midB, 0.6);
  }

  if (totalW <= 0) return { temperature: 0, tint: 0 };
  estR /= totalW;
  estG /= totalW;
  estB /= totalW;

  // Cast ratios of the estimated illuminant (1.0 = neutral).
  const rho = estR / Math.max(estB, 1e-3);
  const gamma = estG / Math.max(Math.sqrt(estR * estB), 1e-3);

  // Exact solve for the slider values that neutralize the cast.
  let temperature = (-Math.log(rho) / (2 * Math.log(1.35))) * 100;
  let tint = (-Math.log(gamma) / (1.5 * Math.log(1.25))) * 100;

  // Creative-intent damping — don't neutralize golden-hour warmth…
  if (profile === 'sunset') {
    if (temperature < 0) temperature *= 0.3; // keep most of the warm cast
    tint *= 0.5;
  }
  // …and be gentler when the frame is mostly skin.
  if (profile === 'portrait' && analysis.content.skinPct > 30) {
    temperature *= 0.65;
    tint *= 0.7;
  }
  if (analysis.scene.isVivid && analysis.saturation.p50 > 0.45) {
    temperature *= 0.7;
    tint *= 0.7;
  }

  temperature = clamp(temperature, -80, 80);
  tint = clamp(tint, -60, 60);

  // Small deadband — doing nothing beats a tiny wrong correction.
  if (Math.abs(temperature) < 3) temperature = 0;
  if (Math.abs(tint) < 2.5) tint = 0;

  return { temperature: round(temperature), tint: round(tint) };
};

/**
 * Two-pass white balance solve. A strong cast pushes true neutrals past the
 * neutral-pixel detector, forcing the first pass onto the (less reliable)
 * grey-world estimate. Applying that first correction usually brings the
 * neutrals back into detection range, so a second pass can solve the
 * residual precisely. Slider values compose additively under the
 * exponential gain model, so the two corrections simply sum.
 */
const solveWhiteBalance = (
  source: ImageBuffer,
  analysis: ImageAnalysis,
): { temperature: number; tint: number } => {
  const first = computeWhiteBalance(analysis);
  if (first.temperature === 0 && first.tint === 0) return first;

  const sample = source.downscale(560);
  const corrected = applyAdjustments(sample, {
    ...DEFAULT_ADJUSTMENTS,
    temperature: first.temperature,
    tint: first.tint,
  });
  const second = computeWhiteBalance(analyzeImage(corrected));

  return {
    temperature: round(clamp(first.temperature + second.temperature, -80, 80)),
    tint: round(clamp(first.tint + second.tint, -60, 60)),
  };
};

export interface AutoWhiteBalanceResult {
  temperature: number;
  tint: number;
  summary: string;
}

/**
 * Standalone auto white balance. Reuses the multi-signal estimator from Auto
 * Tone (neutral-pixel reference when the scene has enough near-grey area,
 * midtone grey-world estimate otherwise, with skin-tone and golden-hour
 * protection) but touches ONLY temperature and tint.
 *
 * Expects the un-adjusted (normalized) source so the returned values are
 * absolute slider positions, not deltas on top of the current edit.
 */
export const computeAutoWhiteBalance = (source: ImageBuffer): AutoWhiteBalanceResult => {
  const analysis = analyzeImage(source);
  const { temperature, tint } = solveWhiteBalance(source, analysis);

  const usedNeutrals = analysis.rgb.neutralCount > analysis.pixelCount * 0.006;
  const parts: string[] = [usedNeutrals ? 'neutral reference' : 'midtone estimate'];
  if (temperature === 0 && tint === 0) {
    parts.push('already balanced');
  } else {
    if (temperature !== 0) parts.push(temperature > 0 ? 'warmed' : 'cooled');
    if (tint !== 0) parts.push(tint > 0 ? 'green shift' : 'magenta shift');
  }

  return { temperature, tint, summary: parts.join(' · ') };
};

const computeSaturation = (analysis: ImageAnalysis): number => {
  const sat = analysis.saturation.p50;
  const bias = SCENE_TARGETS[analysis.scene.profile].satBias;
  const mutedRatio = analysis.saturation.mutedPct;

  let adjustment = 0;

  if (sat < 0.14) {
    adjustment = clamp((0.25 - sat) * 140 + mutedRatio * 0.1, 8, 36);
  } else if (sat < 0.22) {
    adjustment = clamp((0.28 - sat) * 75, 4, 20);
  } else if (sat > 0.54) {
    adjustment = clamp((0.44 - sat) * 32, -18, 0);
  } else if (sat > 0.46) {
    adjustment = clamp((0.42 - sat) * 24, -8, 0);
  }

  adjustment += bias;

  if (analysis.scene.profile === 'portrait') {
    adjustment = clamp(adjustment, -5, 12);
  }

  if (analysis.scene.profile === 'sunset') {
    adjustment = Math.min(adjustment, 6);
  }

  return round(adjustment);
};

const computeClarity = (analysis: ImageAnalysis): number => {
  const acutance = analysis.content.acutance;

  if (acutance > 14) return 0;
  if (analysis.scene.profile === 'portrait') {
    return round(clamp((12 - acutance) * 0.35, 0, 8));
  }
  if (analysis.scene.profile === 'night') {
    return round(clamp((10 - acutance) * 0.25, 0, 6));
  }

  const flatness = 48 - analysis.luminance.stdDev;
  const softness = 13 - acutance;
  return round(clamp(Math.min(flatness * 0.38, softness * 0.55), 0, 20));
};

const computeSharpen = (analysis: ImageAnalysis): number => {
  const acutance = analysis.content.acutance;

  if (acutance > 16) return 0;
  if (acutance < 5) {
    return round(clamp((7 - acutance) * 1.4, 0, 10));
  }
  if (analysis.luminance.stdDev < 28) {
    return round(clamp((30 - analysis.luminance.stdDev) * 0.32, 0, 7));
  }
  return 0;
};

const buildAdjustments = (
  analysis: ImageAnalysis,
  whiteBalance: { temperature: number; tint: number },
  isWhiteBgPortrait = false,
  skinMedian: number | null = null
): Adjustments => {
  const { temperature, tint } = whiteBalance;
  let exposure = computeExposure(analysis);

  // For white bg portraits, anchor more to skin tone instead of global median
  if (isWhiteBgPortrait && skinMedian !== null) {
    // Typical pleasing skin luminance target ~122-135
    const skinTarget = 128;
    const skinGap = skinTarget - skinMedian;
    exposure = clamp(exposure + skinGap * 0.38, -12, 18);
  }

  const adjustments: Adjustments = {
    ...DEFAULT_ADJUSTMENTS,
    exposure,
    brightness: computeBrightness(analysis, exposure),
    contrast: computeContrast(analysis),
    highlights: computeHighlights(analysis),
    shadows: computeShadows(analysis),
    whites: computeWhites(analysis),
    blacks: computeBlacks(analysis),
    temperature,
    tint,
    saturation: computeSaturation(analysis),
    clarity: computeClarity(analysis),
    sharpen: computeSharpen(analysis),
  };

  return adjustments;
};

const refineAdjustments = (
  source: ImageBuffer,
  analysis: ImageAnalysis,
  draft: Adjustments,
): Adjustments => {
  // Stronger, multi-iteration refinement for consistent pro results
  let current = { ...draft };
  const preview = source.downscale(620); // higher res for better accuracy

  for (let iter = 0; iter < 2; iter++) {
    const rendered = applyAdjustments(preview, current);
    const after = analyzeImage(rendered);

    const target = SCENE_TARGETS[analysis.scene.profile];
    const medianGap = after.luminance.p50 - target.median;
    const spanGap = after.color.dynamicRange - target.span;

    let exposure = current.exposure;
    let contrast = current.contrast;
    let shadows = current.shadows;
    let highlights = current.highlights;
    let brightness = current.brightness;
    let saturation = current.saturation;

    // More accurate median targeting
    if (Math.abs(medianGap) > 5) {
      const correction = medianGap * 0.48;
      exposure = round(clamp(exposure - correction, -62, 62));
      brightness = round(clamp(brightness - medianGap * 0.07, -18, 18));
    }

    // Dynamic range / contrast correction
    if (spanGap < -18) {
      contrast = round(clamp(contrast + Math.abs(spanGap) * 0.19, -28, 48));
    } else if (spanGap > 24) {
      contrast = round(clamp(contrast - spanGap * 0.13, -28, 42));
    }

    // Protect against new clipping
    if (after.clipping.shadowPct > analysis.clipping.shadowPct + 0.28) {
      shadows = round(Math.max(0, shadows - 7));
    }
    if (after.clipping.highlightPct > analysis.clipping.highlightPct + 0.42) {
      highlights = round(highlights - 9);
    }

    // Strong highlight protection
    if (after.luminance.p99 > 251 && analysis.scene.profile !== 'sunset') {
      highlights = round(highlights - 7);
      exposure = round(Math.min(exposure, current.exposure - 5));
    }

    // Gentle sat re-balance in refinement
    if (after.saturation.p50 > 0.55 && saturation > 5) {
      saturation = round(clamp(saturation - 3, 0, 30));
    }

    current = {
      ...current,
      exposure,
      brightness,
      contrast,
      shadows,
      highlights,
      saturation,
    };
  }

  return current;
};

const profileLabel: Record<SceneProfile, string> = {
  portrait: 'portrait',
  landscape: 'landscape',
  sunset: 'golden hour',
  night: 'low light',
  indoor: 'indoor',
  backlit: 'backlit',
  'high-key': 'bright scene',
  'low-key': 'moody scene',
  neutral: 'balanced',
};

const buildSummary = (analysis: ImageAnalysis, adjustments: Adjustments): string => {
  const parts: string[] = [profileLabel[analysis.scene.profile]];

  if (Math.abs(adjustments.exposure) > 7) {
    parts.push(adjustments.exposure > 0 ? 'exposure lift' : 'highlight protection');
  }
  if (adjustments.shadows > 10) parts.push('shadow recovery');
  if (adjustments.highlights < -7) parts.push('highlight recovery');
  if (Math.abs(adjustments.temperature) > 5) {
    parts.push(adjustments.temperature > 0 ? 'warm balance' : 'cool balance');
  }
  if (Math.abs(adjustments.saturation) > 7) {
    parts.push(adjustments.saturation > 0 ? 'color lift' : 'saturation control');
  }
  if (adjustments.clarity > 5) parts.push('micro-contrast');
  if (adjustments.sharpen > 3) parts.push('detail');

  if (analysis.rgb.neutralCount > analysis.pixelCount * 0.006) {
    parts.push('neutral WB');
  }

  return parts.slice(0, 4).join(' · ');
};

/**
 * Intelligent auto tone: semantic scene detection, multi-signal white balance,
 * refinement pass that actually applies the edit and corrects, plus subtle curve
 * suggestion for more natural results.
 *
 * Now smart: if PortraitAnalysis is provided (with skin/subject masks), it does
 * **subject-aware** analysis. This prevents white backgrounds or bright backdrops
 * from destroying the exposure/WB of the actual person.
 */
export const computeAutoEnhance = (
  source: ImageBuffer
): AutoEnhanceResult => {
  const analysis = analyzeImage(source);

  const isWhiteBgPortrait =
    analysis.scene.profile === 'portrait' &&
    analysis.scene.isHighKey &&
    analysis.content.skinPct > 4;
  const skinMedian = isWhiteBgPortrait ? analysis.luminance.subjectWeightedMedian : null;
  const whiteBalance = solveWhiteBalance(source, analysis);
  const draft = buildAdjustments(analysis, whiteBalance, isWhiteBgPortrait, skinMedian);
  const adjustments = refineAdjustments(source, analysis, draft);

  const summary = buildSummary(analysis, adjustments);

  // Suggest a subtle professional S-curve on flat scenes — but only when the
  // contrast slider isn't already doing the work. Applying both stacked two
  // contrast boosts and made Auto Tone look heavy-handed.
  let suggestedCurve: import('../core/types').Curves | undefined;
  const dr = analysis.color.dynamicRange;
  const std = analysis.luminance.stdDev;

  if ((dr < 145 || std < 38) && adjustments.contrast <= 12) {
    suggestedCurve = {
      master: [
        { x: 0, y: 0 },
        { x: 0.22, y: 0.17 },
        { x: 0.5, y: 0.5 },
        { x: 0.78, y: 0.83 },
        { x: 1, y: 1 },
      ],
    };
  }

  return { adjustments, summary, suggestedCurve };
};

