import { LUT_SIZE } from './lut';

export interface ParsedCubeLut {
  title: string;
  size: number;
  data: Uint8Array;
}

const TITLE_RE = /^TITLE\s+"([^"]*)"/i;
const TITLE_PLAIN_RE = /^TITLE\s+(.+)$/i;
const SIZE_RE = /^LUT_3D_SIZE\s+(\d+)/i;

const parseFloatTriplet = (line: string): [number, number, number] | null => {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 3) return null;
  const r = Number(parts[0]);
  const g = Number(parts[1]);
  const b = Number(parts[2]);
  if (![r, g, b].every((value) => Number.isFinite(value))) return null;
  return [r, g, b];
};

const sampleSource = (
  lut: Uint8Array,
  size: number,
  r: number,
  g: number,
  b: number,
): [number, number, number] => {
  const maxIndex = size - 1;
  const rf = (r / (LUT_SIZE - 1)) * maxIndex;
  const gf = (g / (LUT_SIZE - 1)) * maxIndex;
  const bf = (b / (LUT_SIZE - 1)) * maxIndex;

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
    const offset = (ri + gi * size + bi * size * size) * 3;
    return [lut[offset], lut[offset + 1], lut[offset + 2]];
  };

  const mix = (a: number, b: number, t: number) => a + (b - a) * t;

  const c000 = read(r0, g0, b0);
  const c100 = read(r1, g0, b0);
  const c010 = read(r0, g1, b0);
  const c110 = read(r1, g1, b0);
  const c001 = read(r0, g0, b1);
  const c101 = read(r1, g0, b1);
  const c011 = read(r0, g1, b1);
  const c111 = read(r1, g1, b1);

  const mixChannel = (index: 0 | 1 | 2) => {
    const r00 = mix(c000[index], c100[index], rt);
    const r10 = mix(c010[index], c110[index], rt);
    const r01 = mix(c001[index], c101[index], rt);
    const r11 = mix(c011[index], c111[index], rt);
    return mix(mix(r00, r10, gt), mix(r01, r11, gt), bt);
  };

  return [mixChannel(0), mixChannel(1), mixChannel(2)];
};

/** Trilinear resample to the editor's working 64³ LUT size. */
export const resampleCubeLut = (lut: Uint8Array, size: number): Uint8Array => {
  if (size === LUT_SIZE) return lut;

  const output = new Uint8Array(LUT_SIZE * LUT_SIZE * LUT_SIZE * 3);
  for (let b = 0; b < LUT_SIZE; b += 1) {
    for (let g = 0; g < LUT_SIZE; g += 1) {
      for (let r = 0; r < LUT_SIZE; r += 1) {
        const [tr, tg, tb] = sampleSource(lut, size, r, g, b);
        const offset = (r + g * LUT_SIZE + b * LUT_SIZE * LUT_SIZE) * 3;
        output[offset] = Math.max(0, Math.min(255, Math.round(tr)));
        output[offset + 1] = Math.max(0, Math.min(255, Math.round(tg)));
        output[offset + 2] = Math.max(0, Math.min(255, Math.round(tb)));
      }
    }
  }
  return output;
};

export const parseCubeFile = (text: string): ParsedCubeLut => {
  const lines = text.split(/\r?\n/);
  let title = 'Imported LUT';
  let size = 0;
  const values: Array<[number, number, number]> = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const titleMatch = line.match(TITLE_RE) ?? line.match(TITLE_PLAIN_RE);
    if (titleMatch) {
      title = titleMatch[1].trim() || title;
      continue;
    }

    const sizeMatch = line.match(SIZE_RE);
    if (sizeMatch) {
      size = Number(sizeMatch[1]);
      continue;
    }

    if (/^DOMAIN_(MIN|MAX)/i.test(line)) continue;

    const triplet = parseFloatTriplet(line);
    if (triplet) values.push(triplet);
  }

  if (!size || size < 2) {
    throw new Error('Missing or invalid LUT_3D_SIZE in .cube file.');
  }

  const expected = size * size * size;
  if (values.length < expected) {
    throw new Error(`Expected ${expected} RGB triplets, found ${values.length}.`);
  }

  const isFloat01 = values.every(([r, g, b]) => r <= 1.001 && g <= 1.001 && b <= 1.001);
  const data = new Uint8Array(expected * 3);

  for (let i = 0; i < expected; i += 1) {
    const [r, g, b] = values[i];
    const offset = i * 3;
    if (isFloat01) {
      data[offset] = Math.round(Math.max(0, Math.min(1, r)) * 255);
      data[offset + 1] = Math.round(Math.max(0, Math.min(1, g)) * 255);
      data[offset + 2] = Math.round(Math.max(0, Math.min(1, b)) * 255);
    } else {
      data[offset] = Math.round(Math.max(0, Math.min(255, r)));
      data[offset + 1] = Math.round(Math.max(0, Math.min(255, g)));
      data[offset + 2] = Math.round(Math.max(0, Math.min(255, b)));
    }
  }

  const resampled = resampleCubeLut(data, size);

  return {
    title,
    size: LUT_SIZE,
    data: resampled,
  };
};

export const readCubeFile = async (file: File): Promise<ParsedCubeLut> => {
  const text = await file.text();
  return parseCubeFile(text);
};