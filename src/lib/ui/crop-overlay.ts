import type { CropRect } from '../core/types';
import { constrainCropToAspect } from '../processing/transform';

export type CropCommitHandler = (crop: CropRect) => void;

type DragMode = 'move' | 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w';

export class CropOverlay {
  private readonly root: HTMLElement;
  private readonly box: HTMLElement;
  private readonly shadeTop: HTMLElement;
  private readonly shadeBottom: HTMLElement;
  private readonly shadeLeft: HTMLElement;
  private readonly shadeRight: HTMLElement;
  private crop: CropRect = { x: 0, y: 0, width: 1, height: 1 };
  private onCommit: CropCommitHandler | null = null;
  private dragging = false;
  private didDrag = false;
  private dragMode: DragMode | null = null;
  private dragStart = { x: 0, y: 0 };
  private cropStart: CropRect = this.crop;
  private activePointerId: number | null = null;
  private captureTarget: HTMLElement | null = null;
  private readonly onWindowPointerMove: (event: PointerEvent) => void;
  private readonly onWindowPointerUp: (event: PointerEvent) => void;
  private isListening = false;
  private lockedAspect: number | null = null;
  private frameAspect = 1;

  constructor(root: HTMLElement) {
    this.root = root;
    root.innerHTML = `
      <div class="crop-shade crop-shade-top" data-shade-top></div>
      <div class="crop-shade crop-shade-bottom" data-shade-bottom></div>
      <div class="crop-shade crop-shade-left" data-shade-left></div>
      <div class="crop-shade crop-shade-right" data-shade-right></div>
      <div class="crop-box" data-crop-box>
        <span class="crop-handle crop-handle-nw" data-handle="nw"></span>
        <span class="crop-handle crop-handle-ne" data-handle="ne"></span>
        <span class="crop-handle crop-handle-sw" data-handle="sw"></span>
        <span class="crop-handle crop-handle-se" data-handle="se"></span>
        <span class="crop-handle crop-handle-n" data-handle="n"></span>
        <span class="crop-handle crop-handle-s" data-handle="s"></span>
        <span class="crop-handle crop-handle-e" data-handle="e"></span>
        <span class="crop-handle crop-handle-w" data-handle="w"></span>
        <span class="crop-grid" aria-hidden="true"></span>
      </div>
    `;

    this.box = root.querySelector('[data-crop-box]') as HTMLElement;
    this.shadeTop = root.querySelector('[data-shade-top]') as HTMLElement;
    this.shadeBottom = root.querySelector('[data-shade-bottom]') as HTMLElement;
    this.shadeLeft = root.querySelector('[data-shade-left]') as HTMLElement;
    this.shadeRight = root.querySelector('[data-shade-right]') as HTMLElement;

    this.box.addEventListener('pointerdown', (event) => this.startDrag('move', event));
    root.querySelectorAll('[data-handle]').forEach((element) => {
      element.addEventListener('pointerdown', (event) => {
        event.stopPropagation();
        const mode = (element as HTMLElement).dataset.handle as DragMode;
        this.startDrag(mode, event as PointerEvent);
      });
    });

    this.onWindowPointerMove = (event: PointerEvent) => this.onDrag(event);
    this.onWindowPointerUp = (event: PointerEvent) => this.endDrag(event);
  }

  setCommitHandler(handler: CropCommitHandler): void {
    this.onCommit = handler;
  }

  setAspectLock(targetAspect: number | null, frameAspect: number): void {
    this.lockedAspect = targetAspect;
    this.frameAspect = frameAspect;
  }

  isDragging(): boolean {
    return this.dragging;
  }

  setCrop(crop: CropRect): void {
    this.crop = { ...crop };
    this.render();
  }

  getCrop(): CropRect {
    return { ...this.crop };
  }

  setVisible(visible: boolean): void {
    this.root.classList.toggle('is-active', visible);
    this.root.hidden = !visible;
    if (visible) {
      this.attachWindowListeners();
      this.render();
    } else {
      this.detachWindowListeners();
      this.cancelDrag();
    }
  }

  private attachWindowListeners(): void {
    if (this.isListening) return;
    window.addEventListener('pointermove', this.onWindowPointerMove);
    window.addEventListener('pointerup', this.onWindowPointerUp);
    window.addEventListener('pointercancel', this.onWindowPointerUp);
    this.isListening = true;
  }

  private detachWindowListeners(): void {
    if (!this.isListening) return;
    window.removeEventListener('pointermove', this.onWindowPointerMove);
    window.removeEventListener('pointerup', this.onWindowPointerUp);
    window.removeEventListener('pointercancel', this.onWindowPointerUp);
    this.isListening = false;
  }

  private startDrag(mode: DragMode, event: PointerEvent): void {
    event.preventDefault();
    this.dragging = true;
    this.didDrag = false;
    this.dragMode = mode;
    this.dragStart = { x: event.clientX, y: event.clientY };
    this.cropStart = { ...this.crop };
    this.activePointerId = event.pointerId;
    this.captureTarget = event.currentTarget as HTMLElement;
    this.captureTarget.setPointerCapture(event.pointerId);
  }

  private onDrag(event: PointerEvent): void {
    if (!this.dragging || this.dragMode === null) return;
    if (this.activePointerId !== null && event.pointerId !== this.activePointerId) return;

    const moved =
      Math.abs(event.clientX - this.dragStart.x) > 2 ||
      Math.abs(event.clientY - this.dragStart.y) > 2;
    if (moved) {
      this.didDrag = true;
    }

    const rect = this.root.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const dx = (event.clientX - this.dragStart.x) / rect.width;
    const dy = (event.clientY - this.dragStart.y) / rect.height;
    const start = this.cropStart;
    let { x, y, width, height } = start;

    switch (this.dragMode) {
      case 'move':
        x = Math.max(0, Math.min(1 - width, start.x + dx));
        y = Math.max(0, Math.min(1 - height, start.y + dy));
        break;
      case 'nw':
        x = Math.min(start.x + start.width - 0.08, start.x + dx);
        y = Math.min(start.y + start.height - 0.08, start.y + dy);
        width = start.width - (x - start.x);
        height = start.height - (y - start.y);
        break;
      case 'ne':
        y = Math.min(start.y + start.height - 0.08, start.y + dy);
        width = Math.max(0.08, start.width + dx);
        height = start.height - (y - start.y);
        break;
      case 'sw':
        x = Math.min(start.x + start.width - 0.08, start.x + dx);
        width = start.width - (x - start.x);
        height = Math.max(0.08, start.height + dy);
        break;
      case 'se':
        width = Math.max(0.08, start.width + dx);
        height = Math.max(0.08, start.height + dy);
        break;
      case 'n':
        y = Math.min(start.y + start.height - 0.08, start.y + dy);
        height = start.height - (y - start.y);
        break;
      case 's':
        height = Math.max(0.08, start.height + dy);
        break;
      case 'e':
        width = Math.max(0.08, start.width + dx);
        break;
      case 'w':
        x = Math.min(start.x + start.width - 0.08, start.x + dx);
        width = start.width - (x - start.x);
        break;
      default:
        break;
    }

    x = Math.max(0, x);
    y = Math.max(0, y);
    width = Math.min(1 - x, width);
    height = Math.min(1 - y, height);

    let next = { x, y, width, height };
    if (this.lockedAspect !== null) {
      next = constrainCropToAspect(next, this.lockedAspect, this.frameAspect);
    }

    this.crop = next;
    this.render();
  }

  private endDrag(event: PointerEvent): void {
    if (!this.dragging) return;
    if (this.activePointerId !== null && event.pointerId !== this.activePointerId) return;

    if (this.didDrag) {
      this.onCommit?.(this.crop);
    }

    this.releaseCapture();
    this.dragging = false;
    this.dragMode = null;
    this.didDrag = false;
    this.activePointerId = null;
    this.captureTarget = null;
  }

  private cancelDrag(): void {
    this.releaseCapture();
    this.dragging = false;
    this.dragMode = null;
    this.didDrag = false;
    this.activePointerId = null;
    this.captureTarget = null;
  }

  private releaseCapture(): void {
    if (
      this.captureTarget &&
      this.activePointerId !== null &&
      this.captureTarget.hasPointerCapture(this.activePointerId)
    ) {
      this.captureTarget.releasePointerCapture(this.activePointerId);
    }
  }

  private render(): void {
    const { x, y, width, height } = this.crop;
    const left = `${x * 100}%`;
    const top = `${y * 100}%`;
    const right = `${(1 - x - width) * 100}%`;
    const bottom = `${(1 - y - height) * 100}%`;
    const boxHeight = `${height * 100}%`;

    Object.assign(this.box.style, {
      left,
      top,
      width: `${width * 100}%`,
      height: boxHeight,
    });

    this.shadeTop.style.height = top;
    this.shadeBottom.style.height = bottom;
    Object.assign(this.shadeLeft.style, {
      top,
      left: '0',
      width: left,
      height: boxHeight,
    });
    Object.assign(this.shadeRight.style, {
      top,
      right: '0',
      width: right,
      height: boxHeight,
    });
  }
}