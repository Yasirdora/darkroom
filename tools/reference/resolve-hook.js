// Teaches Node's ESM loader the two resolution rules Vite applies to this
// project: extensionless relative imports, and the `$lib` alias. Lets the
// reference dumper import the real engine modules with no bundler step, so
// golden values come from the exact same source the app ships.
import { registerHooks } from 'node:module';
import { statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve as resolvePath, dirname } from 'node:path';

const SRC = resolvePath(import.meta.dirname, '../../src');

registerHooks({
  resolve(specifier, context, nextResolve) {
    let spec = specifier;

    if (spec.startsWith('$lib/')) {
      spec = pathToFileURL(resolvePath(SRC, 'lib', spec.slice(5))).href;
    }

    if (spec.startsWith('.') || spec.startsWith('file:')) {
      const base = context.parentURL ? dirname(fileURLToPath(context.parentURL)) : SRC;
      const abs = spec.startsWith('file:') ? fileURLToPath(spec) : resolvePath(base, spec);

      // Must be a *file*: `./effects` sits next to a real `effects/`
      // directory, and returning the directory makes the loader read it and
      // fail with EISDIR rather than falling through to `effects/index.ts`.
      const isFile = (path) => {
        try {
          return statSync(path).isFile();
        } catch {
          return false;
        }
      };

      for (const candidate of [`${abs}.ts`, abs, `${abs}/index.ts`]) {
        if (isFile(candidate)) {
          return { url: pathToFileURL(candidate).href, shortCircuit: true, format: 'module-typescript' };
        }
      }
    }

    return nextResolve(specifier, context);
  },
});
