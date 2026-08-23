import { applyCurves } from '../../src/lib/processing/curves';
import { luma as filmLuma } from '../../src/lib/processing/filters/film-model';
// Reproduce the failing case by hand, both ways.
const pixels: Array<[number, number, number]> = [[200, 150, 120]];
const data = new Uint8ClampedArray(4);
data[0] = 200; data[1] = 150; data[2] = 120; data[3] = 255;
const master = [
  { x: 0, y: 0 }, { x: 0.25, y: 0.18 }, { x: 0.5, y: 0.5 },
  { x: 0.75, y: 0.82 }, { x: 1, y: 1 },
];
const out = applyCurves(new ImageData(data, 1, 1), { master } as any);
console.log('applyCurves ->', out.data[0], out.data[1], out.data[2]);
console.log('filmLuma(200,150,120) =', filmLuma(200, 150, 120));
