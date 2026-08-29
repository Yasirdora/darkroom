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

  // Clamped so the upper corner is always a valid index.
  const r0 = Math.min(Math.floor(rf), maxIndex - 1);
  const g0 = Math.min(Math.floor(gf), maxIndex - 1);
  const b0 = Math.min(Math.floor(bf), maxIndex - 1);

  const dr = rf - r0;
  const dg = gf - g0;
  const db = bf - b0;

  const read = (ri: number, gi: number, bi: number): [number, number, number] => {
    const offset = (ri + gi * size + bi * size * size) * 3;
    return [lut[offset], lut[offset + 1], lut[offset + 2]];
  };
  const at = (x: number, y: number, z: number) => read(r0 + x, g0 + y, b0 + z);

  const c000 = at(0, 0, 0);
  const c111 = at(1, 1, 1);

  // Tetrahedral, matching the engine's own cube samplers in ColorCube.swift and
  // darkroomLookCube. Trilinear blends all eight corners, six of which are off
  // the neutral axis, so resampling a saturating LUT pulled its greys off grey.
  // An imported LUT should come back the shape its author drew.
  const walk = (
    from: [number, number, number],
    to: [number, number, number],
    i: 0 | 1 | 2,
  ) => from[i] - to[i];

  const combine = (
    p: [number, number, number], q: [number, number, number],
    u: [number, number, number], v: [number, number, number],
    w: [number, number, number], x: [number, number, number],
  ): [number, number, number] =>
    [0, 1, 2].map(
      (i) =>
        c000[i as 0] +
        walk(p, q, i as 0) * dr +
        walk(u, v, i as 0) * dg +
        walk(w, x, i as 0) * db,
    ) as [number, number, number];

  if (dr > dg) {
    if (dg > db) {
      const e1 = at(1, 0, 0), e2 = at(1, 1, 0);
      return combine(e1, c000, e2, e1, c111, e2);
    }
    if (dr > db) {
      const e1 = at(1, 0, 0), e2 = at(1, 0, 1);
      return combine(e1, c000, c111, e2, e2, e1);
    }
    const e1 = at(0, 0, 1), e2 = at(1, 0, 1);
    return combine(e2, e1, c111, e2, e1, c000);
  }
  if (db > dg) {
    const e1 = at(0, 0, 1), e2 = at(0, 1, 1);
    return combine(c111, e2, e2, e1, e1, c000);
  }
  if (db > dr) {
    const e1 = at(0, 1, 0), e2 = at(0, 1, 1);
    return combine(c111, e2, e1, c000, e2, e1);
  }
  const e1 = at(0, 1, 0), e2 = at(1, 1, 0);
  return combine(e2, e1, e1, c000, c111, e2);
};

/** Tetrahedral resample to the editor's working 64³ LUT size. */
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