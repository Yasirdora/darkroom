export interface EncodedImageDimensions {
  width: number;
  height: number;
  format: 'jpeg' | 'png' | 'webp';
}

/**
 * Maximum amount of encoded metadata inspected before browser decoding.
 * Keeping this independent of the overall upload limit prevents adversarial
 * metadata from turning validation into an unbounded scan.
 */
export const MAX_ENCODED_IMAGE_HEADER_BYTES = 512 * 1024;

const MAX_JPEG_SEGMENTS = 4096;

const invalidHeader = (format: string): Error =>
  new Error(`Invalid or truncated ${format} image header.`);

const readU16BE = (bytes: Uint8Array, offset: number): number =>
  bytes[offset] * 0x100 + bytes[offset + 1];

const readU16LE = (bytes: Uint8Array, offset: number): number =>
  bytes[offset] + bytes[offset + 1] * 0x100;

const readU24LE = (bytes: Uint8Array, offset: number): number =>
  bytes[offset] + bytes[offset + 1] * 0x100 + bytes[offset + 2] * 0x1_0000;

const readU32BE = (bytes: Uint8Array, offset: number): number =>
  bytes[offset] * 0x1_000000
  + bytes[offset + 1] * 0x1_0000
  + bytes[offset + 2] * 0x100
  + bytes[offset + 3];

const readU32LE = (bytes: Uint8Array, offset: number): number =>
  bytes[offset]
  + bytes[offset + 1] * 0x100
  + bytes[offset + 2] * 0x1_0000
  + bytes[offset + 3] * 0x1_000000;

const matchesAscii = (bytes: Uint8Array, offset: number, value: string): boolean => {
  if (offset < 0 || offset + value.length > bytes.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
};

const isJpegStartOfFrame = (marker: number): boolean =>
  marker >= 0xc0
  && marker <= 0xcf
  && marker !== 0xc4 // DHT
  && marker !== 0xc8 // JPG extension
  && marker !== 0xcc; // DAC

const parseJpegDimensions = (bytes: Uint8Array): EncodedImageDimensions => {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw invalidHeader('JPEG');
  }

  let offset = 2;
  let segmentCount = 0;

  while (offset < bytes.length && segmentCount < MAX_JPEG_SEGMENTS) {
    if (bytes[offset] !== 0xff) throw invalidHeader('JPEG');

    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) throw invalidHeader('JPEG');

    const marker = bytes[offset];
    offset += 1;
    segmentCount += 1;

    // Stuffed zero bytes are only valid in entropy-coded data, after SOS.
    if (marker === 0x00 || marker === 0xd8) throw invalidHeader('JPEG');
    if (marker === 0xd9 || marker === 0xda) throw invalidHeader('JPEG');

    // TEM and restart markers carry no segment length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;

    if (offset + 2 > bytes.length) throw invalidHeader('JPEG');
    const segmentLength = readU16BE(bytes, offset);
    if (segmentLength < 2 || segmentLength > bytes.length - offset) {
      throw invalidHeader('JPEG');
    }

    if (isJpegStartOfFrame(marker)) {
      if (segmentLength < 11) throw invalidHeader('JPEG');

      const componentCount = bytes[offset + 7];
      if (componentCount === 0 || segmentLength !== 8 + componentCount * 3) {
        throw invalidHeader('JPEG');
      }

      const height = readU16BE(bytes, offset + 3);
      const width = readU16BE(bytes, offset + 5);
      if (width === 0 || height === 0) throw invalidHeader('JPEG');
      return { width, height, format: 'jpeg' };
    }

    offset += segmentLength;
  }

  throw invalidHeader('JPEG');
};

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

const hasPngSignature = (bytes: Uint8Array): boolean => {
  if (bytes.length < PNG_SIGNATURE.length) return false;
  return PNG_SIGNATURE.every((value, index) => bytes[index] === value);
};

const parsePngDimensions = (bytes: Uint8Array, fileSize: number): EncodedImageDimensions => {
  // Signature + IHDR length/type/data/CRC.
  if (fileSize < 33 || bytes.length < 33 || !hasPngSignature(bytes)) {
    throw invalidHeader('PNG');
  }
  if (readU32BE(bytes, 8) !== 13 || !matchesAscii(bytes, 12, 'IHDR')) {
    throw invalidHeader('PNG');
  }

  const width = readU32BE(bytes, 16);
  const height = readU32BE(bytes, 20);
  if (width === 0 || height === 0) throw invalidHeader('PNG');
  return { width, height, format: 'png' };
};

const parseWebpDimensions = (bytes: Uint8Array, fileSize: number): EncodedImageDimensions => {
  if (
    fileSize < 20
    || bytes.length < 20
    || !matchesAscii(bytes, 0, 'RIFF')
    || !matchesAscii(bytes, 8, 'WEBP')
  ) {
    throw invalidHeader('WebP');
  }

  const riffSize = readU32LE(bytes, 4);
  const riffEnd = 8 + riffSize;
  if (riffSize < 12 || riffEnd > fileSize) throw invalidHeader('WebP');

  const chunkSize = readU32LE(bytes, 16);
  const paddedChunkSize = chunkSize + (chunkSize % 2);
  if (paddedChunkSize > riffEnd - 20) throw invalidHeader('WebP');

  if (matchesAscii(bytes, 12, 'VP8X')) {
    if (chunkSize !== 10 || bytes.length < 30) throw invalidHeader('WebP');

    // VP8X reserves three flag bits and the following 24 bits.
    if ((bytes[20] & 0xc1) !== 0 || bytes[21] !== 0 || bytes[22] !== 0 || bytes[23] !== 0) {
      throw invalidHeader('WebP');
    }

    const width = readU24LE(bytes, 24) + 1;
    const height = readU24LE(bytes, 27) + 1;
    return { width, height, format: 'webp' };
  }

  if (matchesAscii(bytes, 12, 'VP8L')) {
    if (chunkSize < 5 || bytes.length < 25 || bytes[20] !== 0x2f) {
      throw invalidHeader('WebP');
    }
    // The top three bits are a format version and must currently be zero.
    if ((bytes[24] & 0xe0) !== 0) throw invalidHeader('WebP');

    const width = 1 + bytes[21] + (bytes[22] & 0x3f) * 0x100;
    const height = 1
      + ((bytes[22] & 0xc0) >>> 6)
      + bytes[23] * 4
      + (bytes[24] & 0x0f) * 0x400;
    return { width, height, format: 'webp' };
  }

  if (matchesAscii(bytes, 12, 'VP8 ')) {
    if (
      chunkSize < 10
      || bytes.length < 30
      || (bytes[20] & 0x01) !== 0
      || bytes[23] !== 0x9d
      || bytes[24] !== 0x01
      || bytes[25] !== 0x2a
    ) {
      throw invalidHeader('WebP');
    }

    const width = readU16LE(bytes, 26) & 0x3fff;
    const height = readU16LE(bytes, 28) & 0x3fff;
    if (width === 0 || height === 0) throw invalidHeader('WebP');
    return { width, height, format: 'webp' };
  }

  throw invalidHeader('WebP');
};

const mimeFormat = (mimeType: string): EncodedImageDimensions['format'] | null => {
  switch (mimeType.trim().toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
    case 'image/pjpeg':
      return 'jpeg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    default:
      return null;
  }
};

/**
 * Reads dimensions from a bounded prefix of a JPEG, PNG, or WebP file.
 * Container lengths are checked against both the available prefix and the
 * actual file size before they are used for indexing or advancing a cursor.
 */
export const parseEncodedImageDimensions = (
  header: Uint8Array,
  fileSize: number,
  mimeType = '',
): EncodedImageDimensions => {
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) {
    throw new Error('Image file is empty or has an invalid size.');
  }

  const bytes = header.subarray(0, MAX_ENCODED_IMAGE_HEADER_BYTES);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return parseJpegDimensions(bytes);
  if (hasPngSignature(bytes)) return parsePngDimensions(bytes, fileSize);
  if (matchesAscii(bytes, 0, 'RIFF') && matchesAscii(bytes, 8, 'WEBP')) {
    return parseWebpDimensions(bytes, fileSize);
  }

  // Known MIME types produce a useful malformed/truncated error even when the
  // signature itself is incomplete. Otherwise, fail closed for formats whose
  // dimensions cannot be validated before decoding.
  const hintedFormat = mimeFormat(mimeType);
  if (hintedFormat === 'jpeg') return parseJpegDimensions(bytes);
  if (hintedFormat === 'png') return parsePngDimensions(bytes, fileSize);
  if (hintedFormat === 'webp') return parseWebpDimensions(bytes, fileSize);
  throw new Error('Only JPEG, PNG, and WebP images are supported.');
};

/** Validates a dimension pair without multiplying attacker-controlled values. */
export const assertImagePixelLimit = (
  dimensions: Pick<EncodedImageDimensions, 'width' | 'height'>,
  maxPixels: number,
): void => {
  const { width, height } = dimensions;
  if (
    !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || width <= 0
    || height <= 0
  ) {
    throw new Error('Image dimensions must be positive integers.');
  }
  if (!Number.isSafeInteger(maxPixels) || maxPixels <= 0) {
    throw new Error('Image pixel limit is invalid.');
  }
  if (width > Math.floor(maxPixels / height)) {
    throw new Error(
      `Image dimensions exceed the ${Math.round(maxPixels / 1_000_000)} megapixel maximum.`,
    );
  }
};
