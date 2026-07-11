import { ImageBuffer } from '../core/image-buffer';
import { renderPipeline, renderExportPipeline } from './pipeline';
import type { EditState } from '../core/types';

// Web worker for off-main-thread CPU pipeline (for high-quality preview and export prep)
// Note: WebGL acceleration is done on main for preview speed.

self.onmessage = (e: MessageEvent) => {
  const { id, sourceData, width, height, state, isFullRes } = e.data;

  try {
    const source = new ImageBuffer(width, height, new Uint8ClampedArray(sourceData));

    let result;
    if (isFullRes) {
      // Full res for export: use export pipeline (bakes transforms)
      result = renderExportPipeline(source, state as EditState);
    } else {
      result = renderPipeline(source, state as EditState);
    }

    // Transfer the data back (zero-copy)
    const transfer = [result.data.buffer];
    (self as any).postMessage({
      id,
      width: result.width,
      height: result.height,
      data: result.data,
    }, transfer);
  } catch (err) {
    (self as any).postMessage({ id, error: (err as Error).message });
  }
};