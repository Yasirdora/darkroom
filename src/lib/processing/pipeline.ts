import { ImageBuffer } from '../core/image-buffer';
import type { EditState } from '../core/types';
import { applyAdjustments } from './adjustments';
import { applyEffect } from './effects';
import { applyFilter } from './filters';
import { applyLut } from './lut';
import { applyTransform, applyTransformForExport } from './transform';
import { applyCurves } from './curves';
import { applyColorMatch } from './color-match';
import { buildQualifierMask, applyWithMask, isFullHueSelection } from './qualifiers';

const runEffects = (
  source: ImageBuffer,
  state: EditState,
): ImageBuffer => {
  let current = source;
  current = applyAdjustments(current, state.adjustments);

  // Curves (pro tone control) — applied post basic adjustments
  const curvedData = applyCurves(current.toImageData(), state.curves);
  current = ImageBuffer.fromImageData(curvedData);

  // Reference-image color match — after tone work, before film/effects so a
  // film stock can still sit on top of the matched base.
  if (state.colorMatch?.stats && state.colorMatch.strength > 0) {
    current = applyColorMatch(current, state.colorMatch.stats, state.colorMatch.strength);
  }

  // Qualifier mask (selective): modulates filter/effect strength only.
  // The blend base must be the post-adjustments/post-curves image — blending
  // against the raw source would wipe the user's grade outside the mask.
  const maskBase = current;
  const hasLook = state.filterId !== 'none' || state.importedLut !== null;
  const selectiveFilter =
    state.qualifier?.enabled && hasLook && !isFullHueSelection(state.qualifier);

  let qualMask: Float32Array | null = null;
  if (selectiveFilter) {
    qualMask = buildQualifierMask(current, state.qualifier);
  }

  if (state.importedLut) {
    current = applyLut(current, state.importedLut.data, state.filterIntensity);
  } else {
    current = applyFilter(current, state.filterId, state.filterIntensity);
  }

  let effected = applyEffect(
    current,
    state.effectId,
    state.effectIntensity,
    state.effectOptions,
  );

  if (qualMask) {
    effected = applyWithMask(maskBase, effected, qualMask, 1.0);
  }

  return effected;
};

/**
 * Live preview pipeline — rotation/flip only; crop stays as overlay until Apply.
 */
export const renderPipeline = (
  source: ImageBuffer,
  state: EditState,
): ImageBuffer => {
  const transformed = applyTransform(source, state.transform);
  return runEffects(transformed, state);
};

/**
 * Export pipeline — includes pending crop rectangle in the output.
 */
export const renderExportPipeline = (
  source: ImageBuffer,
  state: EditState,
): ImageBuffer => {
  const transformed = applyTransformForExport(source, state.transform);
  return runEffects(transformed, state);
};