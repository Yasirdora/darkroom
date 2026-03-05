import { adoptPixelBuffer, assertPixelBuffer, clonePixelBuffer } from './buffer.js';
import { applyBoxBlur } from './blur.js';
import { hslToRgb, rgbToHsl } from './color.js';
import { skinToneWeight } from './image-metrics.js';
import { clamp, clampByte, lerp, seededNoise } from './math.js';
import type { Adjustments, PixelBuffer } from './types.js';

const applyExposure = (value: number, exposure: number): number => {
  const stops = exposure / 50;
  return value * Math.pow(2, stops);
};

const luminance = (r: number, g: number, b: number): number =>
  r * 0.2126 + g * 0.7152 + b * 0.0722;

const applyToneCurve = (
  r: number,
  g: number,
  b: number,
  adjustments: Adjustments,
): { r: number; g: number; b: number } => {
  const lum = luminance(r, g, b) / 255;
  let weight = 0;

  const smoothstep = (e0: number, e1: number, x: number) => {
    const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };

  const highlightAmount = adjustments.highlights / 100;
  if (highlightAmount !== 0 && lum > 0.5) {
    const t = smoothstep(0.5, 1.0, lum);
    weight += t * highlightAmount * 45;
  }

  const shadowAmount = adjustments.shadows / 100;
  if (shadowAmount !== 0 && lum < 0.5) {
    // Strongest in the deepest shadows, feathering smoothly to zero at
    // mid-grey. (The previous ramp peaked *at* mid-grey and then cut to zero
    // above it — a hard luminance cliff that produced blotchy contours.)
    const t = smoothstep(0.5, 0.0, lum);
    weight += t * shadowAmount * 45;
  }

  const whiteAmount = adjustments.whites / 100;
  if (whiteAmount !== 0 && lum > 0.7) {
    const t = smoothstep(0.7, 1.0, lum);
    weight += t * whiteAmount * 25;
  }

  const blackAmount = adjustments.blacks / 100;
  if (blackAmount !== 0 && lum < 0.3) {
    // Same feathered falloff: strongest at black, zero at the 0.3 boundary.
    const t = smoothstep(0.3, 0.0, lum);
    weight += t * blackAmount * 25;
  }

  return {
    r: clampByte(r + weight),
    g: clampByte(g + weight),
    b: clampByte(b + weight),
  };
};

const applyVignette = (
  source: PixelBuffer,
  amount: number,
): PixelBuffer => {
  const strength = amount / 100;
  if (strength <= 0) {
    return source;
  }

  const output = clonePixelBuffer(source);
  const { width, height, data } = output;
  const cx = width / 2;
  const cy = height / 2;
  const maxDist = Math.sqrt(cx * cx + cy * cy);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      if (data[index + 3] === 0) continue;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy) / maxDist;
      const factor = 1 - strength * Math.pow(dist, 1.8) * 0.85;

      data[index] = clampByte(data[index] * factor);
      data[index + 1] = clampByte(data[index + 1] * factor);
      data[index + 2] = clampByte(data[index + 2] * factor);
    }
  }

  return output;
};

const applyGrain = (source: PixelBuffer, amount: number): PixelBuffer => {
  const strength = amount / 100;
  if (strength <= 0) {
    return source;
  }

  const output = clonePixelBuffer(source);
  const { data } = output;

  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] === 0) continue;
    const noise = seededNoise(index * 0.37 + 17) * 60 * strength;
    data[index] = clampByte(data[index] + noise);
    data[index + 1] = clampByte(data[index + 1] + noise);
    data[index + 2] = clampByte(data[index + 2] + noise);
  }

  return output;
};

const applyClarity = (source: PixelBuffer, amount: number): PixelBuffer => {
  if (amount === 0) {
    return source;
  }

  const blurred = applyBoxBlur(source, 2);
  const strength = amount / 100;
  const output = new Uint8ClampedArray(source.data.length);

  for (let index = 0; index < output.length; index += 4) {
    if (source.data[index + 3] === 0) {
      output.set(source.data.subarray(index, index + 4), index);
      continue;
    }
    const lum = luminance(
      source.data[index],
      source.data[index + 1],
      source.data[index + 2],
    );
    const midtone = 1 - Math.abs(lum / 255 - 0.5) * 2;
    const factor = strength * midtone * 0.65;

    output[index] = clampByte(source.data[index] + (source.data[index] - blurred.data[index]) * factor);
    output[index + 1] = clampByte(
      source.data[index + 1] + (source.data[index + 1] - blurred.data[index + 1]) * factor,
    );
    output[index + 2] = clampByte(
      source.data[index + 2] + (source.data[index + 2] - blurred.data[index + 2]) * factor,
    );
    output[index + 3] = source.data[index + 3];
  }

  return adoptPixelBuffer({ width: source.width, height: source.height, data: output });
};

const applySharpen = (source: PixelBuffer, amount: number): PixelBuffer => {
  const { width, height, data } = source;
  const output = new Uint8ClampedArray(data);
  const strength = amount / 100;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = (y * width + x) * 4;
      if (data[index + 3] === 0) continue;
      let r = data[index] * (1 + 4 * strength);
      let g = data[index + 1] * (1 + 4 * strength);
      let b = data[index + 2] * (1 + 4 * strength);

      for (const [ox, oy] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ]) {
        const neighbor = ((y + oy) * width + (x + ox)) * 4;
        r -= data[neighbor] * strength;
        g -= data[neighbor + 1] * strength;
        b -= data[neighbor + 2] * strength;
      }

      output[index] = clampByte(r);
      output[index + 1] = clampByte(g);
      output[index + 2] = clampByte(b);
      output[index + 3] = data[index + 3];
    }
  }

  return adoptPixelBuffer({ width, height, data: output });
};

const hasAdjustments = (adjustments: Adjustments): boolean =>
  Object.values(adjustments).some((value) => value !== 0);

/**
 * Bakes all adjustment values into pixel data using a single-pass color pipeline,
 * then applies clarity, sharpen/blur, vignette, and grain.
 */
export const applyAdjustments = (
  source: PixelBuffer,
  adjustments: Adjustments,
): PixelBuffer => {
  assertPixelBuffer(source);
  if (!hasAdjustments(adjustments)) {
    return source;
  }

  const output = clonePixelBuffer(source);
  const { data } = output;

  const brightnessOffset = adjustments.brightness * 1.2;
  // Symmetric contrast formula scaled for the -100..+100 control range.
  const c = adjustments.contrast;
  const contrastFactor = (259 * (c + 255)) / (255 * (259 - c));
  const saturationFactor = (100 + adjustments.saturation) / 100;
  const hueShift = adjustments.hue;
  const temperature = adjustments.temperature / 100;
  const tint = adjustments.tint / 100;
  const sepiaAmount = adjustments.sepia / 100;

  // White balance as multiplicative channel gains — a color cast is a gain
  // error, so correcting it must be multiplicative too. (The previous flat
  // offsets overcorrected shadows, undercorrected highlights, and could never
  // fully neutralize a cast.) Exponential form keeps ± slider values
  // symmetric in "stops of cast" and lets auto-WB invert the model exactly:
  //   temp t   →  r × 1.35^t,  b × 1.35^(−t)          (green anchored)
  //   tint v   →  g × 1.25^v,  r,b × 1.25^(−v/2)      (≈luminance neutral)
  const wbGainR = Math.pow(1.35, temperature) * Math.pow(1.25, -tint / 2);
  const wbGainG = Math.pow(1.25, tint);
  const wbGainB = Math.pow(1.35, -temperature) * Math.pow(1.25, -tint / 2);

  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] === 0) continue;
    let r = applyExposure(data[index], adjustments.exposure);
    let g = applyExposure(data[index + 1], adjustments.exposure);
    let b = applyExposure(data[index + 2], adjustments.exposure);

    r *= wbGainR;
    g *= wbGainG;
    b *= wbGainB;

    r = (r - 128) * contrastFactor + 128 + brightnessOffset;
    g = (g - 128) * contrastFactor + 128 + brightnessOffset;
    b = (b - 128) * contrastFactor + 128 + brightnessOffset;

    ({ r, g, b } = applyToneCurve(r, g, b, adjustments));

    const preR = r;
    const preG = g;
    const preB = b;

    const hsl = rgbToHsl(r, g, b);
    hsl.h = (hsl.h + hueShift + 360) % 360;

    // Saturation (global) — clamp immediately: unclamped s > 1 pushes
    // hslToRgb out of gamut, and the per-channel byte clamp then shifts hue
    // on strongly saturated pixels.
    let s = clamp(hsl.s * saturationFactor, 0, 1);

    // Positive vibrance boosts muted colors more than saturated colors and
    // reduces the change around heuristically detected skin-tone hues.
    const vib = adjustments.vibrance / 100;
    if (vib !== 0) {
      const baseS = clamp(hsl.s, 0, 1);
      let vBoost: number;
      if (vib > 0) {
        // Boost muted colors more than already-saturated ones.
        vBoost = vib * 0.7 * Math.pow(1 - baseS, 1.5);
      } else {
        // Negative vibrance must act on *saturated* pixels — they're the
        // ones with saturation to remove. (Using the positive falloff here
        // made negative vibrance a near no-op on colorful photos.)
        vBoost = vib * 0.7 * Math.pow(baseS, 0.7);
      }
      // Reduce vibrance boost on very dark areas (prevents unnatural coloring on black faces/shadows)
      const lum = luminance(r, g, b) / 255;
      const lumFactor = Math.min(1, Math.max(0, (lum - 0.03) / 0.35));
      vBoost *= lumFactor;
      s = clamp(s + vBoost, 0, 1);
    }

    hsl.s = s;

    let rgb = hslToRgb(hsl.h, hsl.s, hsl.l);

    // Skin protection for positive vibrance: lerp final color toward pre-adjust
    // on skin tones. Uses a *feathered* weight — a binary cutoff creates
    // blotchy contours across faces at high vibrance.
    if (vib > 0) {
      const skinW = skinToneWeight(preR, preG, preB);
      if (skinW > 0) {
        // Full skin confidence keeps 55% of the effect; feathers smoothly to
        // 100% effect away from skin.
        const blend = 1 - 0.45 * skinW;
        rgb.r = clampByte(lerp(preR, rgb.r, blend));
        rgb.g = clampByte(lerp(preG, rgb.g, blend));
        rgb.b = clampByte(lerp(preB, rgb.b, blend));
      }
    }

    if (sepiaAmount > 0) {
      const sr = clampByte(rgb.r * 0.393 + rgb.g * 0.769 + rgb.b * 0.189);
      const sg = clampByte(rgb.r * 0.349 + rgb.g * 0.686 + rgb.b * 0.168);
      const sb = clampByte(rgb.r * 0.272 + rgb.g * 0.534 + rgb.b * 0.131);
      rgb = {
        r: clampByte(lerp(rgb.r, sr, sepiaAmount)),
        g: clampByte(lerp(rgb.g, sg, sepiaAmount)),
        b: clampByte(lerp(rgb.b, sb, sepiaAmount)),
      };
    }

    data[index] = rgb.r;
    data[index + 1] = rgb.g;
    data[index + 2] = rgb.b;
  }

  let result: PixelBuffer = output;

  if (adjustments.clarity !== 0) {
    result = applyClarity(result, adjustments.clarity);
  }

  if (adjustments.sharpen < 0) {
    const radius = Math.max(1, Math.round((Math.abs(adjustments.sharpen) / 100) * 10));
    const blurred = applyBoxBlur(result, radius);
    const amount = Math.abs(adjustments.sharpen) / 100;
    const blended = new Uint8ClampedArray(result.data.length);
    for (let index = 0; index < blended.length; index += 4) {
      blended[index] = Math.round(lerp(result.data[index], blurred.data[index], amount));
      blended[index + 1] = Math.round(lerp(result.data[index + 1], blurred.data[index + 1], amount));
      blended[index + 2] = Math.round(lerp(result.data[index + 2], blurred.data[index + 2], amount));
      blended[index + 3] = result.data[index + 3];
    }
    result = adoptPixelBuffer({ width: result.width, height: result.height, data: blended });
  } else if (adjustments.sharpen > 0) {
    result = applySharpen(result, adjustments.sharpen);
  }

  if (adjustments.vignette > 0) {
    result = applyVignette(result, adjustments.vignette);
  }

  if (adjustments.grain > 0) {
    result = applyGrain(result, adjustments.grain);
  }

  return result;
};
