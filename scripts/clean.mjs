import { readFile, rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED_PACKAGE_NAME = '@coloristic.org/darkroom';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(scriptDirectory, '..');
const outputDirectory = resolve(packageDirectory, 'dist');

/*
 * This deletes a directory tree, so it refuses to run anywhere it cannot first
 * confirm it is standing in this package.
 *
 * The check reads the manifest rather than comparing the folder name: a clone
 * sits in whatever directory the person cloning felt like naming, and a guard
 * that depends on that folder being called `darkroom` turns
 * `git clone <url> my-fork` into a broken build for no safety benefit.
 */
let manifestName;
try {
  const manifest = await readFile(resolve(packageDirectory, 'package.json'), 'utf8');
  manifestName = JSON.parse(manifest).name;
} catch (cause) {
  throw new Error(`Refusing to clean: no readable package.json in ${packageDirectory}.`, { cause });
}

if (manifestName !== EXPECTED_PACKAGE_NAME) {
  throw new Error(
    `Refusing to clean: expected ${EXPECTED_PACKAGE_NAME}, found ${manifestName ?? 'an unnamed package'}.`,
  );
}

if (basename(outputDirectory) !== 'dist') {
  throw new Error('Refusing to clean an unexpected output directory.');
}

await rm(outputDirectory, { force: true, recursive: true });
