import type { FilterId } from '../../core/types';
import { ImageBuffer } from '../../core/image-buffer';
import { applyLut } from '../lut';
import { applyFilmGrain } from './film-grain';
import { FILTER_CATEGORIES, FILTER_PRESETS } from './presets';

const lutCache = new Map<FilterId, Uint8Array>();

const getFilterLut = (filterId: FilterId): Uint8Array | null => {
  if (filterId === 'none') {
    return null;
  }

  const cached = lutCache.get(filterId);
  if (cached) {
    return cached;
  }

  const preset = FILTER_PRESETS.find((item) => item.id === filterId);
  if (!preset) {
    return null;
  }

  const lut = preset.buildLut();
  lutCache.set(filterId, lut);
  return lut;
};

export const applyFilter = (
  source: ImageBuffer,
  filterId: FilterId,
  intensity: number,
): ImageBuffer => {
  const lut = getFilterLut(filterId);
  if (!lut) {
    return source.clone();
  }

  const preset = FILTER_PRESETS.find((item) => item.id === filterId);
  let output = applyLut(source, lut, intensity);

  if (preset?.grain) {
    output = applyFilmGrain(output, preset.grain, intensity);
  }

  return output;
};

export { FILTER_CATEGORIES, FILTER_PRESETS };