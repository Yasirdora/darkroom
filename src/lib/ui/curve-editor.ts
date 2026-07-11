/**
 * Interactive curves editor.
 * Supports master + RGB channels with Bézier handles for smooth curves.
 * Only S-Curve preset + simple point editing (as requested).
 * Click point to select (shows handles), drag handles to shape.
 * Double-click near a point or select + Delete to remove.
 */

import type { Curves, CurvePoint } from '../core/types';
import { interpolateCurve } from '../processing/curves';

export type CurveChannel = 'master' | 'r' | 'g' | 'b';

export class CurveEditor {
  private root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private curves: Curves = {};
  private activeChannel: CurveChannel = 'master';
  private onChange: (curves: Curves) => void;
  private readonly eventAbort = new AbortController();
  private draggingPoint: { ch: CurveChannel; idx: number } | null = null;
  private draggingHandle: { ch: CurveChannel; idx: number; which: 'in' | 'out'; linked: boolean } | null = null;
  private selectedPoint: { ch: CurveChannel; idx: number } | null = null;
  // private readonly handleSize = 6;
  private readonly pointSize = 5;
  private logicalW = 280;
  private logicalH = 180;
  private resizeObserver: ResizeObserver | null = null;

  constructor(container: HTMLElement, onChange: (c: Curves) => void, initial: Curves = {}) {
    this.root = container;
    this.onChange = onChange;
    this.curves = { ...initial };

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'curve-canvas';
    this.ctx = this.canvas.getContext('2d', { alpha: true })!;

    this.root.innerHTML = '';
    this.root.appendChild(this.canvas);
    this.resizeCanvas();
    this.resizeObserver = new ResizeObserver(() => {
      this.resizeCanvas();
      this.render();
    });
    this.resizeObserver.observe(this.canvas);

    // Channel tabs
    const tabs = document.createElement('div');
    tabs.className = 'curve-tabs';
    (['master', 'r', 'g', 'b'] as CurveChannel[]).forEach((ch) => {
      const b = document.createElement('button');
      b.textContent = ch === 'master' ? 'RGB' : ch.toUpperCase();
      b.className = `curve-tab ${ch === this.activeChannel ? 'active' : ''}`;
      b.dataset.ch = ch;
      b.addEventListener('click', () => this.setChannel(ch));
      tabs.appendChild(b);
    });
    this.root.appendChild(tabs);

    // Controls row - keep it simple, only S-Curve as requested
    const row = document.createElement('div');
    row.className = 'curve-row';
    const reset = document.createElement('button');
    reset.textContent = 'Reset';
    reset.className = 'curve-btn';
    reset.addEventListener('click', () => this.resetChannel());

    const sCurve = document.createElement('button');
    sCurve.textContent = 'S-Curve';
    sCurve.className = 'curve-btn';
    sCurve.addEventListener('click', () => this.applySCurve());
    row.append(sCurve, reset);
    this.root.appendChild(row);

    this.bindEvents();
    this.render();
  }

  getCurves(): Curves {
    return JSON.parse(JSON.stringify(this.curves));
  }

  getActiveChannel(): CurveChannel {
    return this.activeChannel;
  }

  setCurves(c: Curves) {
    this.curves = JSON.parse(JSON.stringify(c));
    this.render();
  }

  private setChannel(ch: CurveChannel) {
    this.activeChannel = ch;
    this.root.querySelectorAll('.curve-tab').forEach((el) => {
      (el as HTMLElement).classList.toggle('active', (el as HTMLElement).dataset.ch === ch);
    });
    this.render();
  }

  destroy(): void {
    this.eventAbort.abort();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.root.innerHTML = '';
  }

  /** Match backing-store pixels to CSS size so the curve isn't stretched or blurry. */
  private resizeCanvas(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const displayW = Math.max(1, Math.round(rect.width || this.logicalW));
    const displayH = Math.max(1, Math.round(rect.height || this.logicalH));
    const nextW = Math.round(displayW * dpr);
    const nextH = Math.round(displayH * dpr);

    if (this.canvas.width !== nextW || this.canvas.height !== nextH) {
      this.canvas.width = nextW;
      this.canvas.height = nextH;
    }

    this.logicalW = displayW;
    this.logicalH = displayH;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private bindEvents() {
    const { signal } = this.eventAbort;
    const getNorm = (e: MouseEvent | PointerEvent) => {
      const rect = this.canvas.getBoundingClientRect();
      return {
        x: clamp((e.clientX - rect.left) / rect.width, 0, 1),
        y: clamp(1 - (e.clientY - rect.top) / rect.height, 0, 1)
      };
    };

    this.canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.canvas.setPointerCapture(e.pointerId);
      const { x, y } = getNorm(e);
      const pts = this.getChannelPoints();
      const ch = this.activeChannel;

      // Check handles first if a point is selected
      if (this.selectedPoint && this.selectedPoint.ch === ch) {
        const p = pts[this.selectedPoint.idx];
        if (p) {
          const hinX = p.handleInX ?? p.x - 0.12;
          const hinY = p.handleInY ?? p.y;
          const houtX = p.handleOutX ?? p.x + 0.12;
          const houtY = p.handleOutY ?? p.y;

          const dIn = Math.hypot(hinX - x, hinY - y);
          const dOut = Math.hypot(houtX - x, houtY - y);
          const handleHitRadius = 0.06;
          if (dIn < handleHitRadius) {
            this.draggingHandle = { ch, idx: this.selectedPoint.idx, which: 'in', linked: !e.altKey };
            this.render();
            this.emit();
            return;
          }
          if (dOut < handleHitRadius) {
            this.draggingHandle = { ch, idx: this.selectedPoint.idx, which: 'out', linked: !e.altKey };
            this.render();
            this.emit();
            return;
          }
        }
      }

      // Check points
      let closest = -1;
      let minD = Infinity;
      pts.forEach((p, i) => {
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < minD && d < 0.085) { minD = d; closest = i; }
      });

      if (closest >= 0) {
        this.selectedPoint = { ch, idx: closest };
        this.draggingPoint = { ch, idx: closest };
        const prevX = closest > 0 ? pts[closest - 1].x : 0;
        const nextX = closest < pts.length - 1 ? pts[closest + 1].x : 1;
        const linked = ensurePointHandles(pts[closest], prevX, nextX);
        if (linked) {
          const updated = [...pts];
          updated[closest] = linked;
          this.setChannelPoints(updated, ch);
        }
      } else {
        // Add new point (no auto handles to keep simple unless S-Curve used)
        const pts2 = [...pts, { x, y }];
        this.setChannelPoints(this.sortUnique(pts2));
        const fresh = this.getChannelPoints();
        let idx = fresh.findIndex((p) => Math.abs(p.x - x) < 0.001);
        if (idx < 0) idx = fresh.findIndex((p) => Math.abs(p.x - x) < 0.01);
        this.selectedPoint = { ch, idx: Math.max(0, idx) };
        this.draggingPoint = { ch, idx: Math.max(0, idx) };
      }
      this.render();
      this.emit();
    });

    window.addEventListener('pointermove', (e) => {
      const { x, y } = getNorm(e as any);
      const ch = this.activeChannel;

      if (this.draggingHandle) {
        const idx = this.draggingHandle.idx;
        const pts = this.getChannelPoints(ch);
        if (idx < 0 || idx >= pts.length) return;

        const prevX = idx > 0 ? pts[idx - 1].x : 0;
        const nextX = idx < pts.length - 1 ? pts[idx + 1].x : 1;
        const updated = applyHandleDrag(
          pts[idx],
          this.draggingHandle.which,
          x,
          y,
          prevX,
          nextX,
          this.draggingHandle.linked,
        );

        pts[idx] = updated;
        this.setChannelPoints(pts, ch);
        this.render();
        this.emit();
        return;
      }

      if (!this.draggingPoint) return;
      let idx = this.draggingPoint.idx;
      let pts = this.getChannelPoints(ch);
      if (idx < 0 || idx >= pts.length) return;
      const p = { ...pts[idx] };
      const dx = x - p.x;
      const dy = y - p.y;

      // Move point, clamped to neighbors to preserve order (monotonic x)
      let newX = clamp(x, 0, 1);
      if (idx === 0) {
        newX = 0;
      } else if (idx === pts.length - 1) {
        newX = 1;
      } else {
        const leftX = pts[idx - 1].x;
        const rightX = pts[idx + 1].x;
        newX = clamp(x, leftX, rightX);
      }
      p.x = newX;
      p.y = clamp(y, 0, 1);

      // Move handles with point (preserve relative offset)
      if (p.handleInX !== undefined) p.handleInX = clamp(p.handleInX + dx, 0, 1);
      if (p.handleInY !== undefined) p.handleInY = clamp(p.handleInY + dy, 0, 1);
      if (p.handleOutX !== undefined) p.handleOutX = clamp(p.handleOutX + dx, 0, 1);
      if (p.handleOutY !== undefined) p.handleOutY = clamp(p.handleOutY + dy, 0, 1);

      pts[idx] = p;
      this.setChannelPoints(this.sortUnique(pts), ch);

      // Re-resolve idx after potential reorder from sort (x changed)
      const freshPts = this.getChannelPoints(ch);
      const matchIdx = freshPts.findIndex((pp) => Math.abs(pp.x - p.x) < 0.001);
      if (matchIdx >= 0) {
        idx = matchIdx;
        this.draggingPoint = { ch, idx };
        if (this.selectedPoint && this.selectedPoint.ch === ch) this.selectedPoint.idx = idx;
      }

      this.render();
      this.emit();
    }, { signal });

    const endPointer = (e: PointerEvent) => {
      if (this.canvas.hasPointerCapture(e.pointerId)) {
        this.canvas.releasePointerCapture(e.pointerId);
      }
      this.draggingPoint = null;
      this.draggingHandle = null;
    };

    this.canvas.addEventListener('pointerup', endPointer, { signal });
    this.canvas.addEventListener('pointercancel', endPointer, { signal });

    this.canvas.addEventListener('dblclick', (e) => {
      const { x, y } = getNorm(e as any);
      const ch = this.activeChannel;
      let pts = this.getChannelPoints(ch);
      // Remove closest non-end point — forgiving radius for usability
      let toRemove = -1;
      let minD = 0.12;
      pts.forEach((p, i) => {
        if (i === 0 || i === pts.length - 1) return;
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < minD) {
          minD = d;
          toRemove = i;
        }
      });
      if (toRemove >= 0) {
        pts.splice(toRemove, 1);
        this.selectedPoint = null;
        this.draggingPoint = null;
        this.draggingHandle = null;
        this.setChannelPoints(pts, ch);
        this.render();
        this.emit();
      }
    });

    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedPoint) {
        const ch = this.selectedPoint.ch;
        let pts = this.getChannelPoints(ch);
        let idx = this.selectedPoint.idx;
        if (idx > 0 && idx < pts.length - 1) {
          pts.splice(idx, 1);
          this.selectedPoint = null;
          this.draggingPoint = null;
          this.draggingHandle = null;
          this.setChannelPoints(pts, ch);
          this.render();
          this.emit();
          e.preventDefault();
        }
      }
    }, { signal });
  }

  private getChannelPoints(ch: CurveChannel = this.activeChannel): CurvePoint[] {
    return this.curves[ch] ? [...this.curves[ch]!] : [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  }

  private setChannelPoints(pts: CurvePoint[], ch: CurveChannel = this.activeChannel) {
    if (!this.curves[ch]) this.curves[ch] = [];
    this.curves[ch] = this.sortUnique(pts);
  }

  private sortUnique(pts: CurvePoint[]): CurvePoint[] {
    const s = pts.slice().sort((a, b) => a.x - b.x);
    // dedup close x, preserve handles
    const out: CurvePoint[] = [];
    for (const p of s) {
      if (out.length === 0 || Math.abs(out[out.length - 1].x - p.x) > 0.008) {
        out.push({ ...p }); // copy to keep handles
      }
    }
    return out;
  }

  private resetChannel() {
    delete this.curves[this.activeChannel];
    this.render();
    this.emit();
  }

  private applySCurve() {
    // Subtle contrast S — four anchors on a smooth tangent (no handle bulge).
    this.curves[this.activeChannel] = withSmoothHandles([
      { x: 0, y: 0 },
      { x: 0.25, y: 0.22 },
      { x: 0.75, y: 0.78 },
      { x: 1, y: 1 },
    ]);
    this.selectedPoint = null;
    this.render();
    this.emit();
  }

  private emit() {
    // Clean empty
    const clean: Curves = {};
    (['master', 'r', 'g', 'b'] as const).forEach((k) => {
      if (this.curves[k] && this.curves[k]!.length >= 2) clean[k] = this.curves[k];
    });
    this.onChange(clean);
  }

  private render() {
    this.resizeCanvas();
    const ctx = this.ctx;
    const w = this.logicalW;
    const h = this.logicalH;
    ctx.clearRect(0, 0, w, h);

    // Beautiful interactive RGB/Contrast background gradient
    const bgGradient = ctx.createLinearGradient(0, 0, 0, h);
    if (this.activeChannel === 'r') {
      bgGradient.addColorStop(0, 'rgba(255, 59, 48, 0.14)');   // Red at top
      bgGradient.addColorStop(1, 'rgba(84, 180, 211, 0.12)');  // Cyan at bottom
    } else if (this.activeChannel === 'g') {
      bgGradient.addColorStop(0, 'rgba(52, 199, 89, 0.12)');   // Green at top
      bgGradient.addColorStop(1, 'rgba(255, 45, 85, 0.12)');   // Magenta at bottom
    } else if (this.activeChannel === 'b') {
      bgGradient.addColorStop(0, 'rgba(0, 122, 255, 0.14)');   // Blue at top
      bgGradient.addColorStop(1, 'rgba(255, 204, 0, 0.12)');   // Yellow at bottom
    } else {
      bgGradient.addColorStop(0, 'rgba(255, 255, 255, 0.08)'); // Contrast highlights
      bgGradient.addColorStop(1, 'rgba(0, 0, 0, 0.15)');       // Contrast shadows
    }

    ctx.fillStyle = '#111113';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = bgGradient;
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i += 1) {
      ctx.beginPath();
      ctx.moveTo((i / 4) * w, 0);
      ctx.lineTo((i / 4) * w, h);
      ctx.moveTo(0, (i / 4) * h);
      ctx.lineTo(w, (i / 4) * h);
      ctx.stroke();
    }
    // Diagonal ref
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, h);
    ctx.lineTo(w, 0);
    ctx.stroke();
    ctx.setLineDash([]); // reset line dash for main curve line

    // Curve with Bézier support (cleaner look)
    const pts = this.getChannelPoints();
    const color = this.activeChannel === 'master' ? '#f5f5f7' :
      this.activeChannel === 'r' ? '#ff6b6b' : this.activeChannel === 'g' ? '#6bff8a' : '#6bb8ff';

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    const steps = Math.max(96, Math.round(Math.max(w, h) * 1.5));
    for (let s = 0; s <= steps; s += 1) {
      const xn = s / steps;
      const yn = interpolateCurve(xn, pts);
      const px = xn * w;
      const py = (1 - yn) * h;
      if (s === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // Points and handles (only for selected point to keep it clean)
    pts.forEach((p, i) => {
      const px = p.x * w;
      const py = (1 - p.y) * h;

      const sel = this.selectedPoint;
      const isSelected = !!(sel && sel.idx === i && sel.ch === this.activeChannel && sel.idx >= 0 && sel.idx < pts.length);
      const hasIn = p.handleInX !== undefined && p.handleInY !== undefined;
      const hasOut = p.handleOutX !== undefined && p.handleOutY !== undefined;

      if (isSelected) {
        ctx.strokeStyle = '#0a84ff';
        ctx.lineWidth = 1;

        if (hasIn && i > 0) {
          const hx = p.handleInX! * w;
          const hy = (1 - p.handleInY!) * h;
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(hx, hy);
          ctx.stroke();
          ctx.fillStyle = '#0a84ff';
          ctx.beginPath();
          ctx.arc(hx, hy, 3, 0, Math.PI * 2);
          ctx.fill();
        }
        if (hasOut && i < pts.length - 1) {
          const hx = p.handleOutX! * w;
          const hy = (1 - p.handleOutY!) * h;
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(hx, hy);
          ctx.stroke();
          ctx.fillStyle = '#0a84ff';
          ctx.beginPath();
          ctx.arc(hx, hy, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Anchor point
      ctx.fillStyle = isSelected ? '#fff' : '#ddd';
      ctx.beginPath();
      ctx.arc(px, py, this.pointSize, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#141416';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });
    ctx.lineWidth = 2.5;
  }
}

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

/** Ensure interior points have a linked in/out pair before handle editing. */
function ensurePointHandles(
  p: CurvePoint,
  prevX: number,
  nextX: number,
): CurvePoint | null {
  const isStart = p.x <= prevX + 0.0001;
  const isEnd = p.x >= nextX - 0.0001;
  if (isStart || isEnd) return null;

  const hasIn = p.handleInX !== undefined && p.handleInY !== undefined;
  const hasOut = p.handleOutX !== undefined && p.handleOutY !== undefined;
  if (hasIn && hasOut) return null;

  const spanX = Math.max(nextX - prevX, 0.08);
  const midY = p.y;
  const out: CurvePoint = { ...p };

  if (!hasOut) {
    out.handleOutX = clamp(p.x + spanX / 6, p.x, nextX);
    out.handleOutY = clamp(midY, 0, 1);
  }
  if (!hasIn) {
    out.handleInX = clamp(p.x - spanX / 6, prevX, p.x);
    out.handleInY = clamp(midY, 0, 1);
  }

  return mirrorLinkedHandles(out, prevX, nextX, hasIn ? 'in' : 'out');
}

/** Drag one handle; mirror the opposite through the anchor for a smooth point. */
function applyHandleDrag(
  p: CurvePoint,
  which: 'in' | 'out',
  hx: number,
  hy: number,
  prevX: number,
  nextX: number,
  linked: boolean,
): CurvePoint {
  const out: CurvePoint = { ...p };
  const px = p.x;
  const py = p.y;

  if (which === 'in') {
    out.handleInX = clamp(hx, prevX, px);
    out.handleInY = clamp(hy, 0, 1);
    if (linked && px < nextX - 0.0001) {
      return mirrorLinkedHandles(out, prevX, nextX, 'in');
    }
    return out;
  }

  out.handleOutX = clamp(hx, px, nextX);
  out.handleOutY = clamp(hy, 0, 1);
  if (linked && px > prevX + 0.0001) {
    return mirrorLinkedHandles(out, prevX, nextX, 'out');
  }
  return out;
}

/** Keep handles colinear on opposite sides of the anchor (Lightroom-style smooth point). */
function mirrorLinkedHandles(
  p: CurvePoint,
  prevX: number,
  nextX: number,
  driver: 'in' | 'out',
): CurvePoint {
  const out: CurvePoint = { ...p };
  const px = p.x;
  const py = p.y;

  if (driver === 'out' && out.handleOutX !== undefined && out.handleOutY !== undefined) {
    const vx = out.handleOutX - px;
    const vy = out.handleOutY - py;
    if (px > prevX + 0.0001) {
      out.handleInX = clamp(px - vx, prevX, px);
      out.handleInY = clamp(py - vy, 0, 1);
    }
    return out;
  }

  if (driver === 'in' && out.handleInX !== undefined && out.handleInY !== undefined) {
    const vx = out.handleInX - px;
    const vy = out.handleInY - py;
    if (px < nextX - 0.0001) {
      out.handleOutX = clamp(px - vx, px, nextX);
      out.handleOutY = clamp(py - vy, 0, 1);
    }
  }

  return out;
}

/** Catmull-Rom-style tangents → monotonic cubic handles (no wavy overshoot). */
function withSmoothHandles(anchors: CurvePoint[]): CurvePoint[] {
  const n = anchors.length;
  if (n < 2) return anchors.map((p) => ({ ...p }));

  return anchors.map((p, i) => {
    const out: CurvePoint = { x: p.x, y: p.y };
    const prev = anchors[i - 1];
    const next = anchors[i + 1];

    if (next) {
      const tension = i === 0 ? 1 / 3 : 1 / 6;
      const dx = i === 0 ? next.x - p.x : next.x - prev.x;
      const dy = i === 0 ? next.y - p.y : next.y - prev.y;
      out.handleOutX = clamp(p.x + dx * tension, Math.min(p.x, next.x), Math.max(p.x, next.x));
      out.handleOutY = clamp(p.y + dy * tension, 0, 1);
    }

    if (prev) {
      const tension = i === n - 1 ? 1 / 3 : 1 / 6;
      const dx = i === n - 1 ? p.x - prev.x : next.x - prev.x;
      const dy = i === n - 1 ? p.y - prev.y : next.y - prev.y;
      out.handleInX = clamp(p.x - dx * tension, Math.min(p.x, prev.x), Math.max(p.x, prev.x));
      out.handleInY = clamp(p.y - dy * tension, 0, 1);
    }

    return out;
  });
}
