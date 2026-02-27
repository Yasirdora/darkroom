import { assertPixelBuffer, clonePixelBuffer } from './buffer.js';
import { DarkroomError } from './errors.js';
import { clampByte } from './math.js';
import type { InputProfileId, PixelBuffer } from './types.js';
import {
  arriLogC3ToLinear,
  awg3LinearToSrgbLinear,
  bmdFilmGen4ToLinear,
  bmdFilmGen5ToLinear,
  bmdWideGamutToSrgbLinear,
  cinemaGamutToSrgbLinear,
  cLog3ToLinear,
  davinciIntermediateToLinear,
  dwgToSrgbLinear,
  flatToLinear,
  p3LinearToSrgbLinear,
  redLog3G10ToLinear,
  redWideGamutToSrgbLinear,
  rec709ToLinear,
  sceneLinearToDisplay,
  sGamut3CineToSrgbLinear,
  sLog3ToLinear,
  srgbToLinear,
  toneMapStandardToDisplay,
  vGamutToSrgbLinear,
  vLogToLinear,
} from './color-science.js';

export interface InputProfileSpec {
  readonly id: InputProfileId;
  readonly label: string;
  readonly group: InputProfileGroupId;
  readonly description: string;
  /** Display order — lower appears first in UI. */
  readonly priority: number;
}

export type InputProfileGroupId = 'standard' | 'wide' | 'log' | 'flat';

const PROFILE_GROUPS: Array<{ id: InputProfileGroupId; label: string }> = [
  { id: 'standard', label: 'Standard' },
  { id: 'wide', label: 'Wide Gamut' },
  { id: 'log', label: 'Cinema Log' },
  { id: 'flat', label: 'Flat Still' },
];

export const INPUT_PROFILE_GROUPS: readonly Readonly<{ id: InputProfileGroupId; label: string }>[] =
  Object.freeze(PROFILE_GROUPS.map((group) => Object.freeze(group)));

const PROFILE_CATALOG: InputProfileSpec[] = [
  {
    id: 'standard',
    label: 'sRGB',
    group: 'standard',
    priority: 1,
    description: 'Photos, social JPEG/PNG — IEC 61966-2-1 display encoding',
  },
  {
    id: 'rec709',
    label: 'Rec.709',
    group: 'standard',
    priority: 2,
    description: 'Video stills and broadcast exports — inverse Rec.709 camera transfer approximation',
  },
  {
    id: 'display-p3',
    label: 'Display P3',
    group: 'wide',
    priority: 3,
    description: 'iPhone/Mac wide-gamut — P3 primaries, D65 white point',
  },
  {
    id: 'arri-logc3',
    label: 'ARRI LogC3',
    group: 'log',
    priority: 10,
    description: 'Alexa / AMIRA — reference LogC3 (EI 800) decoding with an AWG3-to-sRGB matrix approximation.',
  },
  {
    id: 'red-log3g10',
    label: 'RED Log3G10',
    group: 'log',
    priority: 11,
    description: 'RED Komodo / V-Raptor — reference Log3G10 decoding with a REDWideGamutRGB matrix approximation.',
  },
  {
    id: 's-log3',
    label: 'Sony S-Log3',
    group: 'log',
    priority: 12,
    description: 'Sony FX / Venice — reference S-Log3 decoding with an S-Gamut3.Cine matrix approximation.',
  },
  {
    id: 'bmd-film-gen4',
    label: 'Blackmagic Film Gen 4',
    group: 'log',
    priority: 13,
    description: 'Pocket 4K/6K, BMPCC 4K — Wide Gamut Gen 4 (pre-2021 bodies)',
  },
  {
    id: 'bmd-film-gen5',
    label: 'Blackmagic Film Gen 5',
    group: 'log',
    priority: 14,
    description: 'URSA 12K, Pocket 6K G2, PYXIS — BMD Gen 5 Color Science',
  },
  {
    id: 'davinci-intermediate',
    label: 'DaVinci Intermediate',
    group: 'log',
    priority: 15,
    description: 'Resolve DWG/Intermediate — color-managed workflow stills',
  },
  {
    id: 'c-log3',
    label: 'Canon C-Log3',
    group: 'log',
    priority: 16,
    description: 'Cinema EOS / R5 C / C70 — Cinema Gamut',
  },
  {
    id: 'v-log',
    label: 'Panasonic V-Log',
    group: 'log',
    priority: 17,
    description: 'Lumix S series / Varicam — V-Gamut',
  },
  {
    id: 'flat',
    label: 'Flat / Picture Profile',
    group: 'flat',
    priority: 20,
    description: 'Camera flat/cine picture profiles or neutral Lightroom exports — extra grading latitude',
  },
];

/** Curated set ordered for display. */
export const INPUT_PROFILES: readonly InputProfileSpec[] = Object.freeze(
  [...PROFILE_CATALOG]
    .sort((a, b) => a.priority - b.priority)
    .map((profile) => Object.freeze(profile)),
);

export const inputProfiles = INPUT_PROFILES;

type LogProfileId = Extract<
  InputProfileId,
  | 'arri-logc3'
  | 'red-log3g10'
  | 's-log3'
  | 'bmd-film-gen4'
  | 'bmd-film-gen5'
  | 'davinci-intermediate'
  | 'c-log3'
  | 'v-log'
>;

/**
 * Per-profile rendering parameters for going from scene-linear (after gamut conversion)
 * to a display-referred image.
 *
 * These values apply a fixed exposure offset and highlight shoulder. Creative
 * "looks" should come from the adjustments and film-emulation stages, not here.
 */
interface LogRenderParams {
  /** Base exposure offset (stops) for the reference EI of this profile */
  recommendedExposure: number;
  shoulder: number;
  /** Human readable typical EI for documentation */
  typicalEI: string;
}

const LOG_RENDER_PARAMS: Record<LogProfileId, LogRenderParams> = {
  'arri-logc3':          { recommendedExposure: 0.0, shoulder: 0.12, typicalEI: 'EI 800' },
  'red-log3g10':         { recommendedExposure: 0.0, shoulder: 0.115, typicalEI: 'EI 800' },
  's-log3':              { recommendedExposure: 0.0, shoulder: 0.11, typicalEI: 'EI 800' },
  'bmd-film-gen4':       { recommendedExposure: 0.0, shoulder: 0.13, typicalEI: 'ISO 800 / 3200' },
  'bmd-film-gen5':       { recommendedExposure: 0.0, shoulder: 0.12, typicalEI: 'ISO 800 / 3200' },
  'davinci-intermediate':{ recommendedExposure: 0.0, shoulder: 0.105, typicalEI: 'N/A (Resolve)' },
  'c-log3':              { recommendedExposure: 0.0, shoulder: 0.12, typicalEI: 'EI 800' },
  'v-log':               { recommendedExposure: 0.0, shoulder: 0.115, typicalEI: 'ISO 800' },
};

const isLogProfile = (profile: InputProfileId): profile is LogProfileId =>
  profile in LOG_RENDER_PARAMS;

const isKnownProfile = (profile: unknown): profile is InputProfileId =>
  typeof profile === 'string' && INPUT_PROFILES.some((candidate) => candidate.id === profile);

const assertKnownProfile: (profile: unknown) => asserts profile is InputProfileId = (profile) => {
  if (!isKnownProfile(profile)) {
    throw new DarkroomError('INVALID_PROFILE', `Unknown input profile: ${String(profile)}.`);
  }
};

const assertEncodedChannel: (value: unknown) => asserts value is number = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 255) {
    throw new DarkroomError('INVALID_PROFILE', 'Encoded channel value must be finite and between 0 and 255.');
  }
};

export function getRecommendedInputExposure(profile: InputProfileId): number {
  if (isLogProfile(profile)) {
    return LOG_RENDER_PARAMS[profile].recommendedExposure;
  }
  return 0;
}

export function getProfileTypicalEI(profile: InputProfileId): string | null {
  if (isLogProfile(profile)) {
    return LOG_RENDER_PARAMS[profile].typicalEI;
  }
  return null;
}

export function getLogRenderParams(profile: InputProfileId) {
  if (isLogProfile(profile)) {
    return LOG_RENDER_PARAMS[profile];
  }
  return null;
}

export function getSceneLinearLuminance(r: number, g: number, b: number, profile: InputProfileId): number {
  assertEncodedChannel(r);
  assertEncodedChannel(g);
  assertEncodedChannel(b);
  assertKnownProfile(profile);
  const lr = decodeToLinear(r, profile);
  const lg = decodeToLinear(g, profile);
  const lb = decodeToLinear(b, profile);
  if (profile === 'standard' || profile === 'rec709' || profile === 'display-p3') {
    return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
  }
  // Wide-gamut / log profiles: neutral average avoids wrong Rec.709 weighting on AWG3, SGamut3, etc.
  return (lr + lg + lb) / 3;
}

/** Decode a finite 0–255 encoded channel value into scene-linear light. */
export function decodeToLinearValue(value: number, profile: InputProfileId): number {
  assertEncodedChannel(value);
  assertKnownProfile(profile);
  return decodeToLinear(value, profile);
}

/** Decode 8-bit encoded value → scene linear reflectance */
const decodeToLinear = (value: number, profile: InputProfileId): number => {
  const normalized = value / 255;

  switch (profile) {
    case 'standard':      return srgbToLinear(normalized);
    case 'rec709':        return rec709ToLinear(normalized);
    case 'display-p3':    return srgbToLinear(normalized);
    case 'arri-logc3':    return arriLogC3ToLinear(normalized);
    case 'red-log3g10':   return redLog3G10ToLinear(normalized);
    case 's-log3':        return sLog3ToLinear(normalized);
    case 'bmd-film-gen4': return bmdFilmGen4ToLinear(normalized);
    case 'bmd-film-gen5': return bmdFilmGen5ToLinear(normalized);
    case 'davinci-intermediate': return davinciIntermediateToLinear(normalized);
    case 'c-log3':        return cLog3ToLinear(normalized);
    case 'v-log':         return vLogToLinear(normalized);
    case 'flat':          return flatToLinear(normalized);
    default:              return srgbToLinear(normalized);
  }
};

/** Convert scene linear (in source gamut) → sRGB linear */
const gamutToSrgbLinear = (r: number, g: number, b: number, profile: InputProfileId): [number, number, number] => {
  switch (profile) {
    case 'display-p3':
      return p3LinearToSrgbLinear(r, g, b);
    case 'arri-logc3':
      return awg3LinearToSrgbLinear(r, g, b);
    case 'red-log3g10':
      return redWideGamutToSrgbLinear(r, g, b);
    case 's-log3':
      return sGamut3CineToSrgbLinear(r, g, b);
    case 'bmd-film-gen4':
    case 'bmd-film-gen5':
      return bmdWideGamutToSrgbLinear(r, g, b);
    case 'davinci-intermediate':
      return dwgToSrgbLinear(r, g, b);
    case 'c-log3':
      return cinemaGamutToSrgbLinear(r, g, b);
    case 'v-log':
      return vGamutToSrgbLinear(r, g, b);
    default:
      return [r, g, b]; // already in sRGB or no conversion needed
  }
};

/** Final scene-linear (sRGB primaries) → display encoded sRGB */
const linearSrgbToDisplay = (linear: number, profile: InputProfileId): number => {
  if (isLogProfile(profile)) {
    const p = LOG_RENDER_PARAMS[profile];
    return sceneLinearToDisplay(linear, p.recommendedExposure, p.shoulder);
  }
  if (profile === 'flat') {
    return sceneLinearToDisplay(linear, 0.2, 0.09);
  }
  return toneMapStandardToDisplay(linear);
};

const transformPixel = (
  r: number,
  g: number,
  b: number,
  profile: InputProfileId,
  exposureStops = 0,
  linearMode = false,
): [number, number, number] => {
  // 1. Decode bytes to relative scene-linear light with the selected reference formula.
  let lr = decodeToLinear(r, profile);
  let lg = decodeToLinear(g, profile);
  let lb = decodeToLinear(b, profile);

  // Apply exposure compensation in relative scene-linear light.
  if (exposureStops !== 0) {
    const gain = Math.pow(2, exposureStops);
    lr *= gain;
    lg *= gain;
    lb *= gain;
  }

  // 2. Approximate source-camera gamut conversion with published/reference matrices.
  [lr, lg, lb] = gamutToSrgbLinear(lr, lg, lb, profile);

  // 3. Apply this 8-bit engine's neutral display rendering transform.
  // linearMode removes the profile-specific shoulder; output remains display encoded.
  const tr = linearMode
    ? toneMapStandardToDisplay(lr)   // pure linear → display encode, no extra shoulder
    : linearSrgbToDisplay(lr, profile);
  const tg = linearMode
    ? toneMapStandardToDisplay(lg)
    : linearSrgbToDisplay(lg, profile);
  const tb = linearMode
    ? toneMapStandardToDisplay(lb)
    : linearSrgbToDisplay(lb, profile);

  return [
    clampByte(Math.round(tr * 255)),
    clampByte(Math.round(tg * 255)),
    clampByte(Math.round(tb * 255)),
  ];
};

/**
 * Normalizes any supported input into a consistent, grading-ready sRGB image.
 *
 * Reference path:
 *   encoded → relative scene linear (profile reference formula)
 *           → approximate source gamut → sRGB-linear matrix
 *           → neutral 8-bit display transform
 *
 * This is a practical creative normalization path, not a substitute for a
 * fully color-managed CST/ACES pipeline, RAW development, or HDR processing.
 */
export interface ApplyInputProfileOptions {
  /** Additional relative-linear exposure compensation, bounded to -3…+3 stops. */
  readonly exposureStops?: number;
  /** Remove the profile-specific shoulder; output remains display-encoded sRGB. */
  readonly linearMode?: boolean;
}

export const applyInputProfile = (
  source: PixelBuffer,
  profile: InputProfileId,
  options: ApplyInputProfileOptions = {},
): PixelBuffer => {
  assertPixelBuffer(source);
  assertKnownProfile(profile);
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new DarkroomError('INVALID_PROFILE', 'Input-profile options must be an object.');
  }
  const exposure = options.exposureStops ?? 0;
  if (typeof exposure !== 'number' || !Number.isFinite(exposure) || exposure < -3 || exposure > 3) {
    throw new DarkroomError('INVALID_PROFILE', 'Input-profile exposureStops must be finite and between -3 and 3.');
  }
  if (options.linearMode !== undefined && typeof options.linearMode !== 'boolean') {
    throw new DarkroomError('INVALID_PROFILE', 'Input-profile linearMode must be a boolean.');
  }
  const linearMode = options.linearMode ?? false;

  if (profile === 'standard' && exposure === 0 && !linearMode) {
    return source;
  }

  const output = clonePixelBuffer(source);
  const { data } = output;

  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] === 0) continue;
    const [tr, tg, tb] = transformPixel(
      data[index],
      data[index + 1],
      data[index + 2],
      profile,
      exposure,
      linearMode
    );
    data[index] = tr;
    data[index + 1] = tg;
    data[index + 2] = tb;
  }

  return output;
};

export const normalizeInput = applyInputProfile;

export const getInputProfileSpec = (id: InputProfileId): InputProfileSpec =>
  INPUT_PROFILES.find((item) => item.id === id) ?? INPUT_PROFILES[0];

/** Maps legacy persisted ids to current canonical ids. */
export const coerceInputProfile = (id: string): InputProfileId => {
  if (id === 'log-c') return 'arri-logc3';
  const known = INPUT_PROFILES.find((item) => item.id === id);
  return known?.id ?? 'standard';
};
