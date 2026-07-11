export const VIEW_ZOOM_MIN = 20;
export const VIEW_ZOOM_MAX = 200;
export const VIEW_ZOOM_DEFAULT = 100;
export const VIEW_ZOOM_STEP = 5;

export const clampViewZoom = (value: number): number =>
  Math.max(VIEW_ZOOM_MIN, Math.min(VIEW_ZOOM_MAX, Math.round(value)));

export interface CanvasDisplaySize {
  width: number;
  height: number;
  scale: number;
}

/** Fit image in container, then apply view zoom (100 = fit, 200 = 2× fit, 20 = 0.2× fit). */
export const computeCanvasDisplaySize = (
  imageWidth: number,
  imageHeight: number,
  containerWidth: number,
  containerHeight: number,
  viewZoomPercent: number,
): CanvasDisplaySize => {
  if (
    imageWidth <= 0 ||
    imageHeight <= 0 ||
    containerWidth <= 0 ||
    containerHeight <= 0
  ) {
    return { width: 0, height: 0, scale: 0 };
  }

  const fitScale = Math.min(
    containerWidth / imageWidth,
    containerHeight / imageHeight,
    1,
  );
  const scale = fitScale * (clampViewZoom(viewZoomPercent) / 100);

  return {
    width: Math.round(imageWidth * scale),
    height: Math.round(imageHeight * scale),
    scale,
  };
};