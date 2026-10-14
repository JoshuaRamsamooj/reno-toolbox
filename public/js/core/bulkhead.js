// Bulkheads: dropped boxes in the ceiling that run along a wall (e.g. to hide
// ducts or beams). A bulkhead is stored on its room as
//   { id, wallId, anchor, depth, bottom, start, length }
// where `depth` projects into the room from the interior wall face, `bottom`
// is the underside height above the floor (null = a fixed drop below the
// ceiling), and `start`/`length` position it along the face from its left
// end as seen in elevation (null length = to the end of the wall).
import { add, closestPointOnSegment, cross, lerp, norm, perp, scale, sub } from './geometry.js';
import { profileHeightAt } from './ceiling.js';
import { MM_PER_IN } from './units.js';

const EPS = 1; // mm

export function bulkheadDefaults(units) {
  return units === 'metric' ? { depth: 400, drop: 300 } : { depth: 16 * MM_PER_IN, drop: 12 * MM_PER_IN };
}

/** Finds the room wall face a bulkhead hangs from: by wall id, else nearest to its anchor. */
export function findBulkheadFace(faces, bh) {
  const byId = faces.find((f) => f.wallIds.includes(bh.wallId));
  if (byId || !bh.anchor) return byId ?? null;
  let best = null;
  let bestD = 600;
  for (const f of faces) {
    const d = closestPointOnSegment(bh.anchor, f.P, f.Q).dist;
    if (d < bestD) {
      best = f;
      bestD = d;
    }
  }
  return best;
}

/** Resolves a room's bulkheads against its current wall faces and ceiling. */
export function resolveBulkheads(room, faces, spec, units) {
  const def = bulkheadDefaults(units);
  const out = [];
  for (const bh of room?.bulkheads ?? []) {
    const face = findBulkheadFace(faces, bh);
    if (!face) continue;
    const L = face.length;
    const s0 = Math.min(Math.max(bh.start ?? 0, 0), L);
    const s1 = bh.length == null ? L : Math.min(Math.max(s0 + bh.length, s0), L);
    if (s1 - s0 < EPS) continue;
    const depth = Math.max(EPS, bh.depth ?? def.depth);
    const bottom = bh.bottom ?? spec.height - def.drop;
    const inward = perp(face.dir);
    const a = add(face.P, scale(face.dir, s0));
    const b = add(face.P, scale(face.dir, s1));
    out.push({
      bulkhead: bh,
      face,
      s0,
      s1,
      depth,
      bottom,
      footprint: [a, b, add(b, scale(inward, depth)), add(a, scale(inward, depth))],
      openStart: s0 > EPS,
      openEnd: s1 < L - EPS,
    });
  }
  return out;
}

/**
 * Spans of a wall face covered by bulkheads: the host wall over the
 * bulkhead's extent, and side walls where a bulkhead runs into a corner.
 * Returns [{s0, s1, bottom, resolved}] in face coordinates.
 */
export function faceBands(face, resolved) {
  const bands = [];
  const d = sub(face.Q, face.P);
  for (const r of resolved) {
    // Clip the face segment against the footprint (a convex, positive-area quad).
    let t0 = 0;
    let t1 = 1;
    const fp = r.footprint;
    for (let i = 0; i < fp.length && t0 <= t1; i++) {
      const e = norm(sub(fp[(i + 1) % fp.length], fp[i]));
      const f0 = cross(e, sub(face.P, fp[i])) + EPS; // inside when ≥ 0
      const fd = cross(e, d);
      if (Math.abs(fd) < 1e-9) {
        if (f0 < 0) t1 = -1;
      } else if (fd > 0) {
        t0 = Math.max(t0, -f0 / fd);
      } else {
        t1 = Math.min(t1, -f0 / fd);
      }
    }
    if ((t1 - t0) * face.length > 2 * EPS) bands.push({ s0: t0 * face.length, s1: t1 * face.length, bottom: r.bottom, resolved: r });
  }
  return bands;
}

/** Area of a band between its underside and the ceiling profile. */
export function bandArea(profile, s0, s1, bottom) {
  const N = 24;
  let a = 0;
  let prev = Math.max(0, profileHeightAt(profile, s0) - bottom);
  for (let i = 1; i <= N; i++) {
    const s = s0 + ((s1 - s0) * i) / N;
    const cur = Math.max(0, profileHeightAt(profile, s) - bottom);
    a += ((prev + cur) / 2) * ((s1 - s0) / N);
    prev = cur;
  }
  return a;
}

function averageDrop(model, p, q, bottom) {
  let sum = 0;
  const N = 8;
  for (let i = 0; i <= N; i++) sum += Math.max(0, model.heightAt(lerp(p, q, i / N)) - bottom);
  return sum / (N + 1);
}

/**
 * Finished surfaces of a bulkhead: soffit (underside), fascia (front face),
 * end caps where it stops short of a wall, and outside-corner length for
 * corner bead.
 */
export function bulkheadSurfaces(r, model) {
  const [a, b, c, dd] = r.footprint;
  const len = r.s1 - r.s0;
  const fasciaDrop = averageDrop(model, dd, c, r.bottom);
  const startDrop = averageDrop(model, a, dd, r.bottom);
  const endDrop = averageDrop(model, b, c, r.bottom);
  if (Math.max(fasciaDrop, startDrop, endDrop) <= 0) return { soffit: 0, fascia: 0, caps: 0, bead: 0, area: 0 };
  const soffit = len * r.depth;
  const fascia = len * fasciaDrop;
  const caps = (r.openStart ? startDrop * r.depth : 0) + (r.openEnd ? endDrop * r.depth : 0);
  const capEdge = (open, p) => (open ? r.depth + Math.max(0, model.heightAt(p) - r.bottom) : 0);
  const bead = len + capEdge(r.openStart, dd) + capEdge(r.openEnd, c);
  return { soffit, fascia, caps, bead, area: soffit + fascia + caps };
}
