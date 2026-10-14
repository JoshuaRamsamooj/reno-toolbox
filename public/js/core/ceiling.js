// Ceiling profiles. Each room carries a ceiling spec; this module turns it
// into a height field z(x, y) over the room's interior polygon, plus the
// derived quantities needed for elevations and takeoff.
import { dot, lerp, offsetPolygon, polygonArea, polygonPerimeter } from './geometry.js';

export const CEILING_TYPES = {
  flat: 'Flat',
  shed: 'Shed (single slope)',
  gable: 'Cathedral / gable',
  tray: 'Tray',
};

const COMPASS = { N: { x: 0, y: -1 }, S: { x: 0, y: 1 }, E: { x: 1, y: 0 }, W: { x: -1, y: 0 } };

export function defaultCeiling() {
  // null heights inherit from the design default.
  return { type: 'flat', height: null, peak: null, dir: 'N', ridge: 'EW', trayDepth: null, trayInset: null };
}

/** Fills in inherited/default values so downstream code never sees nulls. */
export function resolveCeiling(ceiling, defaultHeight) {
  const c = { ...defaultCeiling(), ...(ceiling ?? {}) };
  const height = c.height ?? defaultHeight;
  return {
    type: CEILING_TYPES[c.type] ? c.type : 'flat',
    height,
    peak: Math.max(c.peak ?? height * 1.5, height),
    dir: COMPASS[c.dir] ? c.dir : 'N',
    ridge: c.ridge === 'NS' ? 'NS' : 'EW',
    trayDepth: c.trayDepth ?? Math.round(height / 16),
    trayInset: c.trayInset ?? Math.round(height / 4),
  };
}

function projectionRange(poly, axis) {
  let min = Infinity;
  let max = -Infinity;
  for (const p of poly) {
    const v = dot(p, axis);
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  return { min, max };
}

/**
 * Builds a ceiling model over an interior polygon.
 * Returns { heightAt(p), wallTop(P, Q), area, maxHeight, slope, tray }.
 */
export function ceilingModel(spec, poly) {
  const c = spec;
  const planArea = Math.abs(polygonArea(poly));
  const base = {
    spec: c,
    heightAt: () => c.height,
    breakParams: () => [],
    area: planArea,
    maxHeight: c.height,
    tray: null,
  };

  if (c.type === 'shed') {
    const axis = COMPASS[c.dir];
    const { min, max } = projectionRange(poly, axis);
    const run = max - min;
    const rise = c.peak - c.height;
    const grad = run > 0 ? rise / run : 0;
    return {
      ...base,
      heightAt: (p) => (run > 0 ? c.height + (rise * (dot(p, axis) - min)) / run : c.height),
      area: planArea * Math.sqrt(1 + grad * grad),
      maxHeight: c.peak,
      pitch: grad,
    };
  }

  if (c.type === 'gable') {
    // Ridge runs E-W → slopes fall toward N and S walls (axis is the y direction).
    const axis = c.ridge === 'EW' ? { x: 0, y: 1 } : { x: 1, y: 0 };
    const { min, max } = projectionRange(poly, axis);
    const mid = (min + max) / 2;
    const half = (max - min) / 2;
    const rise = c.peak - c.height;
    const grad = half > 0 ? rise / half : 0;
    return {
      ...base,
      heightAt: (p) => (half > 0 ? c.height + rise * (1 - Math.abs(dot(p, axis) - mid) / half) : c.height),
      // Parameter along P→Q where the segment crosses the ridge line.
      breakParams: (P, Q) => {
        const a = dot(P, axis) - mid;
        const b = dot(Q, axis) - mid;
        return a * b < 0 ? [a / (a - b)] : [];
      },
      area: planArea * Math.sqrt(1 + grad * grad),
      maxHeight: c.peak,
      pitch: grad,
    };
  }

  if (c.type === 'tray') {
    const inner = offsetPolygon(poly, c.trayInset);
    const innerArea = polygonArea(inner);
    const valid = innerArea > 0;
    const riser = valid ? polygonPerimeter(inner) * c.trayDepth : 0;
    return {
      ...base,
      area: planArea + riser,
      maxHeight: valid ? c.height + c.trayDepth : c.height,
      tray: valid ? { polygon: inner, height: c.height + c.trayDepth } : null,
    };
  }

  return base;
}

/**
 * Top-of-wall profile along an interior wall face P→Q as [{s, z}], where s
 * is the distance from P. Linear between samples.
 */
export function wallTopProfile(model, P, Q) {
  const L = Math.hypot(Q.x - P.x, Q.y - P.y);
  const ts = [0, ...model.breakParams(P, Q), 1].sort((a, b) => a - b);
  return ts.map((t) => ({ s: t * L, z: model.heightAt(lerp(P, Q, t)) }));
}

/** Height of a piecewise-linear profile at distance s. */
export function profileHeightAt(profile, s) {
  if (s <= profile[0].s) return profile[0].z;
  for (let i = 1; i < profile.length; i++) {
    const a = profile[i - 1];
    const b = profile[i];
    if (s <= b.s) return b.s > a.s ? a.z + ((b.z - a.z) * (s - a.s)) / (b.s - a.s) : b.z;
  }
  return profile[profile.length - 1].z;
}

/** Area under the profile (gross wall area), optionally between s0 and s1. */
export function profileArea(profile, s0 = -Infinity, s1 = Infinity) {
  let a = 0;
  for (let i = 1; i < profile.length; i++) {
    const lo = Math.max(s0, profile[i - 1].s);
    const hi = Math.min(s1, profile[i].s);
    if (hi <= lo) continue;
    a += ((profileHeightAt(profile, lo) + profileHeightAt(profile, hi)) / 2) * (hi - lo);
  }
  return a;
}
