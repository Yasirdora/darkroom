import { ALL_STOCK_PROFILES } from '../../src/lib/processing/filters/stock-profiles';
import { renderFilmPixel } from '../../src/lib/processing/filters/film-model';

const id = process.argv[2] ?? 'portra400';
const profile = ALL_STOCK_PROFILES.find((p) => p.id === id);
if (!profile) throw new Error(`no stock ${id}`);

const luma = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
let prev: number | null = null;
for (let v = 200; v <= 224; v += 2) {
  const out = renderFilmPixel(v, v, v, profile);
  const L = luma(out);
  const drop = prev !== null && L < prev - 0.4 ? `   DROPS ${(prev - L).toFixed(1)}` : '';
  console.log(`  in ${String(v).padStart(3)}   out ${out.map((x) => x.toFixed(1).padStart(6)).join(' ')}   luma ${L.toFixed(1).padStart(6)}${drop}`);
  prev = L;
}
