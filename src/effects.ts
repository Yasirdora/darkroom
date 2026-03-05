import { applyBilateralBlur, applyBokehBlur, applyBoxBlur, applyGaussianBlur } from './blur.js';
import { adoptPixelBuffer, assertPixelBuffer } from './buffer.js';
import { isSupportedCssColor, parseCssColor } from './color.js';
import { DarkroomError } from './errors.js';
import { clamp, clampByte, lerp, seededNoise } from './math.js';
import type { EffectId, EffectOptions, EffectSpec, PixelBuffer } from './types.js';

const EFFECT_IDS = new Set<EffectId>([
  'pixelate', 'blur', 'posterize', 'water', 'halftone', 'vhs', 'painting',
]);

const NUMERIC_OPTION_RANGES = Object.freeze({
  blurRadius: [0, 256],
  blurThreshold: [0, 255],
  pixelSize: [1, 512],
  posterizeLevels: [2, 256],
  halftoneAngle: [-360, 360],
  halftoneFrequency: [1, 512],
  paintingStrength: [0, 100],
  waterWavelength: [1, 512],
  waterCaustics: [0, 100],
} as const);

const BOOLEAN_OPTION_KEYS = new Set<keyof EffectOptions>([
  'pixelateDither', 'posterizeDither',
]);

const ENUM_OPTION_VALUES = Object.freeze({
  blurMode: new Set(['box', 'gaussian', 'bilateral', 'bokeh']),
  halftoneShape: new Set(['circle', 'line', 'ellipse']),
  vhsProfile: new Set(['consumer', 'pro', 'degraded']),
} as const);

const COLOR_OPTION_KEYS = new Set<keyof EffectOptions>(['color1', 'color2']);
const EFFECT_OPTION_KEYS = new Set<string>([
  ...Object.keys(NUMERIC_OPTION_RANGES),
  ...BOOLEAN_OPTION_KEYS,
  ...Object.keys(ENUM_OPTION_VALUES),
  ...COLOR_OPTION_KEYS,
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const invalidEffect = (message: string): never => {
  throw new DarkroomError('INVALID_GRADE', message);
};

const validateEffectOptions = (value: unknown): EffectOptions => {
  if (!isRecord(value)) {
    return invalidEffect('Effect options must be an object.');
  }

  for (const [key, option] of Object.entries(value)) {
    if (!EFFECT_OPTION_KEYS.has(key)) {
      return invalidEffect(`Unknown effect option: ${key}.`);
    }
    if (key in NUMERIC_OPTION_RANGES) {
      const [minimum, maximum] = NUMERIC_OPTION_RANGES[
        key as keyof typeof NUMERIC_OPTION_RANGES
      ];
      // Public blur processing intentionally normalizes non-finite and very
      // large numeric inputs to bounded work. Preserve that established
      // behavior while still rejecting non-number option shapes.
      if (key === 'blurRadius' || key === 'blurThreshold') {
        if (typeof option !== 'number') {
          return invalidEffect(`Effect option ${key} must be a number.`);
        }
        continue;
      }
      if (
        typeof option !== 'number'
        || !Number.isFinite(option)
        || option < minimum
        || option > maximum
      ) {
        return invalidEffect(`Effect option ${key} must be finite and between ${minimum} and ${maximum}.`);
      }
      continue;
    }
    if (BOOLEAN_OPTION_KEYS.has(key as keyof EffectOptions)) {
      if (typeof option !== 'boolean') {
        return invalidEffect(`Effect option ${key} must be a boolean.`);
      }
      continue;
    }
    if (key in ENUM_OPTION_VALUES) {
      const supported = ENUM_OPTION_VALUES[key as keyof typeof ENUM_OPTION_VALUES];
      if (typeof option !== 'string' || !supported.has(option as never)) {
        return invalidEffect(`Effect option ${key} has an unsupported value.`);
      }
      continue;
    }
    if (COLOR_OPTION_KEYS.has(key as keyof EffectOptions)) {
      if (
        typeof option !== 'string'
        || option.length > 64
        || !isSupportedCssColor(option)
      ) {
        return invalidEffect(`Effect option ${key} must use supported hex or rgb(a) color syntax.`);
      }
    }
  }

  return value as EffectOptions;
};

const validateEffect = (value: unknown): EffectSpec => {
  if (!isRecord(value)) {
    return invalidEffect('Effect specification must be an object.');
  }
  if (typeof value.id !== 'string' || !EFFECT_IDS.has(value.id as EffectId)) {
    return invalidEffect(`Unknown effect: ${String(value.id)}.`);
  }
  if (typeof value.intensity !== 'number' || !Number.isFinite(value.intensity)) {
    return invalidEffect('Effect intensity must be a finite number.');
  }
  return {
    id: value.id as EffectId,
    intensity: value.intensity,
    options: validateEffectOptions(value.options),
  };
};

const BAYER_4X4 = Object.freeze([
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
] as const);

const ditherOffset = (x: number, y: number, step: number): number =>
  ((BAYER_4X4[(y & 3) * 4 + (x & 3)] + 0.5) / 16 - 0.5) * step;

const pixelate = (
  source: PixelBuffer,
  blockSize: number,
  dither: boolean,
): PixelBuffer => {
  const size = Math.max(2, Math.min(512, Math.round(blockSize)));
  const output = new Uint8ClampedArray(source.data);
  for (let startY = 0; startY < source.height; startY += size) {
    for (let startX = 0; startX < source.width; startX += size) {
      let alphaWeight = 0;
      let red = 0;
      let green = 0;
      let blue = 0;
      for (let y = startY; y < Math.min(source.height, startY + size); y += 1) {
        for (let x = startX; x < Math.min(source.width, startX + size); x += 1) {
          const offset = (y * source.width + x) * 4;
          const alpha = source.data[offset + 3] / 255;
          alphaWeight += alpha;
          red += source.data[offset] * alpha;
          green += source.data[offset + 1] * alpha;
          blue += source.data[offset + 2] * alpha;
        }
      }
      if (alphaWeight <= 0) continue;
      const average = [red / alphaWeight, green / alphaWeight, blue / alphaWeight] as const;
      for (let y = startY; y < Math.min(source.height, startY + size); y += 1) {
        for (let x = startX; x < Math.min(source.width, startX + size); x += 1) {
          const offset = (y * source.width + x) * 4;
          if (source.data[offset + 3] === 0) continue;
          const noise = dither ? ditherOffset(x, y, 12) : 0;
          output[offset] = clampByte(average[0] + noise);
          output[offset + 1] = clampByte(average[1] + noise);
          output[offset + 2] = clampByte(average[2] + noise);
        }
      }
    }
  }
  return adoptPixelBuffer({ width: source.width, height: source.height, data: output });
};

const posterize = (source: PixelBuffer, levels: number, dither: boolean): PixelBuffer => {
  // Preserve the editor's established quantizer: `levels` is the divisor,
  // yielding `levels + 1` possible endpoints including 0 and 255.
  const count = Math.max(2, Math.min(256, Math.round(levels)));
  const step = 255 / count;
  const output = new Uint8ClampedArray(source.data);
  for (let index = 0; index < output.length; index += 4) {
    if (source.data[index + 3] === 0) continue;
    const pixel = index / 4;
    const noise = dither
      ? ditherOffset(pixel % source.width, Math.floor(pixel / source.width), step)
      : 0;
    output[index] = clampByte(Math.round((source.data[index] + noise) / step) * step);
    output[index + 1] = clampByte(Math.round((source.data[index + 1] + noise) / step) * step);
    output[index + 2] = clampByte(Math.round((source.data[index + 2] + noise) / step) * step);
  }
  return adoptPixelBuffer({ width: source.width, height: source.height, data: output });
};

const water = (
  source: PixelBuffer,
  intensity: number,
  options: EffectOptions,
): PixelBuffer => {
  const amount = intensity / 100;
  const frequency = options.waterWavelength === undefined
    ? 0.04
    : Math.PI * 2 / clamp(options.waterWavelength, 1, 512);
  const amplitudeScale = options.waterCaustics === undefined
    ? 1
    : clamp(options.waterCaustics, 0, 100) / 50;
  const amplitude = 12 * amount * amplitudeScale;
  const output = new Uint8ClampedArray(source.data);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const destination = (y * source.width + x) * 4;
      if (source.data[destination + 3] === 0) continue;
      const offsetX = Math.sin(y * frequency) * amplitude;
      const offsetY = Math.cos(x * frequency) * amplitude * 0.5;
      const sampleX = Math.max(0, Math.min(source.width - 1, Math.round(x + offsetX)));
      const sampleY = Math.max(0, Math.min(source.height - 1, Math.round(y + offsetY)));
      const sample = (sampleY * source.width + sampleX) * 4;
      if (source.data[sample + 3] === 0) continue;
      output[destination] = source.data[sample];
      output[destination + 1] = source.data[sample + 1];
      output[destination + 2] = source.data[sample + 2];
    }
  }
  return adoptPixelBuffer({ width: source.width, height: source.height, data: output });
};

const legacyHalftone = (
  source: PixelBuffer,
  intensity: number,
  options: EffectOptions,
): PixelBuffer => {
  const amount = intensity / 100;
  const foreground = parseCssColor(options.color1 ?? '#111111');
  const background = parseCssColor(options.color2 ?? '#f4f4f4');
  const spacing = Math.max(4, Math.round(10 - amount * 6));
  const output = new Uint8ClampedArray(source.data);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const index = (y * source.width + x) * 4;
      if (source.data[index + 3] === 0) continue;
      const luminance = 0.299 * source.data[index]
        + 0.587 * source.data[index + 1]
        + 0.114 * source.data[index + 2];
      const distance = Math.hypot(x % spacing - spacing / 2, y % spacing - spacing / 2);
      const radius = (1 - luminance / 255) * spacing * 0.45 * amount;
      const color = distance <= radius ? foreground : background;
      output[index] = color.r;
      output[index + 1] = color.g;
      output[index + 2] = color.b;
    }
  }
  return adoptPixelBuffer({ width: source.width, height: source.height, data: output });
};

const customHalftone = (
  source: PixelBuffer,
  intensity: number,
  options: EffectOptions,
): PixelBuffer => {
  const amount = intensity / 100;
  const spacing = clamp(options.halftoneFrequency ?? Math.round(10 - amount * 6), 1, 512);
  const angle = clamp(options.halftoneAngle ?? 0, -360, 360) * Math.PI / 180;
  const shape = options.halftoneShape ?? 'circle';
  const foreground = parseCssColor(options.color1 ?? '#111111');
  const background = parseCssColor(options.color2 ?? '#f4f4f4');
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const output = new Uint8ClampedArray(source.data);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const index = (y * source.width + x) * 4;
      if (source.data[index + 3] === 0) continue;
      const rotatedX = x * cosine - y * sine;
      const rotatedY = x * sine + y * cosine;
      const localX = ((rotatedX % spacing) + spacing) % spacing - spacing / 2;
      const localY = ((rotatedY % spacing) + spacing) % spacing - spacing / 2;
      const luminance = 0.299 * source.data[index]
        + 0.587 * source.data[index + 1]
        + 0.114 * source.data[index + 2];
      const radius = (1 - luminance / 255) * spacing * 0.45 * amount;
      const distance = shape === 'line'
        ? Math.abs(localY)
        : shape === 'ellipse'
          ? Math.hypot(localX * 0.55, localY)
          : Math.hypot(localX, localY);
      const color = distance <= radius ? foreground : background;
      output[index] = color.r;
      output[index + 1] = color.g;
      output[index + 2] = color.b;
    }
  }
  return adoptPixelBuffer({ width: source.width, height: source.height, data: output });
};

const halftone = (source: PixelBuffer, intensity: number, options: EffectOptions): PixelBuffer =>
  options.halftoneAngle === undefined
    && options.halftoneFrequency === undefined
    && options.halftoneShape === undefined
    ? legacyHalftone(source, intensity, options)
    : customHalftone(source, intensity, options);

const vhs = (
  source: PixelBuffer,
  intensity: number,
  options: EffectOptions,
): PixelBuffer => {
  const profile = options.vhsProfile ?? 'consumer';
  const profileAmount = profile === 'pro' ? 0.55 : profile === 'degraded' ? 1.55 : 1;
  const amount = intensity / 100 * profileAmount;
  const shift = Math.round(4 * amount);
  const output = new Uint8ClampedArray(source.data);
  for (let y = 0; y < source.height; y += 1) {
    const scanline = y % 3 === 0 ? 0.9 : 1;
    const wave = Math.sin(y * 0.08) * 3 * amount;
    for (let x = 0; x < source.width; x += 1) {
      const index = (y * source.width + x) * 4;
      if (source.data[index + 3] === 0) continue;
      const redX = Math.min(source.width - 1, Math.max(0, x - shift));
      const blueX = Math.min(source.width - 1, Math.max(0, x + shift));
      const redIndex = (y * source.width + redX) * 4;
      const blueIndex = (y * source.width + blueX) * 4;
      const noise = seededNoise(index * 0.19 + y * 0.07 + 31) * 30 * amount;
      output[index] = clampByte(source.data[redIndex] * scanline + noise + wave);
      output[index + 1] = clampByte(source.data[index + 1] * scanline + noise);
      output[index + 2] = clampByte(source.data[blueIndex + 2] * scanline + noise - wave);
    }
  }
  return adoptPixelBuffer({ width: source.width, height: source.height, data: output });
};

const painting = (
  source: PixelBuffer,
  intensity: number,
  options: EffectOptions,
): PixelBuffer => {
  const amount = clamp(options.paintingStrength ?? intensity, 0, 100) / 100;
  const primary = parseCssColor(options.color1 ?? '#f6d7b0');
  const secondary = parseCssColor(options.color2 ?? '#4a5d7a');
  const output = new Uint8ClampedArray(source.data);
  const mix = (base: number, tint: number, mixAmount: number): number =>
    clampByte(base * (1 - mixAmount) + tint * mixAmount);
  for (let y = 1; y < source.height - 1; y += 1) {
    for (let x = 1; x < source.width - 1; x += 1) {
      const index = (y * source.width + x) * 4;
      if (source.data[index + 3] === 0) continue;
      const left = (y * source.width + x - 1) * 4;
      const right = (y * source.width + x + 1) * 4;
      const up = ((y - 1) * source.width + x) * 4;
      const down = ((y + 1) * source.width + x) * 4;
      const edge = Math.abs(source.data[right] - source.data[left])
        + Math.abs(source.data[down] - source.data[up])
        + Math.abs(source.data[right + 1] - source.data[left + 1])
        + Math.abs(source.data[down + 1] - source.data[up + 1])
        + Math.abs(source.data[right + 2] - source.data[left + 2])
        + Math.abs(source.data[down + 2] - source.data[up + 2]);
      const paintAmount = Math.min(1, amount * 0.75);
      const edgeAmount = Math.min(1, edge / 900 * amount);
      let red = mix(source.data[index],
        (source.data[left] + source.data[right] + source.data[up] + source.data[down]) / 4,
        paintAmount);
      let green = mix(source.data[index + 1],
        (source.data[left + 1] + source.data[right + 1] + source.data[up + 1] + source.data[down + 1]) / 4,
        paintAmount);
      let blue = mix(source.data[index + 2],
        (source.data[left + 2] + source.data[right + 2] + source.data[up + 2] + source.data[down + 2]) / 4,
        paintAmount);
      red = mix(red, primary.r, edgeAmount * 0.35);
      green = mix(green, primary.g, edgeAmount * 0.35);
      blue = mix(blue, primary.b, edgeAmount * 0.35);
      const luminance = 0.299 * red + 0.587 * green + 0.114 * blue;
      const shadowMix = Math.max(0, 1 - luminance / 255) * amount * 0.2;
      output[index] = mix(red, secondary.r, shadowMix);
      output[index + 1] = mix(green, secondary.g, shadowMix);
      output[index + 2] = mix(blue, secondary.b, shadowMix);
    }
  }
  return adoptPixelBuffer({ width: source.width, height: source.height, data: output });
};

const renderEffect = (source: PixelBuffer, effect: EffectSpec): PixelBuffer => {
  const { options, intensity } = effect;
  const amount = intensity / 100;
  switch (effect.id) {
    case 'pixelate':
      return pixelate(source, options.pixelSize ?? 2 + amount * 22, options.pixelateDither === true);
    case 'posterize':
      return posterize(source, options.posterizeLevels ?? 10 - amount * 7, options.posterizeDither === true);
    case 'water': return water(source, intensity, options);
    case 'halftone': return halftone(source, intensity, options);
    case 'vhs': return vhs(source, intensity, options);
    case 'painting': return painting(source, intensity, options);
    case 'blur': {
      const radius = options.blurRadius ?? Math.max(1, Math.round(amount * 14));
      switch (options.blurMode ?? 'gaussian') {
        case 'box': return applyBoxBlur(source, radius);
        case 'bilateral':
          return applyBilateralBlur(source, radius, options.blurThreshold ?? 20 + amount * 20);
        case 'bokeh': return applyBokehBlur(source, radius);
        default: return applyGaussianBlur(source, radius);
      }
    }
  }
};

export const applyEffect = (source: PixelBuffer, effect: EffectSpec): PixelBuffer => {
  assertPixelBuffer(source);
  const validated = validateEffect(effect);
  const amount = clamp(validated.intensity / 100, 0, 1);
  if (amount === 0) return source;
  const effected = renderEffect(source, { ...validated, intensity: amount * 100 });
  const output = new Uint8ClampedArray(source.data);
  for (let index = 0; index < output.length; index += 4) {
    if (source.data[index + 3] === 0) continue;
    output[index] = clampByte(lerp(source.data[index], effected.data[index], amount));
    output[index + 1] = clampByte(lerp(source.data[index + 1], effected.data[index + 1], amount));
    output[index + 2] = clampByte(lerp(source.data[index + 2], effected.data[index + 2], amount));
    output[index + 3] = source.data[index + 3];
  }
  return adoptPixelBuffer({ width: source.width, height: source.height, data: output });
};
