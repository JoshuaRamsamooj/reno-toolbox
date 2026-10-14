// 2D vector and polygon helpers. Coordinates are screen-oriented (y grows
// downward), so a polygon with positive shoelace area is visually clockwise.

export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
export const scale = (a, k) => ({ x: a.x * k, y: a.y * k });
export const dot = (a, b) => a.x * b.x + a.y * b.y;
export const cross = (a, b) => a.x * b.y - a.y * b.x;
export const len = (a) => Math.hypot(a.x, a.y);
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

export function norm(a) {
  const l = len(a);
  return l > 0 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
}

/** Left-hand normal in screen coordinates; for a positive-area polygon edge it points inward. */
export const perp = (a) => ({ x: -a.y, y: a.x });

/** Parameter t of the projection of p onto line a→b (0 at a, 1 at b), unclamped. */
export function projectParam(p, a, b) {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  return l2 > 0 ? dot(sub(p, a), ab) / l2 : 0;
}

export function closestPointOnSegment(p, a, b) {
  const t = Math.max(0, Math.min(1, projectParam(p, a, b)));
  const point = lerp(a, b, t);
  return { point, t, dist: dist(p, point) };
}

/** Intersection of segments p1-p2 and p3-p4. Returns {point, t, u} or null when parallel. */
export function segmentIntersection(p1, p2, p3, p4) {
  const r = sub(p2, p1);
  const s = sub(p4, p3);
  const denom = cross(r, s);
  if (Math.abs(denom) < 1e-9 * len(r) * len(s)) return null;
  const qp = sub(p3, p1);
  const t = cross(qp, s) / denom;
  const u = cross(qp, r) / denom;
  return { point: add(p1, scale(r, t)), t, u };
}

/** Intersection of infinite lines p + t·d and q + s·e, or null when parallel. */
export function lineIntersection(p, d, q, e) {
  const denom = cross(d, e);
  if (Math.abs(denom) < 1e-9 * len(d) * len(e)) return null;
  const t = cross(sub(q, p), e) / denom;
  return add(p, scale(d, t));
}

export function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function polygonPerimeter(pts) {
  let l = 0;
  for (let i = 0; i < pts.length; i++) l += dist(pts[i], pts[(i + 1) % pts.length]);
  return l;
}

export function polygonCentroid(pts) {
  const a = polygonArea(pts);
  if (Math.abs(a) < 1e-9) {
    const s = pts.reduce((acc, p) => add(acc, p), { x: 0, y: 0 });
    return scale(s, 1 / Math.max(1, pts.length));
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    const f = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * f;
    cy += (p.y + q.y) * f;
  }
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

export function pointInPolygon(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function distanceToPolygonEdges(p, pts) {
  let d = Infinity;
  for (let i = 0; i < pts.length; i++) d = Math.min(d, closestPointOnSegment(p, pts[i], pts[(i + 1) % pts.length]).dist);
  return d;
}

export function bounds(pts) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * Offsets each edge of a positive-area polygon inward by distances[i]
 * (edge i runs from pts[i] to pts[i+1]) and returns the new vertices.
 * Vertex i is the intersection of offset edges i-1 and i.
 */
export function offsetPolygon(pts, distances) {
  const n = pts.length;
  const lines = pts.map((p, i) => {
    const q = pts[(i + 1) % n];
    const d = norm(sub(q, p));
    const off = scale(perp(d), typeof distances === 'number' ? distances : distances[i]);
    return { p: add(p, off), d, off };
  });
  return pts.map((p, i) => {
    const prev = lines[(i - 1 + n) % n];
    const cur = lines[i];
    return lineIntersection(prev.p, prev.d, cur.p, cur.d) ?? add(p, cur.off);
  });
}

/** A point well inside the polygon, suitable for placing a label. */
export function labelPoint(pts) {
  const c = polygonCentroid(pts);
  let best = pointInPolygon(c, pts) ? c : null;
  let bestD = best ? distanceToPolygonEdges(best, pts) : -1;
  const b = bounds(pts);
  const N = 24;
  for (let i = 1; i < N; i++) {
    for (let j = 1; j < N; j++) {
      const p = { x: b.minX + (b.width * i) / N, y: b.minY + (b.height * j) / N };
      if (!pointInPolygon(p, pts)) continue;
      const d = distanceToPolygonEdges(p, pts);
      // Prefer the centroid unless a much roomier spot exists.
      if (d > bestD * 1.35) {
        best = p;
        bestD = d;
      }
    }
  }
  return best ?? c;
}

/** Compass label for an outward direction in screen coordinates (up = north). */
export function compassName(dir) {
  const deg = (Math.atan2(-dir.y, dir.x) * 180) / Math.PI;
  const names = ['East', 'Northeast', 'North', 'Northwest', 'West', 'Southwest', 'South', 'Southeast'];
  return names[(Math.round(deg / 45) + 8) % 8];
}
