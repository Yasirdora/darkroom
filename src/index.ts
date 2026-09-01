/**
 * DOM-free public API for the Darkroom processing engine.
 *
 * Browser decoding lives in `@darkroom/core/browser`; the optional
 * built-in catalog lives in `@darkroom/core/presets`.
 */

export type {
  Adjustments,
  ColorMatchStats,
  CropRect,
  CurvePoint,
  Curves,
  EffectId,
  EffectOptions,
  EffectSpec,
  Grade,
  GradeInput,
  GrainSpec,
  HistogramData,
  InputProfileId,
  Look,
  Lut3D,
  Lut3DInput,
  LutSize,
  PixelBuffer,
  PixelBufferInput,
  QualifierConfig,
  RenderOptions,
  Transform,
  VectorscopeData,
} from './types.js';

export { DarkroomError, asDarkroomError } from './errors.js';
export type { DarkroomErrorCode } from './errors.js';
export { DARKROOM_LIMITS } from './limits.js';

export {
  assertPixelBuffer,
  clonePixelBuffer,
  createPixelBuffer,
  resizePixelBuffer,
  resizeToFit,
} from './buffer.js';

export {
  ADJUSTMENT_RANGES,
  DEFAULT_ADJUSTMENTS,
  DEFAULT_QUALIFIER,
  DEFAULT_TRANSFORM,
  createDefaultGrade,
  normalizeGrade,
} from './grade.js';

export { render, renderForExport } from './render.js';
export { applyAdjustments } from './adjustments.js';
export {
  applyCurves,
  identityCurve,
  interpolateCurve,
  makeDefaultSCurve,
} from './curves.js';
export { applyEffect } from './effects.js';

export {
  applyLut,
  buildLut,
  createLut3D,
  isLutSize,
  resampleLut,
} from './lut.js';
export type { BuildLutOptions, ByteColorTransform } from './lut.js';
export { applyFilmGrain, applyLook } from './look.js';
export { formatCube, parseCube } from './cube.js';
export type { FormatCubeOptions, ParseCubeOptions } from './cube.js';

export {
  applyColorMatch,
  computeColorMatchStats,
} from './color-match.js';
export { computeHistogram } from './histogram.js';
export {
  SKIN_TONE_LINE,
  VECTORSCOPE_CHROMA_RANGE,
  VECTORSCOPE_SIZE,
  computeVectorscope,
  rgbToCbCrOffset,
} from './vectorscope.js';
export {
  analyzeImage,
  isSkinTone,
  skinToneWeight,
} from './image-analysis.js';
export type { ImageAnalysis, SceneProfile } from './image-analysis.js';
export {
  computeAutoEnhance,
  computeAutoWhiteBalance,
} from './auto-enhance.js';
export type { AutoEnhanceResult, AutoWhiteBalanceResult } from './auto-enhance.js';

export {
  QUALIFIER_ENABLE_HUE_DEFAULTS,
  applyWithMask,
  buildQualifierMask,
  isFullHueSelection,
  isIdentityQualifier,
  qualifierAffectsPipeline,
} from './qualifiers.js';

export {
  applyTransform,
  constrainCropToAspect,
  cropsNearlyEqual,
  fullCropRect,
  largestCropForAspect,
} from './transform.js';

export {
  INPUT_PROFILES,
  INPUT_PROFILE_GROUPS,
  applyInputProfile,
  coerceInputProfile,
  decodeToLinearValue,
  getInputProfileSpec,
  getProfileTypicalEI,
  getRecommendedInputExposure,
  getSceneLinearLuminance,
  inputProfiles,
  normalizeInput,
} from './profiles.js';
export type {
  ApplyInputProfileOptions,
  InputProfileGroupId,
  InputProfileSpec,
} from './profiles.js';
export {
  detectInputProfileDetailsFromHeader,
  detectInputProfileFromHeader,
  extractExifOrientation,
  extractJpegDimensions,
} from './profile-detect.js';
export type {
  ExifOrientation,
  InputProfileDetection,
  InputProfileDetectionSource,
} from './profile-detect.js';
