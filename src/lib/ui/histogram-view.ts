import type { HistogramData } from '../core/types';

const COLORS = {
  r: '#ff6b6b',
  g: '#5fe89a',
  b: '#5eb0ff',
  luminance: '#ffffff',
  grid: 'rgba(255,255,255,0.14)',
  bg: '#141416',
} as const;

export class HistogramView {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;

  // Smoothed peak for stable vertical scale. Tiny slider moves won't cause the
  // entire graph to "breathe" or jump dramatically in height.
  private displayPeak = 0;

  constructor(canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d', { alpha: true });
    if (!context) {
      throw new Error('Unable to acquire histogram canvas context.');
    }
    this.canvas = canvas;
    this.context = context;
  }

  /** Call when a completely new image is loaded to reset scale memory. */
  reset(): void {
    this.displayPeak = 0;
  }

  draw(data: HistogramData | null): void {
    const { width, height } = this.canvas;
    const ctx = this.context;

    // Background
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, width, height);

    if (!data || data.peak === 0) {
      // Subtle empty state grid
      this.drawGrid(width, height);
      this.displayPeak = 0;
      return;
    }

    this.drawGrid(width, height);

    // Smooth the peak to prevent dramatic vertical rescaling on small slider moves.
    // This is the #1 reason a "slight change" looks like the histogram explodes.
    let targetPeak = data.peak;

    // New image or completely different data (e.g. after load) → reset scale memory
    if (this.displayPeak > 0 && targetPeak > 0 &&
        (targetPeak > this.displayPeak * 3 || this.displayPeak > targetPeak * 3)) {
      this.displayPeak = targetPeak;
    }

    if (this.displayPeak === 0) {
      this.displayPeak = targetPeak;
    } else {
      // Heavier smoothing on the scale (slow to grow/shrink). Feels "solid".
      const smoothing = 0.88;
      this.displayPeak = this.displayPeak * smoothing + targetPeak * (1 - smoothing);
    }
    // Never let the scale be smaller than current (avoid clipping the top), but don't snap hard.
    const scalePeak = Math.max(targetPeak, this.displayPeak);

    const channels: Array<'luminance' | 'r' | 'g' | 'b'> = ['luminance', 'r', 'g', 'b'];

    // Draw filled shapes first (soft), then crisp strokes on top
    channels.forEach((channel) => {
      const rawBins = data[channel];
      const smoothed = this.smoothBins(rawBins);
      const color = COLORS[channel];
      const isLum = channel === 'luminance';

      ctx.beginPath();
      ctx.moveTo(0, height);

      for (let i = 0; i < 256; i++) {
        const x = (i / 255) * width;
        const h = (smoothed[i] / scalePeak) * (height - 1);
        ctx.lineTo(x, height - h);
      }

      ctx.lineTo(width, height);
      ctx.closePath();

      if (isLum) {
        ctx.fillStyle = 'rgba(255,255,255,0.22)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.82)';
        ctx.lineWidth = 1.5;
      } else {
        ctx.fillStyle = color + '55';
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.95;
        ctx.lineWidth = 2;
        ctx.globalAlpha = 1;
      }
      ctx.stroke();
    });

    // Clipping indicators (pro touch) — use original data for accuracy
    this.drawClipping(data, width, height);
  }

  /** Light 1D smoothing so tiny tone shifts don't create spiky "jumps" in the plot. */
  private smoothBins(bins: Uint32Array): Float32Array {
    const n = 256;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const left = bins[i > 0 ? i - 1 : 0];
      const mid = bins[i];
      const right = bins[i < n - 1 ? i + 1 : n - 1];
      // gentle triangle kernel — enough to tame quantization without losing shape
      out[i] = (left + mid * 2 + right) / 4;
    }
    return out;
  }

  private drawGrid(w: number, h: number): void {
    const ctx = this.context;
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;

    // Vertical tonal guides (roughly shadows / mid / highlights + 1/4s)
    const xs = [0.25, 0.5, 0.75];
    xs.forEach((f) => {
      const x = Math.round(f * w) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    });

    // Horizontal levels
    const ys = [0.25, 0.5, 0.75];
    ys.forEach((f) => {
      const y = Math.round(f * h) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    });
  }

  private drawClipping(data: HistogramData, w: number, h: number): void {
    const ctx = this.context;
    const thresh = Math.max(1, Math.floor(data.peak * 0.0008)); // tiny % of peak counts as clip

    const clipLeft = {
      r: data.r[0] > thresh,
      g: data.g[0] > thresh,
      b: data.b[0] > thresh,
    };
    const clipRight = {
      r: data.r[255] > thresh,
      g: data.g[255] > thresh,
      b: data.b[255] > thresh,
    };

    const drawTick = (x: number, ch: 'r' | 'g' | 'b', isLeft: boolean) => {
      ctx.fillStyle = COLORS[ch];
      ctx.beginPath();
      if (isLeft) {
        ctx.moveTo(x, 2);
        ctx.lineTo(x + 6, 2);
        ctx.lineTo(x + 3, 8);
      } else {
        ctx.moveTo(x, 2);
        ctx.lineTo(x - 6, 2);
        ctx.lineTo(x - 3, 8);
      }
      ctx.closePath();
      ctx.fill();

      // tiny underline to make it pop
      ctx.fillStyle = COLORS[ch];
      ctx.fillRect(isLeft ? x : x - 6, h - 3, 6, 1.5);
    };

    // Left edge clips (shadows)
    const leftX = 1;
    if (clipLeft.r) drawTick(leftX, 'r', true);
    if (clipLeft.g) drawTick(leftX + 3, 'g', true);
    if (clipLeft.b) drawTick(leftX + 6, 'b', true);

    // Right edge clips (highlights)
    const rightX = w - 1;
    if (clipRight.r) drawTick(rightX, 'r', false);
    if (clipRight.g) drawTick(rightX - 3, 'g', false);
    if (clipRight.b) drawTick(rightX - 6, 'b', false);
  }
}