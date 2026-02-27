export interface PixelBuffer {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

export interface PixelBufferInput {
  readonly width: number;
  readonly height: number;
  readonly data: ArrayLike<number>;
}

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

export interface Adjustments {
  readonly exposure: number;
  readonly brightness: number;
  readonly contrast: number;
  readonly highlights: number;
  readonly shadows: number;
  readonly whites: number;
  readonly blacks: number;
  readonly saturation: number;
  readonly vibrance: number;
  readonly hue: number;
  readonly temperature: number;
  readonly tint: number;
  readonly clarity: number;
  readonly vignette: number;
  readonly grain: number;
  readonly sepia: number;
  readonly sharpen: number;
}

export interface CurvePoint {
  readonly x: number;
  readonly y: number;
  readonly handleOutX?: number;
  readonly handleOutY?: number;
  readonly handleInX?: number;
  readonly handleInY?: number;
}

export interface Curves {
  readonly master?: readonly CurvePoint[];
  readonly r?: readonly CurvePoint[];
  readonly g?: readonly CurvePoint[];
  readonly b?: readonly CurvePoint[];
}

export interface QualifierConfig {
  readonly enabled: boolean;
  readonly hueMin: number;
  readonly hueMax: number;
  readonly satMin: number;
  readonly satMax: number;
  readonly lumMin: number;
  readonly lumMax: number;
  readonly hueSoft: number;
  readonly satSoft: number;
  readonly lumSoft: number;
  readonly spatialType: 'none' | 'linear' | 'ellipse' | 'radial';
  readonly spatialX: number;
  readonly spatialY: number;
  readonly spatialWidth: number;
  readonly spatialHeight: number;
  readonly spatialRotation: number;
  readonly spatialFeather: number;
  readonly invert: boolean;
}

export interface ColorMatchStats {
  readonly mean: readonly [number, number, number];
  readonly std: readonly [number, number, number];
  readonly sampleWeight: number;
}

export type LutSize = 17 | 33 | 65;

export interface Lut3D {
  readonly size: LutSize;
  readonly data: Float32Array;
  readonly domainMin: readonly [number, number, number];
  readonly domainMax: readonly [number, number, number];
  readonly title?: string;
}

export interface Lut3DInput {
  readonly size: number;
  readonly data: ArrayLike<number>;
  readonly domainMin?: readonly [number, number, number];
  readonly domainMax?: readonly [number, number, number];
  readonly title?: string;
}

export interface GrainSpec {
  readonly amount: number;
  readonly warmth: number;
  readonly size: number;
}

export interface Look {
  readonly lut: Lut3D;
  readonly grain?: GrainSpec;
}

export type EffectId =
  | 'pixelate'
  | 'blur'
  | 'posterize'
  | 'water'
  | 'halftone'
  | 'vhs'
  | 'painting';

/** Closed, finite effect options. Unknown keys are intentionally not supported. */
export interface EffectOptions {
  readonly blurMode?: 'box' | 'gaussian' | 'bilateral' | 'bokeh';
  readonly blurRadius?: number;
  readonly blurThreshold?: number;
  readonly pixelSize?: number;
  readonly pixelateDither?: boolean;
  readonly posterizeLevels?: number;
  readonly posterizeDither?: boolean;
  readonly halftoneAngle?: number;
  readonly halftoneFrequency?: number;
  readonly halftoneShape?: 'circle' | 'line' | 'ellipse';
  readonly paintingStrength?: number;
  readonly vhsProfile?: 'consumer' | 'pro' | 'degraded';
  readonly waterWavelength?: number;
  readonly waterCaustics?: number;
  readonly color1?: string;
  readonly color2?: string;
}

export interface EffectSpec {
  readonly id: EffectId;
  readonly intensity: number;
  readonly options: EffectOptions;
}

export interface CropRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Transform {
  readonly rotation: 0 | 90 | 180 | 270;
  readonly flipH: boolean;
  readonly flipV: boolean;
  readonly crop: CropRect | null;
}

export interface Grade {
  readonly adjustments: Adjustments;
  readonly curves: Curves;
  readonly qualifier: QualifierConfig;
  readonly colorMatch: {
    readonly stats: ColorMatchStats;
    readonly intensity: number;
  } | null;
  readonly look: Look | null;
  readonly lookIntensity: number;
  readonly effect: EffectSpec | null;
  readonly transform: Transform;
}

/** Untrusted or partial grade input accepted by normalizeGrade/render. */
export type GradeInput = Readonly<Partial<{
  adjustments: Readonly<Partial<Adjustments>>;
  curves: Curves;
  qualifier: Readonly<Partial<QualifierConfig>>;
  colorMatch: Grade['colorMatch'];
  look: Look | null;
  lookIntensity: number;
  effect: Readonly<{
    id: EffectId;
    intensity?: number;
    options?: EffectOptions;
  }> | null;
  transform: Readonly<Partial<Transform>>;
}>>;

export interface RenderOptions {
  /** Skip crop for interactive preview; renderForExport always includes it. */
  readonly includeCrop?: boolean;
}

export interface HistogramData {
  readonly r: Uint32Array;
  readonly g: Uint32Array;
  readonly b: Uint32Array;
  readonly luminance: Uint32Array;
  readonly peak: number;
}

export interface VectorscopeData {
  readonly bins: Uint32Array;
  readonly size: number;
  readonly peak: number;
}
