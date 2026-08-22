import type { FilterDefinition } from '../../core/types';
import { buildLut } from '../lut';
import { ALL_STOCK_PROFILES, profileToFilter } from './stock-profiles';

const NONE_FILTER: FilterDefinition = {
  id: 'none',
  label: 'None',
  category: 'classic',
  description: 'No filter applied',
  buildLut: () => buildLut((r, g, b) => [r, g, b]),
};

export const FILTER_PRESETS: FilterDefinition[] = [
  NONE_FILTER,
  ...ALL_STOCK_PROFILES.map(profileToFilter),
];

export const FILTER_CATEGORIES: Array<{ id: FilterDefinition['category']; label: string }> = [
  { id: 'portrait', label: 'Magic Portrait' },
  { id: 'kodak', label: 'Kodak Film' },
  { id: 'fuji', label: 'Fuji Film' },
  { id: 'cinema', label: 'Cinema & Colorist' },
  { id: 'instant', label: 'Instant Film' },
  { id: 'social', label: 'Social' },
  { id: 'classic', label: 'Classic' },
  { id: 'bw', label: 'Black & White' },
];