import { ImageBuffer } from '../core/image-buffer';
import type { Adjustments, EditState } from '../core/types';
import { DEFAULT_ADJUSTMENTS } from '../editor/constants';
import { applyAdjustments } from '../processing/adjustments';
import { applyCurves } from '../processing/curves';
import { FILTER_PRESETS } from '../processing/filters/presets';
import { applyLut, buildLut } from '../processing/lut';

export interface GradeLutResult {
  lut: Uint8Array;
  warnings: string[];
}

const SPATIAL_ADJUSTMENT_KEYS: Array<keyof Adjustments> = [
  'clarity',
  'sharpen',
  'vignette',
  'grain',
];

const adjustmentsForLut = (adjustments: Adjustments): Adjustments => {
  const next = { ...adjustments };
  for (const key of SPATIAL_ADJUSTMENT_KEYS) {
    next[key] = 0;
  }
  return next;
};

export const getGradeLutWarnings = (state: EditState): string[] => {
  const warnings: string[] = [];
  const adj = state.adjustments;

  if (SPATIAL_ADJUSTMENT_KEYS.some((key) => adj[key] !== 0)) {
    warnings.push('Clarity, sharpen/blur, vignette, and grain are spatial — not baked into the LUT.');
  }
  if (state.colorMatch?.stats && state.colorMatch.strength > 0) {
    warnings.push('Reference color match is image-specific — not baked into the LUT.');
  }
  if (state.effectId !== 'none') {
    warnings.push('Creative effects are spatial — not baked into the LUT.');
  }
  if (state.qualifier?.enabled && (state.filterId !== 'none' || state.importedLut)) {
    warnings.push('Selective qualifiers are spatial — not baked into the LUT.');
  }
  if (state.importedLut) {
    warnings.push(`Imported LUT "${state.importedLut.title}" is baked into this export.`);
  } else if (state.filterId !== 'none') {
    const preset = FILTER_PRESETS.find((item) => item.id === state.filterId);
    if (preset?.grain) {
      warnings.push('Film grain on the active look is spatial — LUT exports color only.');
    }
  }

  return warnings;
};

const transformRgb = (
  r: number,
  g: number,
  b: number,
  state: EditState,
  filterLut: Uint8Array | null,
): [number, number, number] => {
  const pixel = new Uint8ClampedArray([r, g, b, 255]);
  let buffer = new ImageBuffer(1, 1, pixel);

  buffer = applyAdjustments(buffer, adjustmentsForLut(state.adjustments));

  const curved = applyCurves(buffer.toImageData(), state.curves);
  buffer = ImageBuffer.fromImageData(curved);

  if (filterLut) {
    buffer = applyLut(buffer, filterLut, state.filterIntensity);
  }

  return [buffer.data[0], buffer.data[1], buffer.data[2]];
};

const hasNonDefaultAdjustments = (adjustments: Adjustments): boolean =>
  Object.entries(adjustments).some(
    ([key, value]) => value !== DEFAULT_ADJUSTMENTS[key as keyof Adjustments],
  );

const hasCurves = (state: EditState): boolean => {
  const curves = state.curves;
  return Boolean(
    curves?.master?.length ||
      curves?.r?.length ||
      curves?.g?.length ||
      curves?.b?.length,
  );
};

/** True when the current grade has anything a LUT can represent. */
export const canExportGradeLut = (state: EditState): boolean =>
  hasNonDefaultAdjustments(state.adjustments) ||
  hasCurves(state) ||
  state.filterId !== 'none' ||
  state.importedLut !== null;

/** Builds a 64³ RGB LUT from color-only grade controls (adjustments, curves, film look). */
export const buildGradeLut = (state: EditState): GradeLutResult => {
  const warnings = getGradeLutWarnings(state);
  const filterLut = state.importedLut
    ? state.importedLut.data
    : state.filterId === 'none'
      ? null
      : FILTER_PRESETS.find((item) => item.id === state.filterId)?.buildLut() ?? null;

  const lut = buildLut((r, g, b) => transformRgb(r, g, b, state, filterLut));

  return { lut, warnings };
};