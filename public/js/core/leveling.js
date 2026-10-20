// Subfloor leveling: a laser survey grid laid over a room, an interpolated
// elevation surface, and the cut/fill plan for a horizontal target height.
//
// Survey data lives on the room record as
//   room.leveling = { spacing, readings: [{x, y, z}], target, tolerance, locks: [{id, openingId, maxBuild}], linked, minimize }
// Readings are stored as plan points (mm) with a deviation z (mm, + = high,
// relative to the user's benchmark), so they survive grid spacing changes and
// room edits. `target` null means "follow the recommendation", which
// minimizes grinding or pouring (`minimize`: 'grind' | 'pour'). A lock caps
// how far the finished floor may rise: at a doorway (above the existing floor
// there) or, with openingId null, anywhere in the room (above the benchmark).
// The compound product and contingency are plan-wide estimate settings.
// Rooms joined by doors or openings are leveled as one floor (one surface
// and target) unless `linked` is false on either side.
import { add, bounds, distanceToPolygonEdges, pointInPolygon, polygonArea, scale } from './geometry.js';
import { MM_PER_FT, MM_PER_IN } from './units.js';
import { analyze } from './model.js';

const LITRES_PER_CU_FT = 28.3168;
const EDGE_MARGIN = 100; // mm: closest a grid node sits to a wall face
const DOORWAY_INSET = 100; // mm: where a doorway's floor height is sampled, inside the room
const IDW_NEIGHBOURS = 8;
export const MIN_READINGS = 3;
/** Larger readings are almost certainly typos (or the wrong unit). */
export const MAX_READING = 150;
/** Slack on tolerance-band comparisons: targets sit exactly a band off flat areas, so float noise must not flip cells. */
const BAND_EPS = 1e-6;
/** Grinding deeper than this is slow on concrete and usually wrong on wood. */
export const DEEP_GRIND = 6;

export const SPACING_OPTIONS = {
  imperial: [1, 1.5, 2, 2.5, 3].map((ft) => ft * MM_PER_FT),
  metric: [500, 600, 750, 1000],
};

/**
 * Straightedge flatness specs. Keeping every point within ±tolerance/2 of a
 * plane guarantees no straightedge gap exceeds the tolerance.
 */
export const FLATNESS_SPECS = {
  standard: { tolerance: (3 / 16) * MM_PER_IN, imperial: '3/16" in 10\'', metric: '5 mm in 3 m', use: 'hardwood, engineered, LVP' },
  tile: { tolerance: (1 / 8) * MM_PER_IN, imperial: '1/8" in 6\'', metric: '3 mm in 2 m', use: 'large-format tile (any side ≥ 15")' },
  loose: { tolerance: (1 / 4) * MM_PER_IN, imperial: '1/4" in 10\'', metric: '6 mm in 3 m', use: 'carpet, sheet vinyl, small tile' },
};

/**
 * Self-leveling underlayments with nominal data-sheet figures: bag yield
 * (litres of mixed material), the neat thickness range, and the extra
 * yield when extended with aggregate for deep pours. Yield per bag is
 * therefore a step curve over pour depth. Check the current TDS before
 * ordering; formulations change.
 */
export const COMPOUNDS = {
  'cbp-levelquik-rs': {
    name: 'Custom Building Products LevelQuik RS', bag: '50 lb', bagLitres: 0.45 * LITRES_PER_CU_FT,
    minThickness: 0, maxNeat: 1.5 * MM_PER_IN, maxExtended: 5 * MM_PER_IN, extendedYield: 1.5,
  },
  'mapei-ultraplan-1-plus': {
    name: 'MAPEI Ultraplan 1 Plus', bag: '50 lb', bagLitres: 0.5 * LITRES_PER_CU_FT,
    minThickness: (1 / 8) * MM_PER_IN, maxNeat: 1.5 * MM_PER_IN, maxExtended: 5 * MM_PER_IN, extendedYield: 1.5,
  },
  'ardex-k15': {
    name: 'ARDEX K 15 Premium', bag: '55 lb / 25 kg', bagLitres: 0.5 * LITRES_PER_CU_FT,
    minThickness: 0, maxNeat: 1.5 * MM_PER_IN, maxExtended: 5 * MM_PER_IN, extendedYield: 1.5,
  },
  custom: {
    name: 'Custom product', bag: 'bag', bagLitres: 13,
    minThickness: 3, maxNeat: 38, maxExtended: 38, extendedYield: 1,
  },
};

export function levelingDefaults(units) {
  return {
    spacing: units === 'metric' ? 600 : 2 * MM_PER_FT,
    readings: [],
    target: null,
    tolerance: FLATNESS_SPECS.standard.tolerance,
    locks: [],
    linked: true,
    minimize: 'grind',
  };
}

export function resolveLeveling(room, units) {
  const lv = room?.leveling ?? {};
  const def = levelingDefaults(units);
  return {
    ...def,
    ...lv,
    readings: Array.isArray(lv.readings) ? lv.readings : [],
    locks: Array.isArray(lv.locks) ? lv.locks : [],
  };
}

/** Unit for bare numbers in survey input: 'in' or 'mm', defaulting to the plan's system. */
export function readingUnit(d) {
  const u = d.settings.readingUnit;
  return u === 'in' || u === 'mm' ? u : d.units === 'metric' ? 'mm' : 'in';
}

/** One-tap survey readings (mm), highest first, for the entry bar. */
export const READING_PRESETS = {
  in: [1, 3 / 4, 1 / 2, 1 / 4, 1 / 8, 0, -1 / 8, -1 / 4, -1 / 2, -3 / 4, -1].map((i) => i * MM_PER_IN),
  mm: [20, 15, 10, 6, 3, 0, -3, -6, -10, -15, -20],
};

/** The selected compound (custom values merged in) and contingency %. */
export function resolveCompound(d) {
  const e = d.estimate ?? {};
  const key = COMPOUNDS[e.levelProduct] ? e.levelProduct : 'cbp-levelquik-rs';
  const product = key === 'custom' ? { ...COMPOUNDS.custom, ...(e.levelCustom ?? {}) } : COMPOUNDS[key];
  return { key, product, contingency: e.levelContingency ?? 10 };
}

/** Mixed litres a bag yields at a given pour depth (neat, or extended with aggregate). */
export function bagYield(product, thickness) {
  const extended = thickness > product.maxNeat + 1e-6 && product.extendedYield > 1;
  return product.bagLitres * 1e6 * (extended ? product.extendedYield : 1);
}

/** Area one bag covers at `thickness` mm, in mm² (the product's yield curve). */
export function bagCoverage(product, thickness) {
  const t = Math.max(thickness, product.minThickness, 0.1);
  return bagYield(product, t) / t;
}

// ---------------------------------------------------------------------------
// Survey grid

/** Spreadsheet-style column letters: 0 → A, 25 → Z, 26 → AA. */
export function columnLabel(i) {
  let s = '';
  for (let k = i + 1; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(65 + ((k - 1) % 26)) + s;
  return s;
}

function axisPositions(min, size, spacing) {
  let count = Math.floor(size / spacing + 1e-9) + 1;
  let margin = (size - (count - 1) * spacing) / 2;
  while (count > 1 && margin < EDGE_MARGIN) {
    count--;
    margin = (size - (count - 1) * spacing) / 2;
  }
  return Array.from({ length: count }, (_, i) => min + margin + i * spacing);
}

/**
 * Grid nodes centred in the room's bounding box, at least EDGE_MARGIN from
 * the walls, kept only inside the room. Columns are lettered west → east,
 * rows numbered north → south; nodes come in serpentine (walking) order.
 */
export function levelGrid(polygon, spacing) {
  const b = bounds(polygon);
  const xs = axisPositions(b.minX, b.width, spacing);
  const ys = axisPositions(b.minY, b.height, spacing);
  const nodes = [];
  ys.forEach((y, row) => {
    const cols = xs.map((x, col) => ({ x, col }));
    if (row % 2) cols.reverse();
    for (const { x, col } of cols) {
      const p = { x, y };
      if (!pointInPolygon(p, polygon) || distanceToPolygonEdges(p, polygon) < EDGE_MARGIN / 2) continue;
      nodes.push({ key: `${col},${row}`, col, row, x, y, label: `${columnLabel(col)}${row + 1}` });
    }
  });
  return { nodes, xs, ys, spacing, bounds: b };
}

/** How close a reading must be to a node to belong to it. */
export const snapRadius = (spacing) => spacing * 0.3;

/** Readings that fall in (or right at the edge of) the room. */
export function roomReadings(readings, polygon, spacing) {
  return readings.filter((r) => pointInPolygon(r, polygon) || distanceToPolygonEdges(r, polygon) < snapRadius(spacing));
}

/** Attaches each node's reading (nearest within the snap radius); returns the leftovers too. */
export function matchReadings(grid, readings) {
  const tol = snapRadius(grid.spacing);
  const used = new Set();
  // Bucket readings by snap radius so each node only checks its 3×3 neighbourhood.
  const buckets = new Map();
  const cellKey = (i, j) => `${i},${j}`;
  for (const r of readings) {
    const key = cellKey(Math.floor(r.x / tol), Math.floor(r.y / tol));
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }
  const nodes = grid.nodes.map((nd) => {
    let best = null;
    let bestD = tol;
    const ci = Math.floor(nd.x / tol);
    const cj = Math.floor(nd.y / tol);
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (const r of buckets.get(cellKey(ci + di, cj + dj)) ?? []) {
          const dd = Math.hypot(r.x - nd.x, r.y - nd.y);
          if (dd < bestD) {
            best = r;
            bestD = dd;
          }
        }
      }
    }
    if (best) used.add(best);
    return { ...nd, z: best ? best.z : null };
  });
  return { nodes, offGrid: readings.filter((r) => !used.has(r)) };
}

/** Returns a copy of `readings` with the reading at `node` set to z (or removed when z is null). */
export function setReading(readings, node, z, spacing) {
  const tol = snapRadius(spacing);
  const rest = readings.filter((r) => Math.hypot(r.x - node.x, r.y - node.y) >= tol);
  return z == null ? rest : [...rest, { x: Math.round(node.x), y: Math.round(node.y), z: Math.round(z * 100) / 100 }];
}

// ---------------------------------------------------------------------------
// Surface

/** Inverse-distance-weighted elevation from the nearest readings. */
export function interpolator(readings) {
  return (p) => {
    const near = [];
    for (const r of readings) {
      const d2 = (r.x - p.x) ** 2 + (r.y - p.y) ** 2;
      if (d2 < 1) return r.z;
      if (near.length < IDW_NEIGHBOURS) near.push({ d2, z: r.z });
      else {
        let worst = 0;
        for (let k = 1; k < near.length; k++) if (near[k].d2 > near[worst].d2) worst = k;
        if (d2 < near[worst].d2) near[worst] = { d2, z: r.z };
      }
    }
    let wSum = 0;
    let zSum = 0;
    for (const { d2, z } of near) {
      wSum += 1 / d2;
      zSum += z / d2;
    }
    return wSum ? zSum / wSum : 0;
  };
}

const surfaceCache = new Map();

/**
 * Samples the interpolated surface on a raster over the bounding box of one
 * or more room polygons (cells outside them are still sampled so the heatmap
 * blends cleanly to the clip edge). `owner[k]` is the polygon a cell falls
 * in (-1 outside); `cellAreas[i]` scales polygon i's cells so they sum to
 * its exact area.
 */
export function surfaceRaster(polygons, readings, spacing) {
  const key = JSON.stringify([polygons.map((poly) => poly.map((p) => [Math.round(p.x), Math.round(p.y)])), readings, spacing]);
  const hit = surfaceCache.get(key);
  if (hit) return hit;
  const b = bounds(polygons.flat());
  const cell = Math.max(25, Math.min(spacing / 3, Math.max(b.width, b.height) / 90));
  const cols = Math.max(1, Math.ceil(b.width / cell));
  const rows = Math.max(1, Math.ceil(b.height / cell));
  const z = new Float64Array(cols * rows);
  const owner = new Int16Array(cols * rows).fill(-1);
  const counts = polygons.map(() => 0);
  const at = interpolator(readings);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const p = { x: b.minX + (i + 0.5) * cell, y: b.minY + (j + 0.5) * cell };
      z[j * cols + i] = at(p);
      const m = polygons.findIndex((poly) => pointInPolygon(p, poly));
      if (m >= 0) {
        owner[j * cols + i] = m;
        counts[m]++;
      }
    }
  }
  const cellAreas = polygons.map((poly, m) => (counts[m] ? polygonArea(poly) / counts[m] : cell * cell));
  const raster = { x0: b.minX, y0: b.minY, cell, cols, rows, z, owner, cellAreas, at };
  surfaceCache.set(key, raster);
  if (surfaceCache.size > 24) surfaceCache.delete(surfaceCache.keys().next().value);
  return raster;
}

// ---------------------------------------------------------------------------
// Linked rooms

const adjacencyCache = new WeakMap();

/** Room geometries joined by a door or cased opening in a wall between them. */
function doorAdjacency(d, analysis) {
  const hit = adjacencyCache.get(analysis);
  if (hit) return hit;
  const adj = new Map();
  for (const o of d.openings) {
    if (o.type === 'window') continue;
    const [a, b] = analysis.wallInfo.get(o.wallId)?.roomSides ?? [];
    if (!a || !b || a === b) continue;
    for (const [p, q] of [[a, b], [b, a]]) {
      if (!adj.has(p)) adj.set(p, new Set());
      adj.get(p).add(q);
    }
  }
  adjacencyCache.set(analysis, adj);
  return adj;
}

const hasReadings = (g, units) => {
  const lv = resolveLeveling(g.room, units);
  return roomReadings(lv.readings, g.polygon, lv.spacing).length > 0;
};

/**
 * The rooms leveled together with `geom`: those reachable through doors and
 * openings that have readings and linking switched on (rooms without a
 * survey would only be extrapolated). Ordered as in d.rooms; the first one
 * (the leader) holds the shared target and tolerance.
 */
export function levelGroup(d, geom, analysis) {
  const self = analysis.rooms.find((x) => x.room && x.room.id === geom.room?.id) ?? geom;
  const joins = (g) => g.room && resolveLeveling(g.room, d.units).linked !== false && hasReadings(g, d.units);
  if (!joins(self)) return [self];
  const adj = doorAdjacency(d, analysis);
  const seen = new Set([self]);
  const queue = [self];
  while (queue.length) {
    for (const next of adj.get(queue.shift()) ?? []) {
      if (seen.has(next) || !joins(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  const order = new Map(d.rooms.map((r, i) => [r.id, i]));
  return [...seen].sort((p, q) => order.get(p.room.id) - order.get(q.room.id));
}

/** Rooms door-connected to `geom` at all (whether or not they currently join its group). */
export function connectedRooms(d, geom, analysis) {
  const self = analysis.rooms.find((x) => x.room && x.room.id === geom.room?.id) ?? geom;
  return [...(doorAdjacency(d, analysis).get(self) ?? [])].filter((g) => g.room);
}

// ---------------------------------------------------------------------------
// Analysis

/** Doorways and openings of a room, with the floor point just inside each. */
export function roomDoorways(geom) {
  const out = [];
  for (const face of geom.walls) {
    for (const op of face.openings) {
      if (op.opening.type === 'window') continue;
      const s = Math.min(Math.max((op.s0 + op.s1) / 2, 0), face.length);
      const onFace = add(face.P, scale(face.dir, s));
      const inward = { x: -face.dir.y, y: face.dir.x };
      out.push({ opening: op.opening, compass: face.compass, point: add(onFace, scale(inward, DOORWAY_INSET)) });
    }
  }
  return out;
}

/**
 * Resolves clearance locks into target caps: a doorway lock allows the
 * floor to rise maxBuild above the existing floor at that doorway; a
 * room-wide lock allows maxBuild above the benchmark.
 */
function resolveLocks(locks, geom, at) {
  const doorways = roomDoorways(geom);
  const room = { id: geom.room?.id, name: geom.room?.name };
  return locks.map((lock) => {
    if (!lock.openingId) return { lock, room, kind: 'room', point: null, z: 0, maxTarget: lock.maxBuild };
    const dw = doorways.find((x) => x.opening.id === lock.openingId);
    if (!dw) return { lock, room, kind: 'missing', point: null, z: null, maxTarget: Infinity };
    const z = at ? at(dw.point) : null;
    return { lock, room, kind: 'doorway', doorway: dw, point: dw.point, z, maxTarget: z == null ? Infinity : z + lock.maxBuild };
  });
}

/**
 * Full leveling analysis for a room geometry (from analyze()). Rooms linked
 * through doors are analysed as one floor: one surface, the leader's target
 * and tolerance, everyone's clearance locks. `nodes`/`grid`/`lv` describe
 * the requested room; `members` every room in the group; `byRoom` splits
 * the quantities per room. opts.analysis reuses an analyze() result;
 * opts.preview = {roomId, target} previews a target for that room's group.
 */
export function analyzeLeveling(d, geom, opts = {}) {
  const analysis = opts.analysis ?? analyze(d);
  const group = levelGroup(d, geom, analysis);
  const members = group.map((g) => {
    const mlv = resolveLeveling(g.room, d.units);
    const grid = levelGrid(g.polygon, mlv.spacing);
    const readings = roomReadings(mlv.readings, g.polygon, mlv.spacing);
    return { geom: g, lv: mlv, grid, readings, ...matchReadings(grid, readings) };
  });
  const self = members.find((m) => m.geom.room?.id === geom.room?.id) ?? members[0];
  const lead = members[0].lv;
  const ids = members.map((m) => m.geom.room?.id);
  const readings = members.flatMap((m) => m.readings);
  const band = lead.tolerance / 2;
  const linked = members.length > 1;
  const base = {
    lv: self.lv, grid: self.grid, nodes: self.nodes, offGrid: self.offGrid, members, readings, band, linked,
    group: { ids, names: members.map((m) => m.geom.room?.name), leaderId: ids[0] },
    ready: readings.length >= MIN_READINGS,
  };
  const lockList = (at) => members.flatMap((m) => resolveLocks(m.lv.locks, m.geom, at));
  if (!base.ready) return { ...base, locks: lockList(null) };

  const surface = surfaceRaster(members.map((m) => m.geom.polygon), readings, Math.min(...members.map((m) => m.lv.spacing)));
  const zs = readings.map((r) => r.z);
  const min = Math.min(...zs);
  const max = Math.max(...zs);
  const locks = lockList(surface.at);
  const capLock = locks.reduce((best, l) => (l.maxTarget < (best?.maxTarget ?? Infinity) ? l : best), null);
  const cap = capLock?.maxTarget ?? Infinity;

  const { product, contingency, key: productKey } = resolveCompound(d);
  const bagsFor = (raw) => (raw > 0 ? Math.ceil(raw * (1 + contingency / 100) - 1e-9) : 0);
  const outcome = (t) => {
    const plan = cutFill(surface, t, band, product, members.length);
    // Raster cells sample between nodes; the measured extremes are exact.
    for (const r of readings) {
      plan.maxCut = Math.max(plan.maxCut, r.z - t > band + BAND_EPS ? r.z - t : 0);
      plan.maxFill = Math.max(plan.maxFill, t - r.z > band + BAND_EPS ? t - r.z : 0);
    }
    return plan;
  };

  // Grinding only shrinks as the target rises and pouring only grows, so each
  // optimum is an end of the range, then pulled under the tightest lock:
  // minimize grinding = pour up to the highest spot (less the band);
  // minimize pour = grind down to the lowest spot (plus the band).
  // An already-flat floor needs neither; aim for the middle of its range.
  const flat = max - min <= 2 * band + 1e-9;
  const fillOnly = flat ? (max + min) / 2 : max - band;
  const grindOnly = flat ? (max + min) / 2 : min + band;
  const options = {};
  for (const [key, ideal] of [['grind', fillOnly], ['pour', grindOnly]]) {
    const t = Math.min(ideal, cap);
    const o = outcome(t);
    options[key] = { target: t, ideal, capped: t < ideal - 1e-9, grindArea: o.grindArea, maxCut: o.maxCut, fillArea: o.fillArea, avgFill: o.avgFill, bags: bagsFor(o.rawBags) };
  }
  const minimize = lead.minimize === 'pour' ? 'pour' : 'grind';
  const recommended = options[minimize].target;
  const strategy = flat && !options[minimize].capped ? 'none'
    : minimize === 'pour' ? 'grind-only'
      : options.grind.capped ? 'grind' : 'fill';
  const preview = opts.preview && ids.includes(opts.preview.roomId) ? opts.preview.target : opts.target;
  const target = preview ?? lead.target ?? recommended;
  const breaches = locks.filter((l) => target > l.maxTarget + 1e-6).map((l) => ({ ...l, by: target - l.maxTarget }));

  const plan = outcome(target);
  plan.zones = grindZones(surface, plan.delta, band, members, target);
  const bags = bagsFor(plan.rawBags);
  const byRoom = new Map(members.map((m, i) => [ids[i], { ...plan.byMember[i], zones: plan.zones.filter((z) => z.member === i).length }]));

  return {
    ...base,
    surface,
    min,
    max,
    locks,
    cap,
    capLock,
    fillOnly,
    grindOnly,
    options,
    minimize,
    recommended,
    strategy,
    target,
    auto: preview == null && lead.target == null,
    breaches,
    product,
    productKey,
    contingency,
    bags,
    byRoom,
    ...plan,
    scaleMax: Math.max(Math.abs(max - target), Math.abs(min - target), band * 2),
    missing: members.reduce((s, m) => s + m.nodes.filter((nd) => nd.z == null).length, 0),
  };
}

/** Per-cell delta (z − target) and the grind/fill totals (overall and per member room), including bags before contingency. */
function cutFill(surface, target, band, product, memberCount) {
  const { z, owner, cellAreas } = surface;
  const delta = new Float64Array(z.length);
  const r = {
    delta, grindArea: 0, grindVolume: 0, maxCut: 0,
    fillArea: 0, fillVolume: 0, maxFill: 0, extendedArea: 0, overMaxArea: 0, rawBags: 0,
    byMember: Array.from({ length: memberCount }, () => ({ grindArea: 0, fillArea: 0, fillVolume: 0, rawBags: 0 })),
  };
  for (let k = 0; k < z.length; k++) {
    const dz = z[k] - target;
    delta[k] = dz;
    if (owner[k] < 0) continue;
    const area = cellAreas[owner[k]];
    const mine = r.byMember[owner[k]];
    if (dz > band + BAND_EPS) {
      r.grindArea += area;
      r.grindVolume += area * dz;
      r.maxCut = Math.max(r.maxCut, dz);
      mine.grindArea += area;
    } else if (-dz > band + BAND_EPS) {
      const depth = -dz;
      const pour = Math.max(depth, product.minThickness);
      const bags = (area * pour) / bagYield(product, pour);
      r.fillArea += area;
      r.fillVolume += area * depth;
      r.maxFill = Math.max(r.maxFill, depth);
      r.rawBags += bags;
      mine.fillArea += area;
      mine.fillVolume += area * depth;
      mine.rawBags += bags;
      if (pour > product.maxNeat) r.extendedArea += area;
      if (pour > product.maxExtended) r.overMaxArea += area;
    }
  }
  r.avgFill = r.fillArea ? r.fillVolume / r.fillArea : 0;
  return r;
}

/**
 * Connected high spots (4-neighbour) above the band, largest cut first,
 * each with the survey nodes it covers and its distance from the west and
 * north walls of its room (the room's bounding box) for marking out on
 * site. With several linked rooms, node labels carry the room name.
 */
function grindZones(surface, delta, band, members, target) {
  const { cols, rows, cell, x0, y0, owner, cellAreas } = surface;
  const multi = members.length > 1;
  const nodes = members.flatMap((m, i) => m.nodes.map((nd) => ({ ...nd, member: i, name: multi ? `${m.geom.room?.name} ${nd.label}` : nd.label })));
  const seen = new Uint8Array(delta.length);
  const zones = [];
  for (let start = 0; start < delta.length; start++) {
    if (seen[start] || owner[start] < 0 || delta[start] <= band + BAND_EPS) continue;
    const stack = [start];
    seen[start] = 1;
    const zone = { cells: [], area: 0, maxCut: 0, sx: 0, sy: 0, minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    while (stack.length) {
      const k = stack.pop();
      const i = k % cols;
      const j = (k - i) / cols;
      const cx = x0 + (i + 0.5) * cell;
      const cy = y0 + (j + 0.5) * cell;
      zone.cells.push(k);
      zone.area += cellAreas[owner[k]];
      zone.maxCut = Math.max(zone.maxCut, delta[k]);
      zone.sx += cx;
      zone.sy += cy;
      zone.minX = Math.min(zone.minX, cx - cell / 2);
      zone.maxX = Math.max(zone.maxX, cx + cell / 2);
      zone.minY = Math.min(zone.minY, cy - cell / 2);
      zone.maxY = Math.max(zone.maxY, cy + cell / 2);
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
        const nk = nj * cols + ni;
        if (!seen[nk] && owner[nk] >= 0 && delta[nk] > band + BAND_EPS) {
          seen[nk] = 1;
          stack.push(nk);
        }
      }
    }
    const n = zone.cells.length;
    const centroid = { x: zone.sx / n, y: zone.sy / n };
    const member = owner[zone.cells[0]];
    const b = members[member].grid.bounds;
    const cellSet = new Set(zone.cells);
    const cellOf = (p) => Math.min(rows - 1, Math.max(0, Math.floor((p.y - y0) / cell))) * cols + Math.min(cols - 1, Math.max(0, Math.floor((p.x - x0) / cell)));
    let covered = nodes.filter((nd) => nd.z != null && nd.z - target > band + BAND_EPS && cellSet.has(cellOf(nd)));
    if (!covered.length) {
      const nearest = nodes.filter((nd) => nd.member === member)
        .sort((p, q) => Math.hypot(p.x - centroid.x, p.y - centroid.y) - Math.hypot(q.x - centroid.x, q.y - centroid.y))[0];
      covered = nearest ? [nearest] : [];
    }
    zones.push({
      area: zone.area,
      maxCut: Math.max(zone.maxCut, ...covered.map((nd) => (nd.z == null ? 0 : nd.z - target))),
      centroid,
      member,
      room: members[member].geom.room?.name,
      extent: { minX: zone.minX, minY: zone.minY, maxX: zone.maxX, maxY: zone.maxY },
      fromWest: centroid.x - b.minX,
      fromNorth: centroid.y - b.minY,
      nodes: covered.sort((p, q) => q.z - p.z).map((nd) => ({ label: nd.label, name: nd.name, roomId: members[nd.member].geom.room?.id, cut: nd.z - target })),
    });
  }
  zones.sort((p, q) => q.maxCut - p.maxCut || q.area - p.area);
  zones.forEach((zn, i) => { zn.label = `G${i + 1}`; });
  return zones;
}

// ---------------------------------------------------------------------------
// Colours

const GRIND_STOPS = [[250, 204, 21], [249, 115, 22], [220, 38, 38]]; // yellow → orange → red
const FILL_STOPS = [[186, 230, 253], [59, 130, 246], [30, 58, 138]]; // light blue → blue → navy
export const LEVEL_COLOR = [74, 222, 128];

function ramp(stops, t) {
  const x = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const k = Math.min(stops.length - 2, Math.floor(x));
  const f = x - k;
  return stops[k].map((c, i) => Math.round(c + (stops[k + 1][i] - c) * f));
}

/** Heatmap colour for a deviation from target: warm = grind, cool = pour, green = within the band. */
export function levelColor(delta, band, scaleMax) {
  if (Math.abs(delta) <= band + BAND_EPS) return LEVEL_COLOR;
  const t = (Math.abs(delta) - band) / Math.max(1e-6, scaleMax - band);
  return ramp(delta > 0 ? GRIND_STOPS : FILL_STOPS, t);
}

/** Colour stops for a legend bar from deepest fill (offset 0) to highest grind (offset 1). */
export function legendStops(band, scaleMax) {
  const at = (sign, t) => levelColor(sign * (band + 2 * BAND_EPS + t * (scaleMax - band)), band, scaleMax);
  return [
    { offset: 0, color: at(-1, 1) },
    { offset: 0.19, color: at(-1, 0.5) },
    { offset: 0.38, color: at(-1, 0) },
    { offset: 0.38, color: LEVEL_COLOR },
    { offset: 0.62, color: LEVEL_COLOR },
    { offset: 0.62, color: at(1, 0) },
    { offset: 0.81, color: at(1, 0.5) },
    { offset: 1, color: at(1, 1) },
  ];
}
