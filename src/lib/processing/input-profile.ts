import type { InputProfileId } from '../core/types';
import { clampByte } from '../core/math';
import { ImageBuffer } from '../core/image-buffer';
import {
  arriLogC3ToLinear,
  awg3LinearToSrgbLinear,
  bmdFilmGen4ToLinear,
  bmdFilmGen5ToLinear,
  bmdWideGamutToSrgbLinear,
  bt1886ToLinear,
  cinemaGamutToSrgbLinear,
  cLog3ToLinear,
  davinciIntermediateToLinear,
  dwgToSrgbLinear,
  flatToLinear,
  p3LinearToSrgbLinear,
  redLog3G10ToLinear,
  redWideGamutToSrgbLinear,
  sceneLinearToDisplay,
  sGamut3CineToSrgbLinear,
  sLog3ToLinear,
  srgbToLinear,
  toneMapStandardToDisplay,
  vGamutToSrgbLinear,
  vLogToLinear,
} from './color-science';

export interface InputProfileSpec {
  id: InputProfileId;
  label: string;
  group: InputProfileGroupId;
  description: string;
  /** Industry priority — lower appears first in UI. */
  priority: number;
}

export type InputProfileGroupId = 'standard' | 'wide' | 'log' | 'flat';

export const INPUT_PROFILE_GROUPS: Array<{ id: InputProfileGroupId; label: string }> = [
  { id: 'standard', label: 'Standard' },
  { id: 'wide', label: 'Wide Gamut' },
  { id: 'log', label: 'Cinema Log' },
  { id: 'flat', label: 'Flat Still' },
];

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
    label: 'Rec.709 / BT.1886',
    group: 'standard',
    priority: 2,
    description: 'Video stills, broadcast exports — ITU-R BT.1886 transfer',
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
    description: 'Alexa / AMIRA — AWG3 gamut + LogC3 (EI 800). Decodes + gamut converts to accurate sRGB-linear base.',
  },
  {
    id: 'red-log3g10',
    label: 'RED Log3G10',
    group: 'log',
    priority: 11,
    description: 'RED Komodo / V-Raptor — REDWideGamutRGB. Full accurate linearization + gamut conversion.',
  },
  {
    id: 's-log3',
    label: 'Sony S-Log3',
    group: 'log',
    priority: 12,
    description: 'Sony FX / Venice — S-Gamut3.Cine. Correct transfer + gamut conversion to sRGB linear.',
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

/** Curated set — ordered by real-world grading prevalence. */
export const INPUT_PROFILES: InputProfileSpec[] = [...PROFILE_CATALOG].sort(
  (a, b) => a.priority - b.priority,
);

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
 * to a pleasing display-referred image.
 *
 * These values are chosen so that 18% grey lands at a natural level and
 * highlights roll off gracefully. Creative "looks" should come from the
 * adjustments + film emulation stages, not here.
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
  const lr = decodeToLinear(r, profile);
  const lg = decodeToLinear(g, profile);
  const lb = decodeToLinear(b, profile);
  if (profile === 'standard' || profile === 'rec709' || profile === 'display-p3') {
    return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
  }
  // Wide-gamut / log profiles: neutral average avoids wrong Rec.709 weighting on AWG3, SGamut3, etc.
  return (lr + lg + lb) / 3;
}

export function decodeToLinearValue(value: number, profile: InputProfileId): number {
  return decodeToLinear(value, profile);
}

/** Decode 8-bit encoded value → scene linear reflectance */
const decodeToLinear = (value: number, profile: InputProfileId): number => {
  const normalized = value / 255;

  switch (profile) {
    case 'standard':      return srgbToLinear(normalized);
    case 'rec709':        return bt1886ToLinear(normalized);
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
  // 1. Decode bytes → scene linear reflectance (correct transfer function)
  let lr = decodeToLinear(r, profile);
  let lg = decodeToLinear(g, profile);
  let lb = decodeToLinear(b, profile);

  // Apply exposure compensation in scene linear (standard pro practice for EI)
  if (exposureStops !== 0) {
    const gain = Math.pow(2, exposureStops);
    lr *= gain;
    lg *= gain;
    lb *= gain;
  }

  // 2. Convert from source camera gamut to sRGB linear (accurate matrices)
  [lr, lg, lb] = gamutToSrgbLinear(lr, lg, lb, profile);

  // 3. Professional display rendering transform
  // If linearMode, output scene-linear data (still encoded to sRGB primaries but no creative shoulder)
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
 * Professional path:
 *   encoded → scene linear (correct transfer) 
 *           → source gamut → sRGB linear (accurate matrix)
 *           → display transform (neutral, high-quality rolloff)
 *
 * This gives the film emulation and adjustments a trustworthy starting point
 * equivalent to a proper CST (Color Space Transform) in Resolve or ACES.
 */
export interface ApplyInputProfileOptions {
  exposureStops?: number; // additional stops compensation (pro EI matching)
  linearMode?: boolean;   // bypass final display tone map → scene linear output
}

export const applyInputProfile = (
  source: ImageBuffer,
  profile: InputProfileId,
  options: ApplyInputProfileOptions = {},
): ImageBuffer => {
  const exposure = options.exposureStops ?? 0;
  const linearMode = options.linearMode ?? false;

  if (profile === 'standard' && exposure === 0 && !linearMode) {
    return source.clone();
  }

  const output = source.clone();
  const { data } = output;

  for (let index = 0; index < data.length; index += 4) {
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

export const getInputProfileSpec = (id: InputProfileId): InputProfileSpec =>
  INPUT_PROFILES.find((item) => item.id === id) ?? INPUT_PROFILES[0];

/** Maps legacy persisted ids to current canonical ids. */
export const coerceInputProfile = (id: string): InputProfileId => {
  if (id === 'log-c') return 'arri-logc3';
  const known = INPUT_PROFILES.find((item) => item.id === id);
  return known?.id ?? 'standard';
};