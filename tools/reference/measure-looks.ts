// Measures every look's LUT against identity.
//
// Answers one question with numbers instead of impressions: how far does a look
// actually move a pixel, and — the part that turned out to matter — what does it
// do to contrast. Run before and after a change to the film model to see whether
// the change did what it claimed.
//
// Usage: npm run measure:looks

import { FILTER_PRESETS } from '../../src/lib/processing/filters/presets';

const SIZE = 64;
const STEP = 3;

const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

type Row = {
  id: string;
  category: string;
  mean: number;
  contrast: number;
  sat: number;
  cast: number;
  black: number;
};

const measure = (id: string, category: string, lut: Uint8Array): Row => {
  const at = (r: number, g: number, b: number) => {
    const o = (r + g * SIZE + b * SIZE * SIZE) * 3;
    return [lut[o] / 255, lut[o + 1] / 255, lut[o + 2] / 255] as const;
  };

  let total = 0;
  let n = 0;
  let chromaIn = 0;
  let chromaOut = 0;
  for (let b = 0; b < SIZE; b += STEP) {
    for (let g = 0; g < SIZE; g += STEP) {
      for (let r = 0; r < SIZE; r += STEP) {
        const inp = [r / (SIZE - 1), g / (SIZE - 1), b / (SIZE - 1)] as const;
        const out = at(r, g, b);
        total += ((Math.abs(out[0] - inp[0]) + Math.abs(out[1] - inp[1]) + Math.abs(out[2] - inp[2])) / 3) * 255;
        n += 1;
        const ci = Math.max(...inp) - Math.min(...inp);
        if (ci > 0.12) {
          chromaIn += ci;
          chromaOut += Math.max(...out) - Math.min(...out);
        }
      }
    }
  }

  const neutral = (t: number) => {
    const i = Math.round(t * (SIZE - 1));
    return at(i, i, i);
  };
  const spread = (c: readonly [number, number, number]) => (Math.max(...c) - Math.min(...c)) * 255;
  const n25 = neutral(0.25);
  const n50 = neutral(0.5);
  const n75 = neutral(0.75);

  return {
    id,
    category,
    mean: total / n,
    contrast: (luma(...n75) - luma(...n25)) / 0.5,
    sat: chromaIn > 0 ? chromaOut / chromaIn : 1,
    cast: Math.max(spread(n25), spread(n50), spread(n75)),
    black: luma(...neutral(0)) * 255,
  };
};

const rows = FILTER_PRESETS.filter((p) => p.id !== 'none').map((p) =>
  measure(p.id, p.category, p.buildLut()),
);

const colour = rows.filter((r) => r.sat >= 0.1);
const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];

console.log(`${'look'.padEnd(20)} ${'cat'.padEnd(9)} ${'mean'.padStart(6)} ${'ctr'.padStart(5)} ${'sat'.padStart(5)} ${'cast'.padStart(5)} ${'blk'.padStart(5)}`);
console.log('-'.repeat(62));
for (const r of rows.slice().sort((a, b) => b.contrast - a.contrast)) {
  console.log(
    `${r.id.padEnd(20)} ${r.category.padEnd(9)} ${r.mean.toFixed(1).padStart(6)} ${r.contrast.toFixed(2).padStart(5)} ` +
      `${r.sat.toFixed(2).padStart(5)} ${r.cast.toFixed(0).padStart(5)} ${r.black.toFixed(0).padStart(5)}`,
  );
}

const cs = colour.map((r) => r.contrast);
const ms = colour.map((r) => r.mean);
console.log();
console.log(`colour looks: ${colour.length}`);
console.log(`  contrast  min ${Math.min(...cs).toFixed(2)}  median ${median(cs).toFixed(2)}  max ${Math.max(...cs).toFixed(2)}`);
console.log(`  flat (0.95-1.10): ${cs.filter((c) => c >= 0.95 && c <= 1.1).length} of ${cs.length}`);
console.log(`  mean      min ${Math.min(...ms).toFixed(1)}  median ${median(ms).toFixed(1)}  max ${Math.max(...ms).toFixed(1)}`);
console.log(`  cast      median ${median(colour.map((r) => r.cast)).toFixed(0)}`);
