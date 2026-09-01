import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  npmCommand,
  repositoryDirectory,
  runCommand,
  verifyPackedDarkroomPackage,
  withPackedDarkroomPackage,
} from './package-utils.mjs';

const writeJson = (path, value) =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');

const runtimeSmokeSource = `
const core = await import('@darkroom/core');
const browser = await import('@darkroom/core/browser');
const presets = await import('@darkroom/core/presets');

const expectedExports = {
  core: [
    'ADJUSTMENT_RANGES', 'DARKROOM_LIMITS', 'DEFAULT_ADJUSTMENTS',
    'DEFAULT_QUALIFIER', 'DEFAULT_TRANSFORM', 'DarkroomError', 'INPUT_PROFILES',
    'INPUT_PROFILE_GROUPS', 'QUALIFIER_ENABLE_HUE_DEFAULTS', 'SKIN_TONE_LINE',
    'VECTORSCOPE_CHROMA_RANGE', 'VECTORSCOPE_SIZE', 'analyzeImage',
    'applyAdjustments', 'applyColorMatch', 'applyCurves', 'applyEffect',
    'applyFilmGrain', 'applyInputProfile', 'applyLook', 'applyLut',
    'applyTransform', 'applyWithMask', 'asDarkroomError', 'assertPixelBuffer',
    'buildLut', 'buildQualifierMask', 'clonePixelBuffer', 'coerceInputProfile',
    'computeAutoEnhance', 'computeAutoWhiteBalance', 'computeColorMatchStats',
    'computeHistogram', 'computeVectorscope', 'constrainCropToAspect',
    'createDefaultGrade', 'createLut3D', 'createPixelBuffer', 'cropsNearlyEqual',
    'decodeToLinearValue', 'detectInputProfileDetailsFromHeader',
    'detectInputProfileFromHeader', 'extractExifOrientation',
    'extractJpegDimensions', 'formatCube', 'fullCropRect', 'getInputProfileSpec',
    'getProfileTypicalEI', 'getRecommendedInputExposure',
    'getSceneLinearLuminance', 'identityCurve', 'inputProfiles',
    'interpolateCurve', 'isFullHueSelection', 'isIdentityQualifier',
    'isLutSize', 'isSkinTone', 'largestCropForAspect', 'makeDefaultSCurve',
    'normalizeGrade', 'normalizeInput', 'parseCube', 'qualifierAffectsPipeline',
    'render', 'renderForExport', 'resampleLut', 'resizePixelBuffer',
    'resizeToFit', 'rgbToCbCrOffset', 'skinToneWeight',
  ],
  browser: [
    'decodeImageFile', 'pixelBufferFromImageBitmap', 'pixelBufferFromImageData',
    'pixelBufferToImageData',
  ],
  presets: ['compilePreset', 'getPreset', 'isPresetId', 'presets'],
};

for (const [entry, expected] of Object.entries(expectedExports)) {
  const module = { core, browser, presets }[entry];
  const missing = expected.filter((name) => !(name in module));
  if (missing.length > 0) {
    throw new Error(\`The \${entry} entry is missing public exports: \${missing.join(', ')}\`);
  }
}

const source = core.createPixelBuffer({ width: 1, height: 1, data: [12, 34, 56, 255] });
if (core.render(source) !== source) throw new Error('Identity rendering contract changed.');
if (!presets.isPresetId('portra400') || presets.getPreset('portra400')?.id !== 'portra400') {
  throw new Error('Preset lookup contract changed.');
}

try {
  await import('@darkroom/core/dist/index.js');
  throw new Error('A package-internal deep import unexpectedly succeeded.');
} catch (error) {
  if (error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
}
`;

const coreTypeSmokeSource = `
import {
  createDefaultGrade,
  createPixelBuffer,
  render,
  type Adjustments,
  type ApplyInputProfileOptions,
  type AutoEnhanceResult,
  type AutoWhiteBalanceResult,
  type BuildLutOptions,
  type ByteColorTransform,
  type ColorMatchStats,
  type CropRect,
  type CurvePoint,
  type Curves,
  type DarkroomErrorCode,
  type EffectId,
  type EffectOptions,
  type EffectSpec,
  type ExifOrientation,
  type FormatCubeOptions,
  type Grade,
  type GradeInput,
  type GrainSpec,
  type HistogramData,
  type ImageAnalysis,
  type InputProfileDetection,
  type InputProfileDetectionSource,
  type InputProfileGroupId,
  type InputProfileId,
  type InputProfileSpec,
  type Look,
  type Lut3D,
  type Lut3DInput,
  type LutSize,
  type ParseCubeOptions,
  type PixelBuffer,
  type PixelBufferInput,
  type QualifierConfig,
  type RenderOptions,
  type SceneProfile,
  type Transform,
  type VectorscopeData,
} from '@darkroom/core';
import {
  type CompilePresetOptions,
  type PresetCategory,
  type PresetId,
  type PresetMetadata,
  type PresetTag,
} from '@darkroom/core/presets';

const source: PixelBuffer = createPixelBuffer({ width: 1, height: 1, data: [0, 0, 0, 255] });
const grade: Grade = createDefaultGrade();
const output: PixelBuffer = render(source, grade satisfies GradeInput);
type PublicTypes = [
  Adjustments, ApplyInputProfileOptions, AutoEnhanceResult, AutoWhiteBalanceResult,
  BuildLutOptions, ByteColorTransform, ColorMatchStats, CropRect,
  CurvePoint, Curves, DarkroomErrorCode, EffectId, EffectOptions, EffectSpec,
  ExifOrientation, FormatCubeOptions, GrainSpec, HistogramData, ImageAnalysis,
  InputProfileDetection, InputProfileDetectionSource, InputProfileGroupId,
  InputProfileId, InputProfileSpec, Look, Lut3D, Lut3DInput, LutSize,
  ParseCubeOptions, PixelBufferInput, QualifierConfig, RenderOptions,
  SceneProfile, Transform, VectorscopeData, CompilePresetOptions,
  PresetCategory, PresetId, PresetMetadata, PresetTag,
];
void output;
void (null as unknown as PublicTypes);
`;

const browserTypeSmokeSource = `
import {
  decodeImageFile,
  type DecodeColorSpaceConversion,
  type DecodeImageFileOptions,
  type DecodedImageFile,
} from '@darkroom/core/browser';

const decode: typeof decodeImageFile = decodeImageFile;
type BrowserTypes = [DecodeColorSpaceConversion, DecodeImageFileOptions, DecodedImageFile];
void decode;
void (null as unknown as BrowserTypes);
`;

const baseTypeScriptOptions = {
  exactOptionalPropertyTypes: true,
  forceConsistentCasingInFileNames: true,
  module: 'NodeNext',
  moduleDetection: 'force',
  moduleResolution: 'NodeNext',
  noEmit: true,
  skipLibCheck: false,
  strict: true,
  target: 'ES2022',
  types: [],
  verbatimModuleSyntax: true,
};

const PRESET_SENTINELS = ['portra400', 'velvia50', 'noirHigh'];
const ROOT_FORBIDDEN_PRESET_SENTINELS = [
  ...PRESET_SENTINELS,
  '__COLORISTIC_DARKROOM_PRESET_CATALOG__',
];
const ROOT_GZIP_BUDGET = 100 * 1024;
const PRESETS_GZIP_BUDGET = 200 * 1024;
const WORKER_GZIP_BUDGET = 125 * 1024;

const viteRootSource = `
import * as darkroom from '@darkroom/core';

(globalThis as Record<string, unknown>).__darkroomRoot = darkroom;
`;

const vitePresetsSource = `
import * as darkroom from '@darkroom/core';
import * as presets from '@darkroom/core/presets';

(globalThis as Record<string, unknown>).__darkroomWithPresets = { darkroom, presets };
`;

const viteWorkerMainSource = `
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
worker.postMessage('inspect');
`;

const viteWorkerSource = `
import * as darkroom from '@darkroom/core';

self.addEventListener('message', () => {
  self.postMessage(Object.keys(darkroom));
});
`;

const viteIndexSource = `
<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8"><title>Darkroom package smoke</title></head>
  <body><script type="module" src="./src/main.ts"></script></body>
</html>
`;

const walkFiles = async (directory) => {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
};

const inspectViteOutput = async (outputDirectory) => {
  const javascriptFiles = (await walkFiles(outputDirectory)).filter((path) =>
    path.endsWith('.js'),
  );
  if (javascriptFiles.length === 0) {
    throw new Error(`Vite produced no JavaScript in ${outputDirectory}.`);
  }

  let combinedSource = '';
  let gzipBytes = 0;
  for (const path of javascriptFiles) {
    const source = await readFile(path);
    combinedSource += `${source.toString('utf8')}\n`;
    gzipBytes += gzipSync(source, { level: 9 }).byteLength;
  }
  return { combinedSource, gzipBytes, javascriptFileCount: javascriptFiles.length };
};

const createViteFixture = async (consumerDirectory, name, mainSource, workerSource) => {
  const fixtureDirectory = resolve(consumerDirectory, name);
  const sourceDirectory = resolve(fixtureDirectory, 'src');
  await mkdir(sourceDirectory, { recursive: true });
  await writeFile(resolve(fixtureDirectory, 'index.html'), viteIndexSource.trimStart(), 'utf8');
  await writeFile(resolve(sourceDirectory, 'main.ts'), mainSource.trimStart(), 'utf8');
  if (workerSource) {
    await writeFile(resolve(sourceDirectory, 'worker.ts'), workerSource.trimStart(), 'utf8');
  }
  return fixtureDirectory;
};

const buildViteFixture = async (consumerDirectory, fixtureDirectory, outputName) => {
  const outputDirectory = resolve(consumerDirectory, outputName);
  const viteCli = resolve(repositoryDirectory, 'node_modules/vite/bin/vite.js');
  await runCommand(
    process.execPath,
    [
      viteCli,
      'build',
      fixtureDirectory,
      '--outDir',
      outputDirectory,
      '--emptyOutDir',
      '--logLevel',
      'error',
    ],
    { cwd: consumerDirectory },
  );
  return inspectViteOutput(outputDirectory);
};

const assertGzipBudget = (label, actualBytes, budgetBytes) => {
  if (actualBytes > budgetBytes) {
    throw new Error(`${label} is ${actualBytes} gzip bytes; budget is ${budgetBytes}.`);
  }
};

const runViteConsumerSmokes = async (consumerDirectory) => {
  const rootFixture = await createViteFixture(
    consumerDirectory,
    'vite-root',
    viteRootSource,
  );
  const presetsFixture = await createViteFixture(
    consumerDirectory,
    'vite-presets',
    vitePresetsSource,
  );
  const workerFixture = await createViteFixture(
    consumerDirectory,
    'vite-worker',
    viteWorkerMainSource,
    viteWorkerSource,
  );

  const rootOutput = await buildViteFixture(
    consumerDirectory,
    rootFixture,
    'dist-vite-root',
  );
  const presetsOutput = await buildViteFixture(
    consumerDirectory,
    presetsFixture,
    'dist-vite-presets',
  );
  const workerOutput = await buildViteFixture(
    consumerDirectory,
    workerFixture,
    'dist-vite-worker',
  );

  const leakedSentinels = ROOT_FORBIDDEN_PRESET_SENTINELS.filter((sentinel) =>
    rootOutput.combinedSource.includes(sentinel),
  );
  if (leakedSentinels.length > 0) {
    throw new Error(`Root-only Vite bundle contains preset IDs: ${leakedSentinels.join(', ')}`);
  }

  const includedSentinels = PRESET_SENTINELS.filter((sentinel) =>
    presetsOutput.combinedSource.includes(sentinel),
  );
  if (includedSentinels.length !== PRESET_SENTINELS.length) {
    throw new Error(
      `Preset Vite bundle is missing catalog sentinels: ${PRESET_SENTINELS.filter(
        (sentinel) => !includedSentinels.includes(sentinel),
      ).join(', ')}`,
    );
  }

  if (workerOutput.javascriptFileCount < 2) {
    throw new Error('Vite module-worker fixture did not emit a separate worker module.');
  }

  assertGzipBudget('Root-only Vite bundle', rootOutput.gzipBytes, ROOT_GZIP_BUDGET);
  assertGzipBudget('Root-plus-presets Vite bundle', presetsOutput.gzipBytes, PRESETS_GZIP_BUDGET);
  assertGzipBudget('Module-worker Vite bundle', workerOutput.gzipBytes, WORKER_GZIP_BUDGET);

  return {
    presetsGzipBytes: presetsOutput.gzipBytes,
    rootGzipBytes: rootOutput.gzipBytes,
    workerGzipBytes: workerOutput.gzipBytes,
  };
};

const skipBuild = process.argv.includes('--skip-build');

await withPackedDarkroomPackage(async ({ metadata, tarballPath }) => {
  await verifyPackedDarkroomPackage(metadata);

  // macOS exposes its temporary directory through /var while process cwd is
  // canonicalized to /private/var. Use one canonical path throughout so Vite
  // does not mistake the entry HTML for a file outside its project root.
  const consumerDirectory = await realpath(
    await mkdtemp(join(tmpdir(), 'darkroom-consumer-')),
  );
  try {
    const npmCacheEnvironment = {
      npm_config_cache: resolve(consumerDirectory, '.npm-cache'),
    };
    await writeJson(resolve(consumerDirectory, 'package.json'), {
      name: 'darkroom-packed-consumer',
      private: true,
      type: 'module',
      version: '0.0.0',
    });
    await writeFile(
      resolve(consumerDirectory, 'runtime-smoke.mjs'),
      runtimeSmokeSource.trimStart(),
      'utf8',
    );
    await writeFile(
      resolve(consumerDirectory, 'core-smoke.ts'),
      coreTypeSmokeSource.trimStart(),
      'utf8',
    );
    await writeFile(
      resolve(consumerDirectory, 'browser-smoke.ts'),
      browserTypeSmokeSource.trimStart(),
      'utf8',
    );
    await writeJson(resolve(consumerDirectory, 'tsconfig.core.json'), {
      compilerOptions: {
        ...baseTypeScriptOptions,
        lib: ['ES2022'],
      },
      files: ['core-smoke.ts'],
    });
    await writeJson(resolve(consumerDirectory, 'tsconfig.browser.json'), {
      compilerOptions: {
        ...baseTypeScriptOptions,
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      },
      files: ['browser-smoke.ts'],
    });

    await runCommand(
      npmCommand,
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--no-package-lock',
        '--save-exact',
        tarballPath,
      ],
      { cwd: consumerDirectory, env: npmCacheEnvironment },
    );
    await runCommand(process.execPath, ['runtime-smoke.mjs'], { cwd: consumerDirectory });

    const typeScriptCli = resolve(repositoryDirectory, 'node_modules/typescript/bin/tsc');
    await runCommand(process.execPath, [typeScriptCli, '-p', 'tsconfig.core.json'], {
      cwd: consumerDirectory,
    });
    await runCommand(process.execPath, [typeScriptCli, '-p', 'tsconfig.browser.json'], {
      cwd: consumerDirectory,
    });
    await runCommand(npmCommand, ['ls', '--omit=dev', '--all'], {
      cwd: consumerDirectory,
      env: npmCacheEnvironment,
    });

    const bundleSizes = await runViteConsumerSmokes(consumerDirectory);

    console.log(
      'Packed-package smoke passed for Node ESM, strict NodeNext types, Vite root/preset isolation, ' +
        `and module workers (${bundleSizes.rootGzipBytes}/${bundleSizes.presetsGzipBytes}/` +
        `${bundleSizes.workerGzipBytes} gzip bytes).`,
    );
  } finally {
    await rm(consumerDirectory, { force: true, recursive: true });
  }
}, { build: !skipBuild });
