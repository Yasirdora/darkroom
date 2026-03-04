import { adoptPixelBuffer, assertPixelBuffer, clonePixelBuffer } from './buffer.js';
import { clampByte } from './math.js';
import type { PixelBuffer } from './types.js';

const MAX_BILATERAL_RADIUS = 24;
const DEFAULT_SIGMA_COLOR = 25;
const DEFAULT_BOKEH_THRESHOLD = 200;
const BILATERAL_RANGE_LUT_SIZE = 4096;
const MAX_RGB_DISTANCE_SQUARED = 3 * 255 * 255;

const maximumUsefulRadius = (source: PixelBuffer): number =>
  Math.max(0, Math.max(source.width, source.height) - 1);

const normalizeRadius = (value: number, maximum: number): number => {
  if (maximum <= 0 || Number.isNaN(value) || value === Number.NEGATIVE_INFINITY) return 0;
  if (value === Number.POSITIVE_INFINITY) return maximum;
  return Math.min(maximum, Math.max(0, Math.floor(value)));
};

const finiteInRange = (
  value: number,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  if (Number.isNaN(value)) return fallback;
  if (value === Number.POSITIVE_INFINITY) return maximum;
  if (value === Number.NEGATIVE_INFINITY) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
};

const writeAlphaWeightedColor = (
  output: Uint8ClampedArray,
  offset: number,
  red: number,
  green: number,
  blue: number,
  alphaWeight: number,
): void => {
  if (alphaWeight <= 0 || !Number.isFinite(alphaWeight)) return;
  output[offset] = clampByte(red / alphaWeight);
  output[offset + 1] = clampByte(green / alphaWeight);
  output[offset + 2] = clampByte(blue / alphaWeight);
};

const blurByColumns = (
  data: Uint8ClampedArray,
  output: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
): void => {
  const horizontalSums = new Float64Array(height * 4);
  const initialRight = Math.min(radius, width - 1);
  const rightPadding = radius - initialRight;

  for (let y = 0; y < height; y += 1) {
    const sourceRow = y * width * 4;
    const sumOffset = y * 4;
    const lastPixel = sourceRow + (width - 1) * 4;
    const firstAlpha = data[sourceRow + 3];
    let red = data[sourceRow] * firstAlpha * radius;
    let green = data[sourceRow + 1] * firstAlpha * radius;
    let blue = data[sourceRow + 2] * firstAlpha * radius;
    let alpha = firstAlpha * radius;

    for (let x = 0; x <= initialRight; x += 1) {
      const offset = sourceRow + x * 4;
      const sampleAlpha = data[offset + 3];
      red += data[offset] * sampleAlpha;
      green += data[offset + 1] * sampleAlpha;
      blue += data[offset + 2] * sampleAlpha;
      alpha += sampleAlpha;
    }

    const lastAlpha = data[lastPixel + 3];
    red += data[lastPixel] * lastAlpha * rightPadding;
    green += data[lastPixel + 1] * lastAlpha * rightPadding;
    blue += data[lastPixel + 2] * lastAlpha * rightPadding;
    alpha += lastAlpha * rightPadding;
    horizontalSums[sumOffset] = red;
    horizontalSums[sumOffset + 1] = green;
    horizontalSums[sumOffset + 2] = blue;
    horizontalSums[sumOffset + 3] = alpha;
  }

  const initialBottom = Math.min(radius, height - 1);
  const bottomPadding = radius - initialBottom;
  for (let x = 0; x < width; x += 1) {
    const lastSum = (height - 1) * 4;
    let red = horizontalSums[0] * radius;
    let green = horizontalSums[1] * radius;
    let blue = horizontalSums[2] * radius;
    let alpha = horizontalSums[3] * radius;
    for (let y = 0; y <= initialBottom; y += 1) {
      const sumOffset = y * 4;
      red += horizontalSums[sumOffset];
      green += horizontalSums[sumOffset + 1];
      blue += horizontalSums[sumOffset + 2];
      alpha += horizontalSums[sumOffset + 3];
    }
    red += horizontalSums[lastSum] * bottomPadding;
    green += horizontalSums[lastSum + 1] * bottomPadding;
    blue += horizontalSums[lastSum + 2] * bottomPadding;
    alpha += horizontalSums[lastSum + 3] * bottomPadding;

    for (let y = 0; y < height; y += 1) {
      const outputOffset = (y * width + x) * 4;
      writeAlphaWeightedColor(output, outputOffset, red, green, blue, alpha);
      if (y + 1 < height) {
        const departingY = Math.min(height - 1, Math.max(0, y - radius));
        const enteringY = Math.min(height - 1, y + radius + 1);
        const departing = departingY * 4;
        const entering = enteringY * 4;
        red += horizontalSums[entering] - horizontalSums[departing];
        green += horizontalSums[entering + 1] - horizontalSums[departing + 1];
        blue += horizontalSums[entering + 2] - horizontalSums[departing + 2];
        alpha += horizontalSums[entering + 3] - horizontalSums[departing + 3];
      }
    }

    if (x + 1 === width) continue;
    const departingX = Math.min(width - 1, Math.max(0, x - radius));
    const enteringX = Math.min(width - 1, x + radius + 1);
    for (let y = 0; y < height; y += 1) {
      const sourceRow = y * width * 4;
      const departing = sourceRow + departingX * 4;
      const entering = sourceRow + enteringX * 4;
      const sumOffset = y * 4;
      const departingAlpha = data[departing + 3];
      const enteringAlpha = data[entering + 3];
      horizontalSums[sumOffset] += data[entering] * enteringAlpha - data[departing] * departingAlpha;
      horizontalSums[sumOffset + 1] += data[entering + 1] * enteringAlpha
        - data[departing + 1] * departingAlpha;
      horizontalSums[sumOffset + 2] += data[entering + 2] * enteringAlpha
        - data[departing + 2] * departingAlpha;
      horizontalSums[sumOffset + 3] += enteringAlpha - departingAlpha;
    }
  }
};

const blurByRows = (
  data: Uint8ClampedArray,
  output: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
): void => {
  const verticalSums = new Float64Array(width * 4);
  const initialBottom = Math.min(radius, height - 1);
  const bottomPadding = radius - initialBottom;

  for (let x = 0; x < width; x += 1) {
    const firstPixel = x * 4;
    const lastPixel = ((height - 1) * width + x) * 4;
    const sumOffset = x * 4;
    const firstAlpha = data[firstPixel + 3];
    let red = data[firstPixel] * firstAlpha * radius;
    let green = data[firstPixel + 1] * firstAlpha * radius;
    let blue = data[firstPixel + 2] * firstAlpha * radius;
    let alpha = firstAlpha * radius;

    for (let y = 0; y <= initialBottom; y += 1) {
      const offset = (y * width + x) * 4;
      const sampleAlpha = data[offset + 3];
      red += data[offset] * sampleAlpha;
      green += data[offset + 1] * sampleAlpha;
      blue += data[offset + 2] * sampleAlpha;
      alpha += sampleAlpha;
    }
    const lastAlpha = data[lastPixel + 3];
    red += data[lastPixel] * lastAlpha * bottomPadding;
    green += data[lastPixel + 1] * lastAlpha * bottomPadding;
    blue += data[lastPixel + 2] * lastAlpha * bottomPadding;
    alpha += lastAlpha * bottomPadding;
    verticalSums[sumOffset] = red;
    verticalSums[sumOffset + 1] = green;
    verticalSums[sumOffset + 2] = blue;
    verticalSums[sumOffset + 3] = alpha;
  }

  const initialRight = Math.min(radius, width - 1);
  const rightPadding = radius - initialRight;
  for (let y = 0; y < height; y += 1) {
    const lastSum = (width - 1) * 4;
    let red = verticalSums[0] * radius;
    let green = verticalSums[1] * radius;
    let blue = verticalSums[2] * radius;
    let alpha = verticalSums[3] * radius;
    for (let x = 0; x <= initialRight; x += 1) {
      const sumOffset = x * 4;
      red += verticalSums[sumOffset];
      green += verticalSums[sumOffset + 1];
      blue += verticalSums[sumOffset + 2];
      alpha += verticalSums[sumOffset + 3];
    }
    red += verticalSums[lastSum] * rightPadding;
    green += verticalSums[lastSum + 1] * rightPadding;
    blue += verticalSums[lastSum + 2] * rightPadding;
    alpha += verticalSums[lastSum + 3] * rightPadding;

    for (let x = 0; x < width; x += 1) {
      const outputOffset = (y * width + x) * 4;
      writeAlphaWeightedColor(output, outputOffset, red, green, blue, alpha);
      if (x + 1 < width) {
        const departingX = Math.min(width - 1, Math.max(0, x - radius));
        const enteringX = Math.min(width - 1, x + radius + 1);
        const departing = departingX * 4;
        const entering = enteringX * 4;
        red += verticalSums[entering] - verticalSums[departing];
        green += verticalSums[entering + 1] - verticalSums[departing + 1];
        blue += verticalSums[entering + 2] - verticalSums[departing + 2];
        alpha += verticalSums[entering + 3] - verticalSums[departing + 3];
      }
    }

    if (y + 1 === height) continue;
    const departingY = Math.min(height - 1, Math.max(0, y - radius));
    const enteringY = Math.min(height - 1, y + radius + 1);
    for (let x = 0; x < width; x += 1) {
      const departing = (departingY * width + x) * 4;
      const entering = (enteringY * width + x) * 4;
      const sumOffset = x * 4;
      const departingAlpha = data[departing + 3];
      const enteringAlpha = data[entering + 3];
      verticalSums[sumOffset] += data[entering] * enteringAlpha - data[departing] * departingAlpha;
      verticalSums[sumOffset + 1] += data[entering + 1] * enteringAlpha
        - data[departing + 1] * departingAlpha;
      verticalSums[sumOffset + 2] += data[entering + 2] * enteringAlpha
        - data[departing + 2] * departingAlpha;
      verticalSums[sumOffset + 3] += enteringAlpha - departingAlpha;
    }
  }
};

const separableBox = (source: PixelBuffer, radius: number): PixelBuffer => {
  const { width, height, data } = source;
  const output = new Uint8ClampedArray(data);
  if (height <= width) blurByColumns(data, output, width, height, radius);
  else blurByRows(data, output, width, height, radius);
  return adoptPixelBuffer({ width, height, data: output });
};

/** Linear-time, premultiplied-alpha box blur with exact source alpha. */
export const applyBoxBlur = (source: PixelBuffer, radius: number): PixelBuffer => {
  assertPixelBuffer(source);
  const normalized = normalizeRadius(radius, maximumUsefulRadius(source));
  return normalized === 0 ? clonePixelBuffer(source) : separableBox(source, normalized);
};

/** Three-box Gaussian approximation retained for editor-render parity. */
export const applyGaussianBlur = (source: PixelBuffer, radius: number): PixelBuffer => {
  assertPixelBuffer(source);
  const normalized = normalizeRadius(radius, maximumUsefulRadius(source));
  if (normalized === 0) return clonePixelBuffer(source);
  let current = separableBox(source, normalized);
  current = separableBox(current, Math.max(1, Math.floor(normalized * 0.8)));
  return separableBox(current, Math.max(1, Math.floor(normalized * 0.6)));
};

const createBilateralRangeWeights = (sigmaColor: number): Float32Array => {
  const weights = new Float32Array(BILATERAL_RANGE_LUT_SIZE);
  const denominator = 2 * sigmaColor * sigmaColor;
  const indexToDistance = MAX_RGB_DISTANCE_SQUARED / (BILATERAL_RANGE_LUT_SIZE - 1);
  for (let index = 0; index < weights.length; index += 1) {
    weights[index] = Math.exp(-(index * indexToDistance) / denominator);
  }
  return weights;
};

/** Fixed-work, edge-aware approximation suitable for bounded large images. */
export const applyBilateralBlur = (
  source: PixelBuffer,
  radius: number,
  sigmaColor = DEFAULT_SIGMA_COLOR,
): PixelBuffer => {
  assertPixelBuffer(source);
  const normalized = normalizeRadius(
    radius,
    Math.min(MAX_BILATERAL_RADIUS, maximumUsefulRadius(source)),
  );
  if (normalized === 0) return clonePixelBuffer(source);
  const spatial = applyGaussianBlur(source, normalized);
  const output = new Uint8ClampedArray(source.data);
  const safeSigma = finiteInRange(Math.abs(sigmaColor), DEFAULT_SIGMA_COLOR, 0.1, 255);
  const weights = createBilateralRangeWeights(safeSigma);
  const distanceToIndex = (BILATERAL_RANGE_LUT_SIZE - 1) / MAX_RGB_DISTANCE_SQUARED;
  for (let index = 0; index < output.length; index += 4) {
    if (source.data[index + 3] === 0) {
      output[index] = spatial.data[index];
      output[index + 1] = spatial.data[index + 1];
      output[index + 2] = spatial.data[index + 2];
      continue;
    }
    const red = spatial.data[index] - source.data[index];
    const green = spatial.data[index + 1] - source.data[index + 1];
    const blue = spatial.data[index + 2] - source.data[index + 2];
    const distance = red * red + green * green + blue * blue;
    const weight = weights[Math.min(weights.length - 1, Math.round(distance * distanceToIndex))];
    output[index] = clampByte(source.data[index] + red * weight);
    output[index + 1] = clampByte(source.data[index + 1] + green * weight);
    output[index + 2] = clampByte(source.data[index + 2] + blue * weight);
  }
  return adoptPixelBuffer({ width: source.width, height: source.height, data: output });
};

/** Gaussian base plus the editor's established highlight lift. */
export const applyBokehBlur = (
  source: PixelBuffer,
  radius: number,
  threshold = DEFAULT_BOKEH_THRESHOLD,
): PixelBuffer => {
  assertPixelBuffer(source);
  const normalized = normalizeRadius(radius, maximumUsefulRadius(source));
  if (normalized === 0) return clonePixelBuffer(source);
  const blurred = applyGaussianBlur(source, normalized);
  const output = new Uint8ClampedArray(blurred.data);
  const safeThreshold = finiteInRange(threshold, DEFAULT_BOKEH_THRESHOLD, 0, 254);
  const thresholdRange = 255 - safeThreshold;
  for (let index = 0; index < output.length; index += 4) {
    const luminance = blurred.data[index] * 0.2126
      + blurred.data[index + 1] * 0.7152
      + blurred.data[index + 2] * 0.0722;
    if (luminance <= safeThreshold) continue;
    const boost = (luminance - safeThreshold) / thresholdRange * 0.6;
    output[index] = clampByte(blurred.data[index] + boost * 40);
    output[index + 1] = clampByte(blurred.data[index + 1] + boost * 32);
    output[index + 2] = clampByte(blurred.data[index + 2] + boost * 28);
  }
  return adoptPixelBuffer({ width: source.width, height: source.height, data: output });
};
