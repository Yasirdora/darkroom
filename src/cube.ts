import { DarkroomError } from './errors.js';
import { DARKROOM_LIMITS } from './limits.js';
import { createLut3D, ensureLut3D, isLutSize } from './lut.js';
import type { Lut3D } from './types.js';

type Triplet = readonly [number, number, number];

export interface ParseCubeOptions {
  readonly fallbackTitle?: string;
  /** Working LUT size returned by the parser. Defaults to the highest-quality 65³ grid. */
  readonly size?: 17 | 33 | 65;
}

export interface FormatCubeOptions {
  readonly precision?: number;
  readonly title?: string;
}

const FLOAT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

const parseTriplet = (value: string, line: number): Triplet => {
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 3 || fields.some((field) => !FLOAT.test(field))) {
    throw new DarkroomError('INVALID_CUBE', `Expected three finite numbers on line ${line}.`);
  }
  const triplet = fields.map(Number);
  if (triplet.some((channel) => !Number.isFinite(channel))) {
    throw new DarkroomError('INVALID_CUBE', `Non-finite value on line ${line}.`);
  }
  return triplet as unknown as Triplet;
};

const stripComment = (line: string): string => {
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '"') quoted = !quoted;
    if (line[index] === '#' && !quoted) return line.slice(0, index).trim();
  }
  return line.trim();
};

const countLines = (text: string): number => {
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1;
    if (lines > DARKROOM_LIMITS.maxCubeLines) {
      throw new DarkroomError('RESOURCE_LIMIT_EXCEEDED', '.cube file has too many lines.');
    }
  }
  return lines;
};

export const parseCube = (text: string, options: ParseCubeOptions = {}): Lut3D => {
  if (typeof text !== 'string') {
    throw new DarkroomError('INVALID_CUBE', '.cube input must be text.');
  }
  // `maxCubeBytes` bounds encoded files in the browser adapter. A direct core
  // caller supplies decoded UTF-16 text, so code units have their own explicit
  // allocation bound. This does not reject a valid ASCII file at the advertised
  // 16 MiB encoded-file limit merely because V8 stores its string as UTF-16.
  if (text.length > DARKROOM_LIMITS.maxCubeTextCodeUnits) {
    throw new DarkroomError('RESOURCE_LIMIT_EXCEEDED', '.cube text exceeds the import limit.');
  }
  const targetSize = options.size ?? 65;
  if (!isLutSize(targetSize)) {
    throw new DarkroomError('UNSUPPORTED_LUT_SIZE', 'Unsupported target LUT size.');
  }
  countLines(text);
  const lines = text.split(/\r?\n/);
  let title = options.fallbackTitle?.trim() || 'Imported LUT';
  let titleSeen = false;
  let size: number | null = null;
  let domainMin: Triplet = [0, 0, 0];
  let domainMax: Triplet = [1, 1, 1];
  let domainMinSeen = false;
  let domainMaxSeen = false;
  const values: number[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = stripComment(lines[index]);
    if (!line) continue;

    if (/^TITLE\b/i.test(line)) {
      const match = line.match(/^TITLE\s+(?:"([^"]*)"|(.+))$/i);
      if (!match || titleSeen) throw new DarkroomError('INVALID_CUBE', `Invalid TITLE on line ${lineNumber}.`);
      title = (match[1] ?? match[2]).trim() || title;
      if (title.length > 256) throw new DarkroomError('INVALID_CUBE', 'TITLE exceeds 256 characters.');
      titleSeen = true;
      continue;
    }
    if (/^LUT_1D_SIZE\b/i.test(line)) {
      throw new DarkroomError('INVALID_CUBE', '1D and combined LUTs are not supported.');
    }
    if (/^LUT_3D_SIZE\b/i.test(line)) {
      const match = line.match(/^LUT_3D_SIZE\s+(\d+)$/i);
      if (!match || size !== null) throw new DarkroomError('INVALID_CUBE', `Invalid LUT_3D_SIZE on line ${lineNumber}.`);
      size = Number(match[1]);
      if (!Number.isInteger(size) || size < 2 || size > DARKROOM_LIMITS.maxCubeSourceSize) {
        throw new DarkroomError(
          'UNSUPPORTED_LUT_SIZE',
          `LUT_3D_SIZE must be an integer between 2 and ${DARKROOM_LIMITS.maxCubeSourceSize}.`,
        );
      }
      continue;
    }
    const domainMatch = line.match(/^DOMAIN_(MIN|MAX)\s+(.+)$/i);
    if (domainMatch) {
      const minimum = domainMatch[1].toUpperCase() === 'MIN';
      if (minimum ? domainMinSeen : domainMaxSeen) {
        throw new DarkroomError('INVALID_CUBE', `Duplicate domain on line ${lineNumber}.`);
      }
      const parsed = parseTriplet(domainMatch[2], lineNumber);
      if (minimum) {
        domainMin = parsed;
        domainMinSeen = true;
      } else {
        domainMax = parsed;
        domainMaxSeen = true;
      }
      continue;
    }
    if (/^[A-Z_]+\b/i.test(line) && !FLOAT.test(line.split(/\s+/)[0])) {
      throw new DarkroomError('INVALID_CUBE', `Unsupported directive on line ${lineNumber}.`);
    }
    if (size === null) {
      throw new DarkroomError('INVALID_CUBE', `LUT_3D_SIZE must precede data (line ${lineNumber}).`);
    }
    values.push(...parseTriplet(line, lineNumber));
    if (values.length > size ** 3 * 3) {
      throw new DarkroomError('INVALID_CUBE', 'LUT contains more data rows than declared.');
    }
  }

  if (size === null) throw new DarkroomError('INVALID_CUBE', 'Missing LUT_3D_SIZE.');
  if (values.length !== size ** 3 * 3) {
    throw new DarkroomError(
      'INVALID_CUBE',
      `Expected ${size ** 3} color rows, received ${values.length / 3}.`,
    );
  }
  for (let channel = 0; channel < 3; channel += 1) {
    if (domainMin[channel] >= domainMax[channel]) {
      throw new DarkroomError('INVALID_CUBE', 'Each DOMAIN_MIN channel must be below DOMAIN_MAX.');
    }
  }

  const sourceData = Float32Array.from(values);
  if (size === targetSize) {
    return createLut3D({ size: targetSize, data: sourceData, domainMin, domainMax, title });
  }

  const output = new Float32Array(targetSize ** 3 * 3);
  const maximum = size - 1;
  const read = (red: number, green: number, blue: number, channel: number): number =>
    sourceData[(red + green * size + blue * size * size) * 3 + channel];
  const sample = (red: number, green: number, blue: number): Triplet => {
    // Sampling coordinates are physical DOMAIN values. Normalize them against
    // the source domain before interpolation so non-default domains survive
    // resampling instead of being silently baked or shifted.
    const coordinates = [red, green, blue].map((value, channel) =>
      Math.max(0, Math.min(1, (value - domainMin[channel]) / (domainMax[channel] - domainMin[channel])))
        * maximum,
    );
    const lower = coordinates.map(Math.floor);
    const upper = lower.map((value) => Math.min(maximum, value + 1));
    const fraction = coordinates.map((value, channel) => value - lower[channel]);
    const channelAt = (channel: number): number => {
      const c000 = read(lower[0], lower[1], lower[2], channel);
      const c100 = read(upper[0], lower[1], lower[2], channel);
      const c010 = read(lower[0], upper[1], lower[2], channel);
      const c110 = read(upper[0], upper[1], lower[2], channel);
      const c001 = read(lower[0], lower[1], upper[2], channel);
      const c101 = read(upper[0], lower[1], upper[2], channel);
      const c011 = read(lower[0], upper[1], upper[2], channel);
      const c111 = read(upper[0], upper[1], upper[2], channel);
      const low = (c000 + (c100 - c000) * fraction[0])
        + ((c010 + (c110 - c010) * fraction[0])
          - (c000 + (c100 - c000) * fraction[0])) * fraction[1];
      const high = (c001 + (c101 - c001) * fraction[0])
        + ((c011 + (c111 - c011) * fraction[0])
          - (c001 + (c101 - c001) * fraction[0])) * fraction[1];
      return low + (high - low) * fraction[2];
    };
    return [channelAt(0), channelAt(1), channelAt(2)];
  };

  for (let blue = 0; blue < targetSize; blue += 1) {
    for (let green = 0; green < targetSize; green += 1) {
      for (let red = 0; red < targetSize; red += 1) {
        const sampled = sample(
          domainMin[0] + (domainMax[0] - domainMin[0]) * red / (targetSize - 1),
          domainMin[1] + (domainMax[1] - domainMin[1]) * green / (targetSize - 1),
          domainMin[2] + (domainMax[2] - domainMin[2]) * blue / (targetSize - 1),
        );
        output.set(sampled, (red + green * targetSize + blue * targetSize * targetSize) * 3);
      }
    }
  }

  return createLut3D({ size: targetSize, data: output, domainMin, domainMax, title });
};

export const formatCube = (lutInput: Lut3D, options: FormatCubeOptions = {}): string => {
  const lut = ensureLut3D(lutInput);
  const precision = Math.max(1, Math.min(9, Math.round(options.precision ?? 6)));
  const title = (options.title ?? lut.title ?? 'Darkroom LUT')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replaceAll('"', "'")
    .slice(0, 256);
  const format = (value: number): string => {
    const fixed = value.toFixed(precision);
    return fixed.replace(/(?:\.0+|(?:(\.[0-9]*?)0+))$/, '$1');
  };
  const lines = [
    `TITLE "${title}"`,
    `LUT_3D_SIZE ${lut.size}`,
    `DOMAIN_MIN ${lut.domainMin.map(format).join(' ')}`,
    `DOMAIN_MAX ${lut.domainMax.map(format).join(' ')}`,
    '',
  ];
  for (let offset = 0; offset < lut.data.length; offset += 3) {
    lines.push(`${format(lut.data[offset])} ${format(lut.data[offset + 1])} ${format(lut.data[offset + 2])}`);
  }
  return `${lines.join('\n')}\n`;
};
