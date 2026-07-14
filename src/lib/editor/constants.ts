import type {
  Adjustments,
  EditState,
  InputProfileId,
  SliderVariant,
  Transform,
} from '../core/types';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 40_000_000;
export const PREVIEW_MAX_DIMENSION = 1200;  // Lower for smooth performance on moderate hardware
export const LIVE_PREVIEW_MAX_DIMENSION = 1200; // Match full preview to prevent canvas shrinking during scrub

export const DEFAULT_ADJUSTMENTS: Adjustments = {
  exposure: 0,
  brightness: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  saturation: 0,
  vibrance: 0,
  hue: 0,
  temperature: 0,
  tint: 0,
  clarity: 0,
  vignette: 0,
  grain: 0,
  sepia: 0,
  sharpen: 0,
};

export const DEFAULT_TRANSFORM: Transform = {
  rotation: 0,
  flipH: false,
  flipV: false,
  crop: null,
  aspectRatio: 'free',
};

export const DEFAULT_INPUT_PROFILE: InputProfileId = 'standard';

export const DEFAULT_INPUT_EXPOSURE = 0;
export const DEFAULT_INPUT_LINEAR_MODE = false;

export const DEFAULT_CURVES: import('../core/types').Curves = {};

export const DEFAULT_QUALIFIER: import('../core/types').QualifierConfig = {
  enabled: false,
  hueMin: 0,
  hueMax: 360,
  satMin: 0,
  satMax: 1,
  lumMin: 0,
  lumMax: 1,
  hueSoft: 8,
  satSoft: 0.1,
  lumSoft: 0.1,
  spatialType: 'none',
  spatialX: 0.5,
  spatialY: 0.5,
  spatialWidth: 1,
  spatialHeight: 1,
  spatialRotation: 0,
  spatialFeather: 0.1,
  invert: false,
};

export const DEFAULT_ADVANCED_EFFECT: import('../core/types').AdvancedEffectParams = {};

export const DEFAULT_COLOR_MATCH: import('../core/types').ColorMatchState = {
  stats: null,
  strength: 80,
  refName: null,
  refThumb: null,
};

export const DEFAULT_EDIT_STATE: EditState = {
  adjustments: { ...DEFAULT_ADJUSTMENTS },
  transform: { ...DEFAULT_TRANSFORM },
  inputProfile: DEFAULT_INPUT_PROFILE,
  inputExposure: DEFAULT_INPUT_EXPOSURE,
  inputLinearMode: DEFAULT_INPUT_LINEAR_MODE,
  filterId: 'none',
  filterIntensity: 100,
  effectId: 'none',
  effectIntensity: 100,
  effectOptions: {},
  curves: { ...DEFAULT_CURVES },
  qualifier: { ...DEFAULT_QUALIFIER },
  advancedEffect: { ...DEFAULT_ADVANCED_EFFECT },
  colorMatch: { ...DEFAULT_COLOR_MATCH },
  importedLut: null,
};

export const DEFAULT_EXPORT_SETTINGS = {
  kind: 'image' as const,
  format: 'png' as const,
  quality: 92,
  scale: 1,
};

export const ASPECT_RATIOS: Array<{ id: Transform['aspectRatio']; label: string; ratio: number | null }> = [
  { id: 'free', label: 'Free', ratio: null },
  { id: '1:1', label: '1∶1', ratio: 1 },
  { id: '4:3', label: '4∶3', ratio: 4 / 3 },
  { id: '3:2', label: '3∶2', ratio: 3 / 2 },
  { id: '16:9', label: '16∶9', ratio: 16 / 9 },
  { id: '9:16', label: '9∶16', ratio: 9 / 16 },
];

export const ADJUSTMENT_GROUPS: Array<{
  title: string;
  keys: Array<keyof Adjustments>;
}> = [
  { title: 'Light', keys: ['exposure', 'brightness', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'] },
  { title: 'Color', keys: ['saturation', 'vibrance', 'hue', 'temperature', 'tint'] },
  { title: 'Detail', keys: ['clarity', 'sharpen', 'vignette', 'grain', 'sepia'] },
];

export const ADJUSTMENT_CONTROLS: Array<{
  key: keyof Adjustments;
  label: string;
  variant: SliderVariant;
}> = [
  { key: 'exposure', label: 'Exposure', variant: 'default' },
  { key: 'brightness', label: 'Brightness', variant: 'default' },
  { key: 'contrast', label: 'Contrast', variant: 'default' },
  { key: 'highlights', label: 'Highlights', variant: 'default' },
  { key: 'shadows', label: 'Shadows', variant: 'default' },
  { key: 'whites', label: 'Whites', variant: 'default' },
  { key: 'blacks', label: 'Blacks', variant: 'default' },
  { key: 'saturation', label: 'Saturation', variant: 'default' },
  { key: 'vibrance', label: 'Vibrance', variant: 'default' },
  { key: 'hue', label: 'Hue', variant: 'hue' },
  { key: 'temperature', label: 'Temperature', variant: 'temperature' },
  { key: 'tint', label: 'Tint', variant: 'tint' },
  { key: 'clarity', label: 'Clarity', variant: 'default' },
  { key: 'sharpen', label: 'Sharpen / Blur', variant: 'sharpen' },
  { key: 'vignette', label: 'Vignette', variant: 'default' },
  { key: 'grain', label: 'Grain', variant: 'default' },
  { key: 'sepia', label: 'Sepia', variant: 'sepia' },
];

export const ADJUSTMENT_RANGES: Record<
  keyof Adjustments,
  { min: number; max: number; step: number }
> = {
  exposure: { min: -100, max: 100, step: 1 },
  brightness: { min: -100, max: 100, step: 1 },
  contrast: { min: -100, max: 100, step: 1 },
  highlights: { min: -100, max: 100, step: 1 },
  shadows: { min: -100, max: 100, step: 1 },
  whites: { min: -100, max: 100, step: 1 },
  blacks: { min: -100, max: 100, step: 1 },
  saturation: { min: -100, max: 100, step: 1 },
  vibrance: { min: -50, max: 50, step: 1 },
  hue: { min: -180, max: 180, step: 1 },
  temperature: { min: -100, max: 100, step: 1 },
  tint: { min: -100, max: 100, step: 1 },
  clarity: { min: -100, max: 100, step: 1 },
  vignette: { min: 0, max: 100, step: 1 },
  grain: { min: 0, max: 100, step: 1 },
  sepia: { min: 0, max: 100, step: 1 },
  sharpen: { min: -100, max: 100, step: 1 },
};