/**
 * Optional built-in creative looks for Coloristic Darkroom.
 *
 * Product and company names remain the property of their respective owners.
 * These presets are independently authored creative approximations and do not
 * imply affiliation, certification, or endorsement.
 *
 * @packageDocumentation
 */

import { DarkroomError } from '../errors.js';
import { isLutSize } from '../lut.js';
import type { Look, LutSize } from '../types.js';
import {
  PRESET_METADATA,
  compilePresetSource,
  getPresetSource,
} from './catalog.js';
import type {
  CompilePresetOptions,
  PresetId,
  PresetMetadata,
} from './types.js';

export type {
  CompilePresetOptions,
  PresetCategory,
  PresetId,
  PresetMetadata,
  PresetTag,
} from './types.js';

/**
 * Immutable built-in preset metadata in the canonical display order.
 * Rendering parameters and LUT builders are intentionally private.
 */
export const presets: readonly PresetMetadata[] = PRESET_METADATA;

const metadataById = new Map<PresetId, PresetMetadata>(
  presets.map((preset) => [preset.id, preset]),
);

/** Return whether an unknown value is a supported built-in preset ID. */
export const isPresetId = (value: unknown): value is PresetId =>
  typeof value === 'string' && getPresetSource(value) !== undefined;

/** Look up immutable descriptive metadata without compiling a LUT. */
export const getPreset = (id: string): PresetMetadata | undefined =>
  metadataById.get(id as PresetId);

const invalidPreset = (message: string): never => {
  throw new DarkroomError('INVALID_GRADE', message);
};

const validateCompileOptions = (value: unknown): LutSize => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalidPreset('Preset compilation options must be an object.');
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'lutSize') {
      return invalidPreset(`Unknown preset compilation option: ${key}.`);
    }
  }
  const size = record.lutSize ?? 65;
  if (!isLutSize(size)) {
    return invalidPreset('Preset lutSize must be 17, 33, or 65.');
  }
  return size;
};

/**
 * Compile one built-in preset into a generic, structured-clone-safe Look.
 * Compilation is lazy: importing this module or reading metadata builds no LUT.
 * Every call returns fresh LUT data; applications may cache the result by ID
 * and LUT size when repeatedly rendering the same preset.
 */
export const compilePreset = (
  id: PresetId,
  options: CompilePresetOptions = {},
): Look => {
  if (!isPresetId(id)) {
    return invalidPreset(`Unknown Darkroom preset: ${String(id)}`);
  }
  return compilePresetSource(id, validateCompileOptions(options));
};
