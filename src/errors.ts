export type DarkroomErrorCode =
  | 'INVALID_DIMENSIONS'
  | 'BUFFER_LENGTH_MISMATCH'
  | 'RESOURCE_LIMIT_EXCEEDED'
  | 'INVALID_GRADE'
  | 'INVALID_LUT'
  | 'UNSUPPORTED_LUT_SIZE'
  | 'INVALID_CUBE'
  | 'INVALID_PROFILE'
  | 'UNSUPPORTED_IMAGE'
  | 'DECODE_FAILED'
  | 'CANVAS_UNAVAILABLE';

/** A stable, machine-readable error thrown by the public engine API. */
export class DarkroomError extends Error {
  readonly code: DarkroomErrorCode;

  constructor(code: DarkroomErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DarkroomError';
    this.code = code;
  }
}

export const asDarkroomError = (
  error: unknown,
  code: DarkroomErrorCode,
  fallbackMessage: string,
): DarkroomError =>
  error instanceof DarkroomError
    ? error
    : new DarkroomError(code, error instanceof Error ? error.message : fallbackMessage, {
        cause: error,
      });
