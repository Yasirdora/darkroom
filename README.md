# Darkroom

[![npm](https://img.shields.io/npm/v/@darkroom/core?color=0b7285&label=npm)](https://www.npmjs.com/package/@darkroom/core)
[![CI](https://github.com/Yasirdora/darkroom/actions/workflows/ci.yml/badge.svg)](https://github.com/Yasirdora/darkroom/actions/workflows/ci.yml)
[![dependencies](https://img.shields.io/badge/runtime%20dependencies-0-0b7285)](#dependency-policy)
[![license](https://img.shields.io/npm/l/@darkroom/core?color=0b7285)](./LICENSE)

A local-first, framework-independent photo-grading and 3D LUT engine written
in TypeScript. Zero runtime dependencies, DOM-free core, ESM only.

```sh
npm install @darkroom/core
```

## Why Darkroom

Most of what a grading engine does can be assembled from existing parts. The
piece that cannot is the layer underneath: turning log-encoded camera footage
into something you can actually grade.

Darkroom decodes **ARRI LogC3, Sony S-Log3, RED Log3G10, Canon C-Log3,
Panasonic V-Log, Blackmagic Film Gen 4 and 5, and DaVinci Intermediate** to
scene-linear reflectance, then converts each one's native gamut — AWG3, REDWideGamutRGB,
S-Gamut3.Cine, Cinema Gamut, V-Gamut, Blackmagic Wide Gamut, DaVinci Wide Gamut —
to sRGB using published matrices. Those transforms are transcribed from
manufacturer specifications rather than fitted, because a wrong coefficient
produces an image that looks plausible and is wrong.

Everything else is built on that: a grade model, a deterministic render
pipeline shared by preview and export, and 3D LUTs in both directions so a
grade made in a browser opens in Resolve.

The root module is DOM-free and works with the same RGBA buffer contract in
Node.js, browser main threads, and module workers.

- Camera log and gamut normalization to scene-linear, with profile detection
- Deterministic CPU rendering with explicit inputs and outputs
- Adjustments, curves, qualifiers, effects, transforms, and looks
- 3D LUT creation, interpolation, resampling, `.cube` parsing, and export
- Histograms, vectorscopes, scene analysis, automatic corrections, and color matching
- Bounded ICC, EXIF, JPEG, PNG, WebP, grade, curve, and LUT inputs
- Browser decoding isolated behind an explicit subpath
- Lazy, opt-in built-in looks isolated from root-only consumer bundles
- Zero runtime dependencies and no package-initiated network requests

## Dependency policy

Darkroom implements the domain behavior that defines the project: validated
RGBA buffers, alpha-correct resizing and blur, color conversions, curves,
trilinear 3D LUT sampling, `.cube` parsing, masks, qualifiers, effects, scopes,
analysis, and camera-profile normalization. This keeps numerical behavior,
resource limits, and bundle composition under the package's control.

Zero runtime dependencies does not mean rebuilding general infrastructure.
TypeScript, Vitest, and Vite remain development tools, while compressed image
decoding uses native browser APIs behind the `/browser` entry. Consumers do not
install those tools or any transitive runtime package. The rationale and the
criteria for any future exception are recorded in
[ADR 0002](https://github.com/Yasirdora/darkroom/blob/main/docs/decisions/0002-zero-runtime-dependencies.md).

## Installation

```sh
npm install @darkroom/core
```

The package is ESM-only. CommonJS `require()` and package-internal deep imports
are not supported.

## Entry points

| Import | Environment | Purpose |
| --- | --- | --- |
| `@darkroom/core` | Node.js, browsers, module workers | DOM-free pixel processing, grades, LUTs, analysis, transforms, and profile helpers |
| `@darkroom/core/browser` | Browsers with Canvas 2D and `createImageBitmap` | `File` decoding and conversions between browser image objects and `PixelBuffer` |
| `@darkroom/core/presets` | Node.js, browsers, module workers | Immutable preset metadata and lazy compilation into generic engine `Look` values |

The root entry never imports either optional subpath. Importing the root alone
therefore excludes browser adapters and preset catalog data from its module graph.

## Core workflow

Create or obtain an RGBA `PixelBuffer`, describe a partial grade, and render it:

```ts
import {
  createPixelBuffer,
  render,
  renderForExport,
  type GradeInput,
} from '@darkroom/core';

const input = createPixelBuffer({
  width: 2,
  height: 1,
  data: [32, 48, 64, 255, 180, 150, 120, 255],
});

const grade: GradeInput = {
  adjustments: {
    exposure: 12,
    contrast: 8,
    vibrance: 10,
  },
  curves: {
    master: [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.54 },
      { x: 1, y: 1 },
    ],
  },
  transform: {
    crop: { x: 0, y: 0, width: 1, height: 1 },
  },
};

const preview = render(input, grade); // crop is an overlay by default
const exported = renderForExport(input, grade); // crop is baked in
```

Grade fields are partial. `normalizeGrade()` fills defaults, clamps supported
numeric controls, sorts valid curve points, and rejects unsafe structures.
`ADJUSTMENT_RANGES`, `DEFAULT_ADJUSTMENTS`, `DEFAULT_QUALIFIER`, and
`DEFAULT_TRANSFORM` are exported for UI construction and validation.

Processing functions do not mutate the caller's input pixels. A no-op render
may return the original `PixelBuffer` to avoid a full-frame allocation; use
`clonePixelBuffer()` when a distinct buffer identity is required.

## Browser decoding

The browser adapter validates the encoded file type, byte size, dimensions, and
pixel count before allocating the decoded buffer:

```ts
import { render } from '@darkroom/core';
import {
  decodeImageFile,
  pixelBufferToImageData,
} from '@darkroom/core/browser';

async function gradeFile(file: File): Promise<ImageData> {
  const decoded = await decodeImageFile(file, {
    colorSpaceConversion: 'default',
  });

  const output = render(decoded.buffer, {
    adjustments: { exposure: 6, saturation: 8 },
  });

  return pixelBufferToImageData(output);
}
```

`decodeImageFile()` accepts JPEG, PNG, and WebP `File` objects. EXIF orientation
is baked into the returned pixels. Its result reports the effective
`colorSpaceConversionApplied` value because browsers may fall back to their
default conversion when the requested `createImageBitmap` option is unavailable.
The field identifies the option used by the successful call; it cannot prove
that a non-conforming browser honored every option internally.

The browser entry also exports `pixelBufferFromImageData()`,
`pixelBufferToImageData()`, and `pixelBufferFromImageBitmap()`. Consumers own
canvas presentation, worker lifecycle, object URLs, downloads, and storage.

## Built-in presets

Presets live in the same installed tarball but are opt-in through `/presets`:

```ts
import { render } from '@darkroom/core';
import {
  compilePreset,
  getPreset,
  isPresetId,
  presets,
} from '@darkroom/core/presets';

const metadata = getPreset('portra400');
const look = compilePreset('portra400', { lutSize: 33 });
const output = render(input, { look, lookIntensity: 80 });

console.log(metadata?.label, presets.length, isPresetId('portra400'));
```

Catalog metadata is immutable. Preset LUT compilation is lazy, and every call
returns fresh LUT data. Applications that reuse a preset should cache the
compiled `Look` by preset ID and LUT size. The renderer accepts generic `Look`
objects rather than preset IDs, so custom and imported LUTs use the same stage.

The preset subpath provides import-graph, initialization, and consumer-bundle
isolation; it does not provide separate download or licensing isolation.

Film- and scanner-inspired looks are independently authored creative
approximations. Their names do not imply affiliation, certification,
endorsement, or colorimetric equivalence to any manufacturer or product.

## Importing and exporting `.cube` LUTs

```ts
import {
  formatCube,
  parseCube,
  render,
} from '@darkroom/core';

const lut = parseCube(cubeText, {
  fallbackTitle: 'Imported look',
  size: 33,
});

const output = render(input, {
  look: { lut },
  lookIntensity: 100,
});

const normalizedCubeText = formatCube(lut, {
  precision: 6,
  title: 'Darkroom export',
});
```

The parser supports 3D `.cube` data with optional `TITLE`, `DOMAIN_MIN`, and
`DOMAIN_MAX` directives. It rejects 1D or combined LUTs, duplicate or unknown
directives, non-finite values, invalid row counts, and inputs beyond the public
resource limits. Source cubes from size 2 through 65 are resampled to 17, 33,
or 65 as requested.

## Public API overview

The package uses named exports. Major groups include:

| Area | Representative exports |
| --- | --- |
| Buffers and sizing | `createPixelBuffer`, `assertPixelBuffer`, `clonePixelBuffer`, `resizePixelBuffer`, `resizeToFit` |
| Grades and rendering | `createDefaultGrade`, `normalizeGrade`, `render`, `renderForExport` |
| Curves and selective processing | `applyCurves`, `identityCurve`, `makeDefaultSCurve`, `buildQualifierMask`, `applyWithMask` |
| Looks and effects | `applyLook`, `applyFilmGrain`, `applyEffect` |
| LUTs and `.cube` | `createLut3D`, `buildLut`, `applyLut`, `resampleLut`, `parseCube`, `formatCube` |
| Analysis | `computeHistogram`, `computeVectorscope`, `analyzeImage`, `computeColorMatchStats`, `computeAutoEnhance` |
| Geometry | `applyTransform`, `fullCropRect`, `largestCropForAspect`, `constrainCropToAspect` |
| Input profiles | `applyInputProfile`, `normalizeInput`, `getInputProfileSpec`, `detectInputProfileFromHeader`, `extractExifOrientation` |
| Contracts | `DarkroomError`, `DARKROOM_LIMITS`, exported TypeScript interfaces and unions |

The export map—not files under `dist/`—defines the supported API. Imports such
as `@darkroom/core/dist/index.js` are intentionally blocked.

## Resource limits

`DARKROOM_LIMITS` is frozen, exported from the root entry, and used as a shared
contract by the engine, browser adapter, and reference application.

| Limit | Value | Enforcement |
| --- | ---: | --- |
| Encoded image file | 10 MiB | `decodeImageFile()` before decoding |
| Decoded image | 12,000,000 pixels | Buffer constructors, processing boundaries, and browser decoding |
| Encoded metadata header | 512 KiB | ICC, EXIF, orientation, profile, and dimension scans |
| Encoded `.cube` file | 16 MiB | Exported boundary for consumers to check before text decoding |
| Direct `.cube` text | 16,777,216 UTF-16 code units | `parseCube()` before splitting lines |
| Source 3D LUT dimension | 2 through 65 | `parseCube()` |
| Parsed `.cube` lines | 278,721 | `parseCube()` |
| Curve points | 32 per channel | `normalizeGrade()` |
| Vectorscope dimension | 512 maximum | `computeVectorscope()` |
| Engine LUT dimensions | 17, 33, or 65 | LUT creation, building, resampling, and preset compilation |

Limits are part of the package's denial-of-service protections. Consumers
should reject oversized encoded `.cube` files before converting them to text
and should avoid disabling or bypassing these boundaries for untrusted input.

## Error handling

Public validation and browser operations throw `DarkroomError` with a stable,
machine-readable `code`:

```ts
import {
  DarkroomError,
  parseCube,
} from '@darkroom/core';

try {
  const lut = parseCube(untrustedText, { size: 33 });
  // Use the validated LUT.
} catch (error) {
  if (error instanceof DarkroomError) {
    console.error(error.code, error.message);
  } else {
    throw error;
  }
}
```

| Code | Meaning |
| --- | --- |
| `INVALID_DIMENSIONS` | Dimensions or caller-provided allocation bounds are invalid |
| `BUFFER_LENGTH_MISMATCH` | RGBA data does not match the declared dimensions |
| `RESOURCE_LIMIT_EXCEEDED` | A byte, pixel, line, curve, or allocation limit was exceeded |
| `INVALID_GRADE` | Grade structure contains an unsafe or contradictory value |
| `INVALID_LUT` | LUT shape, domain, title, or data is invalid |
| `UNSUPPORTED_LUT_SIZE` | A requested or imported LUT dimension is unsupported |
| `INVALID_CUBE` | `.cube` syntax or declared content is invalid |
| `INVALID_PROFILE` | An input profile request is invalid |
| `UNSUPPORTED_IMAGE` | A browser image file is empty, invalid, or unsupported |
| `DECODE_FAILED` | Browser image decoding failed |
| `CANVAS_UNAVAILABLE` | Canvas 2D is not available in the current browser context |

Do not branch on human-readable messages. `asDarkroomError()` is available to
wrap an unknown exception at application boundaries without double-wrapping an
existing `DarkroomError`.

## Compatibility

- **Modules:** ESM only, with an explicit package export map
- **JavaScript target:** readable ES2022 modules
- **Node.js:** supported `22.12+`, `24`, and `26` release lines
- **TypeScript:** bundled declarations and declaration maps; strict NodeNext
  consumers are covered by packed-tarball smoke tests
- **Browsers:** ES2022-capable browsers for the root and preset entries
- **Browser adapter:** requires `File`, `createImageBitmap`, `ImageData`, and
  Canvas 2D through `OffscreenCanvas` or an HTML document
- **Workers:** the root and preset entries are module-worker safe; browser APIs
  still depend on the capabilities exposed by the worker runtime

The clean-consumer release gate installs the exact packed tarball and checks
Node ESM execution, root/browser TypeScript graphs, root-versus-preset Vite
bundle isolation, module-worker bundling, export-map enforcement, source maps,
package contents, and gzip budgets.

## Processing scope and non-goals

Darkroom is currently an 8-bit, SDR, display-referred photo engine. Camera-log
input transforms and film-inspired presets are creative processing tools, not a
replacement for a calibrated, end-to-end color-managed finishing pipeline.

The package does not currently provide RAW decoding, HDR mastering, GPU
rendering, UI components, editor state, history, worker orchestration, file
downloads, persistence, or server storage. Those responsibilities remain with
the consumer or the Coloristic Darkroom reference application.

## Privacy and security

The package has no runtime dependencies, analytics, telemetry, storage, or
network code. Browser image decoding remains local to the executing browser.
Consumer applications control file acquisition, persistence, logging, DOM
insertion, uploads, and network behavior.

Treat image metadata, filenames, grade data, and `.cube` text as untrusted.
Report suspected vulnerabilities through the repository's
[private security advisory form](https://github.com/Yasirdora/darkroom/security/advisories/new),
not a public issue.

## Versioning

Darkroom follows [Semantic Versioning](https://semver.org/). `0.1.1` is the
first stable release; `0.1.0-beta.0` and `0.1.0-beta.1` preceded it and are
recorded in [CHANGELOG.md](./CHANGELOG.md).

The contract that versioning covers:

- **Public API** is the set of names exported from the three declared entry
  points. Nothing reachable only by deep import is public, and the export map
  enforces that rather than documenting it.
- **Numerical behavior** of the render paths is part of the contract. A change
  that moves pixels for an unchanged grade is breaking, even when no type
  changes, because the output is what consumers actually depend on.
- **Preset identifiers** are stable. Renaming one breaks saved grades.
- Every breaking change is documented in the changelog, and pre-1.0 breaking
  changes land in a new minor version.

Releases publish from a tagged commit through npm trusted publishing, so the
registry verifies the artifact came from this repository's workflow. The
distribution tag is derived from the version: a prerelease goes to `beta`, a
stable release to `latest`.

## License

MIT © Yasir Dora. See [LICENSE](./LICENSE).
