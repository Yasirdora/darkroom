import { ImageBuffer } from './image-buffer';
import {
  VIEW_ZOOM_DEFAULT,
  clampViewZoom,
  computeCanvasDisplaySize,
} from '../ui/canvas-view';

export class CanvasRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly scratch: HTMLCanvasElement;
  private readonly scratchContext: CanvasRenderingContext2D;
  private lastDisplayWidth = '';
  private lastDisplayHeight = '';
  private lastViewZoom = VIEW_ZOOM_DEFAULT;
  private viewZoom = VIEW_ZOOM_DEFAULT;

  constructor(canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!context) {
      throw new Error('Unable to acquire a 2D canvas context.');
    }

    const scratch = document.createElement('canvas');
    const scratchContext = scratch.getContext('2d', { alpha: false, willReadFrequently: true });
    if (!scratchContext) {
      throw new Error('Unable to acquire scratch canvas context.');
    }

    this.canvas = canvas;
    this.context = context;
    this.scratch = scratch;
    this.scratchContext = scratchContext;
  }

  draw(buffer: ImageBuffer): void {
    if (
      this.scratch.width !== buffer.width ||
      this.scratch.height !== buffer.height
    ) {
      this.scratch.width = buffer.width;
      this.scratch.height = buffer.height;
      this.canvas.width = buffer.width;
      this.canvas.height = buffer.height;
      this.lastDisplayWidth = '';
      this.lastDisplayHeight = '';
    }

    this.scratchContext.putImageData(buffer.toImageData(), 0, 0);
    this.context.drawImage(this.scratch, 0, 0);
    this.fitToParent();
  }

  clear(): void {
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.canvas.style.width = '';
    this.canvas.style.height = '';
    this.lastDisplayWidth = '';
    this.lastDisplayHeight = '';
  }

  getViewZoom(): number {
    return this.viewZoom;
  }

  setViewZoom(percent: number): void {
    const next = clampViewZoom(percent);
    if (next === this.viewZoom) return;
    this.viewZoom = next;
    this.lastDisplayWidth = '';
    this.lastDisplayHeight = '';
    this.fitToParent();
  }

  /** Scale canvas element to fit its container without changing pixel resolution. */
  fitToParent(): void {
    const parent = this.canvas.parentElement;
    if (!parent || this.canvas.width === 0 || this.canvas.height === 0) {
      return;
    }

    // Measure available space from a stable flex container (stage/backdrop fill the UI area).
    // .canvas-frame is deliberately sized to the current image display rect (for crop overlay),
    // so using it as bounds would cause chained shrinking on uploads, rotates, aspect changes.
    const container =
      (this.canvas.closest('.canvas-backdrop') as HTMLElement | null) ||
      (this.canvas.closest('.canvas-stage') as HTMLElement | null) ||
      parent;

    const maxWidth = container.clientWidth || parent.clientWidth;
    const maxHeight = container.clientHeight || parent.clientHeight;
    if (maxWidth === 0 || maxHeight === 0) {
      return;
    }

    const { width, height } = computeCanvasDisplaySize(
      this.canvas.width,
      this.canvas.height,
      maxWidth,
      maxHeight,
      this.viewZoom,
    );
    const widthPx = `${width}px`;
    const heightPx = `${height}px`;

    if (
      widthPx === this.lastDisplayWidth &&
      heightPx === this.lastDisplayHeight &&
      this.viewZoom === this.lastViewZoom
    ) {
      return;
    }

    this.canvas.style.width = widthPx;
    this.canvas.style.height = heightPx;
    this.lastDisplayWidth = widthPx;
    this.lastDisplayHeight = heightPx;
    this.lastViewZoom = this.viewZoom;
  }

  async exportBlob(type = 'image/png', quality = 0.92): Promise<Blob> {
    return new Promise((resolve, reject) => {
      this.canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error('Failed to export image.'));
            return;
          }
          resolve(blob);
        },
        type,
        quality,
      );
    });
  }
}