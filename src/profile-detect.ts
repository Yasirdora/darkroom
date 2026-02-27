import type { InputProfileId } from './types.js';
import { DARKROOM_LIMITS } from './limits.js';

const boundEncodedHeader = (bytes: Uint8Array): Uint8Array =>
  bytes.length > DARKROOM_LIMITS.maxEncodedHeaderBytes
    ? bytes.subarray(0, DARKROOM_LIMITS.maxEncodedHeaderBytes)
    : bytes;

const MAX_JPEG_HEADER_SEGMENTS = 4096;

const decodeLatin1 = (bytes: Uint8Array): string => {
  let output = '';
  // ICC `desc` and `text` payloads are bounded by the parser before reaching
  // this helper, so direct byte-to-code-unit decoding is sufficient and keeps
  // the root entry independent of DOM and Node text-decoder globals.
  for (let index = 0; index < bytes.length; index += 1) {
    output += String.fromCharCode(bytes[index]);
  }
  return output;
};

export type InputProfileDetectionSource = 'embedded-icc' | 'exif' | 'filename';

export interface InputProfileDetection {
  profile: InputProfileId;
  source: InputProfileDetectionSource;
}

const hasDelimitedToken = (value: string, expression: string): boolean =>
  new RegExp(`(?:^|[^a-z0-9])(?:${expression})(?=$|[^a-z0-9])`, 'i').test(value);

const matchProfileName = (name: string): InputProfileId | null => {
  // DCI-P3 (DCI white/gamma) and ProPhoto/ROMM are not Display P3. Leave
  // unsupported profiles to browser color management instead of applying a
  // knowingly incorrect matrix and transfer function.
  if (
    hasDelimitedToken(name, 'dci[\\s_-]*p3') ||
    hasDelimitedToken(name, 'prophoto(?:[\\s_-]+rgb)?') ||
    hasDelimitedToken(name, 'romm[\\s_-]+rgb')
  ) return null;

  // Generation-less camera/vendor names do not prove an encoding transfer.
  // In particular, LogC4 must never be decoded with the LogC3 transform.
  if (hasDelimitedToken(name, 'log[\\s_-]*c[\\s_-]*4')) return null;
  if (hasDelimitedToken(name, 'display[\\s_-]+p3') || hasDelimitedToken(name, 'p3[\\s_-]+d65')) {
    return 'display-p3';
  }
  if (hasDelimitedToken(name, 'log[\\s_-]*c[\\s_-]*3')) {
    return 'arri-logc3';
  }
  if (hasDelimitedToken(name, '(?:red[\\s_-]*)?log[\\s_-]*3g10')) {
    return 'red-log3g10';
  }
  if (hasDelimitedToken(name, 's[\\s_-]*log[\\s_-]*3')) {
    return 's-log3';
  }

  const isBlackmagic = hasDelimitedToken(name, 'bmd|blackmagic(?:[\\s_-]+design)?');
  const isGeneration5 = hasDelimitedToken(name, '(?:generation|gen)[\\s_-]*5');
  const isGeneration4 = hasDelimitedToken(name, '(?:generation|gen)[\\s_-]*4');
  if (
    (isBlackmagic && isGeneration5) ||
    hasDelimitedToken(name, 'film[\\s_-]+(?:generation|gen)[\\s_-]*5')
  ) {
    return 'bmd-film-gen5';
  }
  if (
    (isBlackmagic && isGeneration4) ||
    hasDelimitedToken(name, 'film[\\s_-]+(?:generation|gen)[\\s_-]*4')
  ) {
    return 'bmd-film-gen4';
  }
  if (
    hasDelimitedToken(name, 'davinci[\\s_-]+intermediate') ||
    hasDelimitedToken(name, 'dwg[\\s_/-]+intermediate')
  ) {
    return 'davinci-intermediate';
  }
  if (hasDelimitedToken(name, 'v[\\s_-]*log')) {
    return 'v-log';
  }
  if (hasDelimitedToken(name, 'c[\\s_-]*log[\\s_-]*3')) {
    return 'c-log3';
  }
  if (
    hasDelimitedToken(name, 'rec[.\\s_-]*709') ||
    hasDelimitedToken(name, 'bt[.\\s_-]*1886')
  ) {
    return 'rec709';
  }
  if (hasDelimitedToken(name, 's[\\s_-]*rgb')) {
    return 'standard';
  }

  return null;
};

interface EmbeddedProfileRead {
  present: boolean;
  description: string | null;
}

const noEmbeddedProfile = (): EmbeddedProfileRead => ({
  present: false,
  description: null,
});

const unreadableEmbeddedProfile = (): EmbeddedProfileRead => ({
  present: true,
  description: null,
});

const readJpegIcc = (bytes: Uint8Array): EmbeddedProfileRead => {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return noEmbeddedProfile();

  let offset = 2;
  let chunkCount: number | null = null;
  let chunks: Array<Uint8Array | undefined> = [];
  const identifier = 'ICC_PROFILE\0';
  let profileSegmentSeen = false;

  const malformedResult = (): EmbeddedProfileRead =>
    profileSegmentSeen ? unreadableEmbeddedProfile() : noEmbeddedProfile();

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return malformedResult();

    // JPEG permits any number of 0xff fill bytes before a marker.
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return malformedResult();

    const marker = bytes[offset];
    offset += 1;

    if (marker === 0xd9 || marker === 0xda) break;

    // TEM and restart markers have no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;

    if (offset + 2 > bytes.length) return malformedResult();
    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2 || segmentLength > bytes.length - offset) return malformedResult();

    const segmentStart = offset + 2;
    const segmentEnd = offset + segmentLength;

    if (marker === 0xe2) {
      const identifierEnd = segmentStart + identifier.length;
      const metadataEnd = segmentStart + identifier.length + 2;
      if (identifierEnd <= segmentEnd) {
        let matchesIdentifier = true;
        for (let i = 0; i < identifier.length; i += 1) {
          if (bytes[segmentStart + i] !== identifier.charCodeAt(i)) {
            matchesIdentifier = false;
            break;
          }
        }

        if (matchesIdentifier) {
          profileSegmentSeen = true;
          if (metadataEnd > segmentEnd) return unreadableEmbeddedProfile();

          const sequence = bytes[segmentStart + identifier.length];
          const declaredCount = bytes[segmentStart + identifier.length + 1];
          if (declaredCount === 0 || sequence === 0 || sequence > declaredCount) {
            return unreadableEmbeddedProfile();
          }

          if (chunkCount === null) {
            chunkCount = declaredCount;
            chunks = new Array<Uint8Array | undefined>(chunkCount);
          } else if (declaredCount !== chunkCount) {
            return unreadableEmbeddedProfile();
          }

          if (chunks[sequence - 1] !== undefined || metadataEnd === segmentEnd) {
            return unreadableEmbeddedProfile();
          }
          chunks[sequence - 1] = bytes.subarray(metadataEnd, segmentEnd);
        }
      }
    }

    offset = segmentEnd;
  }

  if (chunkCount === null) return noEmbeddedProfile();
  for (let index = 0; index < chunkCount; index += 1) {
    if (chunks[index] === undefined) return unreadableEmbeddedProfile();
  }

  const completeChunks = chunks as Uint8Array[];
  const totalLength = completeChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const icc = new Uint8Array(totalLength);
  let writeOffset = 0;
  completeChunks.forEach((chunk) => {
    icc.set(chunk, writeOffset);
    writeOffset += chunk.length;
  });

  return {
    present: true,
    description: readIccDescription(icc),
  };
};

/**
 * Reports whether a bounded JPEG prefix contains the marker that terminates
 * its metadata header. When the prefix ends first, an embedded ICC profile may
 * still exist outside the scan budget, so weaker EXIF and filename heuristics
 * must not be trusted.
 */
const hasCompleteJpegMetadataHeader = (bytes: Uint8Array): boolean => {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return true;

  let offset = 2;
  let segmentCount = 0;
  while (offset < bytes.length && segmentCount < MAX_JPEG_HEADER_SEGMENTS) {
    if (bytes[offset] !== 0xff) return false;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return false;

    const marker = bytes[offset];
    offset += 1;
    segmentCount += 1;

    if (marker === 0xd9 || marker === 0xda) return true;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;

    if (offset + 2 > bytes.length) return false;
    const segmentLength = bytes[offset] * 0x100 + bytes[offset + 1];
    if (segmentLength < 2 || segmentLength > bytes.length - offset) return false;
    offset += segmentLength;
  }

  return false;
};

const matchesAscii = (bytes: Uint8Array, offset: number, value: string): boolean => {
  if (offset < 0 || offset + value.length > bytes.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
};

const readU32BigEndian = (bytes: Uint8Array, offset: number): number =>
  bytes[offset] * 0x1_000000
  + bytes[offset + 1] * 0x1_0000
  + bytes[offset + 2] * 0x100
  + bytes[offset + 3];

const readU32LittleEndian = (bytes: Uint8Array, offset: number): number =>
  bytes[offset]
  + bytes[offset + 1] * 0x100
  + bytes[offset + 2] * 0x1_0000
  + bytes[offset + 3] * 0x1_000000;

/**
 * PNG/WebP profile payloads remain browser-managed. Detecting their presence
 * is still important: a filename hint must never disable the embedded profile.
 */
const hasOpaqueEmbeddedProfile = (bytes: Uint8Array): boolean => {
  const isPng =
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    matchesAscii(bytes, 1, 'PNG\r\n\x1a\n');
  if (isPng) {
    let offset = 8;
    let chunkCount = 0;
    while (offset + 12 <= bytes.length && chunkCount < 4096) {
      const length = readU32BigEndian(bytes, offset);
      if (matchesAscii(bytes, offset + 4, 'iCCP')) return true;
      if (length > bytes.length - offset - 12) return false;
      offset += 12 + length;
      chunkCount += 1;
    }
    return false;
  }

  const isWebp =
    bytes.length >= 12 &&
    matchesAscii(bytes, 0, 'RIFF') &&
    matchesAscii(bytes, 8, 'WEBP');
  if (!isWebp) return false;

  let offset = 12;
  let chunkCount = 0;
  while (offset + 8 <= bytes.length && chunkCount < 4096) {
    if (matchesAscii(bytes, offset, 'ICCP')) return true;
    const length = readU32LittleEndian(bytes, offset + 4);
    const paddedLength = length + (length & 1);
    if (paddedLength > bytes.length - offset - 8) return false;
    offset += 8 + paddedLength;
    chunkCount += 1;
  }
  return false;
};

/**
 * Extracts the profile description from an ICC profile.
 * Layout: 128-byte header, then a tag table (count at 128, 12-byte entries of
 * signature/offset/size). The description lives in the `desc` tag, whose data
 * is a `desc` (ASCII), `text`, or `mluc` (UTF-16BE multi-locale) element.
 */
const readIccDescription = (icc: Uint8Array): string | null => {
  const readU32 = (o: number) =>
    ((icc[o] << 24) | (icc[o + 1] << 16) | (icc[o + 2] << 8) | icc[o + 3]) >>> 0;
  const readSig = (o: number) =>
    String.fromCharCode(icc[o], icc[o + 1], icc[o + 2], icc[o + 3]);

  if (icc.length < 132) return null;

  const profileSize = readU32(0);
  if (profileSize < 132 || profileSize > icc.length) return null;

  const tagCount = readU32(128);
  const tagTableEnd = 132 + tagCount * 12;
  if (tagCount === 0 || tagCount > 1024 || tagTableEnd > profileSize) return null;

  for (let i = 0; i < tagCount; i += 1) {
    const entry = 132 + i * 12;
    if (readSig(entry) !== 'desc') continue;

    const tagOffset = readU32(entry + 4);
    const tagSize = readU32(entry + 8);
    if (
      tagSize < 8 ||
      tagOffset < tagTableEnd ||
      tagOffset > profileSize - tagSize
    ) {
      return null;
    }

    const tagEnd = tagOffset + tagSize;

    const type = readSig(tagOffset);

    if (type === 'desc') {
      if (tagSize < 13) return null;
      const asciiLength = readU32(tagOffset + 8);
      const asciiStart = tagOffset + 12;
      if (
        asciiLength <= 1 ||
        asciiLength > tagEnd - asciiStart ||
        icc[asciiStart + asciiLength - 1] !== 0
      ) {
        return null;
      }
      return decodeLatin1(icc.subarray(asciiStart, asciiStart + asciiLength - 1));
    }

    if (type === 'text') {
      const textStart = tagOffset + 8;
      let end = textStart;
      while (end < tagEnd && icc[end] !== 0) end += 1;
      if (end <= textStart) return null;
      return decodeLatin1(icc.subarray(textStart, end));
    }

    if (type === 'mluc') {
      if (tagSize < 28) return null;
      const recordCount = readU32(tagOffset + 8);
      const recordSize = readU32(tagOffset + 12);
      if (
        recordCount === 0 ||
        recordSize < 12 ||
        recordCount > Math.floor((tagSize - 16) / recordSize)
      ) {
        return null;
      }

      // First record: language(2) country(2) length(4) offset(4) at +16.
      const strLength = readU32(tagOffset + 20);
      const strOffset = readU32(tagOffset + 24);
      const strStart = tagOffset + strOffset;
      if (
        strLength === 0 ||
        strLength % 2 !== 0 ||
        strOffset > tagSize ||
        strLength > tagEnd - strStart
      ) {
        return null;
      }

      let out = '';
      for (let o = strStart; o + 1 < strStart + strLength; o += 2) {
        const code = (icc[o] << 8) | icc[o + 1]; // UTF-16BE
        if (code === 0) break;
        out += String.fromCharCode(code);
      }
      return out || null;
    }

    return null;
  }

  return null;
};

const matchFileName = (fileName: string): InputProfileId | null => {
  // Compact "vlog" is ordinary prose as often as Panasonic V-Log. Require an
  // explicit separator in filenames; embedded profile descriptions remain
  // authoritative enough to accept the compact spelling.
  if (hasDelimitedToken(fileName, 'vlog')) return null;

  const explicitProfile = matchProfileName(fileName);
  if (explicitProfile) return explicitProfile;
  return hasDelimitedToken(fileName, 'flat') ? 'flat' : null;
};

const MAX_EXIF_IFD_ENTRIES = 256;
const MAX_EXIF_ASCII_BYTES = 256;

interface ExifIfdReader {
  readonly bytes: Uint8Array;
  readonly tiffStart: number;
  readonly entriesStart: number;
  readonly entryCount: number;
  canRead(offset: number, length: number): boolean;
  readU16(offset: number): number | null;
  readU32(offset: number): number | null;
}

const createExifIfdReader = (
  bytes: Uint8Array,
  segmentStart: number,
  segmentEnd: number,
): ExifIfdReader | null => {
  if (
    !Number.isSafeInteger(segmentStart) ||
    !Number.isSafeInteger(segmentEnd) ||
    segmentStart < 0 ||
    segmentEnd > bytes.length ||
    segmentStart + 14 > segmentEnd ||
    !matchesAscii(bytes, segmentStart, 'Exif\0\0')
  ) {
    return null;
  }

  const tiffStart = segmentStart + 6;
  const littleEndian = bytes[tiffStart] === 0x49 && bytes[tiffStart + 1] === 0x49;
  const bigEndian = bytes[tiffStart] === 0x4d && bytes[tiffStart + 1] === 0x4d;
  if (!littleEndian && !bigEndian) return null;

  const canRead = (offset: number, length: number): boolean =>
    Number.isSafeInteger(offset) &&
    Number.isSafeInteger(length) &&
    offset >= tiffStart &&
    length >= 0 &&
    offset <= segmentEnd - length;

  const readU16 = (offset: number): number | null => {
    if (!canRead(offset, 2)) return null;
    return littleEndian
      ? bytes[offset] + bytes[offset + 1] * 0x100
      : bytes[offset] * 0x100 + bytes[offset + 1];
  };

  const readU32 = (offset: number): number | null => {
    if (!canRead(offset, 4)) return null;
    // Multiplication keeps the result unsigned. Bitwise assembly would turn
    // offsets with the high bit set into negative signed 32-bit integers.
    return littleEndian
      ? readU32LittleEndian(bytes, offset)
      : readU32BigEndian(bytes, offset);
  };

  if (readU16(tiffStart + 2) !== 42) return null;
  const ifdOffset = readU32(tiffStart + 4);
  if (
    ifdOffset === null ||
    ifdOffset < 8 ||
    ifdOffset > segmentEnd - tiffStart - 2
  ) {
    return null;
  }

  const ifdStart = tiffStart + ifdOffset;
  const entryCount = readU16(ifdStart);
  if (entryCount === null || entryCount > MAX_EXIF_IFD_ENTRIES) return null;

  const entriesStart = ifdStart + 2;
  const entriesLength = entryCount * 12;
  // A TIFF IFD ends with a four-byte next-IFD offset. Requiring it prevents a
  // truncated final entry from being treated as a complete directory.
  if (!canRead(entriesStart, entriesLength + 4)) return null;

  return {
    bytes,
    tiffStart,
    entriesStart,
    entryCount,
    canRead,
    readU16,
    readU32,
  };
};

const extractExifCameraFromSegment = (
  bytes: Uint8Array,
  segmentStart: number,
  segmentEnd: number,
): string | null => {
  const reader = createExifIfdReader(bytes, segmentStart, segmentEnd);
  if (!reader) return null;

  const {
    tiffStart,
    entriesStart,
    entryCount,
    canRead,
    readU16,
    readU32,
  } = reader;

  let make = '';
  let model = '';
  for (let index = 0; index < entryCount; index += 1) {
    const entry = entriesStart + index * 12;
    const tag = readU16(entry);
    if (tag !== 0x010f && tag !== 0x0110) continue;

    const type = readU16(entry + 2);
    const count = readU32(entry + 4);
    const valueOffset = readU32(entry + 8);
    if (
      type !== 2 ||
      count === null ||
      count < 1 ||
      count > MAX_EXIF_ASCII_BYTES ||
      valueOffset === null
    ) {
      return null;
    }

    const stringStart = count <= 4 ? entry + 8 : tiffStart + valueOffset;
    if (!canRead(stringStart, count)) return null;

    let value = '';
    let terminated = false;
    for (let character = 0; character < count; character += 1) {
      const code = bytes[stringStart + character];
      if (code === 0) {
        terminated = true;
        break;
      }
      value += String.fromCharCode(code);
    }
    if (!terminated) return null;

    if (tag === 0x010f) make = value.toLowerCase();
    else model = value.toLowerCase();
  }

  return `${make} ${model}`.trim() || null;
};

function extractExifCamera(bytes: Uint8Array): string | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;

    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;

    if (offset + 2 > bytes.length) return null;
    const segmentLength = bytes[offset] * 0x100 + bytes[offset + 1];
    if (segmentLength < 2 || segmentLength > bytes.length - offset) return null;

    const segmentStart = offset + 2;
    const segmentEnd = offset + segmentLength;
    if (marker === 0xe1) {
      const camera = extractExifCameraFromSegment(bytes, segmentStart, segmentEnd);
      if (camera) return camera;
    }
    offset = segmentEnd;
  }
  return null;
}

/**
 * Detects a supported input profile and records the evidence source.
 *
 * PNG iCCP keywords are intentionally ignored: the keyword is arbitrary
 * metadata, not the ICC profile itself. Until the compressed profile payload
 * can be validated, PNG color management is left to the browser.
 */
export const detectInputProfileDetailsFromHeader = (
  header: Uint8Array,
  fileName: string,
): InputProfileDetection | null => {
  // Public callers may provide an entire encoded file. Restrict every scan and
  // ICC reconstruction to the same bounded header budget used by the browser
  // decoder so work and allocations cannot scale with arbitrary input size.
  const boundedHeader = boundEncodedHeader(header);
  const jpegIcc = readJpegIcc(boundedHeader);
  if (jpegIcc.present) {
    const match = jpegIcc.description ? matchProfileName(jpegIcc.description) : null;
    if (match) return { profile: match, source: 'embedded-icc' };
    // The browser understands more ICC profiles than the engine does. Once a
    // profile is present, never let weaker EXIF/filename hints disable browser
    // color management or substitute a knowingly different transfer function.
    return null;
  }

  // PNG iCCP and WebP ICCP payloads are intentionally left opaque, but their
  // presence likewise takes precedence over heuristic profile inference.
  if (hasOpaqueEmbeddedProfile(boundedHeader)) return null;

  // A bounded JPEG prefix that ends before SOS/EOI is inconclusive: an ICC
  // APP2 segment may exist later in the file. Do not allow weaker hints to
  // override a potentially unseen embedded profile.
  if (!hasCompleteJpegMetadataHeader(boundedHeader)) return null;

  // EXIF camera make/model is not itself evidence of a transfer function. Only
  // an explicit, generation-specific profile token in those strings may match.
  const exifCam = extractExifCamera(boundedHeader);
  if (exifCam) {
    const match = matchProfileName(exifCam);
    if (match) return { profile: match, source: 'exif' };
  }

  // Filename heuristics only (user or their export named it with log keywords)
  const fileNameMatch = matchFileName(fileName);
  return fileNameMatch ? { profile: fileNameMatch, source: 'filename' } : null;
};

/** Reads embedded metadata and filename hints from a pre-loaded header slice. */
export const detectInputProfileFromHeader = (
  header: Uint8Array,
  fileName: string,
): InputProfileId | null => detectInputProfileDetailsFromHeader(header, fileName)?.profile ?? null;

/**
 * Parses the encoded frame dimensions from a JPEG header (SOF0–SOF15 marker).
 * These are the dimensions of the stored pixel data *before* any EXIF
 * orientation is applied — comparing them against the decoded bitmap reveals
 * whether the decoder baked the orientation in.
 */
export const extractJpegDimensions = (
  header: Uint8Array,
): { width: number; height: number } | null => {
  const bytes = boundEncodedHeader(header);
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    const len = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (len < 2 || offset + 2 + len > bytes.length) break;

    // SOF markers are 0xC0–0xCF excluding DHT (C4), JPG (C8), DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
      const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
      return width > 0 && height > 0 ? { width, height } : null;
    }

    offset += 2 + len;
  }
  return null;
};

export interface ExifOrientation {
  rotation: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
}

const identityExifOrientation = (): ExifOrientation => ({
  rotation: 0,
  flipH: false,
  flipV: false,
});

const orientationFromValue = (value: number): ExifOrientation | null => {
  switch (value) {
    case 1:
      return identityExifOrientation();
    case 2:
      return { rotation: 0, flipH: true, flipV: false };
    case 3:
      return { rotation: 180, flipH: false, flipV: false };
    case 4:
      return { rotation: 180, flipH: true, flipV: false };
    case 5:
      return { rotation: 90, flipH: true, flipV: false };
    case 6:
      return { rotation: 90, flipH: false, flipV: false };
    case 7:
      return { rotation: 270, flipH: true, flipV: false };
    case 8:
      return { rotation: 270, flipH: false, flipV: false };
    default:
      return null;
  }
};

const extractExifOrientationFromSegment = (
  bytes: Uint8Array,
  segmentStart: number,
  segmentEnd: number,
): ExifOrientation | null => {
  const reader = createExifIfdReader(bytes, segmentStart, segmentEnd);
  if (!reader) return null;

  const { entriesStart, entryCount, readU16, readU32 } = reader;
  for (let index = 0; index < entryCount; index += 1) {
    const entry = entriesStart + index * 12;
    if (readU16(entry) !== 0x0112) continue;

    // Orientation is one SHORT value stored inline in the IFD entry. Reject a
    // tag with a different type/count instead of following an attacker-chosen
    // offset or interpreting unrelated bytes as an orientation.
    if (readU16(entry + 2) !== 3 || readU32(entry + 4) !== 1) return null;
    const value = readU16(entry + 8);
    return value === null ? null : orientationFromValue(value);
  }
  return null;
};

/** Extracts EXIF orientation tag (0x0112) from a bounded JPEG header. */
export const extractExifOrientation = (header: Uint8Array): ExifOrientation => {
  const bytes = boundEncodedHeader(header);
  const fallback = identityExifOrientation();
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return fallback;

  let offset = 2;
  let segmentCount = 0;
  while (offset < bytes.length && segmentCount < MAX_JPEG_HEADER_SEGMENTS) {
    if (bytes[offset] !== 0xff) return fallback;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return fallback;

    const marker = bytes[offset];
    offset += 1;
    segmentCount += 1;

    if (marker === 0xd9 || marker === 0xda) return fallback;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;

    if (offset + 2 > bytes.length) return fallback;
    const segmentLength = bytes[offset] * 0x100 + bytes[offset + 1];
    if (segmentLength < 2 || segmentLength > bytes.length - offset) return fallback;

    const segmentStart = offset + 2;
    const segmentEnd = offset + segmentLength;
    if (marker === 0xe1) {
      const orientation = extractExifOrientationFromSegment(bytes, segmentStart, segmentEnd);
      if (orientation) return orientation;
    }
    offset = segmentEnd;
  }
  return fallback;
};
