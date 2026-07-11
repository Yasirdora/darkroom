/**
 * WebGL2 high-performance image processor skeleton.
 * Optimized for web: fragment shaders, 3D LUT textures for curves/film/LUTs, fast blurs via separable or multi-tap.
 * CPU fallback always available. Designed to accelerate effects, qualifiers, curves, and film sampling.
 *
 * Phase A: basic context + passthrough + texture upload/read. Later phases wire real shaders.
 */

import type { CurvePoint } from '../core/types';
import { interpolateCurve } from './curves';

export interface GLProcessorOptions {
  width: number;
  height: number;
}

const VERT_SRC = `
  attribute vec2 a_pos;
  varying vec2 v_uv;
  void main() {
    v_uv = a_pos * 0.5 + 0.5;
    gl_Position = vec4(a_pos, 0.0, 1.0);
  }
`;

const FRAG_PASSTHROUGH = `
  precision highp float;
  uniform sampler2D u_tex;
  varying vec2 v_uv;
  void main() {
    gl_FragColor = texture2D(u_tex, v_uv);
  }
`;

const FRAG_GRADING = `
  precision highp float;
  uniform sampler2D u_tex;
  uniform sampler2D u_curveLut;  // optional 1D master curve LUT (size x 1)

  // Grading uniforms
  uniform float u_exposure;      // stops, e.g. 0.5
  uniform float u_contrast;      // 0-2 range, 1 = neutral
  uniform float u_brightness;    // -1 to 1
  uniform float u_saturation;    // 0-2
  uniform float u_vibrance;      // -1 to 1, boosts desaturated colors more
  uniform float u_hue;           // radians
  uniform float u_temperature;   // -1 to 1 (blue-yellow)
  uniform float u_tint;          // -1 to 1 (green-magenta)
  uniform float u_vignette;      // 0-1
  uniform float u_gamma;         // 0.2 - 2.2
  uniform float u_useCurve;      // 0 or 1
  uniform float u_highlights;    // -1 to 1
  uniform float u_shadows;       // -1 to 1
  uniform float u_whites;        // -1 to 1
  uniform float u_blacks;        // -1 to 1

  varying vec2 v_uv;

  vec3 rgb2hsv(vec3 c) {
    vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
    vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
    vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
    float d = q.x - min(q.w, q.y);
    float e = 1.0e-10;
    return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
  }

  vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  }

  void main() {
    vec4 color = texture2D(u_tex, v_uv);
    vec3 rgb = color.rgb;

    // Exposure
    float expFactor = pow(2.0, u_exposure);
    rgb *= expFactor;

    // White balance — multiplicative gains, matching the CPU model in
    // adjustments.ts (temp: r×1.35^t / b×1.35^−t; tint: g×1.25^v, r,b×1.25^−v/2)
    rgb.r *= pow(1.35, u_temperature) * pow(1.25, -u_tint * 0.5);
    rgb.g *= pow(1.25, u_tint);
    rgb.b *= pow(1.35, -u_temperature) * pow(1.25, -u_tint * 0.5);

    // Brightness + Contrast 
    float mid = 0.5;
    rgb = (rgb - mid) * u_contrast + mid + u_brightness;

    // Highlights / Shadows / Whites / Blacks - pro tonal controls (soft region compression/lift)
    float l = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
    if (u_highlights != 0.0 && l > 0.5) {
      float t = (l - 0.5) / 0.5;
      float k = 1.0 - u_highlights * t * 0.6;
      rgb *= max(0.0, k);
    }
    if (u_shadows != 0.0 && l < 0.5) {
      float t = (0.5 - l) / 0.5;
      float k = 1.0 + u_shadows * t * 0.6;
      rgb = mix(rgb, rgb * k, 0.8); // soft
    }
    if (u_whites != 0.0 && l > 0.75) {
      float t = (l - 0.75) / 0.25;
      float amt = u_whites * t * 0.3;
      rgb = mix(rgb, rgb + amt, 0.5);
    }
    if (u_blacks != 0.0 && l < 0.25) {
      float t = (0.25 - l) / 0.25;
      float amt = u_blacks * t * 0.25;
      rgb = mix(rgb, rgb + amt, 0.7);
    }

    // Note: no extra artistic S-curve here. Neutral load must be faithful to source.
    // Real tonal control comes from the Curves panel + adjustments sliders + input profile.
    rgb = pow(clamp(rgb, 0.0, 1.0), vec3(1.0 / max(u_gamma, 0.1)));

    // Hue / Saturation + Vibrance in HSV
    vec3 hsv = rgb2hsv(rgb);
    hsv.x = mod(hsv.x + u_hue / 6.28318, 1.0); // hue in radians -> 0-1

    float origS = hsv.y;
    hsv.y = clamp(hsv.y * u_saturation, 0.0, 1.0);

    // Vibrance: boost less saturated colors more (pro tool)
    // Matches CPU: vBoost based on original saturation before global sat
    float vib = u_vibrance;
    if (vib != 0.0) {
      float vBoost = vib * 0.7 * pow(1.0 - origS, 1.5); // adjusted for -50..+50 range (matches CPU)
      // Reduce on very dark to avoid coloring black faces/shadows (matches CPU)
      float lum = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
      float lumFactor = min(1.0, max(0.0, (lum - 0.03) / 0.35));
      vBoost *= lumFactor;
      hsv.y = clamp(hsv.y + vBoost, 0.0, 1.0);

      // approx skin protection (relaxed for dark skin, use orig)
      float h = hsv.x * 360.0;
      if (vib > 0.0 && origS > 0.05 && origS < 0.78 && hsv.z > 0.03 && hsv.z < 0.88 &&
          ((h >= 0.0 && h <= 55.0) || h >= 330.0)) {
        float protect = 0.45; // match CPU blend ~0.55
        hsv.y -= vBoost * protect;
        hsv.y = clamp(hsv.y, 0.0, 1.0);
      }
    }
    rgb = hsv2rgb(hsv);

    // Master curve LUT - preserve color by applying luminance delta (matches CPU curves.ts)
    if (u_useCurve > 0.5) {
      float lum = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
      float curveVal = texture2D(u_curveLut, vec2(lum, 0.5)).r;
      float delta = curveVal - lum;
      rgb.r += delta * 0.9;
      rgb.g += delta * 1.05;
      rgb.b += delta * 0.85;
      rgb = clamp(rgb, 0.0, 1.0);
    }

    // Simple vignette
    if (u_vignette > 0.0) {
      vec2 uv = v_uv - 0.5;
      float dist = length(uv);
      float vig = 1.0 - u_vignette * smoothstep(0.3, 0.8, dist);
      rgb *= vig;
    }

    gl_FragColor = vec4(clamp(rgb, 0.0, 1.0), color.a);
  }
`;

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('GL shader compile failed: ' + log);
  }
  return sh;
}

function linkProgram(gl: WebGL2RenderingContext, vs: WebGLShader, fs: WebGLShader): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error('GL program link failed: ' + log);
  }
  return p;
}

export class WebGLProcessor {
  private gl: WebGL2RenderingContext | null = null;
  private canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  private gradingProgram: WebGLProgram | null = null;
  private passthroughProgram: WebGLProgram | null = null;
  private quadBuffer: WebGLBuffer | null = null;
  private texture: WebGLTexture | null = null;
  private currentW = 0;
  private currentH = 0;
  private lutTexture: WebGLTexture | null = null; // for future 3D/1D LUTs

  constructor() {
    this.init();
  }

  private init() {
    try {
      // Prefer OffscreenCanvas if available for worker future-proofing
      if (typeof OffscreenCanvas !== 'undefined') {
        this.canvas = new OffscreenCanvas(4, 4);
      } else {
        this.canvas = document.createElement('canvas');
      }
      const gl = (this.canvas as any).getContext('webgl2', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: false,
        powerPreference: 'high-performance',
      }) as WebGL2RenderingContext | null;

      if (!gl) throw new Error('WebGL2 unavailable');
      this.gl = gl;

      const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
      const fsPassthrough = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_PASSTHROUGH);
      this.passthroughProgram = linkProgram(gl, vs, fsPassthrough);

      const fsGrading = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_GRADING);
      this.gradingProgram = linkProgram(gl, vs, fsGrading);

      // Fullscreen quad
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      this.quadBuffer = buf;

      this.texture = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    } catch (e) {
      console.warn('[WebGLProcessor] Falling back to CPU (WebGL init failed):', e);
      this.gl = null;
    }
  }

  isAvailable(): boolean {
    return !!this.gl;
  }

  /** Upload ImageData (or buffer data) as texture. Resizes internal if needed. */
  upload(data: Uint8ClampedArray | ImageData, w: number, h: number): boolean {
    const gl = this.gl;
    if (!gl || !this.texture) return false;

    if (this.currentW !== w || this.currentH !== h) {
      if (this.canvas) {
        (this.canvas as HTMLCanvasElement | OffscreenCanvas).width = w;
        (this.canvas as HTMLCanvasElement | OffscreenCanvas).height = h;
      }
      this.currentW = w;
      this.currentH = h;
    }

    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    const pixels = data instanceof Uint8ClampedArray ? data : (data as ImageData).data;
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return true;
  }

  /** Apply grading adjustments using GPU. Returns processed pixels or null on failure. */
  applyGrading(
    data: Uint8ClampedArray | ImageData,
    w: number,
    h: number,
    params: {
      exposure?: number;
      contrast?: number;
      brightness?: number;
      saturation?: number;
      vibrance?: number;
      hue?: number;
      temperature?: number;
      tint?: number;
      vignette?: number;
      gamma?: number;
      highlights?: number;
      shadows?: number;
      whites?: number;
      blacks?: number;
    }
  ): Uint8ClampedArray | null {
    const gl = this.gl;
    const prog = this.gradingProgram;
    if (!gl || !prog) return null;

    this.upload(data, w, h);

    gl.viewport(0, 0, w, h);
    gl.useProgram(prog);

    // Set quad
    const posLoc = gl.getAttribLocation(prog, 'a_pos');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    // Bind texture
    const texLoc = gl.getUniformLocation(prog, 'u_tex');
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(texLoc, 0);

    // Set uniforms (with sensible defaults)
    const set = (name: string, val: number | undefined, def: number) => {
      const loc = gl.getUniformLocation(prog, name);
      if (loc) gl.uniform1f(loc, val ?? def);
    };

    set('u_exposure', params.exposure, 0.0);
    set('u_contrast', params.contrast, 1.0);
    set('u_brightness', params.brightness, 0.0);
    set('u_saturation', params.saturation, 1.0);
    set('u_vibrance', params.vibrance, 0.0);
    set('u_hue', params.hue, 0.0);
    set('u_temperature', params.temperature, 0.0);
    set('u_tint', params.tint, 0.0);
    set('u_vignette', params.vignette, 0.0);
    set('u_gamma', params.gamma, 1.0);
    set('u_highlights', params.highlights, 0.0);
    set('u_shadows', params.shadows, 0.0);
    set('u_whites', params.whites, 0.0);
    set('u_blacks', params.blacks, 0.0);

    const curveLoc = gl.getUniformLocation(prog, 'u_useCurve');
    if (curveLoc) gl.uniform1f(curveLoc, this.lutTexture ? 1.0 : 0.0);

    if (this.lutTexture) {
      const curveTexLoc = gl.getUniformLocation(prog, 'u_curveLut');
      if (curveTexLoc) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.lutTexture);
        gl.uniform1i(curveTexLoc, 1);
      }
    }

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    const pixels = new Uint8ClampedArray(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return pixels;
  }

  /** Build and upload a 1D master curve LUT texture (0-255 grayscale).
   *  Uses full interpolate (incl. Bézier handles) for live master curve preview to match CPU path.
   */
  uploadCurveLUT(points: CurvePoint[], size = 256): boolean {
    const gl = this.gl;
    if (!gl) return false;

    const lutData = new Uint8Array(size * 4);

    for (let i = 0; i < size; i++) {
      const t = i / (size - 1);
      const y = interpolateCurve(t, points);
      const v = Math.floor(Math.max(0, Math.min(1, y)) * 255);
      const idx = i * 4;
      lutData[idx] = v;
      lutData[idx + 1] = v;
      lutData[idx + 2] = v;
      lutData[idx + 3] = 255;
    }

    if (!this.lutTexture) this.lutTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.lutTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lutData);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    return true;
  }

  /** Apply grading + optional curve LUT in one GPU pass */
  applyGradingWithCurve(
    data: Uint8ClampedArray | ImageData,
    w: number,
    h: number,
    gradingParams: any,
    curvePoints?: CurvePoint[]
  ): Uint8ClampedArray | null {
    if (curvePoints && curvePoints.length >= 2) {
      this.uploadCurveLUT(curvePoints);
    } else {
      const gl = this.gl;
      if (gl && this.lutTexture) {
        gl.deleteTexture(this.lutTexture);
      }
      this.lutTexture = null;
    }
    return this.applyGrading(data, w, h, gradingParams);
  }

  destroy() {
    const gl = this.gl;
    if (gl) {
      if (this.texture) gl.deleteTexture(this.texture);
      if (this.lutTexture) gl.deleteTexture(this.lutTexture);
      if (this.quadBuffer) gl.deleteBuffer(this.quadBuffer);
      if (this.passthroughProgram) gl.deleteProgram(this.passthroughProgram);
      if (this.gradingProgram) gl.deleteProgram(this.gradingProgram);
    }
    this.gl = null;
    this.canvas = null;
  }
}

// Singleton for the app
let instance: WebGLProcessor | null = null;
export const getWebGLProcessor = (): WebGLProcessor => {
  if (!instance) instance = new WebGLProcessor();
  return instance;
};
