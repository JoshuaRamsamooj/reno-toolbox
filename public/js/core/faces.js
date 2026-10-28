// Wall faces: one side of a straight wall run, facing either a room or the
// outdoors. Room faces come from analyze() with their ceiling profile and
// bulkhead bands; exterior faces get a top-of-wall profile from the rooms
// behind them. A face is addressed by any of its wall sides, {wallId, dir},
// where dir is the half-edge direction (0 = the side seen walking A→B), or
// 'a' / 'b' for the end face of a stub wall that ends free at node A or B.
import { add, compassName, dot, scale, sub } from './geometry.js';
import { analyze, roomElevations } from './model.js';
import { profileHeightAt } from './ceiling.js';

export function faceRef(face) {
  return { wallId: face.sides[0].wallId, dir: face.sides[0].dir };
}

export function faceKey(ref) {
  return ref ? `${ref.wallId}:${ref.dir}` : '';
}

export function parseFaceKey(key) {
  const i = String(key ?? '').lastIndexOf(':');
  if (i <= 0) return null;
  const raw = key.slice(i + 1);
  if (raw === 'a' || raw === 'b') return { wallId: key.slice(0, i), dir: raw };
  const dir = Number(raw);
  return dir === 0 || dir === 1 ? { wallId: key.slice(0, i), dir } : null;
}

export function findFace(faces, ref) {
  if (!ref) return null;
  return faces.find((f) => f.sides.some((s) => s.wallId === ref.wallId && s.dir === ref.dir)) ?? null;
}

/** Which part of a stub wall a face is: "west side" (the side facing west) or "end". */
export function stubPart(w) {
  return w.stub === 'end' ? 'end' : `${compassName(scale(w.outward, -1)).toLowerCase()} side`;
}

/** "3. North wall", or for stub walls "5. Stub wall, west side" / "6. Stub wall end". */
export function faceTitle(w, number) {
  if (w.stub === 'end') return `${number}. Stub wall end`;
  if (w.stub) return `${number}. Stub wall, ${stubPart(w)}`;
  return `${number}. ${w.compass} wall`;
}

/**
 * Every wall face in the plan: room faces (in room order, numbered as on the
 * Elevations tab, then the sides and ends of stub walls in the room; none for
 * dead space) followed by exterior faces. Each carries `profile` (top of
 * wall as [{s, z}]), `bands` (bulkheads), `openings` and `junctions` (where
 * stub walls meet it) in face coordinates.
 */
export function designFaces(d, analysis = analyze(d)) {
  const faces = [];
  for (const g of analysis.rooms) {
    if (g.dead) continue; // dead space is never finished, so its faces take no trim
    const elev = roomElevations(d, g);
    [...elev.walls, ...elev.spurs].forEach((w, i) => faces.push({
      ...w,
      kind: 'room',
      room: g,
      roomId: g.room?.id ?? null,
      number: i + 1,
      name: `${g.room?.name ?? 'Room'} – ${faceTitle(w, i + 1)}`,
    }));
  }
  const roomFaces = faces.slice();
  analysis.exteriorFaces.forEach((w, i) => faces.push({
    ...w,
    room: null,
    roomId: null,
    number: i + 1,
    name: `Exterior – ${i + 1}. ${w.compass} face`,
    profile: exteriorProfile(w, roomFaces, d.settings.ceilingHeight),
    bands: [],
  }));
  return faces;
}

/**
 * Top of an exterior face: the highest wall top of the room faces backing
 * onto it, mapped into the exterior face's coordinates.
 */
function exteriorProfile(w, roomFaces, fallback) {
  const backs = roomFaces.filter((f) => f.wallIds.some((id) => w.wallIds.includes(id)));
  if (!backs.length) return [{ s: 0, z: fallback }, { s: w.length, z: fallback }];
  const toRoom = (f, s) => dot(sub(add(w.P, scale(w.dir, s)), f.P), f.dir);
  const toExt = (f, sr) => dot(sub(add(f.P, scale(f.dir, sr)), w.P), w.dir);
  const stops = new Set([0, w.length]);
  for (const f of backs) {
    for (const p of f.profile) {
      const s = toExt(f, p.s);
      if (s > 0 && s < w.length) stops.add(s);
    }
  }
  const heightAt = (s) => {
    let best = -Infinity;
    let nearest = fallback;
    let nearestD = Infinity;
    for (const f of backs) {
      const sr = toRoom(f, s);
      const z = profileHeightAt(f.profile, Math.min(Math.max(sr, 0), f.length));
      const off = sr < 0 ? -sr : Math.max(0, sr - f.length);
      if (off <= 1) best = Math.max(best, z);
      if (off < nearestD) {
        nearestD = off;
        nearest = z;
      }
    }
    return best > -Infinity ? best : nearest;
  };
  return [...stops].sort((a, b) => a - b).map((s) => ({ s, z: heightAt(s) }));
}

/**
 * A face split at its openings, for chain dimensions: `walls` are the solid
 * stretches between the corners and the opening edges (what gets measured
 * on either side of a door), `openings` the spans the openings take.
 * Openings that overlap (stacked windows) count as one span. In face
 * coordinates, clamped to the face; pieces under 1 mm are dropped.
 */
export function faceRuns(face) {
  const spans = face.openings
    .map((op) => ({ s0: Math.max(0, op.s0), s1: Math.min(face.length, op.s1) }))
    .filter((sp) => sp.s1 - sp.s0 > 1)
    .sort((a, b) => a.s0 - b.s0);
  const openings = [];
  for (const sp of spans) {
    const last = openings.at(-1);
    if (last && sp.s0 <= last.s1) last.s1 = Math.max(last.s1, sp.s1);
    else openings.push({ ...sp });
  }
  const walls = [];
  let at = 0;
  for (const sp of openings) {
    if (sp.s0 - at > 1) walls.push({ s0: at, s1: sp.s0 });
    at = sp.s1;
  }
  if (face.length - at > 1) walls.push({ s0: at, s1: face.length });
  return { walls, openings };
}

/**
 * The face a plan point picks: the nearest face line on the viewer's side,
 * or the nearer half of the wall body. `reach` is how far into the room a
 * click still counts (mm).
 */
export function faceAtPoint(faces, p, reach) {
  let best = null;
  let bestScore = Infinity;
  for (const f of faces) {
    const along = dot(sub(p, f.P), f.dir);
    if (along < -reach / 2 || along > f.length + reach / 2) continue;
    const depth = dot(sub(p, f.P), f.outward); // < 0 on the viewer's side, > 0 inside the wall
    if (depth < -reach || depth > f.thickness / 2 + 0.5) continue;
    const score = Math.abs(depth) + (along < 0 ? -along : Math.max(0, along - f.length));
    if (score < bestScore) {
      best = f;
      bestScore = score;
    }
  }
  return best;
}
