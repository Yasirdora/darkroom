// What the 8-bit look cube costs against evaluating the model directly.
//
// The rest of the pipeline is float: the working space is extended linear sRGB
// in half-float, the curve stage uploads an RGBAf texture. The look is the one
// stage that quantises, and this measures by how much.
import { ALL_STOCK_PROFILES } from '../../src/lib/processing/filters/stock-profiles';
import { renderFilmPixel } from '../../src/lib/processing/filters/film-model';

const SIZE = 64;

const buildCube = (profile: any): Uint8Array => {
  const lut = new Uint8Array(SIZE * SIZE * SIZE * 3);
  for (let b = 0; b < SIZE; b++)
    for (let g = 0; g < SIZE; g++)
      for (let r = 0; r < SIZE; r++) {
        const [tr, tg, tb] = renderFilmPixel(
          Math.round((r / (SIZE - 1)) * 255),
          Math.round((g / (SIZE - 1)) * 255),
          Math.round((b / (SIZE - 1)) * 255),
          profile,
        );
        const o = (r + g * SIZE + b * SIZE * SIZE) * 3;
        lut[o] = Math.round(tr);
        lut[o + 1] = Math.round(tg);
        lut[o + 2] = Math.round(tb);
      }
  return lut;
};

/** Trilinear sample, as Core Image does between lattice points. */
const sample = (lut: Uint8Array, r: number, g: number, b: number): [number, number, number] => {
  const scale = (SIZE - 1) / 255;
  const fr = r * scale, fg = g * scale, fb = b * scale;
  const r0 = Math.floor(fr), g0 = Math.floor(fg), b0 = Math.floor(fb);
  const r1 = Math.min(r0 + 1, SIZE - 1), g1 = Math.min(g0 + 1, SIZE - 1), b1 = Math.min(b0 + 1, SIZE - 1);
  const dr = fr - r0, dg = fg - g0, db = fb - b0;

  const at = (ri: number, gi: number, bi: number, c: number) =>
    lut[(ri + gi * SIZE + bi * SIZE * SIZE) * 3 + c];

  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const c00 = at(r0, g0, b0, c) * (1 - dr) + at(r1, g0, b0, c) * dr;
    const c10 = at(r0, g1, b0, c) * (1 - dr) + at(r1, g1, b0, c) * dr;
    const c01 = at(r0, g0, b1, c) * (1 - dr) + at(r1, g0, b1, c) * dr;
    const c11 = at(r0, g1, b1, c) * (1 - dr) + at(r1, g1, b1, c) * dr;
    const c0 = c00 * (1 - dg) + c10 * dg;
    const c1 = c01 * (1 - dg) + c11 * dg;
    out[c] = c0 * (1 - db) + c1 * db;
  }
  return out;
};

const stocks = ['portra400', 'velvia50', 'bleachBypass', 'magicNatural', 'gold200']
  .map((id) => ALL_STOCK_PROFILES.find((p) => p.id === id)!)
  .filter(Boolean);

console.log('LOOK CUBE ACCURACY — 8-bit 64³ against the model evaluated directly\n');
console.log(`  ${'look'.padEnd(16)} ${'mean'.padStart(7)} ${'p99'.padStart(7)} ${'max'.padStart(7)}   worst at`);
console.log('  ' + '-'.repeat(64));

let worstOverall = 0;
for (const profile of stocks) {
  const lut = buildCube(profile);
  const errors: number[] = [];
  let max = 0, worstAt = '';

  // A stratified sweep, plus the near-neutral axis where banding shows most.
  for (let i = 0; i <= 40; i++)
    for (let j = 0; j <= 40; j++)
      for (let k = 0; k <= 12; k++) {
        const r = (i / 40) * 255, g = (j / 40) * 255, b = (k / 12) * 255;
        const exact = renderFilmPixel(r, g, b, profile);
        const viaLut = sample(lut, r, g, b);
        for (let c = 0; c < 3; c++) {
          const e = Math.abs(exact[c] - viaLut[c]);
          errors.push(e);
          if (e > max) { max = e; worstAt = `(${r.toFixed(0)},${g.toFixed(0)},${b.toFixed(0)})`; }
        }
      }

  errors.sort((a, b) => a - b);
  const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
  const p99 = errors[Math.floor(errors.length * 0.99)];
  worstOverall = Math.max(worstOverall, max);
  console.log(
    `  ${profile.id.padEnd(16)} ${mean.toFixed(2).padStart(7)} ${p99.toFixed(2).padStart(7)} ` +
    `${max.toFixed(2).padStart(7)}   ${worstAt}`,
  );
}

console.log(`\n  worst error anywhere: ${worstOverall.toFixed(2)} code values`);
console.log('  (0.5 is the floor: a value rounded into 8 bits is already half a code out)');

