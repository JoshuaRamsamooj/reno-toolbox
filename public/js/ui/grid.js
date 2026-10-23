// Adaptive grid spacing shared by the plan and the wall face editor: the
// snap step is the finest that stays usable at the current zoom, with
// minor and major lines that divide evenly into each other.
import { MM_PER_IN } from '../core/units.js';

const IMPERIAL_STEPS = [0.5, 1, 3, 6, 12, 24, 60, 120, 240, 600, 1200].map((i) => i * MM_PER_IN);
const IMPERIAL_MAJOR = [12, 60, 120, 600, 1200, 6000].map((i) => i * MM_PER_IN);
const METRIC_STEPS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const METRIC_MAJOR = [1000, 5000, 10000, 50000, 100000];
// Trim needs finer steps: down to 1/16" and 1 mm.
const IMPERIAL_FINE = [1 / 16, 1 / 8, 1 / 4].map((i) => i * MM_PER_IN);
const IMPERIAL_FINE_MAJOR = [1, 6].map((i) => i * MM_PER_IN);
const METRIC_FINE = [1, 2];
const METRIC_FINE_MAJOR = [10, 100];

/** Grid steps (mm) for a zoom of `scale` px/mm. opts.fine allows trim-sized steps. */
export function gridSteps(scale, units, { fine = false } = {}) {
  const metric = units === 'metric';
  const steps = [...(fine ? (metric ? METRIC_FINE : IMPERIAL_FINE) : []), ...(metric ? METRIC_STEPS : IMPERIAL_STEPS)];
  const majors = [...(fine ? (metric ? METRIC_FINE_MAJOR : IMPERIAL_FINE_MAJOR) : []), ...(metric ? METRIC_MAJOR : IMPERIAL_MAJOR)];
  const snap = steps.find((v) => v * scale >= 7) ?? steps[steps.length - 1];
  const major = majors.find((v) => v * scale >= 60) ?? majors[majors.length - 1];
  // Fractional-inch steps need a ratio test; the plan keeps its original remainder test.
  const divides = fine ? (v) => Math.abs(major / v - Math.round(major / v)) < 1e-6 : (v) => major % v < 1e-6;
  const minor = steps.find((v) => v * scale >= 14 && divides(v)) ?? major;
  return { snap, minor, major };
}
