import type { VectorscopeData } from '../core/types';
import {
  SKIN_TONE_LINE,
  VECTORSCOPE_CHROMA_RANGE,
} from '../processing/vectorscope';

const COLORS = {
  bg: '#141416',
  grid: 'rgba(255,255,255,0.12)',
  gridStrong: 'rgba(255,255,255,0.22)',
  trace: 'rgba(120, 220, 140, 0.72)',
  traceHot: 'rgba(255, 240, 120, 0.95)',
  skinLine: 'rgba(255, 168, 72, 0.88)',
  skinLabel: 'rgba(255, 168, 72, 0.7)',
  neutral: 'rgba(255,255,255,0.55)',
} as const;

export class VectorscopeView {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private displayPeak = 0;

  constructor(canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d', { alpha: true });
    if (!context) {
      throw new Error('Unable to acquire vectorscope canvas context.');
    }
    this.canvas = canvas;
    this.context = context;
  }

  reset(): void {
    this.displayPeak = 0;
  }

  draw(data: VectorscopeData | null): void {
    const { width, height } = this.canvas;
    const ctx = this.context;
    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.min(width, height) * 0.46;

    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, width, height);

    this.drawGrid(cx, cy, radius);

    if (!data || data.peak === 0) {
      this.drawSkinToneLine(cx, cy, radius);
      this.drawNeutralMark(cx, cy);
      this.displayPeak = 0;
      return;
    }

    let targetPeak = data.peak;
    if (
      this.displayPeak > 0 &&
      targetPeak > 0 &&
      (targetPeak > this.displayPeak * 3 || this.displayPeak > targetPeak * 3)
    ) {
      this.displayPeak = targetPeak;
    }

    if (this.displayPeak === 0) {
      this.displayPeak = targetPeak;
    } else {
      this.displayPeak = this.displayPeak * 0.88 + targetPeak * 0.12;
    }

    const scalePeak = Math.max(targetPeak, this.displayPeak);
    this.drawTrace(data, cx, cy, radius, scalePeak);
    this.drawSkinToneLine(cx, cy, radius);
    this.drawNeutralMark(cx, cy);
  }

  private chromaToCanvas(
    cb: number,
    cr: number,
    cx: number,
    cy: number,
    radius: number,
  ): { x: number; y: number } {
    const range = VECTORSCOPE_CHROMA_RANGE;
    return {
      x: cx + (cb / range) * radius,
      y: cy - (cr / range) * radius,
    };
  }

  private drawGrid(cx: number, cy: number, radius: number): void {
    const ctx = this.context;

    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(cx - radius, cy);
    ctx.lineTo(cx + radius, cy);
    ctx.moveTo(cx, cy - radius);
    ctx.lineTo(cx, cy + radius);
    ctx.stroke();

    ctx.strokeStyle = COLORS.gridStrong;
    ctx.beginPath();
    ctx.moveTo(cx - radius * 0.5, cy - radius * 0.866);
    ctx.lineTo(cx + radius * 0.5, cy + radius * 0.866);
    ctx.moveTo(cx + radius * 0.5, cy - radius * 0.866);
    ctx.lineTo(cx - radius * 0.5, cy + radius * 0.866);
    ctx.stroke();

    const labels: Array<{ text: string; cb: number; cr: number }> = [
      { text: 'R', cb: 0, cr: VECTORSCOPE_CHROMA_RANGE * 0.92 },
      { text: 'G', cb: -VECTORSCOPE_CHROMA_RANGE * 0.8, cr: -VECTORSCOPE_CHROMA_RANGE * 0.45 },
      { text: 'B', cb: VECTORSCOPE_CHROMA_RANGE * 0.92, cr: -VECTORSCOPE_CHROMA_RANGE * 0.92 },
      { text: 'Y', cb: -VECTORSCOPE_CHROMA_RANGE * 0.92, cr: VECTORSCOPE_CHROMA_RANGE * 0.92 },
    ];

    ctx.font = '600 9px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,255,255,0.28)';

    for (const label of labels) {
      const { x, y } = this.chromaToCanvas(label.cb, label.cr, cx, cy, radius * 0.94);
      ctx.fillText(label.text, x, y);
    }
  }

  private drawSkinToneLine(cx: number, cy: number, radius: number): void {
    const ctx = this.context;
    const start = this.chromaToCanvas(
      SKIN_TONE_LINE.dark.cb,
      SKIN_TONE_LINE.dark.cr,
      cx,
      cy,
      radius,
    );
    const end = this.chromaToCanvas(
      SKIN_TONE_LINE.light.cb,
      SKIN_TONE_LINE.light.cr,
      cx,
      cy,
      radius,
    );

    ctx.save();
    ctx.strokeStyle = COLORS.skinLine;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = '600 8px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = COLORS.skinLabel;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText('Skin', end.x + 4, end.y - 2);
    ctx.restore();
  }

  private drawNeutralMark(cx: number, cy: number): void {
    const ctx = this.context;
    ctx.fillStyle = COLORS.neutral;
    ctx.beginPath();
    ctx.arc(cx, cy, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawTrace(
    data: VectorscopeData,
    cx: number,
    cy: number,
    radius: number,
    scalePeak: number,
  ): void {
    const ctx = this.context;
    const { bins, size } = data;
    const range = VECTORSCOPE_CHROMA_RANGE;
    const half = size - 1;

    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const count = bins[y * size + x];
        if (count === 0) continue;

        const cb = ((x / half) * 2 - 1) * range;
        const cr = -((y / half) * 2 - 1) * range;
        const px = cx + (cb / range) * radius;
        const py = cy - (cr / range) * radius;

        const t = Math.min(1, count / scalePeak);
        const alpha = 0.08 + t * 0.82;
        ctx.fillStyle =
          t > 0.65
            ? `rgba(255, 236, 120, ${alpha})`
            : `rgba(110, 220, 140, ${alpha})`;
        const dot = 1 + Math.floor(t * 2);
        ctx.fillRect(px - dot / 2, py - dot / 2, dot, dot);
      }
    }
  }
}