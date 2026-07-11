import type { EffectDefinition, EffectId, EffectOptions } from '../../core/types';
import { ImageBuffer } from '../../core/image-buffer';
import { lerp } from '../../core/math';
import { applyBoxBlur, applyGaussianBlur, applyBilateralBlur, applyBokehBlur } from './blur';
import { applyHalftone } from './halftone';
import { applyPainting } from './painting';
import { applyPixelate } from './pixelate';
import { applyPosterize } from './posterize';
import { applyVhs } from './vhs';
import { applyWater } from './water';

const blendEffect = (
  original: ImageData,
  effected: ImageData,
  intensity: number,
): ImageData => {
  const amount = intensity / 100;
  if (amount >= 1) {
    return effected;
  }
  if (amount <= 0) {
    return new ImageData(
      new Uint8ClampedArray(original.data),
      original.width,
      original.height,
    );
  }

  const output = new Uint8ClampedArray(original.data.length);
  for (let index = 0; index < output.length; index += 4) {
    output[index] = Math.round(lerp(original.data[index], effected.data[index], amount));
    output[index + 1] = Math.round(lerp(original.data[index + 1], effected.data[index + 1], amount));
    output[index + 2] = Math.round(lerp(original.data[index + 2], effected.data[index + 2], amount));
    output[index + 3] = original.data[index + 3];
  }

  return new ImageData(output, original.width, original.height);
};

const withBlend = (
  source: ImageData,
  intensity: number,
  render: (image: ImageData) => ImageData,
): ImageData => blendEffect(source, render(source), intensity);

export const EFFECT_DEFINITIONS: EffectDefinition[] = [
  {
    id: 'none',
    label: 'None',
    apply: (source) =>
      new ImageData(new Uint8ClampedArray(source.data), source.width, source.height),
  },
  {
    id: 'pixelate',
    label: 'Pixelate',
    apply: (source, intensity) =>
      withBlend(source, intensity, (image) =>
        applyPixelate(image, Math.max(2, Math.round(2 + (intensity / 100) * 22))),
      ),
  },
  {
    id: 'blur',
    label: 'Blur (Pro)',
    apply: (source, intensity, options) => {
      const r = Math.max(1, Math.round((intensity / 100) * 14));
      const mode = (options.blurMode as any) || 'gaussian';
      let fn: (d: ImageData, rad: number) => ImageData;
      if (mode === 'bilateral') fn = (d, rad) => applyBilateralBlur(d, rad, 20 + (intensity / 100) * 20);
      else if (mode === 'bokeh') fn = applyBokehBlur;
      else if (mode === 'box') fn = applyBoxBlur;
      else fn = applyGaussianBlur;
      return withBlend(source, intensity, (image) => fn(image, r));
    },
  },
  {
    id: 'posterize',
    label: 'Posterize',
    apply: (source, intensity) =>
      withBlend(source, intensity, (image) =>
        applyPosterize(image, Math.max(3, Math.round(10 - (intensity / 100) * 7))),
      ),
  },
  {
    id: 'water',
    label: 'Water',
    apply: (source, intensity) =>
      withBlend(source, intensity, (image) => applyWater(image, intensity)),
  },
  {
    id: 'halftone',
    label: 'Halftone',
    supportsDuotone: true,
    apply: (source, intensity, options) =>
      withBlend(source, intensity, (image) =>
        applyHalftone(image, intensity, options.color1, options.color2),
      ),
  },
  {
    id: 'vhs',
    label: 'VHS',
    apply: (source, intensity) =>
      withBlend(source, intensity, (image) => applyVhs(image, intensity)),
  },
  {
    id: 'painting',
    label: 'Painting',
    supportsDuotone: true,
    apply: (source, intensity, options) =>
      withBlend(source, intensity, (image) =>
        applyPainting(image, intensity, options.color1, options.color2),
      ),
  },
];

const effectMap = new Map<EffectId, EffectDefinition>(
  EFFECT_DEFINITIONS.map((effect) => [effect.id, effect]),
);

export const applyEffect = (
  source: ImageBuffer,
  effectId: EffectId,
  intensity: number,
  options: EffectOptions,
): ImageBuffer => {
  const effect = effectMap.get(effectId);
  if (!effect || effectId === 'none' || intensity <= 0) {
    return source.clone();
  }

  const result = effect.apply(source.toImageData(), intensity, options);
  return ImageBuffer.fromImageData(result);
};