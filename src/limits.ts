export const DARKROOM_LIMITS = Object.freeze({
  maxImageBytes: 10 * 1024 * 1024,
  maxImagePixels: 12_000_000,
  maxEncodedHeaderBytes: 512 * 1024,
  /** Maximum encoded file size accepted by the browser adapter. */
  maxCubeBytes: 16 * 1024 * 1024,
  /** Separate in-memory bound because a JavaScript string is not a byte buffer. */
  maxCubeTextCodeUnits: 16 * 1024 * 1024,
  maxCubeSourceSize: 65,
  maxCubeLines: 65 ** 3 + 4096,
  maxCurvePoints: 32,
  maxVectorscopeSize: 512,
  supportedLutSizes: Object.freeze([17, 33, 65] as const),
});
