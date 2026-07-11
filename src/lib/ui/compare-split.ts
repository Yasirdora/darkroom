import { ImageBuffer } from '../core/image-buffer';
import {
  VIEW_ZOOM_DEFAULT,
  clampViewZoom,
  computeCanvasDisplaySize,
} from './canvas-view';

export class CompareSplitView {
  private readonly container: HTMLElement;
  private readonly editedCanvas: HTMLCanvasElement;
  private readonly originalCanvas: HTMLCanvasElement;
  private readonly divider: HTMLElement;
  private fitTarget: HTMLElement | null = null;
  private position = 0.5;
  private isDragging = false;
  private lastEdited: ImageBuffer | null = null;
  private lastOriginal: ImageBuffer | null = null;
  private viewZoom = VIEW_ZOOM_DEFAULT;
  private readonly onKeyDown: (event: KeyboardEvent) => void;

  constructor(container: HTMLElement) {
    this.container = container;
    container.innerHTML = `
      <canvas class="compare-canvas compare-canvas-original" data-original aria-hidden="true"></canvas>
      <canvas class="compare-canvas compare-canvas-edited" data-edited aria-label="Edited image preview"></canvas>
      <span class="compare-label compare-label-before">Before</span>
      <span class="compare-label compare-label-after">After</span>
      <div class="compare-divider" data-divider>
        <div class="compare-divider-line"></div>
        <div class="compare-divider-handle" data-handle>
          <svg class="divider-arrow divider-arrow-left" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>
          <svg class="divider-arrow divider-arrow-right" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
        </div>
      </div>
    `;

    this.originalCanvas = container.querySelector('[data-original]') as HTMLCanvasElement;
    this.editedCanvas = container.querySelector('[data-edited]') as HTMLCanvasElement;
    this.divider = container.querySelector('[data-divider]') as HTMLElement;

    this.divider.tabIndex = 0;
    this.divider.setAttribute('role', 'slider');
    this.divider.setAttribute('aria-label', 'Compare divider');
    this.divider.setAttribute('aria-valuemin', '2');
    this.divider.setAttribute('aria-valuemax', '98');
    this.divider.setAttribute('aria-valuenow', '50');

    this.onKeyDown = (event: KeyboardEvent) => {
      if (!this.container.classList.contains('is-active')) return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        this.setPosition(this.position - 0.02);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        this.setPosition(this.position + 0.02);
      }
    };

    this.bindEvents();
    this.setPosition(0.5);
    this.divider.addEventListener('keydown', this.onKeyDown);
  }

  setFitTarget(target: HTMLElement | null): void {
    this.fitTarget = target;
  }

  setViewZoom(percent: number): void {
    this.viewZoom = clampViewZoom(percent);
    this.refit();
  }

  setVisible(visible: boolean): void {
    this.container.classList.toggle('is-active', visible);
    this.container.hidden = !visible;
    if (visible) {
      this.refit();
      this.setPosition(this.position);
      if (this.lastEdited && this.lastOriginal) {
        this.putBuffer(this.editedCanvas, this.lastEdited);
        this.putBuffer(this.originalCanvas, this.lastOriginal);
      }
    }
  }

  draw(edited: ImageBuffer, original: ImageBuffer): void {
    this.lastEdited = edited;
    this.lastOriginal = original;
    this.putBuffer(this.editedCanvas, edited);
    this.putBuffer(this.originalCanvas, original);
    this.refit();
    this.setPosition(this.position);
  }

  refit(): void {
    this.fitCanvasesToContainer();
  }

  getDisplaySize(): { width: string; height: string } | null {
    const { width, height } = this.container.style;
    if (!width || !height) return null;
    return { width, height };
  }

  clear(): void {
    this.lastEdited = null;
    this.lastOriginal = null;
    const contexts = [this.editedCanvas, this.originalCanvas].map((canvas) =>
      canvas.getContext('2d'),
    );
    contexts.forEach((context, index) => {
      const canvas = index === 0 ? this.editedCanvas : this.originalCanvas;
      if (context) context.clearRect(0, 0, canvas.width, canvas.height);
    });
  }

  private putBuffer(canvas: HTMLCanvasElement, buffer: ImageBuffer): void {
    if (canvas.width !== buffer.width || canvas.height !== buffer.height) {
      canvas.width = buffer.width;
      canvas.height = buffer.height;
    }
    const context = canvas.getContext('2d');
    if (!context) return;
    context.putImageData(buffer.toImageData(), 0, 0);
  }

  private fitCanvasesToContainer(): void {
    const bounds = this.fitTarget ?? this.container.parentElement;
    if (!bounds) return;

    const maxWidth = bounds.clientWidth;
    const maxHeight = bounds.clientHeight;
    if (maxWidth === 0 || maxHeight === 0 || this.editedCanvas.width === 0) {
      return;
    }

    const { width, height } = computeCanvasDisplaySize(
      this.editedCanvas.width,
      this.editedCanvas.height,
      maxWidth,
      maxHeight,
      this.viewZoom,
    );
    const widthPx = `${width}px`;
    const heightPx = `${height}px`;

    this.editedCanvas.style.width = widthPx;
    this.editedCanvas.style.height = heightPx;
    this.originalCanvas.style.width = widthPx;
    this.originalCanvas.style.height = heightPx;
    this.container.style.width = widthPx;
    this.container.style.height = heightPx;
  }

  private bindEvents(): void {
    const onPointerDown = (event: PointerEvent) => {
      event.preventDefault();
      this.isDragging = true;
      this.divider.setPointerCapture(event.pointerId);
      this.updateFromEvent(event);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!this.isDragging) return;
      this.updateFromEvent(event);
    };

    const onPointerUp = (event: PointerEvent) => {
      if (!this.isDragging) return;
      this.isDragging = false;
      this.divider.releasePointerCapture(event.pointerId);
    };

    this.divider.addEventListener('pointerdown', onPointerDown);
    this.divider.addEventListener('pointermove', onPointerMove);
    this.divider.addEventListener('pointerup', onPointerUp);
    this.divider.addEventListener('pointercancel', onPointerUp);
  }

  private updateFromEvent(event: PointerEvent): void {
    const rect = this.container.getBoundingClientRect();
    const x = event.clientX - rect.left;
    this.setPosition(x / rect.width);
  }

  private setPosition(position: number): void {
    this.position = Math.max(0.02, Math.min(0.98, position));
    const percent = `${this.position * 100}%`;
    this.divider.style.left = percent;
    this.editedCanvas.style.clipPath = `inset(0 0 0 ${percent})`;
    this.divider.setAttribute('aria-valuenow', String(Math.round(this.position * 100)));
  }
}