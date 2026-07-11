import { ImageBuffer } from '../core/image-buffer';
import { rgbToHsl } from './color';

const ANALYSIS_MAX_DIMENSION = 720;

export type SceneProfile =
  | 'portrait'
  | 'landscape'
  | 'sunset'
  | 'night'
  | 'indoor'
  | 'backlit'
  | 'high-key'
  | 'low-key'
  | 'neutral';

export interface ImageAnalysis {
  pixelCount: number;
  luminance: {
    p1: number;
    p5: number;
    p25: number;
    p50: number;
    p75: number;
    p95: number;
    p99: number;
    mean: number;
    stdDev: number;
    subjectWeightedMedian: number;
  };
  rgb: {
    meanR: number;
    meanG: number;
    meanB: number;
    midR: number;
    midG: number;
    midB: number;
    highlightR: number;
    highlightG: number;
    highlightB: number;
    shadowR: number;
    shadowG: number;
    shadowB: number;
    neutralR: number;
    neutralG: number;
    neutralB: number;
    neutralCount: number;
    /**
     * Chroma-weighted "soft neutral" average — pixels weighted by
     * (1 − chroma/64)², so surfaces that are neutral-but-color-cast still
     * contribute while genuinely colored subjects contribute ~nothing.
     * This is the robust illuminant signal for white balance: plain
     * grey-world gets poisoned by colored subjects, and the strict neutral
     * detector loses the very pixels a strong cast displaces.
     */
    softNeutralR: number;
    softNeutralG: number;
    softNeutralB: number;
    softNeutralWeight: number;
  };
  clipping: {
    highlightPct: number;
    shadowPct: number;
  };
  saturation: {
    mean: number;
    p50: number;
    vividPct: number;
    mutedPct: number;
  };
  color: {
    warmth: number;
    colorfulness: number;
    dynamicRange: number;
  };
  content: {
    skinPct: number;
    skyPct: number;
    centerFocus: number;
    acutance: number;
  };
  scene: {
    profile: SceneProfile;
    isHighKey: boolean;
    isLowKey: boolean;
    isBacklit: boolean;
    isVivid: boolean;
    confidence: number;
  };
}

const percentile = (hist: Uint32Array, total: number, ratio: number): number => {
  const target = Math.max(1, Math.round(total * ratio));
  let accumulated = 0;
  for (let value = 0; value < 256; value += 1) {
    accumulated += hist[value];
    if (accumulated >= target) {
      return value;
    }
  }
  return 255;
};

const luminance = (r: number, g: number, b: number): number =>
  r * 0.2126 + g * 0.7152 + b * 0.0722;

export const isSkinTone = (r: number, g: number, b: number): boolean => {
  const { h, s, l } = rgbToHsl(r, g, b);
  // Relaxed for darker skin tones (black/brown faces) while still filtering extremes
  if (s < 0.05 || s > 0.75 || l < 0.05 || l > 0.85) return false;
  return (h >= 0 && h <= 50) || h >= 335;
};

/**
 * Soft (0–1) skin-tone likelihood with feathered edges. Use this instead of
 * the boolean `isSkinTone` for per-pixel blending — a hard cutoff makes
 * neighboring face pixels flip between protected/unprotected, which shows up
 * as blotchy contours when effects like vibrance are pushed.
 */
export const skinToneWeight = (r: number, g: number, b: number): number => {
  const { h, s, l } = rgbToHsl(r, g, b);

  // Trapezoid window: 1 inside [lo, hi], linear feather of width `soft` outside.
  const window = (v: number, lo: number, hi: number, soft: number): number => {
    if (v >= lo && v <= hi) return 1;
    const dist = v < lo ? lo - v : v - hi;
    return Math.max(0, 1 - dist / soft);
  };

  // Hue band (wraps through 0): 335°..360°..50°, feathered by 14°.
  let hueWeight: number;
  if (h <= 50 || h >= 335) {
    hueWeight = 1;
  } else {
    const dist = Math.min(h - 50, 335 - h);
    hueWeight = Math.max(0, 1 - dist / 14);
  }

  return hueWeight * window(s, 0.05, 0.75, 0.1) * window(l, 0.05, 0.85, 0.1);
};

const isSkyPixel = (r: number, g: number, b: number, lum: number): boolean => {
  if (lum < 95) return false;
  return b > r * 1.08 && b > g * 1.02 && b - r > 12;
};

const isNeutralPixel = (r: number, g: number, b: number, lum: number): boolean => {
  if (lum < 140 || lum > 245) return false;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max - min < 18;
};

const classifyScene = (input: {
  p50: number;
  p5: number;
  p75: number;
  p95: number;
  p25: number;
  highlightPct: number;
  shadowPct: number;
  satMedian: number;
  skinPct: number;
  skyPct: number;
  warmth: number;
  acutance: number;
  shadowClippedRatio: number;
  dynamicRange: number;
}): { profile: SceneProfile; confidence: number; flags: ImageAnalysis['scene'] } => {
  const isHighKey = input.p50 > 142 && input.p5 > 38 && input.dynamicRange < 155;
  const isLowKey = input.p50 < 78 && input.p95 < 188;
  const isBacklit =
    input.p95 > 205 &&
    input.p25 < 68 &&
    input.shadowClippedRatio > 0.012;
  const isVivid = input.satMedian > 0.38;

  // More robust multi-factor scoring (less brittle to single outliers)
  const scores: Record<SceneProfile, number> = {
    portrait: (input.skinPct * 3.8) + (input.skinPct > 5 ? 22 : 0) + (input.acutance < 9 ? 8 : 0),
    landscape: (input.skyPct * 3.1) + (input.dynamicRange > 145 ? 14 : 0) + (input.skinPct < 3 ? 6 : 0),
    sunset: (input.warmth * 19) + ((input.p75 > 115 && input.warmth > 0.07) ? 16 : 0) + (input.skyPct > 2 ? 5 : 0),
    night: (input.p50 < 55 ? 32 : 0) + (input.p95 < 168 ? 14 : 0) + (input.satMedian < 0.26 ? 7 : 0),
    indoor: ((input.warmth > 0.04 && input.p50 > 72 && input.p50 < 128) ? 18 : 0) +
            (input.skyPct < 3 ? 10 : 0) + (input.acutance < 11 ? 4 : 0),
    backlit: isBacklit ? 45 : 0,
    'high-key': isHighKey ? 38 : 0,
    'low-key': isLowKey ? 38 : 0,
    neutral: 8,
  };

  let profile: SceneProfile = 'neutral';
  let confidence = 0.38;
  for (const [candidate, score] of Object.entries(scores) as [SceneProfile, number][]) {
    if (score > confidence * 100) {
      profile = candidate;
      confidence = Math.min(0.92, score / 100);
    }
  }

  // Strong overrides
  if (isBacklit && profile !== 'sunset') {
    profile = 'backlit';
    confidence = Math.max(confidence, 0.75);
  }
  if (isHighKey && profile !== 'sunset' && profile !== 'backlit') {
    profile = 'high-key';
    confidence = Math.max(confidence, 0.7);
  }

  // If very low confidence, force neutral for safety (avoids bad gimmicky results)
  if (confidence < 0.48) {
    profile = 'neutral';
    confidence = 0.42;
  }

  return {
    profile,
    confidence,
    flags: { profile, isHighKey, isLowKey, isBacklit, isVivid, confidence },
  };
};

/**
 * Builds a statistical and semantic profile of an image for intelligent tone mapping.
 * Downscales first so analysis stays fast on large photos.
 */
export const analyzeImage = (source: ImageBuffer): ImageAnalysis => {
  const sample = source.downscale(ANALYSIS_MAX_DIMENSION);
  const { data, width, height } = sample;
  const pixelCount = width * height;

  const lumHist = new Uint32Array(256);
  const subjectLumSamples: number[] = [];

  let sumLum = 0;
  let sumLumSq = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;

  let midR = 0;
  let midG = 0;
  let midB = 0;
  let midCount = 0;

  let hiR = 0;
  let hiG = 0;
  let hiB = 0;
  let hiCount = 0;

  let shR = 0;
  let shG = 0;
  let shB = 0;
  let shCount = 0;

  let neuR = 0;
  let neuG = 0;
  let neuB = 0;
  let neuCount = 0;

  let softR = 0;
  let softG = 0;
  let softB = 0;
  let softW = 0;

  let satSum = 0;
  const satSamples: number[] = [];
  let vividCount = 0;
  let mutedCount = 0;

  let highlightClipped = 0;
  let shadowClipped = 0;

  let skinCount = 0;
  let skyCount = 0;
  let skyTotal = 0;

  let laplacianSum = 0;
  let laplacianSamples = 0;

  const cx = width / 2;
  const cy = height / 2;
  const maxDist = Math.sqrt(cx * cx + cy * cy) || 1;

  const skyRows = Math.floor(height * 0.38);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const lum = Math.round(luminance(r, g, b));

      lumHist[lum] += 1;
      sumLum += lum;
      sumLumSq += lum * lum;
      sumR += r;
      sumG += g;
      sumB += b;

      const hsl = rgbToHsl(r, g, b);
      satSum += hsl.s;
      if (satSamples.length < 8192 && (x + y) % 3 === 0) {
        satSamples.push(hsl.s);
      }
      if (hsl.s > 0.45) vividCount += 1;
      if (hsl.s < 0.14) mutedCount += 1;

      if (lum >= 252) highlightClipped += 1;
      if (lum <= 3) shadowClipped += 1;

      if (isSkinTone(r, g, b)) skinCount += 1;

      if (y < skyRows) {
        skyTotal += 1;
        if (isSkyPixel(r, g, b, lum)) skyCount += 1;
      }

      if (isNeutralPixel(r, g, b, lum)) {
        neuR += r;
        neuG += g;
        neuB += b;
        neuCount += 1;
      }

      // Soft-neutral accumulator (see interface docs).
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      if (lum > 50 && lum < 250 && chroma < 64) {
        const wSoft = 1 - chroma / 64;
        const w2 = wSoft * wSoft;
        softR += r * w2;
        softG += g * w2;
        softB += b * w2;
        softW += w2;
      }

      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) / maxDist;
      const weight = Math.exp(-dist * dist * 2.4);
      if (weight > 0.35 && subjectLumSamples.length < 12000) {
        subjectLumSamples.push(lum);
      }

      if (x > 0 && x < width - 1 && y > 0 && y < height - 1 && (x + y) % 4 === 0) {
        const left = data[index - 4];
        const right = data[index + 4];
        const up = data[((y - 1) * width + x) * 4];
        const down = data[((y + 1) * width + x) * 4];
        const lap = Math.abs(4 * lum - left - right - up - down);
        laplacianSum += lap;
        laplacianSamples += 1;
      }
    }
  }

  const p25 = percentile(lumHist, pixelCount, 0.25);
  const p75 = percentile(lumHist, pixelCount, 0.75);

  for (let index = 0; index < data.length; index += 4) {
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    const lum = Math.round(luminance(r, g, b));

    if (lum >= p25 && lum <= p75) {
      midR += r;
      midG += g;
      midB += b;
      midCount += 1;
    } else if (lum >= 185) {
      hiR += r;
      hiG += g;
      hiB += b;
      hiCount += 1;
    } else if (lum <= 55) {
      shR += r;
      shG += g;
      shB += b;
      shCount += 1;
    }
  }

  subjectLumSamples.sort((a, b) => a - b);
  const subjectWeightedMedian = subjectLumSamples.length
    ? subjectLumSamples[Math.floor(subjectLumSamples.length / 2)]
    : percentile(lumHist, pixelCount, 0.5);

  satSamples.sort((a, b) => a - b);
  const satMedian = satSamples.length
    ? satSamples[Math.floor(satSamples.length / 2)]
    : satSum / pixelCount;

  const meanLum = sumLum / pixelCount;
  const variance = sumLumSq / pixelCount - meanLum * meanLum;
  const p50 = percentile(lumHist, pixelCount, 0.5);
  const p5 = percentile(lumHist, pixelCount, 0.05);
  const p95 = percentile(lumHist, pixelCount, 0.95);
  const p99 = percentile(lumHist, pixelCount, 0.99);
  const p1 = percentile(lumHist, pixelCount, 0.01);

  const warmth =
    ((midCount ? midR / midCount : sumR / pixelCount) -
      (midCount ? midB / midCount : sumB / pixelCount)) /
    255;

  const colorfulness =
    Math.sqrt(
      ((sumR / pixelCount - sumG / pixelCount) ** 2 +
        (sumG / pixelCount - sumB / pixelCount) ** 2) /
        2,
    ) / 128;

  const shadowClippedRatio = shadowClipped / pixelCount;
  const classified = classifyScene({
    p50,
    p5,
    p75,
    p95,
    p25,
    highlightPct: (highlightClipped / pixelCount) * 100,
    shadowPct: (shadowClipped / pixelCount) * 100,
    satMedian,
    skinPct: (skinCount / pixelCount) * 100,
    skyPct: skyTotal ? (skyCount / skyTotal) * 100 : 0,
    warmth,
    acutance: laplacianSamples ? laplacianSum / laplacianSamples : 0,
    shadowClippedRatio,
    dynamicRange: p95 - p5,
  });

  const centerFocus = subjectLumSamples.length
    ? Math.abs(subjectWeightedMedian - p50) / 128
    : 0;

  return {
    pixelCount,
    luminance: {
      p1,
      p5,
      p25,
      p50,
      p75,
      p95,
      p99,
      mean: meanLum,
      stdDev: Math.sqrt(Math.max(0, variance)),
      subjectWeightedMedian,
    },
    rgb: {
      meanR: sumR / pixelCount,
      meanG: sumG / pixelCount,
      meanB: sumB / pixelCount,
      midR: midCount ? midR / midCount : sumR / pixelCount,
      midG: midCount ? midG / midCount : sumG / pixelCount,
      midB: midCount ? midB / midCount : sumB / pixelCount,
      highlightR: hiCount ? hiR / hiCount : sumR / pixelCount,
      highlightG: hiCount ? hiG / hiCount : sumG / pixelCount,
      highlightB: hiCount ? hiB / hiCount : sumB / pixelCount,
      shadowR: shCount ? shR / shCount : sumR / pixelCount,
      shadowG: shCount ? shG / shCount : sumG / pixelCount,
      shadowB: shCount ? shB / shCount : sumB / pixelCount,
      neutralR: neuCount ? neuR / neuCount : sumR / pixelCount,
      neutralG: neuCount ? neuG / neuCount : sumG / pixelCount,
      neutralB: neuCount ? neuB / neuCount : sumB / pixelCount,
      neutralCount: neuCount,
      softNeutralR: softW > 0 ? softR / softW : sumR / pixelCount,
      softNeutralG: softW > 0 ? softG / softW : sumG / pixelCount,
      softNeutralB: softW > 0 ? softB / softW : sumB / pixelCount,
      softNeutralWeight: softW,
    },
    clipping: {
      highlightPct: (highlightClipped / pixelCount) * 100,
      shadowPct: (shadowClipped / pixelCount) * 100,
    },
    saturation: {
      mean: satSum / pixelCount,
      p50: satMedian,
      vividPct: (vividCount / pixelCount) * 100,
      mutedPct: (mutedCount / pixelCount) * 100,
    },
    color: {
      warmth,
      colorfulness,
      dynamicRange: p95 - p5,
    },
    content: {
      skinPct: (skinCount / pixelCount) * 100,
      skyPct: skyTotal ? (skyCount / skyTotal) * 100 : 0,
      centerFocus,
      acutance: laplacianSamples ? laplacianSum / laplacianSamples : 0,
    },
    scene: classified.flags,
  };
};