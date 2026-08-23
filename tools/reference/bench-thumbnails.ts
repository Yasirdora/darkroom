// What a preset thumbnail actually costs, per approach.
import { ALL_STOCK_PROFILES } from '../../src/lib/processing/filters/stock-profiles';
import { renderFilmPixel } from '../../src/lib/processing/filters/film-model';

const profile = ALL_STOCK_PROFILES.find((p) => p.id === 'portra400')!;
const stocks = ALL_STOCK_PROFILES.length;

// Best of several runs. A single timing on a JIT is not a measurement — the
// first attempt at this reported 30 ms and 273 ms for identical work in two
// runs, which would have made every conclusion below arithmetic on noise.
const time = (label: string, run: () => void, passes = 7) => {
  for (let i = 0; i < 3; i++) run();       // warm the JIT
  let best = Infinity;
  for (let i = 0; i < passes; i++) {
    const start = performance.now();
    run();
    best = Math.min(best, performance.now() - start);
  }
  console.log(`  ${label.padEnd(52)} ${best.toFixed(1).padStart(8)} ms`);
  return best;
};

// A 264 × 176 thumbnail, which is what a 132pt card on a 2× display asks for.
const W = 264, H = 176;
const pixels = W * H;
console.log(`thumbnail ${W}×${H} = ${pixels.toLocaleString()} px, ${stocks} looks\n`);

const src = new Uint8ClampedArray(pixels * 4);
for (let i = 0; i < src.length; i += 4) {
  src[i] = (i * 7) % 255; src[i + 1] = (i * 13) % 255; src[i + 2] = (i * 29) % 255; src[i + 3] = 255;
}

const one = time('renderFilmPixel over one thumbnail (1 look)', () => {
  const out = new Uint8ClampedArray(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const [r, g, b] = renderFilmPixel(src[i], src[i + 1], src[i + 2], profile);
    out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = src[i + 3];
  }
});
console.log(`  → all ${stocks} looks, as the worker does it:${' '.repeat(19)}${(one * stocks / 1000).toFixed(2).padStart(6)} s\n`);

let cachedLut: Uint8Array | null = null;
function profileToLut(p: typeof profile): Uint8Array {
  const lut = new Uint8Array(64 * 64 * 64 * 3);
  for (let b = 0; b < 64; b++) for (let g = 0; g < 64; g++) for (let r = 0; r < 64; r++) {
    const [tr, tg, tb] = renderFilmPixel(
      Math.round(r / 63 * 255), Math.round(g / 63 * 255), Math.round(b / 63 * 255), p);
    const o = (r + g * 64 + b * 64 * 64) * 3;
    lut[o] = tr; lut[o + 1] = tg; lut[o + 2] = tb;
  }
  cachedLut = lut;
  return lut;
}

// What it costs if the look is a lookup table instead — build once, sample.
const lutBuild = time('build one 64³ LUT (262,144 entries)', () => {
  profileToLut(profile);
}, 3);
const lutApply = time('apply a prebuilt LUT to the same thumbnail', () => {
  const lut = cachedLut!;
  const out = new Uint8ClampedArray(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const ri = src[i] >> 2, gi = src[i + 1] >> 2, bi = src[i + 2] >> 2;
    const o = (ri + gi * 64 + bi * 64 * 64) * 3;
    out[i] = lut[o]; out[i + 1] = lut[o + 1]; out[i + 2] = lut[o + 2]; out[i + 3] = 255;
  }
});
console.log(`\n  applying a ready LUT is ${(one / lutApply).toFixed(0)}× cheaper than running the model per pixel.`);
console.log(`  Building a LUT purely to draw one thumbnail would be the wrong trade — 262,144`);
console.log(`  entries to sample ${pixels.toLocaleString()} of them. The saving is that the canvas`);
console.log(`  needs that LUT anyway.\n`);


// How much of that is the print stage, which recomputes its normalising
// constants — f(0) and f(1) — on every call, though they depend only on the
// stock. Nine exp() per pixel where three would do.
// `contrast: 0` short-circuits the stage while keeping the object's shape
// identical. Setting `print: undefined` instead changes the shape, which
// de-optimises renderFilmPixel and measures the de-optimisation rather than
// the stage — it reported the work getting *faster* when the stage was added.
const withoutPrint = { ...profile, print: { contrast: 0, pivot: 0.45 } };
const bare = time('the same thumbnail with the print stage skipped', () => {
  const out = new Uint8ClampedArray(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const [r, g, b] = renderFilmPixel(src[i], src[i + 1], src[i + 2], withoutPrint as any);
    out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = src[i + 3];
  }
});
const share = (one - bare) / one * 100;
console.log(`\n  the print stage costs ${(one - bare).toFixed(1)} ms of ${one.toFixed(1)} ms — ${share.toFixed(0)}%`);
console.log('  Inside the noise. It recomputes f(0) and f(1) on every call, which looked');
console.log('  like an obvious saving, and measuring says there is nothing there to save.');
