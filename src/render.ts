import { applyAdjustments } from './adjustments.js';
import { assertPixelBuffer } from './buffer.js';
import { applyColorMatch } from './color-match.js';
import { applyCurves } from './curves.js';
import { applyEffect } from './effects.js';
import { normalizeGrade } from './grade.js';
import { applyLook } from './look.js';
import { applyWithMask, buildQualifierMask, qualifierAffectsPipeline } from './qualifiers.js';
import { applyTransform } from './transform.js';
import type { GradeInput, PixelBuffer, RenderOptions } from './types.js';

const hasCurves = (curves: ReturnType<typeof normalizeGrade>['curves']): boolean =>
  Object.values(curves).some((points) => points !== undefined && points.length >= 2);

const renderNormalized = (
  source: PixelBuffer,
  gradeInput: GradeInput | unknown,
  includeCrop: boolean,
): PixelBuffer => {
  // Rendering never mutates the caller's pixels. Validate structurally without
  // copying so a no-op render can preserve object identity (and avoid a 48 MiB
  // allocation for a 12 MP image). Call clonePixelBuffer when isolation rather
  // than immutable processing is the desired boundary.
  assertPixelBuffer(source);
  const validatedSource = source;
  const grade = normalizeGrade(gradeInput);
  let current = applyTransform(validatedSource, grade.transform, includeCrop);
  current = applyAdjustments(current, grade.adjustments);
  if (hasCurves(grade.curves)) current = applyCurves(current, grade.curves);
  if (grade.colorMatch) {
    current = applyColorMatch(current, grade.colorMatch.stats, grade.colorMatch.intensity);
  }

  const selectiveBase = current;
  const hasSelectiveStage = (grade.look !== null && grade.lookIntensity > 0)
    || (grade.effect !== null && grade.effect.intensity > 0);
  const mask = qualifierAffectsPipeline(grade.qualifier, hasSelectiveStage)
    ? buildQualifierMask(current, grade.qualifier)
    : null;

  if (grade.look && grade.lookIntensity > 0) {
    current = applyLook(current, grade.look, grade.lookIntensity);
  }
  if (grade.effect && grade.effect.intensity > 0) {
    current = applyEffect(current, grade.effect);
  }
  return mask ? applyWithMask(selectiveBase, current, mask) : current;
};

/** Deterministic CPU preview render. Crop remains an application overlay by default. */
export const render = (
  source: PixelBuffer,
  grade: GradeInput | unknown = {},
  options: RenderOptions = {},
): PixelBuffer => renderNormalized(source, grade, options.includeCrop === true);

/** Deterministic CPU export render with the normalized crop baked into the result. */
export const renderForExport = (
  source: PixelBuffer,
  grade: GradeInput | unknown = {},
): PixelBuffer => renderNormalized(source, grade, true);
