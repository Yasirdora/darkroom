// Muted, film-adjacent tones — ambient color grading, not carnival pixels
const PALETTES = {
  warm: ['#d9cfc0', '#cfc3b2', '#c4b8a6', '#b9ad9c'],
  rose: ['#d4c2c6', '#c9b4b9', '#bea8ae', '#b39ca3'],
  violet: ['#c5c0d4', '#b8b2c9', '#aca6be', '#a09ab3'],
  cool: ['#bcc8d8', '#b0bdd0', '#a4b2c8', '#98a7c0'],
} as const;

interface CachedGeo {
  cx: number;
  cy: number;
  maskRx: number;
  maskRy: number;
  activeRadius: number;
  activeRadiusSq: number;
}

interface MouseState {
  x: number | null;
  y: number | null;
  targetX: number | null;
  targetY: number | null;
  active: boolean;
}

class PixelParticle {
  colorSubIndex = Math.floor(Math.random() * 4);
  colorJitter = (Math.random() - 0.5) * 0.12;
  baseX = 0;
  y = 0;
  size = 2;
  speedY = 0.3;
  swayAngle = 0;
  swaySpeed = 0.006;
  swayAmplitude = 12;
  baseAlpha = 0.4;
  shimmerSpeed = 0.008;
  shimmerPhase = 0;
  x = 0;
  yReal = 0;
  alpha = 0;
  private readonly getWidth: () => number;
  private readonly getHeight: () => number;

  constructor(getWidth: () => number, getHeight: () => number, initRandomY = false) {
    this.getWidth = getWidth;
    this.getHeight = getHeight;
    this.reset(initRandomY);
  }

  reset(initRandomY = false): void {
    const w = this.getWidth();
    const h = this.getHeight();
    this.baseX = Math.random() * w;
    this.y = initRandomY ? Math.random() * h : h + 10;
    this.size = 1.2 + Math.random() * 1.4;
    this.speedY = 0.12 + Math.random() * 0.28;
    this.swayAngle = Math.random() * Math.PI * 2;
    this.swaySpeed = 0.002 + Math.random() * 0.005;
    this.swayAmplitude = 4 + Math.random() * 10;
    this.baseAlpha = 0.12 + Math.random() * 0.28;
    this.shimmerSpeed = 0.003 + Math.random() * 0.006;
    this.shimmerPhase = Math.random() * Math.PI;
    this.x = this.baseX;
    this.yReal = this.y;
    this.alpha = 0;
  }

  getDiscreteColor(): string {
    const w = this.getWidth();
    const normalizedX = this.baseX / w;
    const checkX = (normalizedX + this.colorJitter + 1.0) % 1.0;
    if (checkX < 0.25) return PALETTES.warm[this.colorSubIndex];
    if (checkX < 0.50) return PALETTES.rose[this.colorSubIndex];
    if (checkX < 0.75) return PALETTES.violet[this.colorSubIndex];
    return PALETTES.cool[this.colorSubIndex];
  }

  update(mouse: MouseState, geo: CachedGeo): void {
    this.y -= this.speedY;
    this.swayAngle += this.swaySpeed;
    const targetX = this.baseX + Math.sin(this.swayAngle) * this.swayAmplitude;

    if (this.y < -10) {
      this.reset(false);
      return;
    }

    let pushX = 0;
    let pushY = 0;
    let interactiveAlphaMultiplier = 1;

    if (mouse.active && mouse.x !== null && mouse.y !== null) {
      const dx = targetX - mouse.x;
      const dy = this.y - mouse.y;
      const distSq = dx * dx + dy * dy;

      if (distSq < geo.activeRadiusSq) {
        const dist = Math.sqrt(distSq);
        const force = (geo.activeRadius - dist) / geo.activeRadius;
        const pushAngle = Math.atan2(dy, dx);
        pushX = Math.cos(pushAngle) * force * 6;
        pushY = Math.sin(pushAngle) * force * 3;
        interactiveAlphaMultiplier = 1 + force * 0.12;
      }
    }

    this.x = targetX + pushX;
    this.yReal = this.y + pushY;
    this.shimmerPhase += this.shimmerSpeed;
    const shimmer = Math.sin(this.shimmerPhase) * 0.05;

    const maskDx = (this.x - geo.cx) / geo.maskRx;
    const maskDy = (this.yReal - geo.cy) / geo.maskRy;
    const maskDistSq = maskDx * maskDx + maskDy * maskDy;

    let centerFade = 1.0;
    if (maskDistSq < 1.0) {
      centerFade = maskDistSq * maskDistSq;
    }

    let edgeFade = 1.0;
    if (this.yReal < 80) {
      edgeFade = this.yReal * 0.0125;
    }

    this.alpha = (this.baseAlpha + shimmer) * interactiveAlphaMultiplier * centerFade * edgeFade;
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (this.alpha <= 0.01) return;
    ctx.fillStyle = this.getDiscreteColor();
    ctx.globalAlpha = this.alpha;
    ctx.fillRect(
      this.x - this.size * 0.5,
      this.yReal - this.size * 0.5,
      this.size,
      this.size,
    );
  }
}

export class HeroParticles {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly container: HTMLElement;
  private readonly abort = new AbortController();
  private particles: PixelParticle[] = [];
  private animationFrameId: number | null = null;
  private isVisible = true;
  private isRunning = false;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private particleCount = 300;
  private readonly mouse: MouseState = {
    x: null,
    y: null,
    targetX: null,
    targetY: null,
    active: false,
  };
  private readonly geo: CachedGeo = {
    cx: 0,
    cy: 0,
    maskRx: 260,
    maskRy: 140,
    activeRadius: 150,
    activeRadiusSq: 22500,
  };

  constructor(canvas: HTMLCanvasElement, container: HTMLElement) {
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) {
      throw new Error('Unable to acquire hero canvas context.');
    }
    this.canvas = canvas;
    this.ctx = ctx;
    this.container = container;
    this.bindEvents();
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.isVisible = true;
    this.resize();
    this.animate();
  }

  stop(): void {
    this.isRunning = false;
    if (this.animationFrameId !== null) {
      window.cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  destroy(): void {
    this.stop();
    this.abort.abort();
  }

  resize(): void {
    const rect = this.container.getBoundingClientRect();
    this.width = Math.max(1, Math.round(rect.width));
    this.height = Math.max(1, Math.round(rect.height));
    this.dpr = window.devicePixelRatio || 1;
    this.particleCount = this.width < 768 ? 72 : 140;

    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    this.geo.cx = this.width * 0.5;
    this.geo.cy = this.height * 0.5;
    this.geo.maskRx = Math.max(260, this.width * 0.26);
    this.geo.maskRy = 160;
    this.geo.activeRadius = 120;
    this.geo.activeRadiusSq = this.geo.activeRadius * this.geo.activeRadius;

    if (this.particles.length !== this.particleCount) {
      this.particles = Array.from(
        { length: this.particleCount },
        () => new PixelParticle(() => this.width, () => this.height, true),
      );
    }
  }

  private bindEvents(): void {
    const { signal } = this.abort;

    const handleMouseMove = (e: MouseEvent) => {
      const rect = this.container.getBoundingClientRect();
      this.mouse.targetX = e.clientX - rect.left;
      this.mouse.targetY = e.clientY - rect.top;
      this.mouse.active = true;
    };

    const handleMouseLeave = () => {
      this.mouse.active = false;
      this.mouse.targetX = null;
      this.mouse.targetY = null;
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length > 0) {
        const rect = this.container.getBoundingClientRect();
        this.mouse.targetX = e.touches[0].clientX - rect.left;
        this.mouse.targetY = e.touches[0].clientY - rect.top;
        this.mouse.active = true;
      }
    };

    const handleVisibilityChange = () => {
      this.isVisible = document.visibilityState === 'visible';
      if (this.isVisible && this.isRunning) {
        this.mouse.x = null;
        this.mouse.y = null;
        this.animate();
      } else if (this.animationFrameId !== null) {
        window.cancelAnimationFrame(this.animationFrameId);
        this.animationFrameId = null;
      }
    };

    this.container.addEventListener('mousemove', handleMouseMove, { signal });
    this.container.addEventListener('mouseleave', handleMouseLeave, { signal });
    this.container.addEventListener('touchmove', handleTouchMove, { passive: true, signal });
    this.container.addEventListener('touchend', handleMouseLeave, { signal });
    window.addEventListener('resize', () => this.resize(), { signal });
    document.addEventListener('visibilitychange', handleVisibilityChange, { signal });
  }

  private animate = (): void => {
    if (!this.isRunning || !this.isVisible) return;

    this.ctx.clearRect(0, 0, this.width, this.height);

    if (this.mouse.targetX !== null && this.mouse.targetY !== null) {
      if (this.mouse.x === null || this.mouse.y === null) {
        this.mouse.x = this.mouse.targetX;
        this.mouse.y = this.mouse.targetY;
      } else {
        this.mouse.x += (this.mouse.targetX - this.mouse.x) * 0.08;
        this.mouse.y += (this.mouse.targetY - this.mouse.y) * 0.08;
      }
    }

    for (let i = 0; i < this.particles.length; i += 1) {
      this.particles[i].update(this.mouse, this.geo);
      this.particles[i].draw(this.ctx);
    }

    this.ctx.globalAlpha = 1;
    this.animationFrameId = window.requestAnimationFrame(this.animate);
  };
}