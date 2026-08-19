// Makes the browser-targeted engine loadable under Node, so the reference
// dumper can call the real implementations rather than a reimplementation.
//
// Two things are needed. Node's ESM loader does not apply Vite's resolution
// rules — extensionless relative imports and the `$lib` alias — and it has no
// `ImageData`, which the pixel-level modules take and return.
import { registerHooks } from 'node:module';
import { statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve as resolvePath, dirname } from 'node:path';

// Minimal stand-in for the browser's ImageData. The engine only ever reads
// `data`, `width` and `height` off it, so a fuller implementation would be
// unused surface — and any behaviour it invented could diverge from the real
// thing without anything noticing.
if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = class ImageData {
    constructor(data, width, height) {
      if (typeof data === 'number') {
        // The (width, height) overload the spec also allows.
        this.width = data;
        this.height = width;
        this.data = new Uint8ClampedArray(this.width * this.height * 4);
        return;
      }
      this.data = data;
      this.width = width;
      this.height = height ?? data.length / 4 / width;
    }
  };
}

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
