import { History } from '../core/history';
import { ImageBuffer } from '../core/image-buffer';
import type {
  Adjustments,
  CropRect,
  EditState,
  EffectId,
  EffectOptions,
  ExportSettings,
  FilterId,
  HistogramData,
  ImportedLutState,
  InputProfileId,
  Transform,
  VectorscopeData,
} from '../core/types';
import { computeAutoEnhance, computeAutoWhiteBalance } from '../processing/auto-enhance';
import { computeColorMatchStats } from '../processing/color-match';
import { computeHistogram } from '../processing/histogram';
import { computeVectorscope } from '../processing/vectorscope';
import { applyInputProfile, coerceInputProfile, decodeToLinearValue, getRecommendedInputExposure, getSceneLinearLuminance } from '../processing/input-profile';
import {
  detectInputProfileFromHeader,
  extractExifOrientation,
  extractJpegDimensions,
} from '../processing/input-profile-detect';

import { renderExportPipeline, renderPipeline } from '../processing/pipeline';
import {
  isFullHueSelection,
  QUALIFIER_ENABLE_HUE_DEFAULTS,
} from '../processing/qualifiers';
import { getWebGLProcessor } from '../processing/webgl-processor';

// Worker for heavy CPU pipeline (avoids blocking main thread)
let pipelineWorker: Worker | null = null;
let workerId = 0;
const pendingWorkerJobs = new Map<number, (result: ImageBuffer | null, error?: string) => void>();

const WORKER_CANCELLED = '__cancelled__';

function getPipelineWorker(): Worker {
  if (!pipelineWorker) {
    pipelineWorker = new Worker(new URL('../processing/pipeline.worker.ts', import.meta.url), { type: 'module' });
    pipelineWorker.onmessage = (e) => {
      const { id, width, height, data, error } = e.data;
      const resolver = pendingWorkerJobs.get(id);
      if (resolver) {
        pendingWorkerJobs.delete(id);
        if (error) {
          resolver(null, error);
        } else {
          const buf = new ImageBuffer(width, height, new Uint8ClampedArray(data));
          resolver(buf);
        }
      }
    };
    pipelineWorker.onerror = () => {
      // Settle all outstanding jobs so callers can fall back to the CPU path.
      const jobs = [...pendingWorkerJobs.values()];
      pendingWorkerJobs.clear();
      jobs.forEach((job) => job(null, 'Worker failed'));
    };
  }
  return pipelineWorker;
}

/** Cancels all in-flight worker jobs, settling their promises. */
function cancelWorkerJobs(): void {
  const jobs = [...pendingWorkerJobs.values()];
  pendingWorkerJobs.clear();
  jobs.forEach((job) => job(null, WORKER_CANCELLED));
}
import {
  ASPECT_RATIOS,
  DEFAULT_ADJUSTMENTS,
  DEFAULT_ADVANCED_EFFECT,
  DEFAULT_COLOR_MATCH,
  DEFAULT_CURVES,
  DEFAULT_EDIT_STATE,
  DEFAULT_INPUT_EXPOSURE,
  DEFAULT_INPUT_LINEAR_MODE,
  DEFAULT_QUALIFIER,
  LIVE_PREVIEW_MAX_DIMENSION,
  PREVIEW_MAX_DIMENSION,
} from './constants';
import {
  applyTransform,
  bakeTransform,
  constrainCropToAspect,
  cropsNearlyEqual,
  fullCropRect,
  largestCropForAspect,
} from '../processing/transform';

export type PhotoEditorListener = (state: EditorSnapshot) => void;

export interface EditorSnapshot {
  hasImage: boolean;
  state: EditState;
  canUndo: boolean;
  canRedo: boolean;
  isRendering: boolean;
  isLiveEditing: boolean;
  isFullResReady: boolean;
  hasPendingCrop: boolean;
  histogram: HistogramData | null;
  vectorscope: VectorscopeData | null;
  autoToneSummary: string | null;
  inputProfileAutoDetected: boolean;
}

/**
 * History entries hold a *reference* to the source ImageBuffer rather than a
 * pixel copy. ImageBuffer is treated as immutable throughout the pipeline
 * (every operation clones), so sharing references is safe and keeps history
 * memory bounded — copying full-resolution pixels on every edit could consume
 * gigabytes (~160 MB per entry for a 40 MP image).
 */
interface EditorHistoryEntry {
  state: EditState;
  source: ImageBuffer | null;
}

export class PhotoEditor {
  private source: ImageBuffer | null = null;
  private state: EditState = structuredClone(DEFAULT_EDIT_STATE);
  private readonly history = new History<EditorHistoryEntry>();
  private readonly listeners = new Set<PhotoEditorListener>();
  private renderVersion = 0;
  private fullResVersion = 0;
  private isRendering = false;
  private isFullResReady = false;
  private previewBuffer: ImageBuffer | null = null;
  private fullBuffer: ImageBuffer | null = null;
  private histogram: HistogramData | null = null;
  private vectorscope: VectorscopeData | null = null;
  private autoToneSummary: string | null = null;
  private previewFrame: number | null = null;
  private fullResTimer: ReturnType<typeof setTimeout> | null = null;
  private fullResPromise: Promise<void> | null = null;
  private pendingHistory: EditorHistoryEntry | null = null;
  private pendingHistoryDirty = false;
  private cachedPreviewSource: ImageBuffer | null = null;
  private cachedPreviewSourceKey = '';
  private cachedNormalizedPreview: ImageBuffer | null = null;
  private cachedNormalizedPreviewKey = '';
  private cachedNormalizedFull: ImageBuffer | null = null;
  private cachedNormalizedFullKey = '';
  private inputProfileAutoDetected = false;

  subscribe(listener: PhotoEditorListener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  destroy(): void {
    this.cancelPendingWork();
    if (pipelineWorker) {
      pipelineWorker.terminate();
      pipelineWorker = null;
    }
    this.source = null;
    this.previewBuffer = null;
    this.fullBuffer = null;
    this.listeners.clear();
  }

  getSnapshot(): EditorSnapshot {
    return {
      hasImage: this.source !== null,
      // Read-only reference — history captures structuredClone snapshots for undo.
      state: this.state,
      canUndo: this.history.canUndo,
      canRedo: this.history.canRedo,
      isRendering: this.isRendering,
      isLiveEditing: this._liveEditing,
      isFullResReady: this.isFullResReady,
      hasPendingCrop: this.hasPendingCrop(),
      histogram: this.histogram,
      vectorscope: this.vectorscope,
      autoToneSummary: this.autoToneSummary,
      inputProfileAutoDetected: this.inputProfileAutoDetected,
    };
  }

  /** Pre-warm GPU + worker once at app startup — not on every file open. */
  static prewarm(): void {
    const gl = getWebGLProcessor();
    getPipelineWorker();
    if (gl.isAvailable()) {
      const dummy = new Uint8ClampedArray(64 * 64 * 4);
      gl.applyGrading(dummy, 64, 64, {});
    }
  }

  async loadFile(file: File): Promise<void> {
    this.cancelPendingWork();

    const headerSize = Math.min(file.size, 512 * 1024);
    const [{ buffer, orientationBaked }, headerBuf] = await Promise.all([
      ImageBuffer.decodeFile(file),
      file.slice(0, headerSize).arrayBuffer(),
    ]);

    const header = new Uint8Array(headerBuf);
    const detected = detectInputProfileFromHeader(header, file.name);

    // Read JPEG EXIF orientation metadata — but only apply it as a transform
    // when the decoder did NOT already bake the orientation into the pixels
    // (the createImageBitmap fallback applies EXIF orientation itself).
    let exifOrientation = orientationBaked
      ? { rotation: 0 as const, flipH: false, flipV: false }
      : extractExifOrientation(header);

    // Some browsers bake EXIF orientation into the pixels even when we
    // request `imageOrientation: 'none'` (and without throwing). Detect this
    // per file: if EXIF demands a 90°/270° rotation but the decoded bitmap
    // already has swapped dimensions relative to the encoded JPEG frame, the
    // decoder applied the orientation itself — applying it again would
    // double-rotate the photo.
    if (exifOrientation.rotation === 90 || exifOrientation.rotation === 270) {
      const encoded = extractJpegDimensions(header);
      if (
        encoded &&
        encoded.width !== encoded.height &&
        encoded.width === buffer.height &&
        encoded.height === buffer.width
      ) {
        exifOrientation = { rotation: 0, flipH: false, flipV: false };
      }
    }

    this.source = buffer;
    this.invalidatePreviewCache();
    this.inputProfileAutoDetected = detected !== null;
    this.state = {
      ...structuredClone(DEFAULT_EDIT_STATE),
      inputProfile: detected ?? DEFAULT_EDIT_STATE.inputProfile,
      inputExposure: DEFAULT_INPUT_EXPOSURE,
      transform: {
        ...DEFAULT_EDIT_STATE.transform,
        rotation: exifOrientation.rotation,
        flipH: exifOrientation.flipH,
        flipV: exifOrientation.flipV,
      },
    };
    this.history.clear();

    // Surface the workspace immediately; grade preview asynchronously.
    this.emit();
    this.isRendering = true;
    this.emit();

    void this.renderPreview().finally(() => {
      this.isRendering = false;
      this.emit();
    });
    // No full res scheduled on load – editing works immediately on the fast GL preview.
    // Full res computed only on export.
  }



  reset(): void {
    this.cancelPendingWork();
    this.source = null;
    this.previewBuffer = null;
    this.fullBuffer = null;
    this.histogram = null;
    this.vectorscope = null;
    this.isFullResReady = false;
    this.invalidatePreviewCache();
    this.state = structuredClone(DEFAULT_EDIT_STATE);
    this.inputProfileAutoDetected = false;
    this.history.clear();
    this.emit();
  }

  clearAutoToneSummary(): void {
    this.autoToneSummary = null;
  }

  setAdjustments(partial: Partial<Adjustments>, recordHistory = false): void {
    this.autoToneSummary = null;
    if (recordHistory) this.pushHistory();
    this.state = {
      ...this.state,
      adjustments: { ...this.state.adjustments, ...partial },
    };
    this.scheduleRecompute(recordHistory);
  }

  async autoEnhance(recordHistory = true): Promise<void> {
    if (!this.source) return;
    if (recordHistory) this.pushHistory();

    const { adjustments, summary, suggestedCurve } = computeAutoEnhance(
      this.getNormalizedPreviewSource()
    );

    // Intelligently move some of auto's exposure suggestion into the inputExposure
    // so the control participates (pro workflow: correct input grey first, then tone)
    const profile = this.state.inputProfile;
    const isLog = ['arri-logc3','red-log3g10','s-log3','bmd-film-gen4','bmd-film-gen5','davinci-intermediate','c-log3','v-log'].includes(profile);
    if (isLog && Math.abs(adjustments.exposure) > 0.8) {
      const move = Math.sign(adjustments.exposure) * Math.min(1.8, Math.abs(adjustments.exposure) * 0.65);
      this.state.inputExposure = (this.state.inputExposure || 0) + move;
      adjustments.exposure = adjustments.exposure - move;
      this.invalidateNormalizedCache();
    }

    this.autoToneSummary = summary;
    this.state = { ...this.state, adjustments };
    if (suggestedCurve) {
      this.state.curves = suggestedCurve;
    }
    this.scheduleRecompute(true);
  }






  /**
   * Auto white balance — sets temperature/tint from a neutral-reference /
   * grey-world estimate of the un-adjusted source. Only touches WB sliders.
   */
  autoWhiteBalance(recordHistory = true): void {
    if (!this.source) return;
    if (recordHistory) this.pushHistory();

    const { temperature, tint, summary } = computeAutoWhiteBalance(
      this.getNormalizedPreviewSource(),
    );

    this.autoToneSummary = summary;
    this.state = {
      ...this.state,
      adjustments: { ...this.state.adjustments, temperature, tint },
    };
    this.scheduleRecompute(true);
  }

  setInputProfile(profile: InputProfileId, recordHistory = false): void {
    if (this.state.inputProfile === profile) return;
    if (recordHistory) this.pushHistory();
    this.inputProfileAutoDetected = false;

    // Set to the profile's recommended exposure (pro behavior)
    const recommended = getRecommendedInputExposure(profile);
    this.state = { 
      ...this.state, 
      inputProfile: profile,
      inputExposure: recommended 
    };
    this.invalidateNormalizedCache();
    this.scheduleRecompute(recordHistory);
  }

  setInputExposure(stops: number, recordHistory = false): void {
    if (this.state.inputExposure === stops) return;
    if (recordHistory) this.pushHistory();
    this.state = { ...this.state, inputExposure: stops };
    this.invalidateNormalizedCache();
    this.scheduleRecompute(recordHistory);
  }

  setInputLinearMode(enabled: boolean, recordHistory = false): void {
    if (this.state.inputLinearMode === enabled) return;
    if (recordHistory) this.pushHistory();
    this.state = { ...this.state, inputLinearMode: enabled };
    this.invalidateNormalizedCache();
    this.scheduleRecompute(recordHistory);
  }

  /**
   * Maps normalized display coordinates (what the user clicked on the
   * transformed canvas) back to coordinates on the untransformed source,
   * inverting rotation and flips. The canvas transform chain is R(θ)·S(flip),
   * so the inverse is S(flip)·R(-θ).
   */
  private mapDisplayToSource(nx: number, ny: number): { x: number; y: number } {
    const { rotation, flipH, flipV } = this.state.transform;
    const r = ((rotation % 360) + 360) % 360;

    // Center-relative, aspect-corrected coords (unit square is fine because
    // rotation by multiples of 90° swaps axes cleanly in normalized space).
    let dx = nx - 0.5;
    let dy = ny - 0.5;

    // Inverse rotation (canvas rotate() is clockwise with y-down).
    let ux = dx;
    let uy = dy;
    if (r === 90) {
      ux = dy;
      uy = -dx;
    } else if (r === 180) {
      ux = -dx;
      uy = -dy;
    } else if (r === 270) {
      ux = -dy;
      uy = dx;
    }

    // Inverse flip (scale is its own inverse).
    if (flipH) ux = -ux;
    if (flipV) uy = -uy;

    return { x: ux + 0.5, y: uy + 0.5 };
  }

  /** Pick using normalized click coords (0-1) on the current preview. Maps to raw preview source pixels and sets input exposure so the point becomes 18% grey. */
  pickInputExposureFromNormalized(displayX: number, displayY: number): void {
    const { x: nx, y: ny } = this.mapDisplayToSource(displayX, displayY);
    const preview = this.getPreviewSource();
    const px = Math.max(0, Math.min(preview.width - 1, Math.floor(nx * preview.width)));
    const py = Math.max(0, Math.min(preview.height - 1, Math.floor(ny * preview.height)));
    const i = (py * preview.width + px) * 4;
    const r = preview.data[i];
    const g = preview.data[i + 1];
    const b = preview.data[i + 2];
    const profile = this.state.inputProfile;
    const linearLum = getSceneLinearLuminance(r, g, b, profile);
    if (linearLum < 0.0001) return;
    const target = 0.18;
    const gain = target / linearLum;
    const stops = Math.log2(gain);
    const clamped = Math.max(-3, Math.min(3, stops));

    this.pushHistory();
    this.state = { ...this.state, inputExposure: clamped };
    this.invalidateNormalizedCache();

    const expGain = Math.pow(2, clamped);
    const dr = decodeToLinearValue(r, profile) * expGain;
    const dg = decodeToLinearValue(g, profile) * expGain;
    const db = decodeToLinearValue(b, profile) * expGain;
    const avg = (dr + dg + db) / 3;
    if (avg > 0.01) {
      const warmBias = (dr - db) / avg;
      const greenBias = (dg - (dr + db) / 2) / avg;
      const tempDelta = Math.round(warmBias * -52);
      const tintDelta = Math.round(greenBias * 42);
      if (Math.abs(tempDelta) > 3 || Math.abs(tintDelta) > 2) {
        const curr = this.state.adjustments;
        this.state = {
          ...this.state,
          adjustments: {
            ...curr,
            temperature: curr.temperature + tempDelta,
            tint: curr.tint + tintDelta,
          },
        };
      }
    }

    this.scheduleRecompute(true);
  }

  /** Normalized preview without user adjustments — shown during grey pick. */
  getGreyPickPreview(): ImageBuffer | null {
    if (!this.source) return null;
    // Show it with the current rotation/flip applied so the image doesn't
    // jump orientation when entering pick mode; clicks are inverse-mapped.
    return applyTransform(this.getNormalizedPreviewSource(), this.state.transform);
  }

  setTransform(partial: Partial<Transform>, recordHistory = false): void {
    if (recordHistory) this.pushHistory();

    const next: Transform = { ...this.state.transform, ...partial };
    const frameAspect = this.getCropFrameAspectForRotation(next.rotation);
    const ratio = ASPECT_RATIOS.find((item) => item.id === next.aspectRatio)?.ratio ?? null;
    const rotationChanged =
      partial.rotation !== undefined && partial.rotation !== this.state.transform.rotation;

    let crop = next.crop;
    if (crop && ratio !== null) {
      // Re-fit to the locked aspect for the new orientation — do not re-constrain the old
      // normalized rect, which shrinks the crop on every rotate click.
      crop = rotationChanged
        ? largestCropForAspect(frameAspect, ratio)
        : constrainCropToAspect(crop, ratio, frameAspect);
    }

    this.state = {
      ...this.state,
      transform: { ...next, crop },
    };
    this.scheduleRecompute(recordHistory);
  }

  rotateCW(recordHistory = true): void {
    const rotation = ((this.state.transform.rotation + 90) % 360) as Transform['rotation'];
    this.setTransform({ rotation }, recordHistory);
  }

  rotateCCW(recordHistory = true): void {
    const rotation = ((this.state.transform.rotation + 270) % 360) as Transform['rotation'];
    this.setTransform({ rotation }, recordHistory);
  }

  flipHorizontal(recordHistory = true): void {
    this.setTransform({ flipH: !this.state.transform.flipH }, recordHistory);
  }

  flipVertical(recordHistory = true): void {
    this.setTransform({ flipV: !this.state.transform.flipV }, recordHistory);
  }

  getCropFrameAspect(): number {
    return this.getCropFrameAspectForRotation(this.state.transform.rotation);
  }

  private getCropFrameAspectForRotation(rotation: Transform['rotation']): number {
    if (!this.source) return 1;
    const swap = rotation === 90 || rotation === 270;
    const width = swap ? this.source.height : this.source.width;
    const height = swap ? this.source.width : this.source.height;
    return width / height;
  }

  setAspectRatio(
    aspectRatio: Transform['aspectRatio'],
    recordHistory = false,
    cropOverride?: CropRect,
  ): void {
    const frameAspect = this.getCropFrameAspect();
    const ratio = ASPECT_RATIOS.find((item) => item.id === aspectRatio)?.ratio ?? null;

    let crop: CropRect;
    if (ratio === null) {
      crop = cropOverride ?? this.state.transform.crop ?? fullCropRect();
    } else {
      crop = largestCropForAspect(frameAspect, ratio);
    }

    const current = this.state.transform;
    if (
      current.aspectRatio === aspectRatio &&
      current.crop &&
      cropsNearlyEqual(current.crop, crop)
    ) {
      return;
    }

    if (recordHistory) this.pushHistory();

    this.state = {
      ...this.state,
      transform: { ...current, aspectRatio, crop },
    };
    this.markHistoryDirty();
    this.invalidateExportCache();
    this.emit();
  }

  setCrop(crop: CropRect, recordHistory = false): void {
    const frameAspect = this.getCropFrameAspect();
    const ratio = ASPECT_RATIOS.find((item) => item.id === this.state.transform.aspectRatio)?.ratio ?? null;
    const constrained = constrainCropToAspect(crop, ratio, frameAspect);

    if (recordHistory) this.pushHistory();
    this.state = {
      ...this.state,
      transform: { ...this.state.transform, crop: constrained },
    };
    this.markHistoryDirty();
    this.invalidateExportCache();
    this.emit();
  }

  resetCrop(recordHistory = true): void {
    if (recordHistory) this.pushHistory();
    this.state = {
      ...this.state,
      transform: {
        ...this.state.transform,
        crop: fullCropRect(),
        aspectRatio: 'free',
      },
    };
    this.invalidateExportCache();
    this.emit();
  }

  async applyCrop(recordHistory = true): Promise<void> {
    if (!this.source || !this.state.transform.crop) return;

    const { buffer, transform } = bakeTransform(this.source, this.state.transform);
    if (recordHistory) this.pushHistory();
    this.source = buffer;
    this.invalidatePreviewCache();
    this.state = { ...this.state, transform };
    await this.renderAll({ showBusy: true });
  }

  setFilter(filterId: FilterId, recordHistory = false): void {
    if (recordHistory) this.pushHistory();
    let qualifier = this.state.qualifier;
    if (filterId === 'none' && qualifier.enabled) {
      qualifier = { ...qualifier, enabled: false };
    }
    this.state = {
      ...this.state,
      filterId,
      qualifier,
      importedLut: filterId === 'none' ? this.state.importedLut : null,
    };
    this.scheduleRecompute(recordHistory);
  }

  importCubeLut(lut: ImportedLutState, recordHistory = true): void {
    if (recordHistory) this.pushHistory();
    this.state = {
      ...this.state,
      importedLut: lut,
      filterId: 'none',
      filterIntensity: 100,
      qualifier: { ...this.state.qualifier, enabled: false },
    };
    this.scheduleRecompute(recordHistory);
  }

  clearImportedLut(recordHistory = true): void {
    if (!this.state.importedLut) return;
    if (recordHistory) this.pushHistory();
    this.state = { ...this.state, importedLut: null };
    this.scheduleRecompute(recordHistory);
  }

  setFilterIntensity(intensity: number, recordHistory = false): void {
    if (recordHistory) this.pushHistory();
    this.state = { ...this.state, filterIntensity: intensity };
    this.scheduleRecompute(recordHistory);
  }

  setEffect(effectId: EffectId, recordHistory = false): void {
    if (recordHistory) this.pushHistory();
    this.state = { ...this.state, effectId };
    this.scheduleRecompute(recordHistory);
  }

  setEffectIntensity(intensity: number, recordHistory = false): void {
    if (recordHistory) this.pushHistory();
    this.state = { ...this.state, effectIntensity: intensity };
    this.scheduleRecompute(recordHistory);
  }

  setEffectOptions(options: EffectOptions, recordHistory = false): void {
    if (recordHistory) this.pushHistory();
    this.state = {
      ...this.state,
      effectOptions: { ...this.state.effectOptions, ...options },
    };
    this.scheduleRecompute(recordHistory);
  }

  setCurves(curves: import('../core/types').Curves, recordHistory = false): void {
    if (recordHistory) this.pushHistory();
    this.state = { ...this.state, curves: { ...curves } };
    this.scheduleRecompute(recordHistory);
  }

  /** Applies a shareable grade preset from URL params (no reference match or effects). */
  applyGradeShare(
    payload: import('../grade-share').GradeSharePayload,
    recordHistory = false,
  ): void {
    if (recordHistory) this.pushHistory();

    const next = { ...this.state };

    if (payload.a) {
      next.adjustments = { ...next.adjustments, ...payload.a };
    }
    if (payload.f) {
      next.filterId = payload.f;
    }
    if (typeof payload.fi === 'number') {
      next.filterIntensity = payload.fi;
    }
    if (payload.c) {
      next.curves = { ...payload.c };
    }
    if (payload.ip) {
      next.inputProfile = payload.ip;
    }
    if (typeof payload.ie === 'number') {
      next.inputExposure = payload.ie;
    }
    if (payload.il === 0 || payload.il === 1) {
      next.inputLinearMode = payload.il === 1;
    }

    this.state = next;
    this.invalidateNormalizedCache();
    this.scheduleRecompute(recordHistory);
  }

  setQualifier(qual: import('../core/types').QualifierConfig, recordHistory = false): void {
    if (recordHistory) this.pushHistory();
    this.state = { ...this.state, qualifier: { ...qual } };
    this.markHistoryDirty();
    this.emit();
    cancelWorkerJobs();
    this.scheduleRecompute(recordHistory);
  }

  setQualifierEnabled(enabled: boolean, recordHistory = true): void {
    const current = this.state.qualifier;
    const patch: import('../core/types').QualifierConfig = { ...current, enabled };
    if (enabled && isFullHueSelection(current)) {
      patch.hueMin = QUALIFIER_ENABLE_HUE_DEFAULTS.hueMin;
      patch.hueMax = QUALIFIER_ENABLE_HUE_DEFAULTS.hueMax;
    }
    this.setQualifier(patch, recordHistory);
  }

  resetQualifier(recordHistory = true): void {
    const current = this.state.qualifier;
    this.setQualifier(
      {
        ...current,
        hueMin: QUALIFIER_ENABLE_HUE_DEFAULTS.hueMin,
        hueMax: QUALIFIER_ENABLE_HUE_DEFAULTS.hueMax,
        satMin: DEFAULT_QUALIFIER.satMin,
        satMax: DEFAULT_QUALIFIER.satMax,
        lumMin: DEFAULT_QUALIFIER.lumMin,
        lumMax: DEFAULT_QUALIFIER.lumMax,
        invert: false,
      },
      recordHistory,
    );
  }

  /**
   * Loads a reference image for color matching. Statistics are computed from
   * a downscaled copy — matching converges on global statistics, so full
   * resolution adds nothing.
   */
  async setColorMatchReference(file: File, recordHistory = true): Promise<void> {
    if (!this.source) return;

    const decoded = await ImageBuffer.fromFile(file);
    const sample = decoded.downscale(512);
    const stats = computeColorMatchStats(sample);
    const refThumb = this.makeThumbDataUrl(decoded, 96);

    if (recordHistory) this.pushHistory();
    this.state = {
      ...this.state,
      colorMatch: {
        ...this.state.colorMatch,
        stats,
        refName: file.name,
        refThumb,
      },
    };
    this.scheduleRecompute(true);
  }

  setColorMatchStrength(strength: number, recordHistory = false): void {
    if (this.state.colorMatch.strength === strength) return;
    if (recordHistory) this.pushHistory();
    this.state = {
      ...this.state,
      colorMatch: { ...this.state.colorMatch, strength },
    };
    this.scheduleRecompute(recordHistory);
  }

  clearColorMatch(recordHistory = true): void {
    if (!this.state.colorMatch.stats) return;
    if (recordHistory) this.pushHistory();
    this.state = { ...this.state, colorMatch: { ...DEFAULT_COLOR_MATCH } };
    this.scheduleRecompute(true);
  }

  private makeThumbDataUrl(buffer: ImageBuffer, size: number): string | null {
    try {
      const small = buffer.downscale(size);
      const canvas = document.createElement('canvas');
      canvas.width = small.width;
      canvas.height = small.height;
      const context = canvas.getContext('2d');
      if (!context) return null;
      context.putImageData(small.toImageData(), 0, 0);
      return canvas.toDataURL('image/jpeg', 0.7);
    } catch {
      return null;
    }
  }

  undo(): void {
    const current = this.captureHistoryEntry();
    const previous = this.history.undo(current);
    if (!previous) return;
    this.restoreHistoryEntry(previous);
    this.scheduleRecompute(true);
  }

  redo(): void {
    const current = this.captureHistoryEntry();
    const next = this.history.redo(current);
    if (!next) return;
    this.restoreHistoryEntry(next);
    this.scheduleRecompute(true);
  }

  private updateScopes(buffer: ImageBuffer): void {
    this.histogram = computeHistogram(buffer);
    this.vectorscope = computeVectorscope(buffer);
  }

  /** True when preview must use the full CPU pipeline (filters, qualifier mask, detail tools, etc.). */
  private needsFullFidelityPreview(): boolean {
    const hasPerChannelCurves = !!(this.state.curves?.r?.length || this.state.curves?.g?.length || this.state.curves?.b?.length);
    const hasFiltersOrEffects =
      this.state.filterId !== 'none' || this.state.importedLut !== null || this.state.effectId !== 'none';
    const hasQualifier =
      (this.state.qualifier?.enabled ?? false) &&
      (this.state.filterId !== 'none' || this.state.importedLut !== null);
    const hasColorMatch = !!(this.state.colorMatch?.stats && this.state.colorMatch.strength > 0);
    const adj = this.state.adjustments;
    const hasToneAdjustments = adj.highlights !== 0 || adj.shadows !== 0 || adj.whites !== 0 || adj.blacks !== 0;
    const hasColorAdjustments = adj.saturation !== 0 || adj.vibrance !== 0 || adj.hue !== 0 || adj.temperature !== 0 || adj.tint !== 0;
    const hasDetailAdjustments =
      adj.clarity !== 0 || adj.sharpen !== 0 || adj.grain !== 0 || adj.sepia !== 0 || adj.vignette !== 0;
    return (
      hasPerChannelCurves ||
      hasFiltersOrEffects ||
      hasQualifier ||
      hasColorMatch ||
      hasToneAdjustments ||
      hasColorAdjustments ||
      hasDetailAdjustments
    );
  }

  /** Canvas preview: transform-only on Crop tab, full edit pipeline elsewhere. */
  /** Fast GPU preview path for live scrubbing. Applies core grading on the normalized source. */
  getCanvasPreview(forCropTab: boolean): ImageBuffer | null {
    if (!this.source) return null;
    if (forCropTab) return this.getTransformPreview();

    // Full-fidelity edits are rendered asynchronously into previewBuffer by renderPreview().
    // Re-running the CPU pipeline here blocked the UI on every canvas paint.
    if (this.needsFullFidelityPreview()) {
      return this.previewBuffer;
    }

    const base = this.getNormalizedPreviewSource();
    if (!base) return this.previewBuffer;

    const gl = getWebGLProcessor();
    if (gl.isAvailable()) {
      const adj = this.state.adjustments;
      const curvePts = this.state.curves?.master || [];

      const gpuPixels = gl.applyGradingWithCurve(
        base.toImageData(),
        base.width,
        base.height,
        {
          exposure: adj.exposure / 50,
          // Photoshop-style contrast factor for matching feel
          contrast: (259 * (adj.contrast + 255)) / (255 * (259 - adj.contrast)),
          brightness: adj.brightness * (1.2 / 255.0),
          saturation: (adj.saturation + 100) / 100,
          vibrance: adj.vibrance / 100,
          hue: (adj.hue / 180) * Math.PI * 2,
          temperature: adj.temperature / 100,
          tint: adj.tint / 100,
          vignette: adj.vignette / 100,
          gamma: 1.0,
          highlights: adj.highlights / 100,
          shadows: adj.shadows / 100,
          whites: adj.whites / 100,
          blacks: adj.blacks / 100,
        },
        curvePts.length >= 2 ? curvePts : undefined
      );

      if (gpuPixels) {
        const graded = ImageBuffer.fromImageData(
          new ImageData(new Uint8ClampedArray(gpuPixels), base.width, base.height),
        );
        return this.applyPreviewTransform(graded);
      }
    }

    return this.previewBuffer;
  }

  getPreviewBuffer(): ImageBuffer | null {
    return this.previewBuffer;
  }

  getExportBuffer(settings?: Partial<ExportSettings>): ImageBuffer | null {
    if (!this.fullBuffer) return null;
    const scale = settings?.scale ?? 1;
    if (scale >= 0.999) {
      return this.fullBuffer;
    }
    const targetWidth = Math.max(1, Math.round(this.fullBuffer.width * scale));
    const maxDimension = Math.max(targetWidth, Math.round(this.fullBuffer.height * scale));
    return this.fullBuffer.downscale(maxDimension);
  }

  async ensureFullResolution(): Promise<boolean> {
    if (!this.source) return false;
    if (this.isFullResReady && this.fullResVersion === this.renderVersion) {
      return true;
    }

    if (this.fullResTimer !== null) {
      window.clearTimeout(this.fullResTimer);
      this.fullResTimer = null;
    }

    await this.renderFullResolution();
    if (this.isFullResReady && this.fullResVersion === this.renderVersion) {
      return true;
    }

    // An in-flight render for a stale version may have been reused — run once
    // more against the current state.
    await this.renderFullResolution();
    return this.isFullResReady && this.fullResVersion === this.renderVersion;
  }

  getSourcePreview(): ImageBuffer | null {
    if (!this.source) return null;
    return this.getNormalizedPreviewSource();
  }

  getCompareSourcePreview(): ImageBuffer | null {
    if (!this.source) return null;
    // Compare against the *normalized* source — otherwise log footage flashes
    // as flat/grey log during compare, which reads as a glitch.
    return applyTransform(this.getNormalizedPreviewSource(), this.state.transform);
  }

  getTransformPreview(): ImageBuffer | null {
    if (!this.source) return null;
    return applyTransform(this.getPreviewSource(), this.state.transform);
  }

  getImageDimensions(): { width: number; height: number } | null {
    const preview = this.getTransformPreview();
    if (!preview) return null;

    const crop = this.state.transform.crop;
    if (crop && this.hasPendingCrop()) {
      return {
        width: Math.max(1, Math.round(preview.width * crop.width)),
        height: Math.max(1, Math.round(preview.height * crop.height)),
      };
    }

    return { width: preview.width, height: preview.height };
  }

  getSourceDimensions(): { width: number; height: number } | null {
    if (!this.source) return null;
    return { width: this.source.width, height: this.source.height };
  }

  hasPendingCrop(): boolean {
    const crop = this.state.transform.crop;
    if (!crop) return false;
    return crop.width < 0.999 || crop.height < 0.999 || crop.x > 0.001 || crop.y > 0.001;
  }

  resetAdjustments(recordHistory = true): void {
    if (!this.source) return;
    if (recordHistory) this.pushHistory();
    this.state = { ...this.state, adjustments: { ...DEFAULT_ADJUSTMENTS } };
    this.scheduleRecompute(recordHistory);
  }

  resetAdjustment(key: keyof Adjustments, recordHistory = true): void {
    if (!this.source) return;
    if (recordHistory) this.pushHistory();
    this.state = {
      ...this.state,
      adjustments: { ...this.state.adjustments, [key]: DEFAULT_ADJUSTMENTS[key] },
    };
    this.scheduleRecompute(recordHistory);
  }

  hasNonDefaultAdjustments(): boolean {
    return Object.entries(this.state.adjustments).some(
      ([key, value]) => value !== DEFAULT_ADJUSTMENTS[key as keyof Adjustments],
    );
  }

  /**
   * Marks the beginning of a continuous interaction (slider scrub, curve drag,
   * color drag). Captures the pre-interaction state once; `endInteraction`
   * pushes it to history only if something actually changed. This is what
   * makes a single Undo revert a whole scrub instead of being a no-op.
   */
  beginInteraction(): void {
    if (!this.source || this.pendingHistory) return;
    this.pendingHistory = this.captureHistoryEntry();
    this.pendingHistoryDirty = false;
  }

  endInteraction(): void {
    if (this.pendingHistory && this.pendingHistoryDirty) {
      this.history.push(this.pendingHistory);
      this.emit();
    }
    this.pendingHistory = null;
    this.pendingHistoryDirty = false;
  }

  private markHistoryDirty(): void {
    if (this.pendingHistory) {
      this.pendingHistoryDirty = true;
    }
  }

  private captureHistoryEntry(): EditorHistoryEntry {
    // ImageBuffer is immutable by convention — store a reference, not a copy.
    return {
      state: structuredClone(this.state),
      source: this.source,
    };
  }

  private restoreHistoryEntry(entry: EditorHistoryEntry): void {
    this.state = structuredClone(entry.state);
    this.state.inputProfile = coerceInputProfile(this.state.inputProfile);
    this.state.adjustments = { ...DEFAULT_ADJUSTMENTS, ...this.state.adjustments };
    this.state.curves = { ...DEFAULT_CURVES, ...this.state.curves };
    this.state.qualifier = { ...DEFAULT_QUALIFIER, ...this.state.qualifier };
    this.state.advancedEffect = { ...DEFAULT_ADVANCED_EFFECT, ...this.state.advancedEffect };
    this.state.colorMatch = { ...DEFAULT_COLOR_MATCH, ...this.state.colorMatch };
    if (!this.state.importedLut || !(this.state.importedLut.data instanceof Uint8Array)) {
      this.state.importedLut = null;
    }
    if (typeof this.state.inputExposure !== 'number') {
      this.state.inputExposure = DEFAULT_INPUT_EXPOSURE;
    }
    if (typeof this.state.inputLinearMode !== 'boolean') {
      this.state.inputLinearMode = DEFAULT_INPUT_LINEAR_MODE;
    }
    this.source = entry.source;
    this.invalidatePreviewCache();
    this.inputProfileAutoDetected = false;
    this.autoToneSummary = null;
  }

  private pushHistory(): void {
    // During an interaction the pre-interaction snapshot is pushed by
    // endInteraction — avoid double entries (and post-state entries).
    if (this.pendingHistory) {
      this.pendingHistoryDirty = true;
      return;
    }
    this.history.push(this.captureHistoryEntry());
  }

  private getPreviewSource(): ImageBuffer {
    if (!this.source) {
      throw new Error('No source image loaded.');
    }

    const maxDim = this._liveEditing ? LIVE_PREVIEW_MAX_DIMENSION : PREVIEW_MAX_DIMENSION;
    const key = `${this.source.width}x${this.source.height}:${maxDim}`;
    if (!this.cachedPreviewSource || this.cachedPreviewSourceKey !== key) {
      this.cachedPreviewSource = this.source.downscale(maxDim);
      this.cachedPreviewSourceKey = key;
    }

    return this.cachedPreviewSource;
  }

  private invalidatePreviewCache(): void {
    this.cachedPreviewSource = null;
    this.cachedPreviewSourceKey = '';
    this.invalidateNormalizedCache();
  }

  private invalidateNormalizedCache(): void {
    this.cachedNormalizedPreview = null;
    this.cachedNormalizedPreviewKey = '';
    this.cachedNormalizedFull = null;
    this.cachedNormalizedFullKey = '';
  }

  private getNormalizedPreviewSource(): ImageBuffer {
    const raw = this.getPreviewSource();
    const key = `${this.cachedPreviewSourceKey}:${this.state.inputProfile}:${this.state.inputExposure}:${this.state.inputLinearMode}`;
    if (this.cachedNormalizedPreview && this.cachedNormalizedPreviewKey === key) {
      return this.cachedNormalizedPreview;
    }

    const normalized = applyInputProfile(raw, this.state.inputProfile, { 
      exposureStops: this.state.inputExposure,
      linearMode: this.state.inputLinearMode,
    });
    this.cachedNormalizedPreview = normalized;
    this.cachedNormalizedPreviewKey = key;
    return normalized;
  }

  private getNormalizedFullSource(): ImageBuffer {
    if (!this.source) {
      throw new Error('No source image loaded.');
    }

    const key = `${this.source.width}x${this.source.height}:${this.state.inputProfile}:${this.state.inputExposure}:${this.state.inputLinearMode}`;
    if (this.cachedNormalizedFull && this.cachedNormalizedFullKey === key) {
      return this.cachedNormalizedFull;
    }

    const normalized = applyInputProfile(this.source, this.state.inputProfile, { 
      exposureStops: this.state.inputExposure,
      linearMode: this.state.inputLinearMode,
    });
    this.cachedNormalizedFull = normalized;
    this.cachedNormalizedFullKey = key;
    return normalized;
  }

  private invalidateExportCache(): void {
    this.isFullResReady = false;
    this.renderVersion += 1;
  }

  private applyPreviewTransform(buffer: ImageBuffer): ImageBuffer {
    const { rotation, flipH, flipV } = this.state.transform;
    if (rotation === 0 && !flipH && !flipV) {
      return buffer;
    }
    return applyTransform(buffer, this.state.transform);
  }

  private cancelPendingWork(): void {
    this.cancelPreviewFrame();
    if (this.fullResTimer !== null) {
      window.clearTimeout(this.fullResTimer);
      this.fullResTimer = null;
    }
    // Settle (never orphan) in-flight worker jobs — orphaned jobs previously
    // left the full-res pipeline deadlocked until page reload.
    cancelWorkerJobs();
  }

  private scheduleRecompute(commit = false): void {
    this.markHistoryDirty();
    this.isFullResReady = false;

    if (commit) {
      this.cancelPreviewFrame();
      // Yield one frame so controls (e.g. qualifier checkbox) paint before heavy CPU work.
      this.previewFrame = window.requestAnimationFrame(() => {
        this.previewFrame = null;
        void this.renderPreview();
      });
      return;
    }

    if (this.previewFrame === null) {
      this.previewFrame = window.requestAnimationFrame(() => {
        this.previewFrame = null;
        void this.renderPreview();
      });
    }

    // No automatic full res scheduling for preview
  }

  private cancelPreviewFrame(): void {
    if (this.previewFrame !== null) {
      window.cancelAnimationFrame(this.previewFrame);
      this.previewFrame = null;
    }
  }

  private scheduleFullResolution(delay: number): void {
    if (this.fullResTimer !== null) {
      window.clearTimeout(this.fullResTimer);
    }
    this.fullResTimer = window.setTimeout(() => {
      this.fullResTimer = null;
      void this.renderFullResolution();
    }, delay);
  }

  private async renderAll(options: { showBusy: boolean }): Promise<void> {
    if (!this.source) {
      this.previewBuffer = null;
      this.fullBuffer = null;
      this.histogram = null;
      this.vectorscope = null;
      this.isRendering = false;
      this.isFullResReady = false;
      this.emit();
      return;
    }

    if (options.showBusy) {
      this.isRendering = true;
      this.emit();
    }

    await this.renderPreview();
    // Do NOT await full res here — schedule async so UI doesn't hang on load
    this.scheduleFullResolution(0);

    if (options.showBusy) {
      this.isRendering = false;
      this.emit();
    }
  }

  private async renderPreview(): Promise<void> {
    if (!this.source) {
      this.previewBuffer = null;
      this.histogram = null;
      this.vectorscope = null;
      this.emit();
      return;
    }

    const version = ++this.renderVersion;
    const normalized = this.getNormalizedPreviewSource();

    // Histogram must feel accurate and stable. Always compute it from the higher-quality
    // (non-live) preview size even while scrubbing. Small slider moves on an 800px proxy
    // + aggressive peak renormalization previously made the histogram jump like a toy.
    const prevLive = this._liveEditing;
    this._liveEditing = false;
    const histoNormalized = this.getNormalizedPreviewSource();
    this._liveEditing = prevLive;

    const useFullPreview = this.needsFullFidelityPreview();

    // Prefer GPU for previewBuffer (fast core grading) unless we need full pipeline for other tools
    const gl = getWebGLProcessor();
    if (gl.isAvailable() && !useFullPreview) {
      const adj = this.state.adjustments;
      const curvePts = this.state.curves?.master || [];
      const gpuPixels = gl.applyGradingWithCurve(
        normalized.toImageData(),
        normalized.width,
        normalized.height,
        {
          exposure: adj.exposure / 50,
          // Photoshop-style contrast factor for matching feel
          contrast: (259 * (adj.contrast + 255)) / (255 * (259 - adj.contrast)),
          brightness: adj.brightness * (1.2 / 255.0),
          saturation: (adj.saturation + 100) / 100,
          vibrance: adj.vibrance / 100,
          hue: (adj.hue / 180) * Math.PI * 2,
          temperature: adj.temperature / 100,
          tint: adj.tint / 100,
          vignette: adj.vignette / 100,
          gamma: 1.0,
          highlights: adj.highlights / 100,
          shadows: adj.shadows / 100,
          whites: adj.whites / 100,
          blacks: adj.blacks / 100,
        },
        curvePts.length >= 2 ? curvePts : undefined
      );
      if (gpuPixels && version === this.renderVersion) {
        const graded = ImageBuffer.fromImageData(
          new ImageData(new Uint8ClampedArray(gpuPixels), normalized.width, normalized.height),
        );
        this.previewBuffer = this.applyPreviewTransform(graded);

        // Reuse the graded preview for the histogram when the base is identical
        // (common on initial load) — avoids a redundant GPU pass.
        if (histoNormalized === normalized) {
          this.updateScopes(this.previewBuffer);
        } else {
          const histoGpu = gl.applyGradingWithCurve(
            histoNormalized.toImageData(),
            histoNormalized.width,
            histoNormalized.height,
            {
              exposure: adj.exposure / 50,
              contrast: (259 * (adj.contrast + 255)) / (255 * (259 - adj.contrast)),
              brightness: adj.brightness * (1.2 / 255.0),
              saturation: (adj.saturation + 100) / 100,
              vibrance: adj.vibrance / 100,
              hue: (adj.hue / 180) * Math.PI * 2,
              temperature: adj.temperature / 100,
              tint: adj.tint / 100,
              vignette: adj.vignette / 100,
              gamma: 1.0,
              highlights: adj.highlights / 100,
              shadows: adj.shadows / 100,
              whites: adj.whites / 100,
              blacks: adj.blacks / 100,
            },
            curvePts.length >= 2 ? curvePts : undefined
          );
          if (histoGpu) {
            const hbuf = ImageBuffer.fromImageData(
              new ImageData(new Uint8ClampedArray(histoGpu), histoNormalized.width, histoNormalized.height),
            );
            this.updateScopes(hbuf);
          } else {
            this.updateScopes(this.previewBuffer);
          }
        }
        this.emit();
        return;
      }
    }

    // Full-fidelity path — prefer worker so toggling qualifier doesn't freeze the UI.
    let preview: ImageBuffer | null = null;
    if (useFullPreview) {
      try {
        preview = await this.runWorkerJob(normalized, this.state, false);
      } catch (error) {
        if (error instanceof Error && error.message === WORKER_CANCELLED) {
          if (version !== this.renderVersion) return;
        } else {
          preview = null;
        }
      }
    }
    if (!preview) {
      if (version !== this.renderVersion) return;
      preview = renderPipeline(normalized, this.state);
    }
    if (version !== this.renderVersion) return;

    this.previewBuffer = preview;

    // Histogram on the stable high-quality base (1200) for accuracy even if display is live-low-res
    if (histoNormalized.width !== normalized.width || histoNormalized.height !== normalized.height) {
      let histoPreview: ImageBuffer | null = null;
      if (useFullPreview) {
        try {
          histoPreview = await this.runWorkerJob(histoNormalized, this.state, false);
        } catch {
          histoPreview = null;
        }
      }
      this.updateScopes(histoPreview ?? renderPipeline(histoNormalized, this.state));
    } else {
      this.updateScopes(preview);
    }
    this.emit();
  }

  /** Called by UI to indicate we're in fast interaction mode */
  setLiveEditing(active: boolean) {
    if (this._liveEditing === active) return;
    this._liveEditing = active;
    this.emit();
  }
  private _liveEditing = false;

  /**
   * Renders the full-resolution buffer. The returned promise resolves only
   * after the render (worker or CPU fallback) has actually completed, so
   * `ensureFullResolution` can await a real result instead of racing the
   * worker (which used to make the first export attempt always fail).
   */
  private renderFullResolution(): Promise<void> {
    if (!this.source) {
      this.fullBuffer = null;
      this.isFullResReady = false;
      return Promise.resolve();
    }

    if (this.fullResPromise) return this.fullResPromise;

    const version = this.renderVersion;

    this.fullResPromise = (async () => {
      // Yield so UI updates (e.g. "Preparing export…") can paint first.
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 0);
      });

      if (version !== this.renderVersion || !this.source) return;

      const normalizedFull = this.getNormalizedFullSource();

      let result: ImageBuffer | null = null;
      let cancelled = false;
      try {
        result = await this.runWorkerJob(normalizedFull, this.state);
      } catch (error) {
        if (error instanceof Error && error.message === WORKER_CANCELLED) {
          cancelled = true;
        }
        result = null;
      }

      if (cancelled || version !== this.renderVersion || !this.source) return;

      // CPU fallback on the main thread if the worker failed.
      this.fullBuffer = result ?? renderExportPipeline(normalizedFull, this.state);
      this.fullResVersion = version;
      this.isFullResReady = true;
      this.emit();
    })().finally(() => {
      this.fullResPromise = null;
    });

    return this.fullResPromise;
  }

  private runWorkerJob(
    source: ImageBuffer,
    state: EditState,
    isFullRes = true,
  ): Promise<ImageBuffer> {
    return new Promise<ImageBuffer>((resolve, reject) => {
      const worker = getPipelineWorker();
      const id = ++workerId;

      pendingWorkerJobs.set(id, (result, error) => {
        if (error || !result) {
          reject(new Error(error || 'Worker render failed'));
        } else {
          resolve(result);
        }
      });

      const dataCopy = new Uint8ClampedArray(source.data);
      worker.postMessage({
        id,
        sourceData: dataCopy.buffer,
        width: source.width,
        height: source.height,
        state: structuredClone(state),
        isFullRes,
      }, [dataCopy.buffer]);
    });
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener(this.getSnapshot()));
  }
}