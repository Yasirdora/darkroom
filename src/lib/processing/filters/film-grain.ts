import { clampByte, seededNoise } from '../../core/math';
import { ImageBuffer } from '../../core/image-buffer';
import type { FilmGrainSpec } from './film-model';

export const applyFilmGrain = (
  source: ImageBuffer,
  spec: FilmGrainSpec,
  intensity: number,
): ImageBuffer => {
  const amount = (spec.amount / 100) * (intensity / 100);
  if (amount <= 0.001) return source.clone();

  const output = source.clone();
  const { data, width } = output;
  const scale = 0.6 + spec.size * 1.4;
  const warm = spec.warmth;

  for (let index = 0; index < data.length; index += 4) {
    const px = (index / 4) % width;
    const py = Math.floor(index / 4 / width);
    const seed = px * 0.91 * scale + py * 1.37 * scale + index * 0.17;
    const noise = seededNoise(seed) * 42 * amount;

    const warmNoise = noise * warm;
    const coolNoise = noise * (1 - warm);

    data[index] = clampByte(data[index] + warmNoise);
    data[index + 1] = clampByte(data[index + 1] + noise * 0.35);
    data[index + 2] = clampByte(data[index + 2] + coolNoise * 0.5);
  }

  return output;
};