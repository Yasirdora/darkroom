// Where the film model has steps and kinks in it.
//
// Every stage is meant to be a smooth function of exposure. A step shows up on
// a gradient as a visible edge — a band across a sky, a line down a wall — and
// no amount of dithering hides it, because it is in the transform rather than
// the quantisation. This walks each look along the neutral axis and reports the
// largest jump in slope, which is where a kink is if there is one.
import { ALL_STOCK_PROFILES } from '../../src/lib/processing/filters/stock-profiles';
import { renderFilmPixel } from '../../src/lib/processing/filters/film-model';

// Integer inputs, deliberately. `renderFilmPixel` rounds its result into a
// byte, so sampling finer than one code value measures the rounding staircase
// rather than the model — an earlier version of this tool did exactly that and
// reported every look as violently discontinuous. At one code value the
// rounding contributes at most two to a second difference, so anything above
// about three is the transform itself.
const STEP = 1;
const ROUNDING_FLOOR = 2;

interface Kink { look: string; at: number; channel: string; jump: number; slopeBefore: number; slopeAfter: number }

const scan = (profile: any): Kink => {
  const channels = ['red', 'green', 'blue'];
  let worst: Kink = { look: profile.id, at: 0, channel: '', jump: 0, slopeBefore: 0, slopeAfter: 0 };
  let prev = renderFilmPixel(0, 0, 0, profile);
  let prevSlope: number[] = [0, 0, 0];
  let first = true;
  for (let v = STEP; v <= 255; v += STEP) {
    const cur = renderFilmPixel(v, v, v, profile);
    const slope = [0, 1, 2].map((c) => (cur[c] - prev[c]) / STEP);
    if (!first) {
      for (let c = 0; c < 3; c++) {
        const jump = Math.abs(slope[c] - prevSlope[c]);
        if (jump > worst.jump) {
          worst = {
            look: profile.id, at: v, channel: channels[c], jump,
            slopeBefore: prevSlope[c], slopeAfter: slope[c],
          };
        }
      }
    }
    first = false;
    prev = cur;
    prevSlope = slope;
  }
  return worst;
};

const looks = process.argv.slice(2).length
  ? ALL_STOCK_PROFILES.filter((p) => process.argv.slice(2).includes(p.id))
  : ALL_STOCK_PROFILES;

const results = looks.map(scan).sort((a, b) => b.jump - a.jump);

console.log('\nLARGEST SLOPE DISCONTINUITY ON THE NEUTRAL AXIS');
console.log(`  sampled every ${STEP} code value; jump is the change in slope across one step`);
console.log(`  byte rounding alone can produce ${ROUNDING_FLOOR}, so anything above ~3 is the model\n`);
console.log('  look                 input   channel    slope before → after     jump');
for (const k of results.slice(0, 14)) {
  console.log(
    `  ${k.look.padEnd(20)}${k.at.toFixed(1).padStart(6)}   ${k.channel.padEnd(9)}` +
    `${k.slopeBefore.toFixed(2).padStart(8)} → ${k.slopeAfter.toFixed(2).padStart(7)}   ${k.jump.toFixed(2).padStart(8)}`,
  );
}
const worst = results[0];
console.log(`\n  worst across ${results.length} looks: ${worst.jump.toFixed(2)} (${worst.look} at ${worst.at.toFixed(1)})`);
console.log(`  the rounding floor is ${ROUNDING_FLOOR}; a smooth transform should not exceed it by much.`);
