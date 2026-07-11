import type { InputProfileId } from '../core/types';

const matchProfileName = (name: string): InputProfileId | null => {
  const normalized = name.toLowerCase();

  if (normalized.includes('display p3') || normalized.includes('display-p3')) {
    return 'display-p3';
  }
  if (normalized.includes('p3 d65') || normalized.includes('dci-p3')) {
    return 'display-p3';
  }
  if (normalized.includes('prophoto') || normalized.includes('romm rgb')) {
    return 'display-p3';
  }
  if (
    normalized.includes('logc3') ||
    normalized.includes('log-c3') ||
    normalized.includes('log-c') ||
    normalized.includes('logc') ||
    normalized.includes('arri') ||
    normalized.includes('alexa')
  ) {
    return 'arri-logc3';
  }
  if (normalized.includes('log3g10') || normalized.includes('red log') || normalized.includes('redwide')) {
    return 'red-log3g10';
  }
  if (normalized.includes('s-log3') || normalized.includes('slog3') || normalized.includes('sgamut')) {
    return 's-log3';
  }
  if (
    normalized.includes('film gen 5') ||
    normalized.includes('film gen5') ||
    normalized.includes('generation 5') ||
    normalized.includes('gen 5 color')
  ) {
    return 'bmd-film-gen5';
  }
  if (
    normalized.includes('film gen 4') ||
    normalized.includes('film gen4') ||
    normalized.includes('pocket 6k film') ||
    normalized.includes('pocket 4k film') ||
    normalized.includes('bmpcc')
  ) {
    return 'bmd-film-gen4';
  }
  if (normalized.includes('bmd film') || normalized.includes('blackmagic') || normalized.includes('ursa')) {
    return 'bmd-film-gen4';
  }
  if (
    normalized.includes('davinci intermediate') ||
    normalized.includes('dwg/intermediate') ||
    normalized.includes('dwg intermediate')
  ) {
    return 'davinci-intermediate';
  }
  if (normalized.includes('v-log') || normalized.includes('vlog')) {
    return 'v-log';
  }
  if (normalized.includes('c-log3') || normalized.includes('clog3')) {
    return 'c-log3';
  }
  if (
    normalized.includes('rec.709') ||
    normalized.includes('rec709') ||
    normalized.includes('bt.1886') ||
    normalized.includes('bt1886')
  ) {
    return 'rec709';
  }
  if (normalized.includes('srgb') || normalized.includes('s rgb')) {
    return 'standard';
  }

  return null;
};

const readPngIcc = (bytes: Uint8Array): string | null => {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[i] !== signature[i]) return null;
  }

  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length =
      (bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3];
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > bytes.length) break;

    if (type === 'iCCP' && length > 2) {
      const nameEnd = bytes.indexOf(0, dataStart);
      if (nameEnd > dataStart) {
        return new TextDecoder().decode(bytes.subarray(dataStart, nameEnd));
      }
    }

    offset = dataEnd + 4;
  }

  return null;
};

const readJpegIcc = (bytes: Uint8Array): string | null => {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let offset = 2;
  const chunks: Uint8Array[] = [];

  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1];
    if (marker === 0xd9 || marker === 0xda) break;

    const segmentLength = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (segmentLength < 2 || offset + 2 + segmentLength > bytes.length) break;

    if (marker === 0xe2) {
      const segmentStart = offset + 4;
      const identifier = 'ICC_PROFILE\0';
      let matches = true;
      for (let i = 0; i < identifier.length; i += 1) {
        if (bytes[segmentStart + i] !== identifier.charCodeAt(i)) {
          matches = false;
          break;
        }
      }
      if (matches) {
        chunks.push(bytes.subarray(segmentStart + identifier.length, offset + 2 + segmentLength));
      }
    }

    offset += 2 + segmentLength;
  }

  if (chunks.length === 0) return null;

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const icc = new Uint8Array(totalLength);
  let writeOffset = 0;
  chunks.forEach((chunk) => {
    icc.set(chunk, writeOffset);
    writeOffset += chunk.length;
  });

  return readIccDescription(icc);
}

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

  const tagCount = readU32(128);
  if (tagCount === 0 || tagCount > 1024) return null;

  for (let i = 0; i < tagCount; i += 1) {
    const entry = 132 + i * 12;
    if (entry + 12 > icc.length) break;
    if (readSig(entry) !== 'desc') continue;

    const tagOffset = readU32(entry + 4);
    const tagSize = readU32(entry + 8);
    if (tagOffset + 12 > icc.length || tagOffset + tagSize > icc.length) return null;

    const type = readSig(tagOffset);

    if (type === 'desc') {
      const asciiLength = readU32(tagOffset + 8);
      const asciiStart = tagOffset + 12;
      if (asciiLength <= 1 || asciiStart + asciiLength > icc.length) return null;
      return new TextDecoder().decode(icc.subarray(asciiStart, asciiStart + asciiLength - 1));
    }

    if (type === 'text') {
      const textStart = tagOffset + 8;
      const textEnd = icc.indexOf(0, textStart);
      const end = textEnd > textStart ? textEnd : tagOffset + tagSize;
      if (end <= textStart) return null;
      return new TextDecoder().decode(icc.subarray(textStart, end));
    }

    if (type === 'mluc') {
      const recordCount = readU32(tagOffset + 8);
      if (recordCount === 0) return null;
      // First record: language(2) country(2) length(4) offset(4) at +16.
      const strLength = readU32(tagOffset + 20);
      const strOffset = readU32(tagOffset + 24);
      const strStart = tagOffset + strOffset;
      if (strLength <= 0 || strStart + strLength > icc.length) return null;
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
};;

const matchFileName = (fileName: string): InputProfileId | null => {
  const name = fileName.toLowerCase();
  if (name.includes('logc3') || name.includes('log-c3') || name.includes('logc') || name.includes('log-c') || name.includes('arri')) {
    return 'arri-logc3';
  }
  if (name.includes('log3g10') || name.includes('redlog') || name.includes('red_log')) {
    return 'red-log3g10';
  }
  if (name.includes('slog3') || name.includes('s-log3')) return 's-log3';
  if (name.includes('gen5') || name.includes('gen-5') || name.includes('gen_5')) {
    return 'bmd-film-gen5';
  }
  if (
    name.includes('gen4') ||
    name.includes('gen-4') ||
    name.includes('gen_4') ||
    name.includes('bmd') ||
    name.includes('blackmagic') ||
    name.includes('bmpcc') ||
    name.includes('pocket6k') ||
    name.includes('pocket-6k')
  ) {
    return 'bmd-film-gen4';
  }
  if (name.includes('davinci') || name.includes('dovi') || name.includes('dwg')) {
    return 'davinci-intermediate';
  }
  if (name.includes('vlog') || name.includes('v-log')) return 'v-log';
  if (name.includes('clog3') || name.includes('c-log3')) return 'c-log3';
  if (name.includes('rec709') || name.includes('rec_709')) return 'rec709';
  if (name.includes('flat')) return 'flat';
  return null;
};

function extractExifCamera(bytes: Uint8Array): string | null {
  // Basic JPEG EXIF camera Make/Model extraction
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    const len = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (len < 2 || offset + 2 + len > bytes.length) break;
    if (marker === 0xe1) { // APP1 EXIF
      const start = offset + 4;
      if (start + 8 < bytes.length &&
          String.fromCharCode(bytes[start], bytes[start+1], bytes[start+2], bytes[start+3]) === 'Exif' &&
          bytes[start+4] === 0 && bytes[start+5] === 0) {
        // TIFF header — byte-order marker ("II"/"MM") is the first two bytes.
        const tiffStart = start + 6;
        const little = bytes[tiffStart] === 0x49 && bytes[tiffStart + 1] === 0x49; // "II"
        const getU16 = (o: number) => {
          if (little) return bytes[o] | (bytes[o+1] << 8);
          return (bytes[o] << 8) | bytes[o+1];
        };
        const getU32 = (o: number) => {
          if (little) return bytes[o] | (bytes[o+1]<<8) | (bytes[o+2]<<16) | (bytes[o+3]<<24);
          return (bytes[o]<<24) | (bytes[o+1]<<16) | (bytes[o+2]<<8) | bytes[o+3];
        };
        const ifd0 = tiffStart + getU32(tiffStart + 4);
        const numEntries = getU16(ifd0);
        let p = ifd0 + 2;
        let make = '', model = '';
        for (let i = 0; i < numEntries && p + 12 <= bytes.length; i++) {
          const tag = getU16(p);
          getU16(p+2); // type
          const count = getU32(p+4);
          const valOffset = getU32(p+8);
          if (tag === 0x010f || tag === 0x0110) { // Make or Model
            let strStart = tiffStart + valOffset;
            if (count <= 4) strStart = p + 8;
            let s = '';
            for (let j = 0; j < count && strStart + j < bytes.length; j++) {
              const c = bytes[strStart + j];
              if (c === 0) break;
              s += String.fromCharCode(c);
            }
            if (tag === 0x010f) make = s.toLowerCase();
            else model = s.toLowerCase();
          }
          p += 12;
        }
        const cam = (make + ' ' + model).trim();
        if (cam) return cam;
      }
    }
    offset += 2 + len;
  }
  return null;
}

/** Reads embedded ICC metadata from a pre-loaded header slice. */
export const detectInputProfileFromHeader = (
  header: Uint8Array,
  fileName: string,
): InputProfileId | null => {
  const pngName = readPngIcc(header);
  if (pngName) {
    const match = matchProfileName(pngName);
    if (match) return match;
  }

  const jpegName = readJpegIcc(header);
  if (jpegName) {
    const match = matchProfileName(jpegName);
    if (match) return match;
  }

  // EXIF camera make/model — be conservative: only trust explicit log mentions in the decoded strings.
  // Regular stills JPEGs from "Sony", "Canon" etc are baked Rec.709/sRGB 99% of the time.
  // Log profiles are for video/raw workflows and should be chosen manually or via clear filename/ICC.
  const exifCam = extractExifCamera(header);
  if (exifCam) {
    const match = matchProfileName(exifCam);
    if (match) return match;
  }

  // Filename heuristics only (user or their export named it with log keywords)
  return matchFileName(fileName);
};

/** Reads embedded ICC metadata when present and maps it to an input profile. */
export const detectInputProfile = async (file: File): Promise<InputProfileId | null> => {
  const header = new Uint8Array(await file.slice(0, Math.min(file.size, 512 * 1024)).arrayBuffer());
  return detectInputProfileFromHeader(header, file.name);
};

/**
 * Parses the encoded frame dimensions from a JPEG header (SOF0–SOF15 marker).
 * These are the dimensions of the stored pixel data *before* any EXIF
 * orientation is applied — comparing them against the decoded bitmap reveals
 * whether the decoder baked the orientation in.
 */
export const extractJpegDimensions = (
  bytes: Uint8Array,
): { width: number; height: number } | null => {
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

/** Extracts EXIF orientation tag (0x0112) from JPEG headers. */
export const extractExifOrientation = (bytes: Uint8Array): ExifOrientation => {
  const result: ExifOrientation = { rotation: 0, flipH: false, flipV: false };
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return result;

  let offset = 2;
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    const len = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (len < 2 || offset + 2 + len > bytes.length) break;

    if (marker === 0xe1) { // APP1 EXIF
      const start = offset + 4;
      if (
        start + 8 < bytes.length &&
        String.fromCharCode(bytes[start], bytes[start + 1], bytes[start + 2], bytes[start + 3]) === 'Exif' &&
        bytes[start + 4] === 0 &&
        bytes[start + 5] === 0
      ) {
        // TIFF header — byte-order marker ("II"/"MM") is the first two bytes.
        const tiffStart = start + 6;
        const little = bytes[tiffStart] === 0x49 && bytes[tiffStart + 1] === 0x49; // "II"
        const getU16 = (o: number) => {
          if (little) return bytes[o] | (bytes[o + 1] << 8);
          return (bytes[o] << 8) | bytes[o + 1];
        };
        const getU32 = (o: number) => {
          if (little) return bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24);
          return (bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3];
        };
        const ifd0Offset = getU32(tiffStart + 4);
        const ifd0 = tiffStart + ifd0Offset;
        if (ifd0 + 2 > bytes.length) break;
        const numEntries = getU16(ifd0);
        let p = ifd0 + 2;
        for (let i = 0; i < numEntries && p + 12 <= bytes.length; i++) {
          const tag = getU16(p);
          if (tag === 0x0112) { // Orientation tag
            const val = getU16(p + 8);
            switch (val) {
              case 1:
                result.rotation = 0;
                result.flipH = false;
                result.flipV = false;
                break;
              case 2:
                result.rotation = 0;
                result.flipH = true;
                result.flipV = false;
                break;
              case 3:
                result.rotation = 180;
                result.flipH = false;
                result.flipV = false;
                break;
              case 4:
                result.rotation = 180;
                result.flipH = true;
                result.flipV = false;
                break;
              case 5:
                result.rotation = 90;
                result.flipH = true;
                result.flipV = false;
                break;
              case 6:
                result.rotation = 90;
                result.flipH = false;
                result.flipV = false;
                break;
              case 7:
                result.rotation = 270;
                result.flipH = true;
                result.flipV = false;
                break;
              case 8:
                result.rotation = 270;
                result.flipH = false;
                result.flipV = false;
                break;
            }
            return result;
          }
          p += 12;
        }
      }
    }
    offset += 2 + len;
  }
  return result;
};

