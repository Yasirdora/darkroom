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
import { interpolateCurve, makeDefaultSCurve } from '../../src/lib/processing/curves';
import { FILTER_PRESETS } from '../../src/lib/processing/filters/presets';
import { formatCubeFile } from '../../src/lib/export/cube-file';
import { LUT_SIZE } from '../../src/lib/processing/lut';
import type { CurvePoint, InputProfileId } from '../../src/lib/core/types';

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
  files['cube-format.json'] = write('cube-format.json', dumpCubeFormat());

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
