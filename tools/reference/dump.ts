/**
 * Phase 0 — reference vector generator.
 *
 * Freezes the behaviour of the TypeScript colour engine as machine-readable
 * golden data. The Swift port (DarkroomCore) validates against these files, so
 * "does the native version match?" is a test result rather than an opinion.
 *
 * Run: `npm run reference`
 *
 * Determinism matters more than coverage here — every value must be
 * reproducible from a clean checkout, so nothing samples randomly and nothing
 * depends on wall-clock time or platform state.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
  linearToBt1886,
  linearToSrgb,
  p3LinearToSrgbLinear,
  redLog3G10ToLinear,
  redWideGamutToSrgbLinear,
  sGamut3CineToSrgbLinear,
  sLog3ToLinear,
  srgbToLinear,
  vGamutToSrgbLinear,
  vLogToLinear,
} from '../../src/lib/processing/color-science';
import {
  INPUT_PROFILES,
  decodeToLinearValue,
  getProfileTypicalEI,
  getRecommendedInputExposure,
} from '../../src/lib/processing/input-profile';
import { applyCurves, interpolateCurve, makeDefaultSCurve } from '../../src/lib/processing/curves';
import { applyAdjustments } from '../../src/lib/processing/adjustments';
import { computeHistogram } from '../../src/lib/processing/histogram';
import { computeVectorscope } from '../../src/lib/processing/vectorscope';
import { buildQualifierMask } from '../../src/lib/processing/qualifiers';
import { DEFAULT_QUALIFIER } from '../../src/lib/editor/constants';
import type { QualifierConfig } from '../../src/lib/core/types';
import { ImageBuffer } from '../../src/lib/core/image-buffer';
import { DEFAULT_ADJUSTMENTS } from '../../src/lib/editor/constants';
import type { Adjustments } from '../../src/lib/core/types';
import { FILTER_PRESETS } from '../../src/lib/processing/filters/presets';
import { formatCubeFile } from '../../src/lib/export/cube-file';
import {
  decodeGradePayload,
  encodeGradePayload,
  serializeGradeState,
} from '../../src/lib/grade-share';
import { DEFAULT_EDIT_STATE } from '../../src/lib/editor/constants';
import { LUT_SIZE } from '../../src/lib/processing/lut';
import type { CurvePoint, EditState, InputProfileId } from '../../src/lib/core/types';

const OUT_DIR = resolve(import.meta.dirname, '../../reference');

/** Ramp used for every 1D transfer function. 65 points — exact at both ends
 *  and at the 0.5 midpoint, dense enough to catch a wrong toe or shoulder. */
const RAMP: number[] = Array.from({ length: 65 }, (_, i) => i / 64);

/** Colours that exercise a 3×3 gamut matrix meaningfully: primaries,
 *  secondaries, neutrals, and 18% grey. */
const GAMUT_PROBES: Array<[number, number, number]> = [
  [1, 0, 0], [0, 1, 0], [0, 0, 1],
  [0, 1, 1], [1, 0, 1], [1, 1, 0],
  [1, 1, 1], [0.18, 0.18, 0.18], [0.5, 0.25, 0.75],
  [0.9, 0.6, 0.3], [0.05, 0.12, 0.2], [0, 0, 0],
];

const sha256 = (data: Uint8Array | string): string =>
  createHash('sha256').update(data).digest('hex');

const write = (name: string, payload: unknown): string => {
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  writeFileSync(resolve(OUT_DIR, name), json, 'utf8');
  return sha256(json);
};

// ── Transfer functions ──────────────────────────────────────────────────────

type Transfer1D = (value: number) => number;

const TRANSFERS: Record<string, Transfer1D> = {
  srgbToLinear,
  linearToSrgb,
  bt1886ToLinear,
  linearToBt1886,
  arriLogC3ToLinear,
  redLog3G10ToLinear,
  sLog3ToLinear,
  bmdFilmGen4ToLinear,
  bmdFilmGen5ToLinear,
  davinciIntermediateToLinear,
  cLog3ToLinear,
  vLogToLinear,
  flatToLinear,
};

/**
 * Published encodings of 18% scene grey. These are the load-bearing invariants
 * — a decoder can look plausible across a ramp and still be wrong here, which
 * would shift every exposure decision the app makes.
 */
const GREY_POINTS: Record<string, number> = {
  arriLogC3ToLinear: 0.391,
  redLog3G10ToLinear: 1 / 3,
  sLog3ToLinear: 420 / 1023,
  bmdFilmGen5ToLinear: 0.383562,
};

const dumpTransfers = () => ({
  description: '1D transfer functions sampled over a 65-point [0,1] ramp.',
  ramp: RAMP,
  functions: Object.fromEntries(
    Object.entries(TRANSFERS).map(([name, fn]) => [name, RAMP.map(fn)]),
  ),
  greyPoints: Object.fromEntries(
    Object.entries(GREY_POINTS).map(([name, encoded]) => [
      name,
      { encoded, decoded: TRANSFERS[name](encoded) },
    ]),
  ),
});

// ── Gamut conversion matrices ───────────────────────────────────────────────

type Matrix3 = (r: number, g: number, b: number) => [number, number, number];

const GAMUTS: Record<string, Matrix3> = {
  p3LinearToSrgbLinear,
  awg3LinearToSrgbLinear,
  redWideGamutToSrgbLinear,
  sGamut3CineToSrgbLinear,
  vGamutToSrgbLinear,
  cinemaGamutToSrgbLinear,
  dwgToSrgbLinear,
  bmdWideGamutToSrgbLinear,
};

const dumpGamuts = () => ({
  description: 'Wide-gamut → sRGB linear 3×3 conversions applied to fixed probe colours.',
  probes: GAMUT_PROBES,
  conversions: Object.fromEntries(
    Object.entries(GAMUTS).map(([name, fn]) => [
      name,
      GAMUT_PROBES.map(([r, g, b]) => fn(r, g, b)),
    ]),
  ),
});

// ── Input profiles ──────────────────────────────────────────────────────────

/** decodeToLinearValue() takes an 8-bit code value, not a normalised float —
 *  it divides by 255 internally. Probing it with a [0,1] ramp would exercise
 *  only the bottom 1/255 of every curve and prove nothing about the toe,
 *  midtones or shoulder. */
const BYTE_RAMP: number[] = Array.from({ length: 65 }, (_, i) => Math.min(255, i * 4));

const dumpInputProfiles = () => ({
  description:
    'Per-profile decode of 8-bit code values to scene-linear, plus the exposure metadata the UI relies on.',
  byteRamp: BYTE_RAMP,
  profiles: INPUT_PROFILES.map((spec) => ({
    id: spec.id,
    label: spec.label,
    group: spec.group,
    priority: spec.priority,
    typicalEI: getProfileTypicalEI(spec.id as InputProfileId),
    recommendedExposure: getRecommendedInputExposure(spec.id as InputProfileId),
    decoded: BYTE_RAMP.map((v) => decodeToLinearValue(v, spec.id as InputProfileId)),
  })),
});

// ── Tone curves ─────────────────────────────────────────────────────────────

/** Control-point sets covering the interpolator's distinct code paths:
 *  identity, plain multi-point spline, explicit Bézier handles, and the
 *  clamped extremes at either end of the domain. */
const CURVE_CASES: Array<{ name: string; points: CurvePoint[] }> = [
  { name: 'identity', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
  { name: 'defaultSCurve', points: makeDefaultSCurve() },
  {
    name: 'threePointLift',
    points: [{ x: 0, y: 0.08 }, { x: 0.5, y: 0.52 }, { x: 1, y: 0.96 }],
  },
  {
    name: 'bezierHandles',
    points: [
      { x: 0, y: 0, handleOutX: 0.18, handleOutY: 0.02 },
      { x: 0.5, y: 0.55, handleInX: 0.32, handleInY: 0.4, handleOutX: 0.68, handleOutY: 0.7 },
      { x: 1, y: 1, handleInX: 0.82, handleInY: 0.98 },
    ],
  },
  {
    name: 'steepContrast',
    points: [{ x: 0, y: 0 }, { x: 0.25, y: 0.1 }, { x: 0.75, y: 0.9 }, { x: 1, y: 1 }],
  },
  {
    name: 'invertedRoll',
    points: [{ x: 0, y: 0.95 }, { x: 0.5, y: 0.5 }, { x: 1, y: 0.05 }],
  },
];

const dumpCurves = () => ({
  description: 'interpolateCurve() sampled over the shared ramp for each control-point case.',
  ramp: RAMP,
  cases: CURVE_CASES.map(({ name, points }) => ({
    name,
    points,
    sampled: RAMP.map((t) => interpolateCurve(t, points)),
  })),
});

// ── Full curve application ──────────────────────────────────────────────────

/** Pixels that exercise the master curve's luminance coupling: neutrals, where
 *  the per-channel weights cancel, and saturated colours, where they do not. */
const CURVE_PIXELS: Array<[number, number, number]> = [
  [0, 0, 0], [255, 255, 255], [128, 128, 128], [64, 64, 64], [200, 200, 200],
  [200, 150, 120], [220, 40, 40], [40, 220, 40], [40, 40, 220],
  [30, 60, 90], [180, 200, 220], [128, 64, 200],
];

/** Channel combinations covering master alone, single channels, and all four
 *  together — where per-channel and master interact. */
const CURVE_APPLY_CASES: Array<{ name: string; curves: Record<string, CurvePoint[]> }> = [
  { name: 'masterSCurve', curves: { master: makeDefaultSCurve() } },
  { name: 'redLift', curves: { r: [{ x: 0, y: 0.2 }, { x: 1, y: 1 }] } },
  { name: 'greenPull', curves: { g: [{ x: 0, y: 0 }, { x: 1, y: 0.8 }] } },
  { name: 'blueContrast', curves: { b: [{ x: 0, y: 0 }, { x: 0.5, y: 0.4 }, { x: 1, y: 1 }] } },
  {
    name: 'allChannels',
    curves: {
      master: makeDefaultSCurve(),
      r: [{ x: 0, y: 0.05 }, { x: 1, y: 0.98 }],
      g: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
      b: [{ x: 0, y: 0.02 }, { x: 0.5, y: 0.48 }, { x: 1, y: 1 }],
    },
  },
];

const dumpCurveApplication = () => ({
  description:
    'applyCurves() on fixed pixels — covers the master curve\'s luminance coupling and its per-channel weights.',
  pixels: CURVE_PIXELS,
  cases: CURVE_APPLY_CASES.map(({ name, curves }) => {
    const data = new Uint8ClampedArray(CURVE_PIXELS.length * 4);
    CURVE_PIXELS.forEach(([r, g, b], index) => {
      data[index * 4] = r;
      data[index * 4 + 1] = g;
      data[index * 4 + 2] = b;
      data[index * 4 + 3] = 255;
    });

    const output = applyCurves(new ImageData(data, CURVE_PIXELS.length, 1), curves);
    const results: number[][] = [];
    for (let index = 0; index < CURVE_PIXELS.length; index += 1) {
      results.push([
        output.data[index * 4],
        output.data[index * 4 + 1],
        output.data[index * 4 + 2],
      ]);
    }

    return { name, curves, results };
  }),
});

// ── Film stock LUTs ─────────────────────────────────────────────────────────

/** Lattice indices sampled from each 64³ cube: both ends plus every 8th step.
 *  The hash proves exactness; these samples localise a mismatch when one
 *  appears, which a hash alone cannot do. */
const LATTICE = [0, 8, 16, 24, 32, 40, 48, 56, 63];

const sampleLut = (lut: Uint8Array): number[] => {
  const out: number[] = [];
  for (const b of LATTICE) {
    for (const g of LATTICE) {
      for (const r of LATTICE) {
        const offset = (r + g * LUT_SIZE + b * LUT_SIZE * LUT_SIZE) * 3;
        out.push(lut[offset], lut[offset + 1], lut[offset + 2]);
      }
    }
  }
  return out;
};

const dumpFilmStocks = () => {
  const stocks = FILTER_PRESETS.map((preset) => {
    const lut = preset.buildLut();
    return {
      id: preset.id,
      label: preset.label,
      category: preset.category,
      grain: preset.grain ?? null,
      lutSha256: sha256(lut),
      lutByteLength: lut.length,
      samples: sampleLut(lut),
    };
  });

  return {
    description:
      'Every built-in look baked to a 64³ LUT. sha256 covers the full cube; samples are a 9³ lattice for diagnosis.',
    lutSize: LUT_SIZE,
    latticeIndices: LATTICE,
    stockCount: stocks.length,
    stocks,
  };
};

// ── .cube serialisation ─────────────────────────────────────────────────────

const dumpCubeFormat = () => {
  const identity = FILTER_PRESETS.find((preset) => preset.id === 'none');
  if (!identity) throw new Error('Identity filter missing from FILTER_PRESETS.');

  const text = formatCubeFile(identity.buildLut(), 'Reference Identity', [
    'Generated by tools/reference/dump.ts',
  ]);

  // The full identity cube is ~6 MB of text; the header plus a deterministic
  // slice is enough to pin the format, and the hash still covers all of it.
  const lines = text.split('\n');
  return {
    description: 'formatCubeFile() output for the identity LUT.',
    sha256: sha256(text),
    lineCount: lines.length,
    header: lines.slice(0, 8),
    firstDataLines: lines.slice(6, 16),
    lastDataLines: lines.slice(-4),
  };
};

// ── Adjustments ─────────────────────────────────────────────────────────────

/** One control at a time, so a mismatch names the control rather than the
 *  grade. Spatial adjustments are excluded deliberately: they depend on a
 *  pixel's neighbours, so they cannot be checked per-pixel and the render
 *  layer implements them with different filters anyway. */
const ADJUSTMENT_CASES: Array<{ name: string; values: Partial<Adjustments> }> = [
  { name: 'exposure+25', values: { exposure: 25 } },
  { name: 'exposure-25', values: { exposure: -25 } },
  { name: 'brightness+20', values: { brightness: 20 } },
  { name: 'contrast+40', values: { contrast: 40 } },
  { name: 'contrast-40', values: { contrast: -40 } },
  { name: 'highlights-60', values: { highlights: -60 } },
  { name: 'shadows+60', values: { shadows: 60 } },
  { name: 'whites+40', values: { whites: 40 } },
  { name: 'blacks-40', values: { blacks: -40 } },
  { name: 'saturation+50', values: { saturation: 50 } },
  { name: 'saturation-100', values: { saturation: -100 } },
  { name: 'vibrance+40', values: { vibrance: 40 } },
  { name: 'vibrance-40', values: { vibrance: -40 } },
  { name: 'hue+90', values: { hue: 90 } },
  { name: 'temperature+50', values: { temperature: 50 } },
  { name: 'temperature-50', values: { temperature: -50 } },
  { name: 'tint+40', values: { tint: 40 } },
  { name: 'sepia100', values: { sepia: 100 } },
  {
    name: 'combined',
    values: { exposure: 15, contrast: 25, saturation: 20, temperature: -30, highlights: -40 },
  },
];

const dumpAdjustments = () => ({
  description:
    'applyAdjustments() on fixed pixels, colour-only controls. Spatial stages are excluded — they depend on neighbouring pixels.',
  pixels: CURVE_PIXELS,
  cases: ADJUSTMENT_CASES.map(({ name, values }) => {
    const data = new Uint8ClampedArray(CURVE_PIXELS.length * 4);
    CURVE_PIXELS.forEach(([r, g, b], index) => {
      data[index * 4] = r;
      data[index * 4 + 1] = g;
      data[index * 4 + 2] = b;
      data[index * 4 + 3] = 255;
    });

    const source = new ImageBuffer(CURVE_PIXELS.length, 1, data);
    const output = applyAdjustments(source, { ...DEFAULT_ADJUSTMENTS, ...values });

    const results: number[][] = [];
    for (let index = 0; index < CURVE_PIXELS.length; index += 1) {
      results.push([
        output.data[index * 4],
        output.data[index * 4 + 1],
        output.data[index * 4 + 2],
      ]);
    }

    return { name, values, results };
  }),
});

// ── Scopes ──────────────────────────────────────────────────────────────────

/** A deterministic test image with a known distribution: a luminance ramp, the
 *  six Rec.709 primaries and secondaries, neutrals, and skin-adjacent tones.
 *  Built rather than loaded so the vectors reproduce from a clean checkout. */
const scopeTestImage = (): ImageBuffer => {
  const width = 64;
  const height = 64;
  const data = new Uint8ClampedArray(width * height * 4);

  const patches: Array<[number, number, number]> = [
    [255, 0, 0], [0, 255, 0], [0, 0, 255],
    [0, 255, 255], [255, 0, 255], [255, 255, 0],
    [200, 150, 120], [120, 90, 70],
  ];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      if (y < 32) {
        // Top half: a horizontal luminance ramp.
        const v = Math.round((x / (width - 1)) * 255);
        data[index] = v;
        data[index + 1] = v;
        data[index + 2] = v;
      } else {
        // Bottom half: colour patches, eight across.
        const [r, g, b] = patches[Math.floor(x / 8) % patches.length];
        data[index] = r;
        data[index + 1] = g;
        data[index + 2] = b;
      }
      data[index + 3] = 255;
    }
  }

  return new ImageBuffer(width, height, data);
};

const dumpScopes = () => {
  const source = scopeTestImage();
  const histogram = computeHistogram(source);
  const vectorscope = computeVectorscope(source);

  return {
    description:
      'Histogram and vectorscope of a deterministic 64x64 test image — a luminance ramp over primaries, secondaries and skin tones.',
    image: {
      width: source.width,
      height: source.height,
      // The pixels themselves, so the Swift side measures the same image
      // rather than rebuilding it and hoping the two constructions agree.
      rgba: Array.from(source.data),
    },
    histogram: {
      r: Array.from(histogram.r),
      g: Array.from(histogram.g),
      b: Array.from(histogram.b),
      luminance: Array.from(histogram.luminance),
      peak: histogram.peak,
    },
    vectorscope: {
      size: vectorscope.size,
      peak: vectorscope.peak,
      bins: Array.from(vectorscope.bins),
    },
  };
};

// ── Qualifier masks ─────────────────────────────────────────────────────────

/** Configurations covering each distinct code path: hue band, a range that
 *  wraps through zero, saturation and lightness limits, each window shape, and
 *  inversion. A small image keeps the vectors readable while still exercising
 *  the separable blur at its edges. */
const QUALIFIER_CASES: Array<{ name: string; config: Partial<QualifierConfig> }> = [
  { name: 'warmBand', config: { hueMin: 0, hueMax: 80 } },
  { name: 'wrappedReds', config: { hueMin: 340, hueMax: 20 } },
  { name: 'saturatedOnly', config: { satMin: 0.5, satMax: 1 } },
  { name: 'midtonesOnly', config: { lumMin: 0.3, lumMax: 0.7 } },
  { name: 'ellipseWindow', config: { spatialType: 'ellipse', spatialWidth: 0.6, spatialHeight: 0.6 } },
  {
    name: 'linearWindow',
    config: { spatialType: 'linear', spatialWidth: 0.8, spatialRotation: 30 },
  },
  { name: 'inverted', config: { hueMin: 0, hueMax: 80, invert: true } },
  // Deliberately off-centre and unrotated. A window centred at 0.5,0.5 is
  // symmetric about both axes, so it passes whether or not the y axis has been
  // flipped — the one case that cannot detect an orientation error is the one
  // most likely to be used as the example. This one can.
  {
    name: 'offCentreWindow',
    config: {
      spatialType: 'ellipse',
      spatialX: 0.25, spatialY: 0.2,
      spatialWidth: 0.4, spatialHeight: 0.3,
    },
  },
  {
    name: 'combined',
    config: {
      hueMin: 0, hueMax: 60, satMin: 0.2,
      spatialType: 'ellipse', spatialWidth: 0.7, spatialHeight: 0.5,
    },
  },
];

const dumpQualifiers = () => {
  const source = scopeTestImage();

  return {
    description:
      'buildQualifierMask() over the shared test image, one case per distinct code path.',
    image: { width: source.width, height: source.height },
    cases: QUALIFIER_CASES.map(({ name, config }) => {
      const full: QualifierConfig = { ...DEFAULT_QUALIFIER, ...config, enabled: true };
      const mask = buildQualifierMask(source, full);
      return {
        name,
        config: full,
        // The full mask, at 64x64 — 4,096 floats per case is large but exact,
        // and a sampled mask could hide an error in whatever was not sampled.
        mask: Array.from(mask),
      };
    }),
  };
};

// ── Grade share payloads ────────────────────────────────────────────────────

/** Grades chosen to exercise every field of the share payload, including the
 *  sparse-encoding rule (defaults omitted) and curves with Bézier handles. */
const GRADE_CASES: Array<{ name: string; mutate: (state: EditState) => void }> = [
  { name: 'neutral', mutate: () => {} },
  {
    name: 'adjustmentsOnly',
    mutate: (s) => {
      s.adjustments.exposure = 25;
      s.adjustments.contrast = -12;
      s.adjustments.vibrance = 30;
      s.adjustments.hue = -45;
    },
  },
  { name: 'filmStockOnly', mutate: (s) => { s.filterId = 'portra400'; } },
  {
    name: 'stockWithIntensity',
    mutate: (s) => { s.filterId = 'velvia50'; s.filterIntensity = 65; },
  },
  {
    name: 'logProfile',
    mutate: (s) => {
      s.inputProfile = 's-log3';
      s.inputExposure = 1.5;
      s.inputLinearMode = true;
    },
  },
  {
    name: 'curvesWithHandles',
    mutate: (s) => { s.curves = { master: makeDefaultSCurve() }; },
  },
  {
    name: 'perChannelCurves',
    mutate: (s) => {
      s.curves = {
        r: [{ x: 0, y: 0.05 }, { x: 1, y: 0.95 }],
        b: [{ x: 0, y: 0 }, { x: 0.5, y: 0.45 }, { x: 1, y: 1 }],
      };
    },
  },
  {
    name: 'everything',
    mutate: (s) => {
      s.adjustments.exposure = -18;
      s.adjustments.temperature = 40;
      s.adjustments.sepia = 15;
      s.filterId = 'eterna';
      s.filterIntensity = 80;
      s.inputProfile = 'arri-logc3';
      s.inputExposure = -0.75;
      s.curves = { master: makeDefaultSCurve() };
    },
  },
];

const dumpGradeShare = () => ({
  description:
    'Compact grade payloads and their base64url encodings — the wire contract shared with the native app.',
  cases: GRADE_CASES.map(({ name, mutate }) => {
    const state = structuredClone(DEFAULT_EDIT_STATE) as EditState;
    mutate(state);
    const payload = serializeGradeState(state);
    return {
      name,
      payload,
      encoded: payload ? encodeGradePayload(payload) : null,
      // Proves the web app's own decoder accepts what its encoder produced.
      roundTrips: payload
        ? JSON.stringify(decodeGradePayload(encodeGradePayload(payload))) === JSON.stringify(payload)
        : true,
    };
  }),
});

// ── Entry point ─────────────────────────────────────────────────────────────

const main = () => {
  mkdirSync(OUT_DIR, { recursive: true });

  const started = Date.now();
  const files: Record<string, string> = {};

  files['transfer.json'] = write('transfer.json', dumpTransfers());
  files['gamut.json'] = write('gamut.json', dumpGamuts());
  files['input-profiles.json'] = write('input-profiles.json', dumpInputProfiles());
  files['curves.json'] = write('curves.json', dumpCurves());
  files['film-stocks.json'] = write('film-stocks.json', dumpFilmStocks());
  files['curve-application.json'] = write('curve-application.json', dumpCurveApplication());
  files['adjustments.json'] = write('adjustments.json', dumpAdjustments());
  files['scopes.json'] = write('scopes.json', dumpScopes());
  files['qualifiers.json'] = write('qualifiers.json', dumpQualifiers());
  files['cube-format.json'] = write('cube-format.json', dumpCubeFormat());
  files['grade-share.json'] = write('grade-share.json', dumpGradeShare());

  writeFileSync(
    resolve(OUT_DIR, 'manifest.json'),
    `${JSON.stringify(
      {
        description:
          'Golden reference vectors generated from the TypeScript engine. Consumed by DarkroomCore tests.',
        formatVersion: 1,
        generator: 'tools/reference/dump.ts',
        // Deliberately no timestamp: output must be byte-identical across runs
        // so an unrelated regeneration never shows up as a diff.
        files,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const names = Object.keys(files);
  console.log(`Wrote ${names.length + 1} files to reference/ in ${Date.now() - started} ms`);
  for (const name of names) console.log(`  ${name}  ${files[name].slice(0, 12)}…`);
};

main();
