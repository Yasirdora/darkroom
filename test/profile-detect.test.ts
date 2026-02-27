import { describe, expect, it } from 'vitest';
import { DARKROOM_LIMITS } from '../src/limits.js';
import {
  detectInputProfileFromHeader,
  extractExifOrientation,
  type ExifOrientation,
} from '../src/profile-detect.js';

const concatBytes = (...parts: Uint8Array[]): Uint8Array => {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
};

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0));

const writeU16 = (
  bytes: Uint8Array,
  offset: number,
  value: number,
  littleEndian: boolean,
): void => {
  if (littleEndian) {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >>> 8) & 0xff;
  } else {
    bytes[offset] = (value >>> 8) & 0xff;
    bytes[offset + 1] = value & 0xff;
  }
};

const writeU32 = (
  bytes: Uint8Array,
  offset: number,
  value: number,
  littleEndian: boolean,
): void => {
  if (littleEndian) {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >>> 8) & 0xff;
    bytes[offset + 2] = (value >>> 16) & 0xff;
    bytes[offset + 3] = (value >>> 24) & 0xff;
  } else {
    bytes[offset] = (value >>> 24) & 0xff;
    bytes[offset + 1] = (value >>> 16) & 0xff;
    bytes[offset + 2] = (value >>> 8) & 0xff;
    bytes[offset + 3] = value & 0xff;
  }
};

const jpegSegment = (marker: number, payload: Uint8Array): Uint8Array => {
  if (payload.length > 65_533) throw new Error('JPEG test segment payload is too large.');
  const length = payload.length + 2;
  return concatBytes(
    Uint8Array.of(0xff, marker, (length >>> 8) & 0xff, length & 0xff),
    payload,
  );
};

const jpeg = (...segments: Uint8Array[]): Uint8Array =>
  concatBytes(Uint8Array.of(0xff, 0xd8), ...segments, Uint8Array.of(0xff, 0xd9));

const validExifPayload = (orientation: number, littleEndian = true): Uint8Array => {
  const tiff = new Uint8Array(26);
  tiff[0] = littleEndian ? 0x49 : 0x4d;
  tiff[1] = littleEndian ? 0x49 : 0x4d;
  writeU16(tiff, 2, 42, littleEndian);
  writeU32(tiff, 4, 8, littleEndian);
  writeU16(tiff, 8, 1, littleEndian);
  writeU16(tiff, 10, 0x0112, littleEndian);
  writeU16(tiff, 12, 3, littleEndian);
  writeU32(tiff, 14, 1, littleEndian);
  writeU16(tiff, 18, orientation, littleEndian);
  writeU32(tiff, 22, 0, littleEndian);
  return concatBytes(ascii('Exif\0\0'), tiff);
};

const identity: ExifOrientation = { rotation: 0, flipH: false, flipV: false };

describe('EXIF orientation parsing', () => {
  it.each<[number, ExifOrientation]>([
    [1, identity],
    [2, { rotation: 0, flipH: true, flipV: false }],
    [3, { rotation: 180, flipH: false, flipV: false }],
    [4, { rotation: 180, flipH: true, flipV: false }],
    [5, { rotation: 90, flipH: true, flipV: false }],
    [6, { rotation: 90, flipH: false, flipV: false }],
    [7, { rotation: 270, flipH: true, flipV: false }],
    [8, { rotation: 270, flipH: false, flipV: false }],
  ])('reads little-endian orientation %i', (value, expected) => {
    expect(extractExifOrientation(jpeg(jpegSegment(0xe1, validExifPayload(value))))).toEqual(
      expected,
    );
  });

  it('reads a valid big-endian orientation directory', () => {
    expect(extractExifOrientation(jpeg(jpegSegment(0xe1, validExifPayload(6, false))))).toEqual({
      rotation: 90,
      flipH: false,
      flipV: false,
    });
  });

  it('rejects an unsigned IFD offset beyond the APP1 payload', () => {
    const tiff = new Uint8Array(8);
    tiff.set([0x49, 0x49]);
    writeU16(tiff, 2, 42, true);
    writeU32(tiff, 4, 0xfffffff0, true);

    expect(
      extractExifOrientation(jpeg(jpegSegment(0xe1, concatBytes(ascii('Exif\0\0'), tiff)))),
    ).toEqual(identity);
  });

  it('rejects an IFD entry count above the parser budget', () => {
    const tiff = new Uint8Array(10);
    tiff.set([0x49, 0x49]);
    writeU16(tiff, 2, 42, true);
    writeU32(tiff, 4, 8, true);
    writeU16(tiff, 8, 0xffff, true);

    expect(
      extractExifOrientation(jpeg(jpegSegment(0xe1, concatBytes(ascii('Exif\0\0'), tiff)))),
    ).toEqual(identity);
  });

  it('rejects a truncated APP1 segment without reading beyond it', () => {
    const payload = validExifPayload(6);
    const declaredLength = payload.length + 12;
    const truncated = concatBytes(
      Uint8Array.of(
        0xff,
        0xd8,
        0xff,
        0xe1,
        (declaredLength >>> 8) & 0xff,
        declaredLength & 0xff,
      ),
      payload.subarray(0, 12),
    );

    expect(extractExifOrientation(truncated)).toEqual(identity);
  });

  it('validates byte order and TIFF magic', () => {
    const badOrder = validExifPayload(6);
    badOrder[6] = 0x58;
    badOrder[7] = 0x58;
    const badMagic = validExifPayload(6);
    badMagic[8] = 0;
    badMagic[9] = 0;

    expect(extractExifOrientation(jpeg(jpegSegment(0xe1, badOrder)))).toEqual(identity);
    expect(extractExifOrientation(jpeg(jpegSegment(0xe1, badMagic)))).toEqual(identity);
  });

  it('does not scan an orientation segment beyond the encoded-header budget', () => {
    const padding = Array.from({ length: 8 }, () =>
      jpegSegment(0xe0, new Uint8Array(65_533)),
    );
    const oversized = jpeg(...padding, jpegSegment(0xe1, validExifPayload(6)));
    expect(oversized.length).toBeGreaterThan(DARKROOM_LIMITS.maxEncodedHeaderBytes);
    expect(extractExifOrientation(oversized)).toEqual(identity);
  });
});

describe('profile-detection header limits', () => {
  it('suppresses weaker hints when the JPEG metadata header exceeds the scan budget', () => {
    const padding = Array.from({ length: 8 }, () =>
      jpegSegment(0xe0, new Uint8Array(65_533)),
    );
    const opaqueIcc = concatBytes(ascii('ICC_PROFILE\0'), Uint8Array.of(1, 1, 0));
    const oversized = jpeg(...padding, jpegSegment(0xe2, opaqueIcc));

    expect(oversized.length).toBeGreaterThan(DARKROOM_LIMITS.maxEncodedHeaderBytes);
    expect(detectInputProfileFromHeader(oversized, 'shot_s-log3.jpg')).toBeNull();
  });

  it('uses filename hints when SOS completes the metadata header within the scan budget', () => {
    const oversized = concatBytes(
      Uint8Array.of(0xff, 0xd8, 0xff, 0xda),
      new Uint8Array(DARKROOM_LIMITS.maxEncodedHeaderBytes),
    );

    expect(oversized.length).toBeGreaterThan(DARKROOM_LIMITS.maxEncodedHeaderBytes);
    expect(detectInputProfileFromHeader(oversized, 'shot_s-log3.jpg')).toBe('s-log3');
  });
});
