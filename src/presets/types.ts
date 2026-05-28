import type { LutSize } from '../types.js';

/** Stable identifiers for Darkroom's optional built-in creative looks. */
export type PresetId =
  | 'vintage'
  | '1977'
  | 'aden'
  | 'moon'
  | 'rise'
  | 'willow'
  | 'lofi'
  | 'vesper'
  | 'clarendon'
  | 'valencia'
  | 'nashville'
  | 'juno'
  | 'lark'
  | 'gingham'
  | 'reyes'
  | 'hudson'
  | 'sierra'
  | 'stinson'
  | 'crema'
  | 'ludwig'
  | 'amaro'
  | 'portra400'
  | 'portra160'
  | 'portra800'
  | 'gold200'
  | 'ektar100'
  | 'ultramax400'
  | 'vision3_250d'
  | 'exr200t_5293'
  | 'pro400h'
  | 'superia400'
  | 'velvia50'
  | 'provia100f'
  | 'eterna'
  | 'classic_chrome'
  | 'acros100'
  | 'tealOrange'
  | 'bleachBypass'
  | 'goldenHour'
  | 'moodyDesat'
  | 'noirTeal'
  | 'sunsetGlow'
  | 'forestMist'
  | 'copperTone'
  | 'trix400'
  | 'hp5Plus'
  | 'delta100'
  | 'noirHigh'
  | 'magicNatural'
  | 'magicGlow'
  | 'magicGolden'
  | 'magicCool'
  | 'magicMatte'
  | 'magicStudio'
  | 'magicSunset'
  | 'magicNight'
  | 'magicBwPortrait'
  | 'magicVintage'
  | 'magicBright'
  | 'magicMoody';

/** Neutral catalog groups. Product and company names are never category IDs. */
export type PresetCategory =
  | 'portrait'
  | 'film-color'
  | 'cinema'
  | 'social'
  | 'classic'
  | 'monochrome';

export type PresetTag =
  | 'film-inspired'
  | 'featured-cinema'
  | 'black-and-white'
  | 'skin-preserving'
  | 'grain';

/** Immutable descriptive data. Rendering parameters remain private. */
export interface PresetMetadata {
  readonly id: PresetId;
  readonly label: string;
  readonly category: PresetCategory;
  readonly description: string;
  readonly tags: readonly PresetTag[];
}

export interface CompilePresetOptions {
  /** 65 gives the closest match to Darkroom's original 64-cube renderer. */
  readonly lutSize?: LutSize;
}
