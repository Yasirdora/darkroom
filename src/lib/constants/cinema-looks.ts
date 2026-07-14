import type { FilterId } from '../core/types';

export interface CinemaLookEntry {
  id: FilterId;
  name: string;
  tagline: string;
}

/** Curated cinema looks — mirrors coloristic.org/film/ handoff presets. */
export const CINEMA_LOOKS: CinemaLookEntry[] = [
  {
    id: 'tealOrange',
    name: 'Teal & Orange',
    tagline: 'Blockbuster DI — cool shadows, warm skin',
  },
  {
    id: 'bleachBypass',
    name: 'Bleach Bypass',
    tagline: 'Silver retention — low saturation, high contrast',
  },
  {
    id: 'goldenHour',
    name: 'Golden Hour',
    tagline: 'Amber highlight wash, warm fill',
  },
  {
    id: 'moodyDesat',
    name: 'Moody Desat',
    tagline: 'Crushed shadows, restrained saturation',
  },
  {
    id: 'noirTeal',
    name: 'Noir Teal',
    tagline: 'Near-monochrome with teal shadow bias',
  },
  {
    id: 'sunsetGlow',
    name: 'Sunset Glow',
    tagline: 'Magenta highlights over warm fill',
  },
  {
    id: 'forestMist',
    name: 'Forest Mist',
    tagline: 'Cool greens, airy lifted mids',
  },
  {
    id: 'copperTone',
    name: 'Copper Tone',
    tagline: 'Copper highlights, brown shadows',
  },
];

export const CINEMA_LOOK_IDS = new Set<FilterId>(CINEMA_LOOKS.map((look) => look.id));