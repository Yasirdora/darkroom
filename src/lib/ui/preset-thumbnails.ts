import type { EffectId, FilterId } from '../core/types';
import { ImageBuffer } from '../core/image-buffer';
import { DEFAULT_EDIT_STATE } from '../editor/constants';
import { applyEffect, EFFECT_DEFINITIONS } from '../processing/effects';
import type { ThumbnailResult, ThumbnailDone } from './thumbnail.worker';

const EFFECT_BATCH_SIZE = 2;

/**
 * Thumbnails must be rendered for the size they're actually displayed at,
 * times devicePixelRatio. A fixed 72px looked passable in the narrow desktop
 * rail but turned into blocky, artifact-ridden mush on phones, where the
 * two-column preset grid shows cards ~170 CSS px wide on 2–3× displays
 * (a 5–7× upscale). Capped for render cost — the film pipeline runs
 * per-pixel per stock.
 */
const thumbRenderSize = (): number => {
  const dpr = Math.min(2.5, window.devicePixelRatio || 1);
  const cardCss =
    window.innerWidth <= 820
      ? Math.min(220, window.innerWidth / 2 - 28) // two-column mobile grid
      : 132; // desktop rail card
  return Math.round(Math.min(288, Math.max(96, cardCss * dpr)));
};

// Reuse a single canvas for all data-URL conversions to avoid GC pressure.
let sharedCanvas: HTMLCanvasElement | null = null;
let sharedCtx: CanvasRenderingContext2D | null = null;

const pixelsToDataUrl = (
  data: ArrayBuffer,
  width: number,
  height: number,
): string => {
  if (!sharedCanvas) {
    sharedCanvas = document.createElement('canvas');
  }
  if (sharedCanvas.width !== width) sharedCanvas.width = width;
  if (sharedCanvas.height !== height) sharedCanvas.height = height;

  if (!sharedCtx) {
    sharedCtx = sharedCanvas.getContext('2d', { willReadFrequently: true });
  }
  if (!sharedCtx) return '';

  const imageData = new ImageData(new Uint8ClampedArray(data), width, height);
  sharedCtx.putImageData(imageData, 0, 0);
  return sharedCanvas.toDataURL('image/jpeg', 0.86);
};

// ─── Worker management ───────────────────────────────────────────────────────

let thumbnailWorker: Worker | null = null;
let jobId = 0;

function getThumbnailWorker(): Worker {
  if (!thumbnailWorker) {
    thumbnailWorker = new Worker(
      new URL('./thumbnail.worker.ts', import.meta.url),
      { type: 'module' },
    );
  }
  return thumbnailWorker;
}

/**
 * Build all filter thumbnails off the main thread.
 *
 * The worker calls renderFilmPixel directly on each thumbnail pixel
 * (~5K pixels) instead of building a 262K-entry LUT per filter,
 * giving a ~50× speedup. Results stream back progressively via onProgress.
 */
export const buildFilterThumbnails = (
  source: ImageBuffer,
  onProgress?: (filterId: FilterId, dataUrl: string) => void,
): Promise<Partial<Record<FilterId, string>>> => {
  const base = source.downscale(thumbRenderSize());
  const id = ++jobId;

  return new Promise((resolve, reject) => {
    const worker = getThumbnailWorker();
    const thumbnails: Partial<Record<FilterId, string>> = {};

    const handler = (e: MessageEvent) => {
      if (e.data.id !== id) return;

      if (e.data.error) {
        worker.removeEventListener('message', handler);
        reject(new Error(e.data.error));
        return;
      }

      if ((e.data as ThumbnailDone).done) {
        worker.removeEventListener('message', handler);
        resolve(thumbnails);
        return;
      }

      // Progressive result — convert raw pixels to data URL and notify
      const result = e.data as ThumbnailResult;
      const dataUrl = pixelsToDataUrl(result.imageData, result.width, result.height);
      thumbnails[result.filterId] = dataUrl;
      onProgress?.(result.filterId, dataUrl);
    };

    worker.addEventListener('message', handler);

    // Transfer source pixel data to the worker (zero-copy)
    const transferData = base.data.buffer.slice(0) as ArrayBuffer;
    worker.postMessage(
      { id, sourceData: transferData, width: base.width, height: base.height },
      [transferData],
    );
  });
};

// ─── Effect thumbnails (still on main thread — fewer & lighter) ──────────────

const bufferToDataUrl = (buffer: ImageBuffer): string => {
  if (!sharedCanvas) {
    sharedCanvas = document.createElement('canvas');
  }
  if (sharedCanvas.width !== buffer.width) sharedCanvas.width = buffer.width;
  if (sharedCanvas.height !== buffer.height) sharedCanvas.height = buffer.height;

  if (!sharedCtx) {
    sharedCtx = sharedCanvas.getContext('2d', { willReadFrequently: true });
  }
  if (!sharedCtx) return '';

  sharedCtx.putImageData(buffer.toImageData(), 0, 0);
  return sharedCanvas.toDataURL('image/jpeg', 0.86);
};

const idle = (): Promise<void> =>
  new Promise((resolve) => {
    const ric = (window as Window & { requestIdleCallback?: typeof requestIdleCallback })
      .requestIdleCallback;
    if (ric) {
      ric(() => resolve(), { timeout: 100 });
    } else {
      setTimeout(resolve, 4);
    }
  });

const processBatches = async <T>(
  items: T[],
  batchSize: number,
  handler: (item: T) => void,
): Promise<void> => {
  for (let index = 0; index < items.length; index += batchSize) {
    const batch = items.slice(index, index + batchSize);
    batch.forEach(handler);
    await idle();
  }
};

const renderEffectThumb = (buffer: ImageBuffer, effectId: EffectId): string => {
  const state = {
    ...DEFAULT_EDIT_STATE,
    effectId,
    effectIntensity: 100,
  };
  let current = buffer.clone();
  current = applyEffect(
    current,
    state.effectId,
    state.effectIntensity,
    state.effectOptions,
  );
  return bufferToDataUrl(current);
};

export const buildEffectThumbnails = async (
  source: ImageBuffer,
): Promise<Partial<Record<EffectId, string>>> => {
  const base = source.downscale(thumbRenderSize());
  const thumbnails: Partial<Record<EffectId, string>> = {};
  const effects = EFFECT_DEFINITIONS.filter((item) => item.id !== 'none');

  await processBatches(effects, EFFECT_BATCH_SIZE, (effect) => {
    thumbnails[effect.id] = renderEffectThumb(base, effect.id);
  });

  return thumbnails;
};