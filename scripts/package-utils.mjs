import { spawn } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));

export const repositoryDirectory = resolve(scriptDirectory, '..');
// The package is the repository root now that the engine has its own repo.
export const packageDirectory = repositoryDirectory;

const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const MAX_PACKED_BYTES = 2 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 8 * 1024 * 1024;
const PACKAGE_DOCUMENTS = new Set(['CHANGELOG.md', 'LICENSE', 'README.md', 'package.json']);
const DISTRIBUTION_EXTENSIONS = ['.js', '.js.map', '.d.ts', '.d.ts.map'];
const EXPECTED_EXPORTS = new Set(['.', './browser', './package.json', './presets']);

const formatCommand = (command, args) => [command, ...args].join(' ');

export const runCommand = (command, args, options = {}) =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repositoryDirectory,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', rejectPromise);
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolvePromise({ stderr, stdout });
        return;
      }

      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      rejectPromise(
        new Error(
          `${formatCommand(command, args)} failed with ${reason}.\n${stderr || stdout}`.trim(),
        ),
      );
    });
  });

const runNpm = (args, options) => runCommand(npmExecutable, args, options);

const parsePackMetadata = (stdout) => {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`npm pack returned invalid JSON: ${error.message}`);
  }

  if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0]?.filename) {
    throw new Error('npm pack did not return exactly one package artifact.');
  }
  return parsed[0];
};

export const withPackedDarkroomPackage = async (callback, options = {}) => {
  if (options.build !== false) {
    await runNpm(['run', 'build'], { cwd: repositoryDirectory });
  }

  const artifactDirectory = await mkdtemp(join(tmpdir(), 'darkroom-package-'));
  try {
    // Use an isolated writable cache so packing is reproducible even when a
    // developer's global npm cache has stale ownership or permissions.
    const npmCacheDirectory = resolve(artifactDirectory, 'npm-cache');
    const { stdout } = await runNpm(
      [
        'pack',
        '--json',
        '--ignore-scripts',
        '--pack-destination',
        artifactDirectory,
      ],
      {
        cwd: packageDirectory,
        env: { npm_config_cache: npmCacheDirectory },
      },
    );
    const metadata = parsePackMetadata(stdout);
    const tarballPath = resolve(artifactDirectory, metadata.filename);
    return await callback({ artifactDirectory, metadata, tarballPath });
  } finally {
    await rm(artifactDirectory, { force: true, recursive: true });
  }
};

const hasAllowedDistributionExtension = (path) =>
  DISTRIBUTION_EXTENSIONS.some((extension) => path.endsWith(extension));

const isAllowedPackagePath = (path) =>
  PACKAGE_DOCUMENTS.has(path) ||
  (path.startsWith('dist/') && hasAllowedDistributionExtension(path));

const collectExportTargets = (value, targets = []) => {
  if (typeof value === 'string') {
    targets.push(value);
    return targets;
  }
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) collectExportTargets(nested, targets);
  }
  return targets;
};

const assertRuntimeDependencyFree = (manifest) => {
  const dependencyFields = [
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
    'bundledDependencies',
    'bundleDependencies',
  ];
  for (const field of dependencyFields) {
    const value = manifest[field];
    const count = Array.isArray(value) ? value.length : Object.keys(value ?? {}).length;
    if (count > 0) throw new Error(`Published package must not declare ${field}.`);
  }

  for (const script of ['preinstall', 'install', 'postinstall', 'prepare']) {
    if (manifest.scripts?.[script]) {
      throw new Error(`Published package must not define the ${script} lifecycle script.`);
    }
  }
};

const assertSourceMapIsPortable = async (relativePath) => {
  const absolutePath = resolve(packageDirectory, relativePath);
  const sourceMap = JSON.parse(await readFile(absolutePath, 'utf8'));
  const candidates = [sourceMap.sourceRoot, ...(sourceMap.sources ?? [])].filter(Boolean);
  for (const candidate of candidates) {
    if (
      isAbsolute(candidate) ||
      candidate.startsWith('file:') ||
      /^[A-Za-z]:[\\/]/u.test(candidate)
    ) {
      throw new Error(`Source map ${relativePath} contains an absolute source path.`);
    }
  }
};

const findStaticModuleSpecifiers = (source) => {
  const specifiers = new Set();
  const staticPattern = /(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]/gu;
  const dynamicPattern = /import\(\s*['"]([^'"]+)['"]\s*\)/gu;
  for (const pattern of [staticPattern, dynamicPattern]) {
    let match;
    while ((match = pattern.exec(source))) specifiers.add(match[1]);
  }
  return [...specifiers];
};

const resolveEmittedImport = (fromPath, specifier) => {
  if (!specifier.startsWith('.')) return null;
  const candidate = resolve(dirname(fromPath), specifier);
  return extname(candidate) ? candidate : `${candidate}.js`;
};

const assertRootGraphIsolation = async (packedPaths) => {
  const distributionDirectory = resolve(packageDirectory, 'dist');
  const entryPath = resolve(distributionDirectory, 'index.js');
  const visited = new Set();
  const pending = [entryPath];

  while (pending.length > 0) {
    const current = pending.pop();
    if (visited.has(current)) continue;
    visited.add(current);

    const emittedPath = normalize(relative(packageDirectory, current)).replaceAll('\\', '/');
    if (!packedPaths.has(emittedPath)) {
      throw new Error(`Root entry imports an emitted file missing from the tarball: ${emittedPath}`);
    }

    if (emittedPath.startsWith('dist/browser/') || emittedPath.startsWith('dist/presets/')) {
      throw new Error(`Root entry must not reach optional subpath module ${emittedPath}.`);
    }

    const source = await readFile(current, 'utf8');
    for (const specifier of findStaticModuleSpecifiers(source)) {
      const resolved = resolveEmittedImport(current, specifier);
      if (!resolved) continue;
      const relativeToDistribution = relative(distributionDirectory, resolved);
      if (relativeToDistribution.startsWith('..') || isAbsolute(relativeToDistribution)) {
        throw new Error(`Root entry imports a file outside dist: ${specifier}`);
      }
      pending.push(resolved);
    }
  }
};

export const verifyPackedDarkroomPackage = async (metadata) => {
  if (metadata.size > MAX_PACKED_BYTES) {
    throw new Error(`Packed package exceeds ${MAX_PACKED_BYTES} bytes.`);
  }
  if (metadata.unpackedSize > MAX_UNPACKED_BYTES) {
    throw new Error(`Unpacked package exceeds ${MAX_UNPACKED_BYTES} bytes.`);
  }

  const manifest = JSON.parse(
    await readFile(resolve(packageDirectory, 'package.json'), 'utf8'),
  );
  assertRuntimeDependencyFree(manifest);

  if (manifest.name !== '@coloristic.org/darkroom') {
    throw new Error('Package name does not match the intended npm scope.');
  }
  if (manifest.version === '0.0.0') {
    throw new Error('Published package must not use the placeholder 0.0.0 version.');
  }
  if (manifest.sideEffects !== false) {
    throw new Error('Package must explicitly declare sideEffects: false.');
  }

  const declaredExports = new Set(Object.keys(manifest.exports ?? {}));
  if (
    declaredExports.size !== EXPECTED_EXPORTS.size ||
    [...EXPECTED_EXPORTS].some((entry) => !declaredExports.has(entry))
  ) {
    throw new Error('Package exports must expose only ., ./browser, ./presets, and ./package.json.');
  }

  const packedPaths = new Set(metadata.files.map((file) => file.path.replaceAll('\\', '/')));
  for (const path of packedPaths) {
    if (!isAllowedPackagePath(path)) {
      throw new Error(`Unexpected file in npm tarball: ${path}`);
    }
  }
  for (const required of PACKAGE_DOCUMENTS) {
    if (!packedPaths.has(required)) throw new Error(`Required package file is missing: ${required}`);
  }

  const exportTargets = collectExportTargets(manifest.exports);
  for (const target of exportTargets) {
    if (!target.startsWith('./')) {
      throw new Error(`Package export target must be relative: ${target}`);
    }
    const path = target.slice(2);
    if (!packedPaths.has(path)) {
      throw new Error(`Package export target is absent from the tarball: ${target}`);
    }
  }

  for (const path of packedPaths) {
    if (path.endsWith('.js') && !packedPaths.has(`${path}.map`)) {
      throw new Error(`JavaScript source map is missing for ${path}.`);
    }
    if (path.endsWith('.d.ts') && !packedPaths.has(`${path}.map`)) {
      throw new Error(`Declaration map is missing for ${path}.`);
    }
    if (path.endsWith('.map')) await assertSourceMapIsPortable(path);
  }

  await assertRootGraphIsolation(packedPaths);
  return {
    fileCount: packedPaths.size,
    packedBytes: metadata.size,
    unpackedBytes: metadata.unpackedSize,
  };
};

export const npmCommand = npmExecutable;
