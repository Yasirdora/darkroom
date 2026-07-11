/** Shared domain types for the photo editor. */

export interface Adjustments {
  exposure: number;
  brightness: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  saturation: number;
  vibrance: number;
  hue: number;
  temperature: number;
  tint: number;
  clarity: number;
  vignette: number;
  grain: number;
  sepia: number;
  sharpen: number;
}

export type SliderVariant =
  | 'default'
  | 'hue'
  | 'temperature'
  | 'tint'
  | 'sepia'
  | 'sharpen';

export type FilterCategory = 'classic' | 'social' | 'portrait' | 'kodak' | 'fuji' | 'cinema' | 'bw';

/** How uploaded pixel values are interpreted before grading. */
export type InputProfileId =
  | 'standard'
  | 'rec709'
  | 'display-p3'
  | 'arri-logc3'
  | 'red-log3g10'
  | 's-log3'
  | 'bmd-film-gen4'
  | 'bmd-film-gen5'
  | 'davinci-intermediate'
  | 'c-log3'
  | 'v-log'
  | 'flat';

export type FilterId =
  | 'none'
  // Classic
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
  // Social
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
  // Kodak
  | 'portra400'
  | 'portra160'
  | 'portra800'
  | 'gold200'
  | 'ektar100'
  | 'ultramax400'
  | 'vision3_250d'
  | 'exr200t_5293'
  // Fuji
  | 'pro400h'
  | 'superia400'
  | 'velvia50'
  | 'provia100f'
  | 'eterna'
  | 'classic_chrome'
  | 'acros100'
  // Cinema
  | 'tealOrange'
  | 'bleachBypass'
  | 'goldenHour'
  | 'moodyDesat'
  | 'noirTeal'
  | 'sunsetGlow'
  | 'forestMist'
  | 'copperTone'
  // B&W
  | 'trix400'
  | 'hp5Plus'
  | 'delta100'
  | 'noirHigh'
  // Magic Portrait
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

export type EffectId =
  | 'none'
  | 'pixelate'
  | 'blur'
  | 'posterize'
  | 'water'
  | 'halftone'
  | 'vhs'
  | 'painting';

export type AspectRatioId = 'free' | '1:1' | '4:3' | '3:2' | '16:9' | '9:16';

/** Normalized crop rectangle (0–1 relative to image bounds). */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Transform {
  rotation: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
  crop: CropRect | null;
  aspectRatio: AspectRatioId;
}

export interface EffectOptions {
  color1?: string;
  color2?: string;
  // Advanced per-effect params for pro tools (intensity still separate)
  [key: string]: string | number | boolean | undefined;
}

/** Point for interactive curves (normalized 0-1). Master + per-channel.
 * Supports Bézier handles for smooth curves. Handles are absolute coords in [0,1].
 */
export interface CurvePoint {
  x: number;
  y: number;
  /** Optional outgoing Bézier control point (for cubic segments) */
  handleOutX?: number;
  handleOutY?: number;
  /** Optional incoming Bézier control point */
  handleInX?: number;
  handleInY?: number;
}

export interface Curves {
  master?: CurvePoint[];
  r?: CurvePoint[];
  g?: CurvePoint[];
  b?: CurvePoint[];
}

/** Config for general qualifiers / power windows (builds on portrait masks). */
export interface QualifierConfig {
  enabled: boolean;
  // HSL range keyer (0-360 hue, 0-1 sat/lum)
  hueMin?: number;
  hueMax?: number;
  satMin?: number;
  satMax?: number;
  lumMin?: number;
  lumMax?: number;
  hueSoft?: number; // feather 0-30 deg
  satSoft?: number;
  lumSoft?: number;
  // Spatial power window (like Resolve)
  spatialType?: 'none' | 'linear' | 'ellipse' | 'radial';
  spatialX?: number; // 0-1 center or grad start
  spatialY?: number;
  spatialWidth?: number;
  spatialHeight?: number;
  spatialRotation?: number; // deg
  spatialFeather?: number; // px relative
  invert?: boolean;
}

/** Per-effect advanced settings (pro controls beyond duotone + intensity). */
export interface AdvancedEffectParams {
  blurMode?: 'box' | 'gaussian' | 'bilateral' | 'bokeh';
  blurThreshold?: number;
  halftoneAngle?: number;
  halftoneFrequency?: number;
  halftoneShape?: 'circle' | 'line' | 'ellipse';
  paintingStrength?: number; // directional etc
  pixelateDither?: boolean;
  posterizeDither?: boolean;
  vhsProfile?: 'consumer' | 'pro' | 'degraded';
  waterWavelength?: number;
  waterCaustics?: number;
}

/** Per-axis lαβ statistics of a reference image (structured-clone safe). */
export interface ColorMatchStats {
  mean: [number, number, number];
  std: [number, number, number];
}

/** Reference-image color match state. */
export interface ColorMatchState {
  /** Statistics of the loaded reference image, or null when inactive. */
  stats: ColorMatchStats | null;
  /** 0–100 blend between original and fully matched. */
  strength: number;
  /** Reference file name for the UI. */
  refName: string | null;
  /** Small data-URL thumbnail of the reference for the UI. */
  refThumb: string | null;
}

export interface EditState {
  adjustments: Adjustments;
  transform: Transform;
  inputProfile: InputProfileId;
  inputExposure: number; // stops compensation for log profiles (professional EI matching)
  inputLinearMode: boolean; // true = bypass display tone map, work in scene-linear (advanced pro)
  filterId: FilterId;
  filterIntensity: number;
  effectId: EffectId;
  effectIntensity: number;
  effectOptions: EffectOptions;
  curves: Curves;
  qualifier: QualifierConfig;
  advancedEffect: AdvancedEffectParams;
  colorMatch: ColorMatchState;
}

export type ExportFormat = 'png' | 'jpeg' | 'webp';

export interface ExportSettings {
  format: ExportFormat;
  quality: number;
  scale: number;
}

export interface HistogramData {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  luminance: Uint32Array;
  peak: number;
}

export interface FilterDefinition {
  id: FilterId;
  label: string;
  category: FilterCategory;
  description: string;
  grain?: { amount: number; warmth: number; size: number };
  /** Builds a 64³ RGB LUT (values 0–255). */
  buildLut: () => Uint8Array;
}

export interface EffectDefinition {
  id: EffectId;
  label: string;
  supportsDuotone?: boolean;
  apply: (
    source: ImageData,
    intensity: number,
    options: EffectOptions,
  ) => ImageData;
}

export type TabId = 'adjust' | 'filters';

export type CompareMode = 'off' | 'hold' | 'split';