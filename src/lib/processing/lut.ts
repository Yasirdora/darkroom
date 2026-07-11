import { clamp, lerp } from '../core/math';
import { ImageBuffer } from '../core/image-buffer';

export const LUT_SIZE = 64;
const LUT_ENTRIES = LUT_SIZE * LUT_SIZE * LUT_SIZE * 3;

type LutTransform = (r: number, g: number, b: number) => [number, number, number];

const sampleLut = (
  lut: Uint8Array,
  r: number,
  g: number,
  b: number,
): [number, number, number] => {
  const maxIndex = LUT_SIZE - 1;
  const rf = (r / 255) * maxIndex;
  const gf = (g / 255) * maxIndex;
  const bf = (b / 255) * maxIndex;

  const r0 = Math.floor(rf);
  const g0 = Math.floor(gf);
  const b0 = Math.floor(bf);
  const r1 = Math.min(r0 + 1, maxIndex);
  const g1 = Math.min(g0 + 1, maxIndex);
  const b1 = Math.min(b0 + 1, maxIndex);

  const rt = rf - r0;
  const gt = gf - g0;
  const bt = bf - b0;

  const read = (ri: number, gi: number, bi: number): [number, number, number] => {
    const offset = (ri + gi * LUT_SIZE + bi * LUT_SIZE * LUT_SIZE) * 3;
    return [lut[offset], lut[offset + 1], lut[offset + 2]];
  };

  const c000 = read(r0, g0, b0);
  const c100 = read(r1, g0, b0);
  const c010 = read(r0, g1, b0);
  const c110 = read(r1, g1, b0);
  const c001 = read(r0, g0, b1);
  const c101 = read(r1, g0, b1);
  const c011 = read(r0, g1, b1);
  const c111 = read(r1, g1, b1);

  const mix = (a: number, b: number, t: number) => lerp(a, b, t);

  const r00 = mix(c000[0], c100[0], rt);
  const r10 = mix(c010[0], c110[0], rt);
  const r01 = mix(c001[0], c101[0], rt);
  const r11 = mix(c011[0], c111[0], rt);
  const red = mix(mix(r00, r10, gt), mix(r01, r11, gt), bt);

  const g00 = mix(c000[1], c100[1], rt);
  const g10 = mix(c010[1], c110[1], rt);
  const g01 = mix(c001[1], c101[1], rt);
  const g11 = mix(c011[1], c111[1], rt);
  const green = mix(mix(g00, g10, gt), mix(g01, g11, gt), bt);

  const b00 = mix(c000[2], c100[2], rt);
  const b10 = mix(c010[2], c110[2], rt);
  const b01 = mix(c001[2], c101[2], rt);
  const b11 = mix(c011[2], c111[2], rt);
  const blue = mix(mix(b00, b10, gt), mix(b01, b11, gt), bt);

  return [red, green, blue];
};

/** Builds a 64³ LUT by sampling a color transform across the RGB cube. */
export const buildLut = (transform: LutTransform): Uint8Array => {
  const lut = new Uint8Array(LUT_ENTRIES);

  for (let b = 0; b < LUT_SIZE; b += 1) {
    for (let g = 0; g < LUT_SIZE; g += 1) {
      for (let r = 0; r < LUT_SIZE; r += 1) {
        const rn = Math.round((r / (LUT_SIZE - 1)) * 255);
        const gn = Math.round((g / (LUT_SIZE - 1)) * 255);
        const bn = Math.round((b / (LUT_SIZE - 1)) * 255);
        const [tr, tg, tb] = transform(rn, gn, bn);
        const offset = (r + g * LUT_SIZE + b * LUT_SIZE * LUT_SIZE) * 3;
        lut[offset] = clamp(Math.round(tr), 0, 255);
        lut[offset + 1] = clamp(Math.round(tg), 0, 255);
        lut[offset + 2] = clamp(Math.round(tb), 0, 255);
      }
    }
  }

  return lut;
};

export const applyLut = (
  source: ImageBuffer,
  lut: Uint8Array,
  intensity: number,
): ImageBuffer => {
  const amount = clamp(intensity / 100, 0, 1);
  if (amount === 0) {
    return source.clone();
  }

  const output = source.clone();
  const { data } = output;

  for (let index = 0; index < data.length; index += 4) {
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    const [lr, lg, lb] = sampleLut(lut, r, g, b);

    data[index] = Math.round(lerp(r, lr, amount));
    data[index + 1] = Math.round(lerp(g, lg, amount));
    data[index + 2] = Math.round(lerp(b, lb, amount));
  }

  return output;
};