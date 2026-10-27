// Flooring layout: how a run of planks, tiles or subfloor panels lands in one
// or more rooms, which cuts it needs, what to buy, and install guidance.
//
// Runs live in design.floorRuns:
//   { id, name, kind, preset, length, width, joint, stagger: {mode, offset, min, seed},
//     perBox, unit, waste, gap, minCut, angle, origin: {x, y}, roomIds }
// `kind` is 'plank' | 'tile' (the finish layer) or 'subfloor' (its own
// layer), so a room can have both, but only one run per layer. `length` runs
// along `angle` (degrees, 0 = east–west, 90 = north–south). `origin` is a plan
// point where a corner of course 0 sits; because it is in plan coordinates, a
// run shared by several rooms continues across their doorways without
// restarting. `joint` is the grout (tile) or panel gap (subfloor). Course j
// is shifted by j·offset ('fixed'), or by a seeded random offset kept at least
// `min` from its neighbours ('random'). `minCut` null derives the smallest
// acceptable end cut from the piece size.
import { add, bounds, compassName, dot, offsetPolygon, perp, pointInPolygon, polygonArea, scale, sub } from './geometry.js';
import { MM_PER_FT, MM_PER_IN, formatLength } from './units.js';
import { analyze, uid } from './model.js';

const IN = MM_PER_IN;
const TOL = 0.5; // mm: cuts within this of a full piece are full
const KERF = 3; // mm lost to each saw cut when reusing offcuts
const TRAFFIC_DEPTH = 600; // mm: the approach in front of a doorway counts as high traffic
const MAX_PIECES = 60000; // safety cap on pieces per run (tiny tiles in a huge plan)

export const FLOOR_KINDS = {
  plank: { label: 'Plank', layer: 'finish', piece: 'board', pieces: 'boards' },
  tile: { label: 'Tile', layer: 'finish', piece: 'tile', pieces: 'tiles' },
  subfloor: { label: 'Subfloor', layer: 'subfloor', piece: 'panel', pieces: 'panels' },
};

export const FLOOR_LAYERS = { finish: 'Finish floor', subfloor: 'Subfloor' };

/** Purchase units: [singular, plural]. */
export const BUY_UNITS = { box: ['box', 'boxes'], sheet: ['sheet', 'sheets'], panel: ['panel', 'panels'], roll: ['roll', 'rolls'] };

/**
 * Product presets with typical sizes and carton counts (check the carton:
 * counts vary by maker). `gap` is the usual expansion or movement gap at the
 * walls, `offset` the default stagger as a fraction of the length, `nailed`
 * marks nail-down hardwood (direction matters over joists).
 */
export const FLOOR_PRESETS = {
  'lvp-7x48': { kind: 'plank', units: 'imperial', name: 'Vinyl plank 7" × 48"', length: 48 * IN, width: 7 * IN, perBox: 10, gap: 0.25 * IN },
  'lvp-9x60': { kind: 'plank', units: 'imperial', name: 'Vinyl plank 9" × 60"', length: 60 * IN, width: 9 * IN, perBox: 8, gap: 0.25 * IN },
  'laminate-7.5x50': { kind: 'plank', units: 'imperial', name: 'Laminate 7 1/2" × 50 1/2"', length: 50.5 * IN, width: 7.5 * IN, perBox: 8, gap: 0.375 * IN, stagger: 8 * IN },
  'hardwood-3.25': { kind: 'plank', units: 'imperial', name: 'Solid hardwood strip 3 1/4" × 48"', length: 48 * IN, width: 3.25 * IN, perBox: 18, gap: 0.75 * IN, nailed: true },
  'hardwood-5x48': { kind: 'plank', units: 'imperial', name: 'Solid hardwood plank 5" × 48"', length: 48 * IN, width: 5 * IN, perBox: 12, gap: 0.75 * IN, nailed: true, stagger: 8 * IN },
  'engineered-7.5x72': { kind: 'plank', units: 'imperial', name: 'Engineered 7 1/2" × 72"', length: 72 * IN, width: 7.5 * IN, perBox: 6, gap: 0.5 * IN, stagger: 8 * IN },
  'lvp-180x1220': { kind: 'plank', units: 'metric', name: 'Vinyl plank 180 × 1220 mm', length: 1220, width: 180, perBox: 10, gap: 6 },
  'laminate-193x1380': { kind: 'plank', units: 'metric', name: 'Laminate 193 × 1380 mm', length: 1380, width: 193, perBox: 8, gap: 10, stagger: 200 },
  'engineered-190x1900': { kind: 'plank', units: 'metric', name: 'Engineered 190 × 1900 mm', length: 1900, width: 190, perBox: 6, gap: 12, stagger: 200 },
  'tile-12x24': { kind: 'tile', units: 'imperial', name: 'Tile 12" × 24"', length: 24 * IN, width: 12 * IN, perBox: 8, joint: IN / 8, gap: 0.25 * IN },
  'tile-12x12': { kind: 'tile', units: 'imperial', name: 'Tile 12" × 12"', length: 12 * IN, width: 12 * IN, perBox: 15, joint: (3 / 16) * IN, gap: 0.25 * IN },
  'tile-24x24': { kind: 'tile', units: 'imperial', name: 'Tile 24" × 24"', length: 24 * IN, width: 24 * IN, perBox: 4, joint: IN / 8, gap: 0.25 * IN },
  'tile-6x36': { kind: 'tile', units: 'imperial', name: 'Plank tile 6" × 36"', length: 36 * IN, width: 6 * IN, perBox: 8, joint: IN / 8, gap: 0.25 * IN, offset: 1 / 3 },
  'tile-3x6': { kind: 'tile', units: 'imperial', name: 'Subway tile 3" × 6"', length: 6 * IN, width: 3 * IN, perBox: 80, joint: IN / 16, gap: 0.25 * IN, offset: 1 / 2 },
  'tile-300x600': { kind: 'tile', units: 'metric', name: 'Tile 300 × 600 mm', length: 600, width: 300, perBox: 6, joint: 3, gap: 6 },
  'tile-300x300': { kind: 'tile', units: 'metric', name: 'Tile 300 × 300 mm', length: 300, width: 300, perBox: 11, joint: 3, gap: 6 },
  'tile-600x600': { kind: 'tile', units: 'metric', name: 'Tile 600 × 600 mm', length: 600, width: 600, perBox: 4, joint: 3, gap: 6 },
  'tile-200x1200': { kind: 'tile', units: 'metric', name: 'Plank tile 200 × 1200 mm', length: 1200, width: 200, perBox: 6, joint: 3, gap: 6, offset: 1 / 3 },
  'ply-4x8': { kind: 'subfloor', units: 'imperial', name: 'Plywood / OSB 4\' × 8\'', length: 8 * MM_PER_FT, width: 4 * MM_PER_FT, perBox: 1, unit: 'sheet', joint: IN / 8, gap: 0.25 * IN, offset: 1 / 2, minCut: 24 * IN },
  'panel-2x2': { kind: 'subfloor', units: 'imperial', name: 'Basement panel 2\' × 2\' (DRIcore type)', length: 2 * MM_PER_FT, width: 2 * MM_PER_FT, perBox: 1, unit: 'panel', joint: 0, gap: 0.25 * IN, offset: 0 },
  'membrane-6.5x65': { kind: 'subfloor', units: 'imperial', name: 'Dimple membrane roll 6\' 6" × 65\'', length: 65 * MM_PER_FT, width: 78 * IN, perBox: 1, unit: 'roll', joint: 0, gap: 0, offset: 0, minCut: 12 * IN },
  'ply-1220x2440': { kind: 'subfloor', units: 'metric', name: 'Plywood / OSB 1220 × 2440 mm', length: 2440, width: 1220, perBox: 1, unit: 'sheet', joint: 3, gap: 6, offset: 1 / 2, minCut: 600 },
  'panel-600x600': { kind: 'subfloor', units: 'metric', name: 'Basement panel 600 × 600 mm', length: 600, width: 600, perBox: 1, unit: 'panel', joint: 0, gap: 6, offset: 0 },
  'membrane-2x20': { kind: 'subfloor', units: 'metric', name: 'Dimple membrane roll 2 × 20 m', length: 20000, width: 2000, perBox: 1, unit: 'roll', joint: 0, gap: 0, offset: 0, minCut: 300 },
};

/** Presets of a kind, the plan's unit system first. */
export function presetsFor(kind, units) {
  const all = Object.entries(FLOOR_PRESETS).filter(([, p]) => p.kind === kind);
  return [...all.filter(([, p]) => p.units === units), ...all.filter(([, p]) => p.units !== units)];
}

/** Run fields for a preset (sizes, joint, stagger, carton, gap). */
export function presetFields(key, units) {
  const p = FLOOR_PRESETS[key];
  const metric = units === 'metric';
  return {
    preset: key,
    length: p.length,
    width: p.width,
    joint: p.joint ?? 0,
    perBox: p.perBox,
    unit: p.unit ?? 'box',
    gap: p.gap,
    minCut: p.minCut ?? null,
    stagger: p.kind === 'plank'
      ? { mode: 'random', offset: p.length / 3, min: p.stagger ?? (metric ? 150 : 6 * IN), seed: 1 }
      : { mode: 'fixed', offset: p.length * (p.offset ?? 0), min: metric ? 150 : 6 * IN, seed: 1 },
  };
}

export function runDefaults(kind, units) {
  const k = FLOOR_KINDS[kind] ? kind : 'plank';
  return {
    kind: k,
    name: FLOOR_KINDS[k].label,
    waste: 5,
    angle: 0,
    origin: { x: 0, y: 0 },
    roomIds: [],
    ...presetFields(presetsFor(k, units)[0][0], units),
  };
}

const finite = (v, lo = -Infinity) => Number.isFinite(v) && v >= lo;

/** A run with every field present and in range. */
export function resolveRun(run, units) {
  const def = runDefaults(run?.kind, units);
  const st = { ...def.stagger, ...(run?.stagger ?? {}) };
  const r = { ...def, ...run, kind: def.kind };
  r.length = finite(r.length, 10) ? r.length : def.length;
  r.width = finite(r.width, 10) ? r.width : def.width;
  r.joint = finite(r.joint, 0) ? r.joint : def.joint;
  r.gap = finite(r.gap, 0) ? r.gap : def.gap;
  r.perBox = finite(r.perBox, 1) ? r.perBox : def.perBox;
  r.waste = finite(r.waste, 0) ? r.waste : def.waste;
  r.angle = finite(r.angle) ? r.angle : 0;
  r.minCut = finite(r.minCut, 0) && r.minCut > 0 ? r.minCut : null;
  r.unit = BUY_UNITS[r.unit] ? r.unit : def.unit;
  r.origin = finite(r.origin?.x) && finite(r.origin?.y) ? r.origin : { x: 0, y: 0 };
  r.stagger = {
    mode: st.mode === 'random' ? 'random' : 'fixed',
    offset: finite(st.offset) ? st.offset : 0,
    min: finite(st.min, 0) ? st.min : def.stagger.min,
    seed: Number.isInteger(st.seed) ? st.seed : 1,
  };
  r.layer = FLOOR_KINDS[r.kind].layer;
  r.units = units;
  return r;
}

/** Cleans design.floorRuns loaded from storage. */
export function sanitizeFloorRuns(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((r) => r && typeof r.id === 'string' && FLOOR_KINDS[r.kind] && Array.isArray(r.roomIds))
    .map((r) => ({ ...r, roomIds: r.roomIds.filter((id) => typeof id === 'string') }));
}

/**
 * Keeps runs in step with the rooms: deleted rooms and dead space leave their runs, a room
 * is in at most one run per layer (the first one listing it), and runs left
 * without rooms are removed.
 */
export function syncFloorRuns(d) {
  const alive = new Set(d.rooms.filter((r) => !r.dead).map((r) => r.id));
  const taken = { finish: new Set(), subfloor: new Set() };
  d.floorRuns = (d.floorRuns ?? []).filter((run) => {
    const used = taken[FLOOR_KINDS[run.kind].layer];
    run.roomIds = [...new Set(run.roomIds)].filter((id) => alive.has(id) && !used.has(id));
    run.roomIds.forEach((id) => used.add(id));
    return run.roomIds.length > 0;
  });
}

export const runLayer = (run) => FLOOR_KINDS[run.kind]?.layer ?? 'finish';

/** The run covering a room on a layer, or null. */
export function roomRun(d, roomId, layer) {
  return (d.floorRuns ?? []).find((r) => runLayer(r) === layer && r.roomIds.includes(roomId)) ?? null;
}

/**
 * Moves rooms into a run (out of any other run on the same layer). Call
 * normalize() afterwards, which drops runs left empty.
 */
export function assignRooms(d, runId, roomIds) {
  const run = d.floorRuns.find((r) => r.id === runId);
  if (!run) return;
  const layer = runLayer(run);
  for (const other of d.floorRuns) {
    if (other !== run && runLayer(other) === layer) other.roomIds = other.roomIds.filter((id) => !roomIds.includes(id));
  }
  run.roomIds = [...new Set([...run.roomIds, ...roomIds])];
}

/**
 * Adds a run of `kind` over the rooms, aimed along the longest wall of the
 * first room (or across the joists for subfloor sheets and nailed hardwood)
 * with its origin placed by bestFit(). Returns the run.
 */
export function createRun(d, kind, roomIds, analysis = analyze(d)) {
  const def = runDefaults(kind, d.units);
  const n = d.floorRuns.filter((r) => r.kind === def.kind).length + 1;
  const run = { id: uid('f'), ...def, name: `${FLOOR_KINDS[def.kind].label} ${n}`, roomIds: [] };
  const g = analysis.rooms.find((x) => x.room && roomIds.includes(x.room.id));
  if (g) {
    const longest = [...g.walls].sort((a, b) => b.length - a.length)[0];
    run.angle = longest && Math.abs(longest.dir.x) < Math.abs(longest.dir.y) ? 90 : 0;
    const joists = d.settings.joists;
    if (joists && (run.unit === 'sheet' || FLOOR_PRESETS[run.preset]?.nailed)) run.angle = joists === 'EW' ? 90 : 0;
    run.origin = { x: g.polygon[0].x, y: g.polygon[0].y };
  }
  d.floorRuns.push(run);
  assignRooms(d, run.id, roomIds);
  if (g) run.origin = bestFit(d, run, analysis);
  return run;
}

// ---------------------------------------------------------------------------
// Region

/** A rectangle polygon from a centre, two unit axes and half extents. */
function box(c, a, b, ha, hb) {
  return [
    add(add(c, scale(a, -ha)), scale(b, -hb)),
    add(add(c, scale(a, ha)), scale(b, -hb)),
    add(add(c, scale(a, ha)), scale(b, hb)),
    add(add(c, scale(a, -ha)), scale(b, hb)),
  ];
}

/**
 * The floor a run covers: each room's interior inset by the expansion gap,
 * plus a threshold strip through every door or cased opening between two of
 * its rooms (so the run carries through the doorway). Traffic zones are the
 * thresholds and the approach in front of every doorway of its rooms.
 */
export function runRegion(d, run, analysis = analyze(d)) {
  const r = run.layer ? run : resolveRun(run, d.units);
  const geoms = analysis.rooms.filter((g) => g.room && r.roomIds.includes(g.room.id));
  const parts = [];
  for (const g of geoms) {
    const poly = r.gap > 0 ? offsetPolygon(g.polygon, r.gap) : g.polygon;
    if (polygonArea(poly) > 0) parts.push({ kind: 'room', roomId: g.room.id, name: g.room.name, polygon: poly, geom: g });
  }
  const inRun = new Set(geoms);
  const zones = [];
  for (const o of d.openings) {
    if (o.type === 'window') continue;
    const info = analysis.wallInfo.get(o.wallId);
    const [a, b] = info?.roomSides ?? [];
    if (!a || !b || a === b || !inRun.has(a) || !inRun.has(b)) continue;
    const w = info.wall;
    const A = analysis.idx.nodes.get(w.a);
    const B = analysis.idx.nodes.get(w.b);
    const u = scale(sub(B, A), 1 / Math.hypot(B.x - A.x, B.y - A.y));
    const c = add(A, scale(u, o.offset));
    const polygon = box(c, u, perp(u), o.width / 2, w.thickness / 2 + r.gap);
    parts.push({ kind: 'threshold', roomId: a.room.id, roomIds: [a.room.id, b.room.id], opening: o, polygon });
    zones.push(polygon);
  }
  for (const g of geoms) {
    for (const face of g.walls) {
      for (const op of face.openings) {
        if (op.opening.type === 'window') continue;
        const s0 = Math.max(0, op.s0);
        const s1 = Math.min(face.length, op.s1);
        if (s1 <= s0) continue;
        const inward = perp(face.dir);
        const c = add(add(face.P, scale(face.dir, (s0 + s1) / 2)), scale(inward, TRAFFIC_DEPTH / 2));
        zones.push(box(c, face.dir, inward, (s1 - s0) / 2, TRAFFIC_DEPTH / 2));
      }
    }
  }
  return { run: r, geoms, parts, zones };
}

// ---------------------------------------------------------------------------
// Pattern

const mod = (a, m) => ((a % m) + m) % m;
const circ = (a, b, m) => {
  const x = mod(a - b, m);
  return Math.min(x, m - x);
};

function hash01(seed, j, k) {
  let h = (Math.imul(seed | 0, 374761393) + Math.imul(j | 0, 668265263) + Math.imul(k | 0, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Fixed stagger: course j's joints are shifted j·offset (course 0 at 0). */
export function courseOffsets(r) {
  const pu = r.length + r.joint;
  return (j) => mod(j * r.stagger.offset, pu);
}

/** The u extents where a course strip [v0, v1] crosses the floor, touching parts (room + threshold) merged. */
function courseIntervals(parts, v0, v1) {
  const list = [];
  for (const p of parts) {
    if (p.box.v0 >= v1 || p.box.v1 <= v0) continue;
    const c = clipToRect(p.uv, p.box.u0 - 1, v0, p.box.u1 + 1, v1);
    if (c.length < 3) continue;
    const b = polyBounds(c);
    list.push({ a: b.u0, b: b.u1 });
  }
  list.sort((p, q) => p.a - q.a);
  const out = [];
  for (const iv of list) {
    const last = out[out.length - 1];
    if (last && iv.a <= last.b + TOL) last.b = Math.max(last.b, iv.b);
    else out.push({ ...iv });
  }
  return out;
}

/**
 * Random stagger, row by row as an installer lays it: each course takes the
 * first seeded offset whose end pieces at the walls are at least the minimum
 * end cut, whose joints stay `min` from the row before and half that from two
 * rows back (no H-joints); failing that, the candidate breaking the fewest.
 */
function randomOffsets(r, parts, j0, j1, pv, lim) {
  const pu = r.length + r.joint;
  const minD = Math.min(r.stagger.min, pu * 0.3);
  const minEnd = Math.min(lim.end.sliver, pu * 0.25);
  const offs = new Map();
  for (let j = j0; j <= j1; j++) {
    const intervals = courseIntervals(parts, j * pv, j * pv + r.width).filter((iv) => iv.b - iv.a >= 2 * minEnd + r.joint);
    const prev = offs.get(j - 1);
    const prev2 = offs.get(j - 2);
    let best = null;
    for (let k = 0; k < 32; k++) {
      const c = hash01(r.stagger.seed, j, k) * pu;
      let bad = 0;
      if (prev != null && circ(c, prev, pu) < minD) bad += 4;
      if (prev2 != null && circ(c, prev2, pu) < minD / 2) bad += 2;
      for (const { a, b } of intervals) {
        const start = mod(c - a, pu) - r.joint; // first piece, from the wall at a to the first joint
        const end = mod(b - c, pu); // last piece, from the last joint to the wall at b
        if (start > 1e-6 && start < minEnd) bad++;
        if (end > 1e-6 && end < minEnd) bad++;
      }
      if (!best || bad < best.bad) best = { c, bad };
      if (!bad) break;
    }
    offs.set(j, best.c);
  }
  return (j) => offs.get(j) ?? 0;
}

/** Sutherland–Hodgman: polygon {x: u, y: v} clipped to the rectangle [u0,u1]×[v0,v1]. */
function clipToRect(poly, u0, v0, u1, v1) {
  let out = poly;
  for (const [axis, val, keepAbove] of [['x', u0, true], ['x', u1, false], ['y', v0, true], ['y', v1, false]]) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const p = input[i];
      const q = input[(i + 1) % input.length];
      const pin = keepAbove ? p[axis] >= val : p[axis] <= val;
      const qin = keepAbove ? q[axis] >= val : q[axis] <= val;
      if (pin) out.push(p);
      if (pin !== qin) {
        const t = (val - p[axis]) / (q[axis] - p[axis]);
        out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
      }
    }
    if (out.length < 3) return [];
  }
  return out;
}

/** World ↔ pattern transforms for a run at an origin: u along the run, v across it. */
export function patternFrame(r, origin = r.origin) {
  const a = (r.angle * Math.PI) / 180;
  const dir = { x: Math.round(Math.cos(a) * 1e12) / 1e12, y: Math.round(Math.sin(a) * 1e12) / 1e12 };
  const nrm = perp(dir);
  return {
    dir, nrm, origin,
    pu: r.length + r.joint,
    pv: r.width + r.joint,
    toUV: (p) => {
      const q = sub(p, origin);
      return { x: dot(q, dir), y: dot(q, nrm) };
    },
    toXY: (u, v) => add(origin, add(scale(dir, u), scale(nrm, v))),
  };
}

/** Smallest acceptable cut along the length (end) and across the width (rip): sliver below, warning below `warn`. */
export function cutLimits(r) {
  const tileLimit = (D) => ({ sliver: Math.max(D / 4, Math.min(50, D / 2)), warn: D / 2 });
  if (r.kind === 'tile') {
    const end = tileLimit(r.length);
    const rip = tileLimit(r.width);
    if (r.minCut) end.sliver = rip.sliver = r.minCut;
    return { end, rip };
  }
  if (r.kind === 'plank') {
    const end = r.minCut ?? (r.units === 'metric' ? 150 : 6 * IN);
    return { end: { sliver: end, warn: end }, rip: { sliver: r.width / 3, warn: r.width / 2 } };
  }
  const end = r.minCut ?? r.length / 4;
  return { end: { sliver: end, warn: end }, rip: { sliver: r.width / 4, warn: r.width / 4 } };
}

const boxesTouch = (a, b) => a.u0 <= b.u1 + TOL && b.u0 <= a.u1 + TOL && a.v0 <= b.v1 + TOL && b.v0 <= a.v1 + TOL;

function polyBounds(poly) {
  const b = bounds(poly);
  return { u0: b.minX, v0: b.minY, u1: b.maxX, v1: b.maxY };
}

/**
 * Places every piece of the pattern over the region and clips it. Each
 * physical piece (fragments that touch, e.g. across a threshold) records its
 * cut extent in piece axes (needL × needW), area, rooms and whether it lies
 * in a threshold or a traffic zone, and is graded full / cut / warn / sliver.
 */
function placePieces(r, region, frame) {
  const { pu, pv } = frame;
  const L = r.length;
  const W = r.width;
  const parts = region.parts.map((p) => {
    const uv = p.polygon.map(frame.toUV);
    return { ...p, uv, box: polyBounds(uv) };
  });
  const zones = region.zones.map((z) => {
    const uv = z.map(frame.toUV);
    return { uv, box: polyBounds(uv) };
  });
  const rooms = parts.filter((p) => p.kind === 'room');
  if (!rooms.length) return { parts, zones, pieces: [], extent: null, truncated: false, offset: courseOffsets(r) };
  const all = polyBounds(parts.flatMap((p) => p.uv));
  const extent = polyBounds(rooms.flatMap((p) => p.uv));
  const lim = cutLimits(r);
  const pieces = [];
  let truncated = false;
  const j0 = Math.floor(all.v0 / pv);
  const j1 = Math.floor(all.v1 / pv);
  const offset = r.stagger.mode === 'random' ? randomOffsets(r, parts, j0, j1, pv, lim) : courseOffsets(r);
  for (let j = j0; j <= j1 && !truncated; j++) {
    const v0 = j * pv;
    const v1 = v0 + W;
    if (v1 <= all.v0 + 1e-6 || v0 >= all.v1 - 1e-6) continue;
    const rowParts = parts.filter((p) => p.box.v0 < v1 && p.box.v1 > v0);
    if (!rowParts.length) continue;
    const off = offset(j);
    const i0 = Math.floor((all.u0 - off) / pu);
    const i1 = Math.floor((all.u1 - off) / pu);
    for (let i = i0; i <= i1; i++) {
      const u0 = off + i * pu;
      const u1 = u0 + L;
      const frags = [];
      for (const p of rowParts) {
        if (p.box.u0 >= u1 || p.box.u1 <= u0) continue;
        const clipped = clipToRect(p.uv, u0, v0, u1, v1);
        if (clipped.length < 3) continue;
        const area = Math.abs(polygonArea(clipped));
        if (area < 1) continue;
        frags.push({ part: p, area, box: polyBounds(clipped) });
      }
      if (!frags.length) continue;
      // Fragments that touch are one piece (room + threshold); others are separate cuts from the same cell.
      const groups = [];
      for (const f of frags) {
        const hit = groups.filter((g) => g.frags.some((x) => boxesTouch(x.box, f.box)));
        const merged = { frags: [f, ...hit.flatMap((g) => g.frags)] };
        for (const g of hit) groups.splice(groups.indexOf(g), 1);
        groups.push(merged);
      }
      for (const g of groups) {
        const cut = g.frags.reduce((b, f) => ({
          u0: Math.min(b.u0, f.box.u0), v0: Math.min(b.v0, f.box.v0), u1: Math.max(b.u1, f.box.u1), v1: Math.max(b.v1, f.box.v1),
        }), { u0: Infinity, v0: Infinity, u1: -Infinity, v1: -Infinity });
        const area = g.frags.reduce((s, f) => s + f.area, 0);
        pieces.push(gradePiece({
          j, i, u0, v0, u1, v1, cut, area,
          needL: Math.min(L, cut.u1 - cut.u0),
          needW: Math.min(W, cut.v1 - cut.v0),
          roomIds: [...new Set(g.frags.map((f) => f.part.roomId))],
          threshold: g.frags.some((f) => f.part.kind === 'threshold'),
          traffic: zones.some((z) => z.box.u0 < cut.u1 && z.box.u1 > cut.u0 && z.box.v0 < cut.v1 && z.box.v1 > cut.v0
            && clipToRect(z.uv, cut.u0, cut.v0, cut.u1, cut.v1).length >= 3),
        }, L, W, lim));
      }
      if (pieces.length > MAX_PIECES) {
        truncated = true;
        break;
      }
    }
  }
  return { parts, zones, pieces, extent, truncated, offset };
}

function gradePiece(p, L, W, lim) {
  p.lenCut = p.needL < L - TOL;
  p.widCut = p.needW < W - TOL;
  p.full = !p.lenCut && !p.widCut && p.area >= L * W - TOL * (L + W);
  p.grade = p.full ? 'full' : 'cut';
  const rank = { full: 0, cut: 1, warn: 2, sliver: 3 };
  const worse = (g) => {
    if (rank[g] > rank[p.grade]) p.grade = g;
  };
  if (p.lenCut) {
    if (p.needL < lim.end.sliver - 1e-6) worse('sliver');
    else if (p.needL < lim.end.warn - 1e-6) worse('warn');
  }
  if (p.widCut) {
    if (p.needW < lim.rip.sliver - 1e-6) worse('sliver');
    else if (p.needW < lim.rip.warn - 1e-6) worse('warn');
  }
  return p;
}

/**
 * First and last course widths across the room(s) (at the walls the courses
 * start and end against), and for a straight grid the first and last column.
 */
function courseEnds(r, frame, extent) {
  const ends = (lo, hi, pitch, size) => {
    let j0 = Math.floor(lo / pitch);
    let first = Math.min(size, j0 * pitch + size - lo);
    if (first <= TOL) {
      j0++;
      first = Math.min(size, hi - j0 * pitch);
    }
    const j1 = Math.floor(hi / pitch);
    let last = Math.min(size, hi - j1 * pitch);
    if (j1 === j0) last = first;
    else if (last <= TOL) last = size; // the far wall falls in a joint
    return { first: Math.max(0, first), last: Math.max(0, last), courses: j1 - j0 + 1 };
  };
  const v = ends(extent.v0, extent.v1, frame.pv, r.width);
  const grid = r.stagger.mode === 'fixed' && circ(r.stagger.offset, 0, frame.pu) < TOL;
  const u = grid ? ends(extent.u0, extent.u1, frame.pu, r.length) : null;
  return {
    v, u,
    vFrom: compassName(scale(frame.nrm, -1)),
    vTo: compassName(frame.nrm),
    uFrom: compassName(scale(frame.dir, -1)),
    uTo: compassName(frame.dir),
  };
}

/** Penalty used by bestFit(): slivers dominate, then warnings, traffic triples both, then balance. */
function scorePieces(r, pieces, ends) {
  const lim = cutLimits(r);
  const pen = (c, l) => {
    if (c < l.sliver) return 10 + 10 * (1 - c / l.sliver);
    if (c < l.warn) return (2 * (l.warn - c)) / Math.max(1e-6, l.warn - l.sliver);
    return 0;
  };
  let s = pieces.length * 0.01;
  for (const p of pieces) {
    if (p.grade === 'full') continue;
    const k = p.traffic ? 3 : 1;
    if (p.lenCut) s += k * pen(p.needL, lim.end);
    if (p.widCut) s += k * pen(p.needW, lim.rip);
  }
  if (ends) {
    s += (0.5 * Math.abs(ends.v.first - ends.v.last)) / r.width;
    if (ends.u) s += (0.5 * Math.abs(ends.u.first - ends.u.last)) / r.length;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Takeoff

/**
 * Stock needed for the cuts, reusing offcuts: largest cut first, each taken
 * from the smallest leftover it fits, else a new piece. Plank offcuts are
 * reused along their length only (rips lose the profile) and only when long
 * enough for an end piece; tile and panel offcuts both ways.
 */
function packCuts(r, pieces) {
  const L = r.length;
  const W = r.width;
  const lim = cutLimits(r);
  const roll = r.unit === 'roll';
  const kerf = roll ? 0 : KERF;
  const reuseL = r.kind === 'plank' ? lim.end.sliver : roll ? Math.min(300, L) : 25;
  const reuseW = 25;
  let stock = 0;
  const pool = [];
  const cuts = [];
  for (const p of pieces) {
    if (p.full) stock++;
    else cuts.push(p);
  }
  cuts.sort((a, b) => b.needL * b.needW - a.needL * a.needW || b.needL - a.needL);
  let reused = 0;
  for (const c of cuts) {
    let best = -1;
    for (let k = 0; k < pool.length; k++) {
      const o = pool[k];
      if (o.l >= c.needL - TOL && o.w >= c.needW - TOL && (best < 0 || o.l * o.w < pool[best].l * pool[best].w)) best = k;
    }
    let item;
    if (best >= 0) {
      item = pool.splice(best, 1)[0];
      reused++;
    } else {
      stock++;
      item = { l: L, w: W };
    }
    const lenLeft = item.l - c.needL - kerf;
    if (lenLeft >= reuseL) pool.push({ l: lenLeft, w: item.w });
    const widLeft = item.w - c.needW - kerf;
    if (r.kind !== 'plank' && widLeft >= reuseW) pool.push({ l: Math.min(c.needL, item.l), w: widLeft });
  }
  return { stock, reused };
}

/** Pieces, order quantity with the waste allowance, boxes and areas for a laid-out run. */
function runMaterial(r, pieces) {
  const { stock, reused } = packCuts(r, pieces);
  const pieceArea = r.length * r.width;
  const order = Math.ceil(stock * (1 + r.waste / 100) - 1e-9);
  const boxes = Math.ceil(order / r.perBox - 1e-9);
  const netArea = pieces.reduce((s, p) => s + p.area, 0);
  return {
    stock,
    reused,
    order,
    boxes,
    buy: boxes * r.perBox,
    netArea,
    coverage: boxes * r.perBox * pieceArea,
    boxArea: r.perBox * pieceArea,
    cutWaste: stock ? Math.max(0, 1 - netArea / (stock * pieceArea)) : 0,
  };
}

// ---------------------------------------------------------------------------
// Layout

/** Joint spacing between neighbouring rows (and two rows apart) over the courses laid. */
function jointStagger(frame, pieces, offset) {
  if (!pieces.length) return null;
  const js = pieces.map((p) => p.j);
  const lo = Math.min(...js);
  const hi = Math.max(...js);
  let adjacent = Infinity;
  let twoRows = Infinity;
  for (let j = lo; j < hi; j++) {
    adjacent = Math.min(adjacent, circ(offset(j), offset(j + 1), frame.pu));
    if (j + 2 <= hi) twoRows = Math.min(twoRows, circ(offset(j), offset(j + 2), frame.pu));
  }
  return { adjacent, twoRows };
}

/**
 * Full layout of a run: region, pattern frame, every clipped piece with its
 * grade, course widths at the walls, cut statistics, the material takeoff
 * and install guidance. opts.origin overrides the run's origin (previews).
 */
export function layoutRun(d, run, opts = {}) {
  const analysis = opts.analysis ?? analyze(d);
  const r = resolveRun(run, d.units);
  const region = runRegion(d, r, analysis);
  const frame = patternFrame(r, opts.origin ?? r.origin);
  const placed = placePieces(r, region, frame);
  const pieces = placed.pieces;
  const ends = placed.extent ? courseEnds(r, frame, placed.extent) : null;
  const count = (fn) => pieces.filter(fn).length;
  const cuts = pieces.filter((p) => !p.full);
  const minOf = (list, key) => list.reduce((best, p) => (!best || p[key] < best[key] ? p : best), null);
  const stats = {
    pieces: pieces.length,
    full: count((p) => p.full),
    cut: cuts.length,
    warn: count((p) => p.grade === 'warn'),
    slivers: count((p) => p.grade === 'sliver'),
    trafficIssues: count((p) => p.traffic && (p.grade === 'sliver' || p.grade === 'warn')),
    thresholdIssues: count((p) => p.threshold && (p.grade === 'sliver' || p.grade === 'warn')),
    shortestEnd: minOf(cuts.filter((p) => p.lenCut), 'needL'),
    narrowestRip: minOf(cuts.filter((p) => p.widCut), 'needW'),
    joints: r.kind === 'tile' && !(r.stagger.mode === 'fixed' && circ(r.stagger.offset, 0, frame.pu) > TOL) ? null : jointStagger(frame, pieces, placed.offset),
    span: placed.extent ? { u: placed.extent.u1 - placed.extent.u0, v: placed.extent.v1 - placed.extent.v0 } : { u: 0, v: 0 },
  };
  const layout = {
    run: r, region, frame, parts: placed.parts, zones: placed.zones, pieces, ends, stats,
    extent: placed.extent, truncated: placed.truncated, limits: cutLimits(r),
    material: runMaterial(r, pieces),
  };
  layout.score = scorePieces(r, pieces, ends);
  layout.guidance = installGuidance(d, layout, analysis);
  return layout;
}

/** Score of the run's layout at a given origin (lower is better). */
function scoreAt(r, region, origin) {
  const frame = patternFrame(r, origin);
  const placed = placePieces(r, region, frame);
  if (!placed.extent) return Infinity;
  return scorePieces(r, placed.pieces, courseEnds(r, frame, placed.extent));
}

/**
 * The origin giving the cleanest layout: no slivers (above all in doorways
 * and traffic paths), cuts of at least half a piece where possible, then
 * balanced first and last courses. Searches the phase across the courses,
 * then along them, then refines both; candidates include courses flush with
 * a wall and centred courses.
 */
export function bestFit(d, run, analysis = analyze(d)) {
  const r = resolveRun(run, d.units);
  const region = runRegion(d, r, analysis);
  const rooms = region.parts.filter((p) => p.kind === 'room');
  if (!rooms.length) return r.origin;
  let origin = r.origin;
  const { dir, nrm, pu, pv } = patternFrame(r, origin);
  const extent = () => {
    const f = patternFrame(r, origin);
    return polyBounds(rooms.flatMap((p) => p.polygon.map(f.toUV)));
  };
  // Moving the origin by `shift` along an axis moves every course line by the same amount.
  const search = (along, shifts) => {
    let best = { s: Infinity, shift: 0 };
    for (const shift of shifts) {
      const s = scoreAt(r, region, add(origin, scale(along, shift)));
      if (s < best.s - 1e-9) best = { s, shift };
    }
    origin = add(origin, scale(along, best.shift));
  };
  // Course flush with the low wall, flush with the high wall, a piece centred, a joint centred; then a sweep.
  const coarse = (pitch, size, lo, hi) => [
    mod(lo, pitch), mod(hi - size, pitch), mod((lo + hi - size) / 2, pitch), mod((lo + hi + r.joint) / 2, pitch),
    ...Array.from({ length: 24 }, (_, k) => (pitch * k) / 24),
  ];
  const fine = (pitch) => Array.from({ length: 9 }, (_, k) => ((k - 4) * pitch) / 48);
  let e = extent();
  search(nrm, coarse(pv, r.width, e.v0, e.v1));
  e = extent();
  search(dir, coarse(pu, r.length, e.u0, e.u1));
  search(nrm, fine(pv));
  search(dir, fine(pu));
  return { x: Math.round(origin.x * 10) / 10, y: Math.round(origin.y * 10) / 10 };
}

/**
 * Origin putting a tile centre ('tile') or a grout-joint crossing ('joint')
 * at the centre of the run's largest room.
 */
export function centredOrigin(d, run, mode, analysis = analyze(d)) {
  const r = resolveRun(run, d.units);
  const g = analysis.rooms.filter((x) => x.room && r.roomIds.includes(x.room.id)).sort((a, b) => b.area - a.area)[0];
  if (!g) return r.origin;
  const f = patternFrame(r);
  const b = polyBounds(g.polygon.map(f.toUV));
  const c = f.toXY((b.u0 + b.u1) / 2, (b.v0 + b.v1) / 2);
  return mode === 'joint'
    ? add(c, add(scale(f.dir, r.joint / 2), scale(f.nrm, r.joint / 2)))
    : sub(c, add(scale(f.dir, r.length / 2), scale(f.nrm, r.width / 2)));
}

/**
 * Snaps a dragged origin so a course edge or piece end passes through a
 * corner of the floor (within `tol` mm), or a piece centre / joint through a
 * room centre. Returns { origin, targets: [point] } (what it snapped to).
 */
export function snapOrigin(layout, origin, tol) {
  const r = layout.run;
  const f = patternFrame(r, origin);
  const offset = courseOffsets(r);
  const corners = layout.region.parts.flatMap((p) => p.polygon);
  const centres = layout.region.geoms.map((g) => {
    const b = bounds(g.polygon);
    return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  });
  const grid = r.stagger.mode === 'fixed' && circ(r.stagger.offset, 0, f.pu) < TOL;
  let bestV = null;
  let bestU = null;
  const consider = (p, lines) => {
    const { x: u, y: v } = f.toUV(p);
    for (const line of lines.v) {
      const s = mod(v - line + f.pv / 2, f.pv) - f.pv / 2;
      if (Math.abs(s) <= tol && (!bestV || Math.abs(s) < Math.abs(bestV.s))) bestV = { s, p };
    }
    const off = offset(Math.floor(v / f.pv));
    for (const line of lines.u) {
      const s = mod(u - off - line + f.pu / 2, f.pu) - f.pu / 2;
      if (Math.abs(s) <= tol && (!bestU || Math.abs(s) < Math.abs(bestU.s))) bestU = { s, p };
    }
  };
  for (const p of corners) consider(p, { v: [0, r.width], u: r.stagger.mode === 'random' ? [] : [0, r.length] });
  const mid = { v: [r.width / 2, r.width + r.joint / 2], u: grid ? [r.length / 2, r.length + r.joint / 2] : [] };
  for (const p of centres) consider(p, mid);
  let o = origin;
  if (bestV) o = add(o, scale(f.nrm, bestV.s));
  if (bestU) o = add(o, scale(f.dir, bestU.s));
  return { origin: o, targets: [bestV?.p, bestU?.p].filter(Boolean) };
}

/** The run (on `layer`, if given) whose floor contains a plan point. */
export function runAtPoint(d, p, analysis = analyze(d), layer = null) {
  const g = analysis.rooms.filter((x) => x.room && pointInPolygon(p, x.polygon)).sort((a, b) => a.area - b.area)[0];
  const runs = (d.floorRuns ?? []).filter((r) => !layer || runLayer(r) === layer);
  if (g) return runs.find((r) => r.roomIds.includes(g.room.id)) ?? null;
  // In a doorway between two rooms of a run.
  for (const run of runs) {
    const { parts } = runRegion(d, resolveRun(run, d.units), analysis);
    if (parts.some((pt) => pt.kind === 'threshold' && pointInPolygon(p, pt.polygon))) return run;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Install guidance

/** Axis ('EW' | 'NS' | null for a diagonal) of a direction or an angle in degrees. */
function axisOf(angle) {
  const a = mod(angle, 180);
  if (a < 1 || a > 179) return 'EW';
  if (Math.abs(a - 90) < 1) return 'NS';
  return null;
}

const AXIS_NAME = { EW: 'east–west', NS: 'north–south' };

/**
 * Industry-standard recommendations for the run's flooring type, each
 * checked against this layout where it can be:
 *   [{ status: 'ok' | 'warn' | 'info', title, text }]
 * Figures are the usual published ones (NWFA, ANSI A108 / TCNA, APA); the
 * product maker's instructions take precedence.
 */
export function installGuidance(d, layout, analysis = analyze(d)) {
  const r = layout.run;
  const u = d.units;
  const L = (mm) => formatLength(mm, u, { precision: 'label' });
  const metric = u === 'metric';
  const s = layout.stats;
  const out = [];
  const note = (status, title, text) => out.push({ status, title, text });
  const axis = axisOf(r.angle);
  const ends = layout.ends;
  const piece = FLOOR_KINDS[r.kind].piece;

  // Daylight: the wall with the most window width sets the light direction.
  const light = { EW: 0, NS: 0 };
  for (const g of layout.region.geoms) {
    for (const face of g.walls) {
      const glass = face.openings.filter((op) => op.opening.type === 'window').reduce((sum, op) => sum + op.opening.width, 0);
      if (glass) light[Math.abs(face.outward.x) > Math.abs(face.outward.y) ? 'EW' : 'NS'] += glass;
    }
  }
  const lightAxis = light.EW || light.NS ? (light.EW >= light.NS ? 'EW' : 'NS') : null;
  const ext = layout.region.geoms.length ? bounds(layout.region.geoms.flatMap((g) => g.polygon)) : null;
  const longAxis = ext ? (ext.width >= ext.height ? 'EW' : 'NS') : null;
  const joists = d.settings.joists || null;

  const sliverCheck = () => {
    if (!s.slivers && !s.trafficIssues) {
      note('ok', 'No slivers', `Every cut is at least ${L(layout.limits.end.sliver)} long and ${L(layout.limits.rip.sliver)} wide, including doorways and traffic paths.`);
      return;
    }
    const where = s.trafficIssues ? ` ${s.trafficIssues} of the small cuts ${s.trafficIssues === 1 ? 'is' : 'are'} in a doorway or traffic path, where they break loose first.` : '';
    note('warn', 'Slivers', `${s.slivers} cut${s.slivers === 1 ? '' : 's'} below the minimum (red on the plan).${where} Drag the layout or use Best fit.`);
  };

  const courseCheck = (size, label) => {
    if (!ends) return;
    const { first, last, courses } = ends.v;
    const text = `First ${label} at the ${ends.vFrom.toLowerCase()} wall ${L(first)}, last at the ${ends.vTo.toLowerCase()} wall ${L(last)} (${courses} rows).`;
    if (Math.min(first, last) >= size / 2 - TOL) note('ok', 'Balanced first and last rows', `${text} Both are at least half a ${piece}.`);
    else note('warn', 'Narrow first or last row', `${text} Aim for at least half a ${piece} (${L(size / 2)}) at both walls: rip the first row so both match. Best fit does this.`);
  };

  if (r.kind === 'plank') {
    if (lightAxis) {
      note(axis === lightAxis ? 'ok' : 'warn', 'Direction and light',
        `The main windows face ${AXIS_NAME[lightAxis]}. Boards running toward the light (${AXIS_NAME[lightAxis]}) hide the seams${axis === lightAxis ? '; this run does' : '; rotate the run 90°'}.`);
    } else if (longAxis) {
      note(axis === longAxis ? 'ok' : 'info', 'Direction', `Boards usually look best along the longest dimension of the space (${AXIS_NAME[longAxis]}) and the main sightline from the entry.`);
    }
    if (FLOOR_PRESETS[r.preset]?.nailed) {
      if (joists) {
        const across = axis && axis !== joists;
        note(across ? 'ok' : 'warn', 'Joists', across
          ? 'Nail-down hardwood runs across the floor joists, as the NWFA recommends.'
          : `The joists run ${AXIS_NAME[joists]}. Run nail-down hardwood across them, or add a ${metric ? '12 mm' : '1/2"'} plywood layer (or blocking) to run parallel.`);
      } else note('info', 'Joists', 'Nail-down hardwood should run across the floor joists (NWFA). Set the joist direction below to check this.');
    } else note('info', 'Joists', 'Floating vinyl plank and laminate can run either way over joists or slab.');
    const minStagger = r.stagger.min;
    const j = s.joints;
    if (j && Number.isFinite(j.adjacent)) {
      const tight = j.adjacent < minStagger - TOL;
      const hJoint = Number.isFinite(j.twoRows) && j.twoRows < Math.min(minStagger, r.length / 4) / 2;
      note(tight || hJoint ? 'warn' : 'ok', 'End-joint stagger',
        `${tight ? `Joints in neighbouring rows come within ${L(j.adjacent)}` : `Neighbouring rows' joints stay ${L(j.adjacent)}+ apart`} (target ${L(minStagger)}: NWFA asks 6" for strip and 8–10" for plank, laminate makers 8–12").` +
        (hJoint ? ' Joints line up two rows apart (H-joints): use a random stagger.' : ''));
    }
    if (r.stagger.mode === 'fixed') note('info', 'Random stagger', 'A fixed offset repeats as a visible stair-step. A random stagger with the minimum spacing looks natural and uses offcuts to start rows.');
    const end = layout.limits.end.sliver;
    const short = s.shortestEnd;
    note(short && short.needL < end - TOL ? 'warn' : 'ok', 'End pieces',
      short ? `Shortest end piece ${L(short.needL)} (minimum ${L(end)}; most makers say 6–8").` : 'No end cuts needed.');
    courseCheck(r.width, 'row');
    const recGap = FLOOR_PRESETS[r.preset]?.gap ?? (metric ? 6 : 0.25 * IN);
    note(r.gap >= recGap - TOL ? 'ok' : 'warn', 'Expansion gap',
      `${L(r.gap)} at the walls. Typical: ${metric ? '6 mm for vinyl plank, 8–10 mm for laminate, the board thickness (about 19 mm) for solid hardwood' : '1/4" for vinyl plank, 1/4–3/8" for laminate, about the board thickness (3/4") for solid hardwood'}; hide it under the baseboard.`);
    if (layout.region.parts.some((p) => p.kind === 'threshold') || Math.max(s.span.u, s.span.v) > 9144) {
      note(Math.max(s.span.u, s.span.v) > 9144 ? 'warn' : 'info', 'Continuous run',
        `This run is ${L(Math.max(s.span.u, s.span.v))} across${layout.region.geoms.length > 1 ? ` and flows through ${layout.region.parts.filter((p) => p.kind === 'threshold').length} doorway(s)` : ''}. Floating floors often need an expansion break past ${metric ? '9–12 m' : '30–40 ft'} or at doorways; check the maker's maximum run.`);
    }
  } else if (r.kind === 'tile') {
    if (ends) {
      const bal = (e, size) => Math.abs(e.first - e.last) <= Math.max(size / 8, metric ? 6 : 0.25 * IN);
      const vOk = bal(ends.v, r.width);
      const uOk = !ends.u || bal(ends.u, r.length);
      const parts = [`${ends.vFrom}/${ends.vTo} walls ${L(ends.v.first)} / ${L(ends.v.last)}`];
      if (ends.u) parts.push(`${ends.uFrom}/${ends.uTo} walls ${L(ends.u.first)} / ${L(ends.u.last)}`);
      note(vOk && uOk ? 'ok' : 'warn', 'Centred, balanced cuts',
        `Perimeter cuts: ${parts.join('; ')}. Lay out from centre lines so opposite walls get matching cuts${vOk && uOk ? '.' : ': use Center tile / Center joint or Best fit.'}`);
    }
    const perimeter = [ends?.v.first, ends?.v.last, ends?.u?.first, ends?.u?.last].filter((v) => v != null);
    if (perimeter.length) {
      const small = Math.min(...perimeter);
      note(small >= Math.min(r.width, r.length) / 2 - TOL ? 'ok' : 'warn', 'Half-tile minimum',
        `Smallest perimeter cut ${L(small)}. Keep visible cuts to at least half a tile and never under ${metric ? '50 mm' : '2"'}; put full tiles at the doorway and the most visible wall.`);
    }
    const offFrac = circ(r.stagger.offset, 0, r.length + r.joint) / (r.length + r.joint);
    if (offFrac > TOL / r.length) {
      const long = Math.max(r.length, r.width) > 18 * IN + TOL;
      note(long && offFrac > 0.34 ? 'warn' : 'ok', 'Offset', long
        ? `${Math.round(offFrac * 100)}% offset. ANSI A108.02 limits offsets to 33% for tile with a side over 18" (457 mm), where warpage shows as lippage, unless the maker says otherwise.`
        : `${Math.round(offFrac * 100)}% offset: fine for tile with no side over 18".`);
    }
    note(r.joint >= IN / 16 - 0.05 ? 'ok' : 'warn', 'Grout joint',
      `${L(r.joint)} joints. ANSI A108.02: never under 1/16" (1.5 mm) and at least 3× the tile's size variation: about ${metric ? '2–3 mm' : '1/8"'} for rectified, ${metric ? '5 mm' : '3/16"'}+ for calibrated tile.`);
    note(r.gap >= (metric ? 6 : 0.25 * IN) - TOL ? 'ok' : 'warn', 'Perimeter movement joint',
      `${L(r.gap)} at the walls and other hard surfaces (TCNA EJ171: about ${metric ? '6 mm' : '1/4"'}, hidden under the base, filled with sealant, never grout).`);
    const span = Math.max(s.span.u, s.span.v);
    note(span > 6096 ? 'warn' : 'ok', 'Field movement joints', span > 6096
      ? `The floor is ${L(span)} across: add field movement joints every ${metric ? '6–7.5 m' : '20–25 ft'} (${metric ? '2.5–3.5 m' : '8–12 ft'} in sunlit or wet areas), per TCNA EJ171.`
      : `Under ${metric ? '6 m' : '20 ft'} across: no field movement joints needed indoors (TCNA EJ171).`);
    const large = Math.max(r.length, r.width) >= 15 * IN - TOL;
    note('info', 'Flatness', large
      ? `Tile with a side of 15" or more needs the floor flat to ${metric ? '3 mm in 3 m and 1.5 mm in 600 mm' : '1/8" in 10\' and 1/16" in 24"'} (ANSI A108.02). Check it with the Level tool.`
      : `Flat to ${metric ? '6 mm in 3 m and 1.5 mm in 300 mm' : '1/4" in 10\' and 1/16" in 12"'} (ANSI A108.02). Check it with the Level tool.`);
    if (r.length > r.width * 1.5 && longAxis) {
      note(axis === longAxis ? 'ok' : 'info', 'Direction', `Rectangular tile usually runs its long side along the longest dimension of the space (${AXIS_NAME[longAxis]}).`);
    }
  } else if (r.unit === 'sheet') {
    if (joists) {
      const across = axis && axis !== joists;
      note(across ? 'ok' : 'warn', 'Strength axis', across
        ? 'The long dimension runs across the joists, as APA requires.'
        : `The joists run ${AXIS_NAME[joists]}: turn the sheets so their long dimension runs across the joists (APA).`);
    } else note('info', 'Strength axis', 'Run the long dimension of each sheet across the joists (APA). Set the joist direction below to check this.');
    const j = s.joints;
    const bay = metric ? 400 : 16 * IN;
    if (j && Number.isFinite(j.adjacent)) {
      note(j.adjacent >= bay - TOL ? 'ok' : 'warn', 'Staggered seams',
        `End joints in neighbouring rows are ${L(j.adjacent)} apart. Stagger them at least one joist bay (half a sheet, ${L(r.length / 2)}, is standard), and land every end joint on a joist.`);
    }
    note(r.joint >= (metric ? 3 : IN / 8) - 0.05 ? 'ok' : 'warn', 'Panel gaps', `${L(r.joint)} between panels. APA: leave about ${metric ? '3 mm' : '1/8"'} at all panel ends and edges for swelling.`);
    note('info', 'Fastening', 'Glue and screw (or ring-shank nail) to every joist; pieces should span at least two joist bays.');
    courseCheck(r.width, 'row');
  } else if (r.unit === 'panel') {
    note(r.gap >= (metric ? 6 : 0.25 * IN) - TOL ? 'ok' : 'warn', 'Spacers at the walls', `${L(r.gap)} gap. Panel subfloors over concrete want about ${metric ? '6 mm' : '1/4"'} spacers around the perimeter.`);
    note('info', 'Seams', 'Most tongue-and-groove basement panels don\'t require staggered seams; check the maker. Shim or level low spots in the slab first (Level tool).');
    courseCheck(r.width, 'row');
  } else {
    note('info', 'Strips', `Lay strips the long way of the room to keep seams to a minimum (${ends ? `${ends.v.courses} strips here` : 'one per width'}); butt or overlap and tape the seams as the maker specifies.`);
    if (longAxis) note(axis === longAxis ? 'ok' : 'info', 'Direction', `The room's long dimension runs ${AXIS_NAME[longAxis]}.`);
  }
  sliverCheck();
  if (layout.truncated) note('warn', 'Too many pieces', `Only the first ${MAX_PIECES.toLocaleString()} pieces are shown and counted.`);
  return out;
}
