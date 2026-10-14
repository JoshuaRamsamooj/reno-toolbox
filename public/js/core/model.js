// The floor plan model: a planar graph of nodes and walls (centrelines),
// with openings attached to walls and rooms derived from the graph's faces.
// Room records only persist user metadata (name, ceiling); their geometry is
// always recomputed from the walls, so drawing stays free-form.
import {
  add, compassName, dist, dot, closestPointOnSegment, cross, labelPoint, norm, offsetPolygon,
  perp, pointInPolygon, polygonArea, polygonPerimeter, projectParam, scale, segmentIntersection, sub,
} from './geometry.js';
import { unitDefaults } from './units.js';
import { ceilingModel, defaultCeiling, resolveCeiling, wallTopProfile } from './ceiling.js';
import { bulkheadDefaults, faceBands, findBulkheadFace, resolveBulkheads } from './bulkhead.js';

export const EPS = 1; // mm: nodes closer than this are the same point
const MIN_FACE_AREA = 10000; // mm²: anything smaller is a sliver, not a room

let idCounter = 0;
export function uid(prefix) {
  idCounter = (idCounter + 1) % 1679616;
  return `${prefix}${Date.now().toString(36).slice(-5)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

export const OPENING_TYPES = { door: 'Door', window: 'Window', opening: 'Opening' };

export function createDesign(units = 'imperial') {
  const d = unitDefaults(units);
  return {
    version: 1,
    units,
    settings: { wallThickness: d.wallThickness, ceilingHeight: d.ceilingHeight, dimensionMode: 'interior' },
    estimate: {},
    nodes: [],
    walls: [],
    openings: [],
    rooms: [],
  };
}

/** Fills in missing fields on designs loaded from storage or older versions. */
export function migrateDesign(raw) {
  const base = createDesign(raw?.units === 'metric' ? 'metric' : 'imperial');
  const d = { ...base, ...raw, settings: { ...base.settings, ...(raw?.settings ?? {}) } };
  for (const key of ['nodes', 'walls', 'openings', 'rooms']) d[key] = Array.isArray(d[key]) ? d[key] : [];
  d.estimate = d.estimate && typeof d.estimate === 'object' ? d.estimate : {};
  d.walls.forEach((w) => {
    w.thickness ??= d.settings.wallThickness;
    w.exterior ??= 'auto';
  });
  d.rooms.forEach((r) => {
    r.ceiling = { ...defaultCeiling(), ...(r.ceiling ?? {}) };
    r.crown ??= false;
    r.flooring ??= true;
    r.bulkheads = Array.isArray(r.bulkheads) ? r.bulkheads : [];
  });
  return d;
}

export function indexDesign(d) {
  return {
    nodes: new Map(d.nodes.map((n) => [n.id, n])),
    walls: new Map(d.walls.map((w) => [w.id, w])),
  };
}

export function wallEnds(d, w, idx = indexDesign(d)) {
  return [idx.nodes.get(w.a), idx.nodes.get(w.b)];
}

export function wallLength(d, w, idx) {
  const [A, B] = wallEnds(d, w, idx);
  return A && B ? dist(A, B) : 0;
}

// ---------------------------------------------------------------------------
// Construction

export function findNodeNear(d, p, tol = EPS) {
  let best = null;
  let bestD = tol;
  for (const n of d.nodes) {
    const dd = dist(n, p);
    if (dd <= bestD) {
      best = n;
      bestD = dd;
    }
  }
  return best;
}

export function findOrCreateNode(d, p) {
  const existing = findNodeNear(d, p);
  if (existing) return existing;
  const n = { id: uid('n'), x: p.x, y: p.y };
  d.nodes.push(n);
  return n;
}

export function addWall(d, p1, p2, props = {}) {
  const a = findOrCreateNode(d, p1);
  const b = findOrCreateNode(d, p2);
  if (a === b) return null;
  const w = { id: uid('w'), a: a.id, b: b.id, thickness: props.thickness ?? d.settings.wallThickness, exterior: 'auto' };
  d.walls.push(w);
  return w;
}

/** Adds walls along a polyline. Call normalize() afterwards. */
export function addWallChain(d, points, closed = false) {
  const walls = [];
  for (let i = 0; i + 1 < points.length; i++) walls.push(addWall(d, points[i], points[i + 1]));
  if (closed && points.length > 2) walls.push(addWall(d, points[points.length - 1], points[0]));
  return walls.filter(Boolean);
}

export function rectangleCorners(p1, p2) {
  return [
    { x: p1.x, y: p1.y },
    { x: p2.x, y: p1.y },
    { x: p2.x, y: p2.y },
    { x: p1.x, y: p2.y },
  ];
}

export function addRectangle(d, p1, p2) {
  if (Math.abs(p1.x - p2.x) < EPS || Math.abs(p1.y - p2.y) < EPS) return [];
  return addWallChain(d, rectangleCorners(p1, p2), true);
}

export function addOpening(d, wallId, type, offset, overrides = {}) {
  const defaults = unitDefaults(d.units)[type];
  const o = {
    id: uid('o'),
    wallId,
    type,
    offset,
    width: defaults.width,
    height: defaults.height,
    sill: defaults.sill,
    flipX: false, // door: hinge at the end of the opening nearer wall end B
    flipY: false, // door: swings to the right of the wall direction A→B
    ...overrides,
  };
  d.openings.push(o);
  clampOpenings(d);
  return o;
}

// ---------------------------------------------------------------------------
// Normalisation: keep the wall graph planar (split at junctions and
// crossings, merge duplicates) and re-derive rooms.

export function normalize(d) {
  mergeCoincidentNodes(d);
  for (let guard = 0; guard < 25; guard++) {
    const split = splitWallsAtNodes(d);
    const crossed = addCrossingNodes(d);
    if (!split && !crossed) break;
  }
  dedupeWalls(d);
  healCollinearJoints(d);
  removeOrphans(d);
  clampOpenings(d);
  syncRooms(d);
  return d;
}

function mergeCoincidentNodes(d) {
  const remap = new Map();
  const kept = [];
  for (const n of d.nodes) {
    const target = kept.find((k) => dist(k, n) < EPS);
    if (target) remap.set(n.id, target.id);
    else kept.push(n);
  }
  if (remap.size) {
    d.nodes = kept;
    for (const w of d.walls) {
      w.a = remap.get(w.a) ?? w.a;
      w.b = remap.get(w.b) ?? w.b;
    }
  }
  const before = d.walls.length;
  d.walls = d.walls.filter((w) => w.a !== w.b);
  return remap.size > 0 || d.walls.length !== before;
}

function moveOpeningsToPieces(d, wall, pieces) {
  // pieces: [{wall, startOffset}] along the original wall's direction.
  for (const o of d.openings) {
    if (o.wallId !== wall.id) continue;
    let target = pieces[0];
    for (const p of pieces) if (o.offset >= p.startOffset) target = p;
    o.wallId = target.wall.id;
    o.offset -= target.startOffset;
  }
}

function splitWallsAtNodes(d) {
  const idx = indexDesign(d);
  let changed = false;
  const result = [];
  for (const w of d.walls) {
    const A = idx.nodes.get(w.a);
    const B = idx.nodes.get(w.b);
    const L = dist(A, B);
    const hits = [];
    for (const n of d.nodes) {
      if (n.id === w.a || n.id === w.b) continue;
      const t = projectParam(n, A, B);
      if (t * L <= EPS || (1 - t) * L <= EPS) continue;
      if (closestPointOnSegment(n, A, B).dist < EPS) hits.push({ n, t });
    }
    if (!hits.length) {
      result.push(w);
      continue;
    }
    changed = true;
    hits.sort((p, q) => p.t - q.t);
    const chain = [A, ...hits.map((h) => h.n), B];
    const pieces = [];
    for (let i = 0; i + 1 < chain.length; i++) {
      const piece = i === 0
        ? { ...w, b: chain[1].id }
        : { ...w, id: uid('w'), a: chain[i].id, b: chain[i + 1].id };
      pieces.push({ wall: piece, startOffset: dist(A, chain[i]) });
      result.push(piece);
    }
    moveOpeningsToPieces(d, w, pieces);
  }
  d.walls = result;
  return changed;
}

function addCrossingNodes(d) {
  const idx = indexDesign(d);
  let added = false;
  for (let i = 0; i < d.walls.length; i++) {
    const w1 = d.walls[i];
    const A = idx.nodes.get(w1.a);
    const B = idx.nodes.get(w1.b);
    const L1 = dist(A, B);
    for (let j = i + 1; j < d.walls.length; j++) {
      const w2 = d.walls[j];
      if (w2.a === w1.a || w2.a === w1.b || w2.b === w1.a || w2.b === w1.b) continue;
      const C = idx.nodes.get(w2.a);
      const D = idx.nodes.get(w2.b);
      const hit = segmentIntersection(A, B, C, D);
      if (!hit) continue;
      const L2 = dist(C, D);
      if (hit.t * L1 <= EPS || (1 - hit.t) * L1 <= EPS || hit.u * L2 <= EPS || (1 - hit.u) * L2 <= EPS) continue;
      if (hit.t < 0 || hit.t > 1 || hit.u < 0 || hit.u > 1) continue;
      if (findNodeNear(d, hit.point)) continue;
      d.nodes.push({ id: uid('n'), x: hit.point.x, y: hit.point.y });
      added = true;
    }
  }
  return added;
}

function dedupeWalls(d) {
  const idx = indexDesign(d);
  const seen = new Map();
  const result = [];
  for (const w of d.walls) {
    const key = w.a < w.b ? `${w.a}|${w.b}` : `${w.b}|${w.a}`;
    const keep = seen.get(key);
    if (!keep) {
      seen.set(key, w);
      result.push(w);
      continue;
    }
    const reversed = keep.a !== w.a;
    const L = wallLength(d, w, idx);
    for (const o of d.openings) {
      if (o.wallId !== w.id) continue;
      o.wallId = keep.id;
      if (reversed) {
        o.offset = L - o.offset;
        o.flipX = !o.flipX;
        o.flipY = !o.flipY;
      }
    }
  }
  d.walls = result;
}

/** Joins two collinear walls that meet at a node nothing else touches. */
function healCollinearJoints(d) {
  for (let guard = 0; guard < 1000; guard++) {
    const idx = indexDesign(d);
    const degree = new Map();
    for (const w of d.walls) {
      degree.set(w.a, [...(degree.get(w.a) ?? []), w]);
      degree.set(w.b, [...(degree.get(w.b) ?? []), w]);
    }
    let merged = false;
    for (const [nodeId, walls] of degree) {
      if (walls.length !== 2) continue;
      const [w1, w2] = walls;
      if (Math.abs(w1.thickness - w2.thickness) > 0.5 || w1.exterior !== w2.exterior) continue;
      const P = idx.nodes.get(w1.a === nodeId ? w1.b : w1.a);
      const N = idx.nodes.get(nodeId);
      const Q = idx.nodes.get(w2.a === nodeId ? w2.b : w2.a);
      const u = norm(sub(N, P));
      const v = norm(sub(Q, N));
      if (Math.abs(cross(u, v)) > 1e-4 || dot(u, v) <= 0) continue;
      // Re-express both walls as P→N→Q, then merge into w1 as P→Q.
      const L1 = dist(P, N);
      const L2 = dist(N, Q);
      for (const o of d.openings) {
        if (o.wallId === w1.id && w1.a !== P.id) {
          o.offset = L1 - o.offset;
          o.flipX = !o.flipX;
          o.flipY = !o.flipY;
        } else if (o.wallId === w2.id) {
          if (w2.a !== nodeId) {
            o.offset = L2 - o.offset;
            o.flipX = !o.flipX;
            o.flipY = !o.flipY;
          }
          o.offset += L1;
          o.wallId = w1.id;
        }
      }
      w1.a = P.id;
      w1.b = Q.id;
      d.walls = d.walls.filter((w) => w !== w2);
      d.nodes = d.nodes.filter((n) => n.id !== nodeId);
      merged = true;
      break;
    }
    if (!merged) return;
  }
}

function removeOrphans(d) {
  const used = new Set();
  for (const w of d.walls) {
    used.add(w.a);
    used.add(w.b);
  }
  d.nodes = d.nodes.filter((n) => used.has(n.id));
  const walls = new Set(d.walls.map((w) => w.id));
  d.openings = d.openings.filter((o) => walls.has(o.wallId));
}

export function clampOpenings(d) {
  const idx = indexDesign(d);
  for (const o of d.openings) {
    const w = idx.walls.get(o.wallId);
    if (!w) continue;
    const L = wallLength(d, w, idx);
    o.width = Math.max(1, Math.min(o.width, L));
    o.offset = Math.min(Math.max(o.offset, o.width / 2), L - o.width / 2);
    o.height = Math.max(1, o.height);
    o.sill = o.type === 'window' ? Math.max(0, o.sill) : 0;
  }
}

// ---------------------------------------------------------------------------
// Faces and rooms

/**
 * Traces the faces of the wall graph. Interior faces (positive area) are
 * candidate rooms; each connected component also yields one negative-area
 * outer face.
 */
export function computeFaces(d, idx = indexDesign(d)) {
  const out = new Map();
  const halfEdges = [];
  for (const w of d.walls) {
    const A = idx.nodes.get(w.a);
    const B = idx.nodes.get(w.b);
    if (!A || !B) continue;
    const h1 = { wall: w, from: w.a, to: w.b, dir: 0, angle: Math.atan2(B.y - A.y, B.x - A.x) };
    const h2 = { wall: w, from: w.b, to: w.a, dir: 1, angle: Math.atan2(A.y - B.y, A.x - B.x) };
    h1.twin = h2;
    h2.twin = h1;
    for (const h of [h1, h2]) {
      halfEdges.push(h);
      if (!out.has(h.from)) out.set(h.from, []);
      out.get(h.from).push(h);
    }
  }
  for (const list of out.values()) {
    list.sort((p, q) => p.angle - q.angle);
    list.forEach((h, i) => (h.idx = i));
  }
  const faces = [];
  for (const start of halfEdges) {
    if (start.face !== undefined) continue;
    const cycle = [];
    let e = start;
    while (e.face === undefined) {
      e.face = faces.length;
      cycle.push(e);
      const list = out.get(e.to);
      e = list[(e.twin.idx - 1 + list.length) % list.length];
    }
    const pts = cycle.map((h) => idx.nodes.get(h.from));
    faces.push({ index: faces.length, halfEdges: cycle, area: polygonArea(pts) });
  }
  for (const f of faces) f.interior = f.area > MIN_FACE_AREA;
  return { faces, halfEdges };
}

function stripSpurs(cycle) {
  const edges = cycle.slice();
  const spurs = new Set();
  let changed = true;
  while (changed && edges.length > 2) {
    changed = false;
    for (let i = 0; i < edges.length; i++) {
      const j = (i + 1) % edges.length;
      if (edges[i].wall === edges[j].wall) {
        spurs.add(edges[i].wall);
        if (j > i) edges.splice(i, 2);
        else {
          edges.splice(i, 1);
          edges.splice(0, 1);
        }
        changed = true;
        break;
      }
    }
  }
  return { edges, spurs: [...spurs] };
}

/** User override for exterior status, or null to derive it from the faces. */
function forcedExterior(w) {
  if (w.exterior === 'yes') return true;
  if (w.exterior === 'no') return false;
  return null;
}

/**
 * Full analysis of the plan: faces, room geometry and per-wall info. This is
 * the single source of derived data for rendering, elevations and takeoff.
 */
export function analyze(d) {
  const idx = indexDesign(d);
  const { faces, halfEdges } = computeFaces(d, idx);

  const wallInfo = new Map();
  for (const w of d.walls) wallInfo.set(w.id, { wall: w, sides: [null, null], exterior: false });
  for (const h of halfEdges) {
    const info = wallInfo.get(h.wall.id);
    info.sides[h.dir] = faces[h.face];
  }
  for (const info of wallInfo.values()) {
    const forced = forcedExterior(info.wall);
    const interiorSides = info.sides.filter((f) => f?.interior).length;
    info.exterior = forced ?? interiorSides === 1;
  }

  const geoms = faces.filter((f) => f.interior).map((f) => roomGeometry(f, idx, wallInfo, d)).filter(Boolean);
  const matched = matchRooms(d.rooms, geoms);
  const rooms = [];
  for (const g of geoms) {
    const room = matched.get(g) ?? null;
    g.room = room;
    rooms.push(g);
  }
  for (const g of rooms) {
    for (const h of g.face.halfEdges) {
      const info = wallInfo.get(h.wall.id);
      info.roomSides ??= [null, null];
      info.roomSides[h.dir] = g;
    }
  }
  for (const info of wallInfo.values()) info.roomSides ??= [null, null];
  return { idx, faces, rooms, wallInfo };
}

function roomGeometry(face, idx, wallInfo, d) {
  const { edges, spurs } = stripSpurs(face.halfEdges);
  if (edges.length < 3) return null;
  const segs = edges.map((h) => {
    const P = idx.nodes.get(h.from);
    const Q = idx.nodes.get(h.to);
    return { h, P, Q, dir: norm(sub(Q, P)), thickness: h.wall.thickness, exterior: wallInfo.get(h.wall.id).exterior };
  });
  const mergeable = (s, t) =>
    Math.abs(cross(s.dir, t.dir)) < 1e-6 && dot(s.dir, t.dir) > 0 && Math.abs(s.thickness - t.thickness) < 0.5;
  const n = segs.length;
  let start = 0;
  while (start < n && mergeable(segs[(start - 1 + n) % n], segs[start])) start++;
  if (start === n) return null;
  const groups = [];
  for (let k = 0; k < n; k++) {
    const s = segs[(start + k) % n];
    const last = groups[groups.length - 1];
    if (last && mergeable(last.segs[last.segs.length - 1], s)) last.segs.push(s);
    else groups.push({ segs: [s] });
  }
  if (groups.length < 3) return null;
  const centerPolygon = groups.map((g) => g.segs[0].P);
  const polygon = offsetPolygon(centerPolygon, groups.map((g) => g.segs[0].thickness / 2));
  const area = polygonArea(polygon);
  if (area <= 0) return null;

  const openingsByWall = new Map();
  for (const o of d.openings) {
    if (!openingsByWall.has(o.wallId)) openingsByWall.set(o.wallId, []);
    openingsByWall.get(o.wallId).push(o);
  }

  const walls = groups.map((g, i) => {
    const P = polygon[i];
    const Q = polygon[(i + 1) % groups.length];
    const dir = g.segs[0].dir;
    const length = Math.max(0, dot(sub(Q, P), dir));
    const outward = scale(perp(dir), -1);
    const openings = [];
    for (const s of g.segs) {
      const w = s.h.wall;
      const A = idx.nodes.get(w.a);
      const B = idx.nodes.get(w.b);
      const wd = norm(sub(B, A));
      for (const o of openingsByWall.get(w.id) ?? []) {
        const center = add(A, scale(wd, o.offset));
        const c = dot(sub(center, P), dir);
        const bottom = o.type === 'window' ? o.sill : 0;
        openings.push({ opening: o, s0: c - o.width / 2, s1: c + o.width / 2, bottom, top: bottom + o.height, forward: dot(wd, dir) > 0 });
      }
    }
    openings.sort((p, q) => p.s0 - q.s0);
    // Exterior status can vary along a merged face (e.g. partly shared with a neighbour).
    const segments = g.segs.map((s, k) => ({
      s0: k === 0 ? 0 : Math.min(length, Math.max(0, dot(sub(s.P, P), dir))),
      s1: k === g.segs.length - 1 ? length : Math.min(length, Math.max(0, dot(sub(s.Q, P), dir))),
      exterior: s.exterior,
      wallId: s.h.wall.id,
    }));
    return {
      index: i,
      P,
      Q,
      dir,
      length,
      outward,
      compass: compassName(outward),
      thickness: g.segs[0].thickness,
      exterior: g.segs.some((s) => s.exterior),
      segments,
      wallIds: g.segs.map((s) => s.h.wall.id),
      centerP: g.segs[0].P,
      centerQ: g.segs[g.segs.length - 1].Q,
      openings,
    };
  });

  const wallIds = [...new Set(edges.map((h) => h.wall.id))];
  return {
    face,
    key: [...wallIds].sort().join(','),
    centerPolygon,
    polygon,
    area,
    perimeter: polygonPerimeter(polygon),
    walls,
    wallIds,
    spurWallIds: spurs.map((w) => w.id),
    labelPoint: labelPoint(polygon),
  };
}

/** Pairs persisted room records with current faces: by wall set, then by anchor point. */
function matchRooms(rooms, geoms) {
  const result = new Map();
  const freeRooms = new Set(rooms);
  for (const g of geoms) {
    const r = [...freeRooms].find((room) => room.key === g.key);
    if (r) {
      result.set(g, r);
      freeRooms.delete(r);
    }
  }
  const byArea = geoms.filter((g) => !result.has(g)).sort((p, q) => p.area - q.area);
  for (const r of [...freeRooms]) {
    if (!r.anchor) continue;
    const g = byArea.find((cand) => !result.has(cand) && pointInPolygon(r.anchor, cand.centerPolygon));
    if (g) {
      result.set(g, r);
      freeRooms.delete(r);
    }
  }
  return result;
}

function nextRoomName(rooms) {
  const used = new Set(rooms.map((r) => r.name));
  for (let i = 1; ; i++) if (!used.has(`Room ${i}`)) return `Room ${i}`;
}

/** Creates/removes persisted room records to match the current faces. */
export function syncRooms(d) {
  const { rooms } = analyze(d);
  const kept = [];
  for (const g of rooms) {
    let r = g.room;
    if (!r) {
      r = { id: uid('r'), name: nextRoomName([...d.rooms, ...kept]), ceiling: defaultCeiling(), crown: false, flooring: true, bulkheads: [] };
    }
    r.key = g.key;
    r.anchor = { x: g.labelPoint.x, y: g.labelPoint.y };
    // Re-attach bulkheads to their wall faces so they survive wall splits/merges.
    r.bulkheads = (r.bulkheads ?? []).filter((bh) => {
      const face = findBulkheadFace(g.walls, bh);
      if (!face) return false;
      bh.wallId = face.wallIds[0];
      bh.anchor = faceMidpoint(face);
      return true;
    });
    kept.push(r);
  }
  d.rooms = kept;
}

export function resolveRoomCeiling(d, room) {
  return resolveCeiling(room?.ceiling, d.settings.ceilingHeight);
}

/** Elevation data for each wall face of a room geometry. */
export function roomElevations(d, geom) {
  const spec = resolveRoomCeiling(d, geom.room);
  const model = ceilingModel(spec, geom.polygon);
  const bulkheads = resolveBulkheads(geom.room, geom.walls, spec, d.units);
  return {
    spec,
    model,
    bulkheads,
    walls: geom.walls.map((w) => ({ ...w, profile: wallTopProfile(model, w.P, w.Q), bands: faceBands(w, bulkheads) })),
  };
}

function faceMidpoint(face) {
  return { x: (face.P.x + face.Q.x) / 2, y: (face.P.y + face.Q.y) / 2 };
}

/** Adds a bulkhead along a room wall face (identified by any wall id in the face). */
export function addBulkhead(d, roomId, wallId) {
  const room = d.rooms.find((r) => r.id === roomId);
  const g = analyze(d).rooms.find((x) => x.room?.id === roomId);
  const face = g?.walls.find((f) => f.wallIds.includes(wallId));
  if (!room || !face) return null;
  const bh = { id: uid('b'), wallId, anchor: faceMidpoint(face), depth: bulkheadDefaults(d.units).depth, bottom: null, start: null, length: null };
  room.bulkheads = [...(room.bulkheads ?? []), bh];
  return bh;
}

// ---------------------------------------------------------------------------
// Edit operations (call normalize() afterwards unless noted)

export function openingGeometry(d, o, idx = indexDesign(d)) {
  const w = idx.walls.get(o.wallId);
  if (!w) return null;
  const A = idx.nodes.get(w.a);
  const B = idx.nodes.get(w.b);
  const dir = norm(sub(B, A));
  const center = add(A, scale(dir, o.offset));
  return {
    wall: w,
    A,
    B,
    dir,
    normal: perp(dir),
    center,
    start: add(center, scale(dir, -o.width / 2)),
    end: add(center, scale(dir, o.width / 2)),
    length: dist(A, B),
  };
}

export function deleteWall(d, wallId) {
  d.walls = d.walls.filter((w) => w.id !== wallId);
  d.openings = d.openings.filter((o) => o.wallId !== wallId);
}

export function deleteNode(d, nodeId) {
  for (const w of d.walls.filter((x) => x.a === nodeId || x.b === nodeId)) deleteWall(d, w.id);
}

export function deleteOpening(d, openingId) {
  d.openings = d.openings.filter((o) => o.id !== openingId);
}

/** Removes a room's walls except those shared with another room. */
export function deleteRoom(d, roomId) {
  const { rooms, wallInfo } = analyze(d);
  const g = rooms.find((x) => x.room?.id === roomId);
  if (!g) return;
  for (const id of [...g.wallIds, ...g.spurWallIds]) {
    const sides = wallInfo.get(id).roomSides;
    const shared = sides.some((s) => s && s !== g);
    if (!shared) deleteWall(d, id);
  }
  d.rooms = d.rooms.filter((r) => r.id !== roomId);
}

/**
 * Changes a wall's centreline length by stretching the plan along the wall's
 * direction: end B and everything at or beyond it moves, so rectangular
 * rooms stay rectangular.
 */
export function setWallLength(d, wallId, newLength) {
  const idx = indexDesign(d);
  const w = idx.walls.get(wallId);
  if (!w || !(newLength > EPS)) return false;
  const A = idx.nodes.get(w.a);
  const B = idx.nodes.get(w.b);
  const L = dist(A, B);
  if (L < EPS) return false;
  const u = norm(sub(B, A));
  const delta = newLength - L;
  const limit = dot(B, u) - 0.5;
  for (const n of d.nodes) {
    if (n === A || dot(n, u) < limit) continue;
    n.x += u.x * delta;
    n.y += u.y * delta;
  }
  return true;
}

export function translateNodes(d, nodeIds, delta) {
  const ids = new Set(nodeIds);
  for (const n of d.nodes) {
    if (!ids.has(n.id)) continue;
    n.x += delta.x;
    n.y += delta.y;
  }
}

/** Degree of each node (number of walls touching it). */
export function nodeDegrees(d) {
  const deg = new Map();
  for (const w of d.walls) {
    deg.set(w.a, (deg.get(w.a) ?? 0) + 1);
    deg.set(w.b, (deg.get(w.b) ?? 0) + 1);
  }
  return deg;
}

export function designBounds(d) {
  if (!d.nodes.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of d.nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x);
    maxY = Math.max(maxY, n.y);
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}
