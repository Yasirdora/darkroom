// Trilinear against tetrahedral, on a 64-cube look.
//
// Core Image's CIColorCube interpolates trilinearly: it blends all eight
// lattice corners around the sample. Six of those corners are off the neutral
// axis, so on a saturating look they drag grey off grey. Tetrahedral
// interpolation walks the cube's diagonal instead, and on the neutral axis it
// touches only the two neutral corners — which is why every professional LUT
// application uses it. This measures the difference rather than asserting it.
import { ALL_STOCK_PROFILES } from '../../src/lib/processing/filters/stock-profiles';
import { renderFilmPixel } from '../../src/lib/processing/filters/film-model';

const SIZE = 64;
type RGB = [number, number, number];

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

/** The same cube without the 8-bit step, to separate quantisation from interpolation. */
const buildCubeFloat = (profile: any): Float32Array => {
  const lut = new Float32Array(SIZE * SIZE * SIZE * 3);
  for (let b = 0; b < SIZE; b++)
    for (let g = 0; g < SIZE; g++)
      for (let r = 0; r < SIZE; r++) {
        const [tr, tg, tb] = renderFilmPixel(
          (r / (SIZE - 1)) * 255, (g / (SIZE - 1)) * 255, (b / (SIZE - 1)) * 255, profile,
        );
        const o = (r + g * SIZE + b * SIZE * SIZE) * 3;
        lut[o] = tr; lut[o + 1] = tg; lut[o + 2] = tb;
      }
  return lut;
};

const corners = (lut: Uint8Array | Float32Array, r: number, g: number, b: number) => {
  const scale = (SIZE - 1) / 255;
  const fr = r * scale, fg = g * scale, fb = b * scale;
  const r0 = Math.min(Math.floor(fr), SIZE - 2);
  const g0 = Math.min(Math.floor(fg), SIZE - 2);
  const b0 = Math.min(Math.floor(fb), SIZE - 2);
  const at = (dr: number, dg: number, db: number): RGB => {
    const o = ((r0 + dr) + (g0 + dg) * SIZE + (b0 + db) * SIZE * SIZE) * 3;
    return [lut[o], lut[o + 1], lut[o + 2]];
  };
  return { at, dr: fr - r0, dg: fg - g0, db: fb - b0 };
};

const trilinear = (lut: Uint8Array | Float32Array, r: number, g: number, b: number): RGB => {
  const { at, dr, dg, db } = corners(lut, r, g, b);
  const out: RGB = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const lerp = (a: number, z: number, t: number) => a + (z - a) * t;
    const c00 = lerp(at(0, 0, 0)[c], at(1, 0, 0)[c], dr);
    const c10 = lerp(at(0, 1, 0)[c], at(1, 1, 0)[c], dr);
    const c01 = lerp(at(0, 0, 1)[c], at(1, 0, 1)[c], dr);
    const c11 = lerp(at(0, 1, 1)[c], at(1, 1, 1)[c], dr);
    out[c] = lerp(lerp(c00, c10, dg), lerp(c01, c11, dg), db);
  }
  return out;
};

/**
 * Tetrahedral: the unit cube splits into six tetrahedra, and which one the
 * sample falls in is decided by the ordering of the three fractions. Each
 * result is the base corner plus three edge walks, so only four of the eight
 * corners contribute. On the diagonal dr == dg == db every intermediate term
 * cancels and the result is a straight line between the two neutral corners.
 */
const tetrahedral = (lut: Uint8Array | Float32Array, r: number, g: number, b: number): RGB => {
  const { at, dr, dg, db } = corners(lut, r, g, b);
  const c000 = at(0, 0, 0);
  const out: RGB = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const v = (x: number, y: number, z: number) => at(x, y, z)[c];
    const base = c000[c];
    let acc: number;
    if (dr > dg) {
      if (dg > db) acc = (v(1,0,0) - base) * dr + (v(1,1,0) - v(1,0,0)) * dg + (v(1,1,1) - v(1,1,0)) * db;
      else if (dr > db) acc = (v(1,0,0) - base) * dr + (v(1,1,1) - v(1,0,1)) * dg + (v(1,0,1) - v(1,0,0)) * db;
      else acc = (v(1,0,1) - v(0,0,1)) * dr + (v(1,1,1) - v(1,0,1)) * dg + (v(0,0,1) - base) * db;
    } else {
      if (db > dg) acc = (v(1,1,1) - v(0,1,1)) * dr + (v(0,1,1) - v(0,0,1)) * dg + (v(0,0,1) - base) * db;
      else if (db > dr) acc = (v(1,1,1) - v(0,1,1)) * dr + (v(0,1,0) - base) * dg + (v(0,1,1) - v(0,1,0)) * db;
      else acc = (v(1,1,0) - v(0,1,0)) * dr + (v(0,1,0) - base) * dg + (v(1,1,1) - v(1,1,0)) * db;
    }
    out[c] = base + acc;
  }
  return out;
};

interface Stat { mean: number; max: number; worstAt: string }
const measure = (
  profile: any, lut: Uint8Array | Float32Array,
  sampler: (l: any, r: number, g: number, b: number) => RGB,
  points: RGB[],
): Stat => {
  let sum = 0, n = 0, max = 0, worstAt = '';
  for (const [r, g, b] of points) {
    const want = renderFilmPixel(r, g, b, profile);
    const got = sampler(lut, r, g, b);
    for (let c = 0; c < 3; c++) {
      const e = Math.abs(want[c] - got[c]);
      sum += e; n++;
      if (e > max) { max = e; worstAt = `(${r.toFixed(0)},${g.toFixed(0)},${b.toFixed(0)})`; }
    }
  }
  return { mean: sum / n, max, worstAt };
};

// Two loci: the neutral axis, where a cast is most visible, and the whole gamut.
const neutralPoints: RGB[] = [];
for (let v = 0; v <= 255; v += 0.5) neutralPoints.push([v, v, v]);

const gamutPoints: RGB[] = [];
for (let i = 0; i <= 24; i++)
  for (let j = 0; j <= 24; j++)
    for (let k = 0; k <= 24; k++)
      gamutPoints.push([(i / 24) * 255, (j / 24) * 255, (k / 24) * 255]);

const looks = process.argv.slice(2).length
  ? ALL_STOCK_PROFILES.filter((p) => process.argv.slice(2).includes(p.id))
  : ALL_STOCK_PROFILES;

const row = (s: string, a: Stat, b: Stat) =>
  `  ${s.padEnd(18)}${a.mean.toFixed(2).padStart(6)}${a.max.toFixed(2).padStart(8)}   ` +
  `${b.mean.toFixed(2).padStart(6)}${b.max.toFixed(2).padStart(8)}`;

let worstTriNeutral = 0, worstTetNeutral = 0, worstTriGamut = 0, worstTetGamut = 0;
let worstTriLook = '', worstTetLook = '';
const floatRows: string[] = [];

console.log('\nNEUTRAL AXIS — every grey from black to white, in half-code steps');
console.log('  error against the model, in 8-bit code values\n');
console.log('  look                 trilinear          tetrahedral');
console.log('                      mean     max       mean     max');
for (const profile of looks) {
  const lut = buildCube(profile);
  const tri = measure(profile, lut, trilinear, neutralPoints);
  const tet = measure(profile, lut, tetrahedral, neutralPoints);
  if (tri.max > worstTriNeutral) { worstTriNeutral = tri.max; worstTriLook = profile.id; }
  if (tet.max > worstTetNeutral) { worstTetNeutral = tet.max; worstTetLook = profile.id; }
  const flut = buildCubeFloat(profile);
  const tetF = measure(profile, flut, tetrahedral, neutralPoints);
  floatRows.push(`  ${profile.id.padEnd(18)}${tetF.mean.toFixed(2).padStart(6)}${tetF.max.toFixed(2).padStart(8)}   worst at ${tetF.worstAt}`);
  const triG = measure(profile, lut, trilinear, gamutPoints);
  const tetG = measure(profile, lut, tetrahedral, gamutPoints);
  worstTriGamut = Math.max(worstTriGamut, triG.max);
  worstTetGamut = Math.max(worstTetGamut, tetG.max);
  console.log(row(profile.id, tri, tet));
}

console.log(`\n  worst on the neutral axis:  trilinear ${worstTriNeutral.toFixed(2)} (${worstTriLook})` +
            `   tetrahedral ${worstTetNeutral.toFixed(2)} (${worstTetLook})`);
console.log(`  worst anywhere in gamut:    trilinear ${worstTriGamut.toFixed(2)}` +
            `   tetrahedral ${worstTetGamut.toFixed(2)}`);
console.log('\nSAME, WITH A FLOAT CUBE — isolates what the 8-bit step costs\n');
console.log('  look                 tetrahedral, float');
console.log('                      mean     max');
for (const r of floatRows) console.log(r);
console.log('\n  0.5 is the floor: a value rounded into 8 bits is already half a code out.');
