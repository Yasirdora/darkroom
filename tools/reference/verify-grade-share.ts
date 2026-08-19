/**
 * Closes the grade-share contract in the direction Swift cannot check alone.
 *
 * The Swift conformance suite proves it can read payloads the web app wrote.
 * This proves the web app can read payloads *Swift* wrote — which is what
 * happens when someone shares a grade from the Mac app and the recipient opens
 * the link in a browser.
 *
 * Run: `npm run verify:grade-share`
 *   (builds the Swift emitter, pipes its output through the real web decoder)
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { decodeGradePayload } from '../../src/lib/grade-share';
import { FILTER_PRESETS } from '../../src/lib/processing/filters/presets';

interface EmittedCase {
  name: string;
  encoded: string;
}

const APPLE_DIR = resolve(import.meta.dirname, '../../apple');

const emitFromSwift = (): EmittedCase[] => {
  const output = execFileSync(
    'swift',
    ['run', '--package-path', APPLE_DIR, 'darkroom-conformance', '--emit-grade-share'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  // `swift run` may prepend build chatter on stderr; stdout is ours alone, but
  // be defensive and start at the first brace either way.
  const json = output.slice(output.indexOf('{'));
  return (JSON.parse(json) as { cases: EmittedCase[] }).cases;
};

const main = () => {
  const cases = emitFromSwift();
  const knownStocks = new Set(FILTER_PRESETS.map((preset) => preset.id));
  const failures: string[] = [];

  for (const { name, encoded } of cases) {
    const payload = decodeGradePayload(encoded);

    if (!payload) {
      failures.push(`${name}: the web decoder rejected Swift's payload`);
      continue;
    }

    // Every field Swift claims to have written must survive the crossing.
    if (payload.ip !== 's-log3') {
      failures.push(`${name}: input profile arrived as ${payload.ip}, expected s-log3`);
    }
    if (payload.ie !== 1.25) {
      failures.push(`${name}: input exposure arrived as ${payload.ie}, expected 1.25`);
    }
    if (payload.il !== 1) {
      failures.push(`${name}: linear flag arrived as ${payload.il}, expected 1`);
    }
    if (payload.a?.exposure !== 25 || payload.a?.temperature !== -40) {
      failures.push(`${name}: adjustments arrived as ${JSON.stringify(payload.a)}`);
    }
    if (!payload.c?.master || payload.c.master.length !== 5) {
      failures.push(`${name}: master curve arrived with ${payload.c?.master?.length ?? 0} points, expected 5`);
    }

    // Bézier handles are the part most likely to be silently dropped by a
    // key-name mismatch, and losing them changes the curve's shape.
    const second = payload.c?.master?.[1];
    if (second?.handleOutX !== 0.38 || second?.handleOutY !== 0.22) {
      failures.push(`${name}: curve handles were lost — got ${JSON.stringify(second)}`);
    }

    if (name !== 'noLook') {
      if (payload.f !== name) {
        failures.push(`${name}: film stock arrived as '${payload.f}'`);
      } else if (!knownStocks.has(payload.f)) {
        failures.push(`${name}: '${payload.f}' is not a stock the web app knows`);
      }
    } else if (payload.f !== undefined) {
      failures.push(`${name}: expected no film stock, got '${payload.f}'`);
    }
  }

  console.log(`Checked ${cases.length} Swift-encoded payloads through the web decoder.`);

  if (failures.length > 0) {
    console.error(`\nFAIL — ${failures.length} problems:`);
    for (const failure of failures) console.error(`  • ${failure}`);
    process.exit(1);
  }

  console.log('PASS — every Swift payload decoded correctly in JavaScript.');
};

main();
