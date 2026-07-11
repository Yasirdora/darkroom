/**
 * Thumbnail generation worker.
 *
 * Key insight: building a 64³ LUT (262,144 entries) per filter is the
 * bottleneck, but thumbnails are small (≤288px longest edge, sized to
 * display size × devicePixelRatio). Calling renderFilmPixel directly on
 * each pixel beats building a full LUT just to sample a fraction of it,
 * and results stream back progressively so early cards appear immediately.
 */
import { ALL_STOCK_PROFILES } from '../processing/filters/stock-profiles';
import { renderFilmPixel } from '../processing/filters/film-model';
import type { FilterId } from '../core/types';

export interface ThumbnailRequest {
  id: number;
  sourceData: ArrayBuffer;
  width: number;
  height: number;
}

export interface ThumbnailResult {
  id: number;
  filterId: FilterId;
  imageData: ArrayBuffer;
  width: number;
  height: number;
}

export interface ThumbnailDone {
  id: number;
  done: true;
}

self.onmessage = (e: MessageEvent<ThumbnailRequest>) => {
  const { id, sourceData, width, height } = e.data;

  try {
    const src = new Uint8ClampedArray(sourceData);
    const len = src.length; // width × height × 4

    for (const profile of ALL_STOCK_PROFILES) {
      const out = new Uint8ClampedArray(len);

      for (let i = 0; i < len; i += 4) {
        const [r, g, b] = renderFilmPixel(src[i], src[i + 1], src[i + 2], profile);
        out[i] = r;
        out[i + 1] = g;
        out[i + 2] = b;
        out[i + 3] = src[i + 3]; // preserve alpha
      }

      const buf = out.buffer.slice(0) as ArrayBuffer;
      (self as any).postMessage(
        { id, filterId: profile.id, imageData: buf, width, height } satisfies ThumbnailResult,
        [buf],
      );
    }

    (self as any).postMessage({ id, done: true } satisfies ThumbnailDone);
  } catch (err) {
    (self as any).postMessage({ id, error: (err as Error).message });
  }
};
