import { MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS } from '../editor/constants';

/**
 * Immutable-friendly wrapper around raw RGBA pixel data.
 * All processing modules accept and return ImageBuffer instances.
 */
export class ImageBuffer {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;

  constructor(width: number, height: number, data: Uint8ClampedArray) {
    if (data.length !== width * height * 4) {
      throw new Error('ImageBuffer data length does not match dimensions.');
    }
    this.width = width;
    this.height = height;
    this.data = data;
  }

  static async fromFile(file: File): Promise<ImageBuffer> {
    return (await ImageBuffer.decodeFile(file)).buffer;
  }

  /**
   * Decodes a file and reports whether EXIF orientation was baked into the
   * pixels by the decoder. The primary path decodes with orientation
   * suppressed (caller applies it as a transform); the fallback path
   * (`createImageBitmap(file)`, older Safari) applies orientation itself —
   * callers must not apply it a second time.
   */
  static async decodeFile(file: File): Promise<{ buffer: ImageBuffer; orientationBaked: boolean }> {
    if (file.size > MAX_IMAGE_BYTES) {
      throw new Error(`Image must be ${MAX_IMAGE_BYTES / (1024 * 1024)} MB or smaller.`);
    }
    if (!file.type.startsWith('image/')) {
      throw new Error('Only image files are supported.');
    }

    let bitmap: ImageBitmap;
    let orientationBaked = false;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'none' });
    } catch {
      bitmap = await createImageBitmap(file);
      orientationBaked = true;
    }
    try {
      return { buffer: ImageBuffer.fromImageBitmap(bitmap), orientationBaked };
    } finally {
      bitmap.close();
    }
  }

  static fromImageBitmap(bitmap: ImageBitmap): ImageBuffer {
    const pixels = bitmap.width * bitmap.height;
    if (pixels > MAX_IMAGE_PIXELS) {
      throw new Error(
        `Image is too large (${Math.round(pixels / 1_000_000)}MP). Maximum is ${Math.round(MAX_IMAGE_PIXELS / 1_000_000)} megapixels.`,
      );
    }

    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;

    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      throw new Error('Canvas 2D is not available.');
    }

    context.drawImage(bitmap, 0, 0);
    const imageData = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return ImageBuffer.fromImageData(imageData);
  }

  static fromImageData(imageData: ImageData): ImageBuffer {
    return new ImageBuffer(
      imageData.width,
      imageData.height,
      new Uint8ClampedArray(imageData.data),
    );
  }

  clone(): ImageBuffer {
    return new ImageBuffer(this.width, this.height, new Uint8ClampedArray(this.data));
  }

  toImageData(): ImageData {
    return new ImageData(new Uint8ClampedArray(this.data), this.width, this.height);
  }

  /**
   * Returns a downscaled copy when the longest edge exceeds `maxDimension`.
   * Used for responsive preview while keeping full resolution for export.
   */
  downscale(maxDimension: number): ImageBuffer {
    const longest = Math.max(this.width, this.height);
    if (longest <= maxDimension) {
      return this.clone();
    }

    const scale = maxDimension / longest;
    const targetWidth = Math.max(1, Math.round(this.width * scale));
    const targetHeight = Math.max(1, Math.round(this.height * scale));

    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = this.width;
    sourceCanvas.height = this.height;
    const sourceContext = sourceCanvas.getContext('2d');
    if (!sourceContext) {
      return this.clone();
    }
    sourceContext.putImageData(this.toImageData(), 0, 0);

    const targetCanvas = document.createElement('canvas');
    targetCanvas.width = targetWidth;
    targetCanvas.height = targetHeight;
    const targetContext = targetCanvas.getContext('2d');
    if (!targetContext) {
      return this.clone();
    }

    targetContext.imageSmoothingEnabled = true;
    targetContext.imageSmoothingQuality = 'high';
    targetContext.drawImage(sourceCanvas, 0, 0, targetWidth, targetHeight);

    const scaled = targetContext.getImageData(0, 0, targetWidth, targetHeight);
    return ImageBuffer.fromImageData(scaled);
  }
}