import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BARN_OVERLAP, addOpening, addRectangle, addWallChain, analyze, createDesign, doorStyle, migrateDesign, normalize, slideClearance, wallFaceSpans,
} from '../public/js/core/model.js';
import { designFaces } from '../public/js/core/faces.js';
import { createRun } from '../public/js/core/flooring.js';
import { computeTakeoff } from '../public/js/core/takeoff.js';
import { MM_PER_FT, MM_PER_IN, MM2_PER_FT2 } from '../public/js/core/units.js';

const FT = MM_PER_FT;
const IN = MM_PER_IN;
const near = (a, b, tol = 0.5) => assert.ok(Math.abs(a - b) <= tol, `expected ${a} ≈ ${b}`);

/** A 12' × 10' room (centrelines) with 4" walls, its south wall running west → east. */
function room() {
  const d = createDesign('imperial');
  d.settings.wallThickness = 4 * IN;
  addRectangle(d, { x: 0, y: 0 }, { x: 12 * FT, y: 10 * FT });
  normalize(d);
  return d;
}

/** The wall along y = `y` (horizontal), with its end A at the west. */
function horizontalWall(d, y) {
  const nodes = new Map(d.nodes.map((n) => [n.id, n]));
  const w = d.walls.find((x) => nodes.get(x.a).y === y && nodes.get(x.b).y === y);
  if (nodes.get(w.a).x > nodes.get(w.b).x) [w.a, w.b] = [w.b, w.a];
  return w;
}

test('doors get a style, defaulting to single swing for doors saved without one', () => {
  const d = room();
  const w = horizontalWall(d, 0);
  const door = addOpening(d, w.id, 'door', 3 * FT);
  assert.equal(door.style, 'single');
  const win = addOpening(d, w.id, 'window', 9 * FT);
  assert.equal(doorStyle(win), null);
  assert.equal(doorStyle({ type: 'door' }), 'single');
  assert.equal(doorStyle({ type: 'door', style: 'nonsense' }), 'single');
  assert.equal(doorStyle({ type: 'door', style: 'pocket' }), 'pocket');
});

test('opening gaps are measured to the corners of each wall face, not along the centreline', () => {
  const d = room();
  const w = horizontalWall(d, 0);
  const door = addOpening(d, w.id, 'door', 3 * FT, { width: 32 * IN });
  normalize(d);
  const spans = wallFaceSpans(analyze(d), door.wallId, door.offset, door.width);
  assert.equal(spans.length, 2, 'interior and exterior face');
  const inside = spans.find((s) => s.face.room);
  const outside = spans.find((s) => !s.face.room);
  near(inside.face.length, 12 * FT - 4 * IN);
  near(outside.face.length, 12 * FT + 4 * IN);
  // Interior gaps add up with the width to the face length; the inside corners are 2" closer.
  near(inside.s0 + door.width + (inside.face.length - inside.s1), inside.face.length);
  const left = inside.forward ? inside.s0 : inside.face.length - inside.s1;
  near(left, 3 * FT - 16 * IN - 2 * IN);
});

test('pocket and barn doors report the wall space they need beside the opening', () => {
  const d = room();
  const w = horizontalWall(d, 0);
  // 30" pocket door 20" from the west corner of the room (centre at 2" + 20" + 15").
  const pocket = addOpening(d, w.id, 'door', 37 * IN, { width: 30 * IN, style: 'pocket' });
  normalize(d);
  let c = slideClearance(d, pocket);
  near(c.need, 30 * IN);
  near(c.have, 20 * IN); // toward A (the west corner) by default
  pocket.flipX = true;
  c = slideClearance(d, pocket);
  near(c.have, 12 * FT - 4 * IN - 20 * IN - 30 * IN);
  // A window in the way shortens the pocket.
  addOpening(d, w.id, 'window', 37 * IN + 15 * IN + 10 * IN + 12 * IN, { width: 24 * IN });
  c = slideClearance(d, pocket);
  near(c.have, 10 * IN);

  // A barn door hangs on one face (the room side here) and its slab laps the opening each side.
  const door = d.openings.find((o) => o.id === pocket.id);
  Object.assign(door, { style: 'barn', flipX: false });
  d.openings = [door];
  c = slideClearance(d, door);
  near(c.need, 30 * IN + 2 * BARN_OVERLAP);
  near(c.have, 20 * IN);
  assert.equal(slideClearance(d, { ...door, style: 'double' }), null);
});

test('dead space is drawn but left out of the takeoff, trim faces and flooring', () => {
  const d = createDesign('imperial');
  d.settings.wallThickness = 0;
  d.settings.ceilingHeight = 8 * FT;
  addRectangle(d, { x: 0, y: 0 }, { x: 10 * FT, y: 10 * FT });
  addRectangle(d, { x: 10 * FT, y: 0 }, { x: 12 * FT, y: 4 * FT });
  normalize(d);
  const chase = analyze(d).rooms.find((g) => g.area < 10 * FT * FT).room;
  const before = computeTakeoff(d);
  createRun(d, 'plank', d.rooms.map((r) => r.id));
  normalize(d);
  assert.equal(d.floorRuns[0].roomIds.length, 2);

  chase.dead = true;
  normalize(d);
  const g = analyze(d).rooms.find((x) => x.room === chase);
  assert.equal(g.dead, true);
  assert.deepEqual(d.floorRuns[0].roomIds, d.rooms.filter((r) => r !== chase).map((r) => r.id), 'dead space leaves its flooring run');
  assert.ok(!designFaces(d).some((f) => f.roomId === chase.id), 'no trim faces in dead space');
  const t = computeTakeoff(d);
  assert.equal(t.rooms.length, 1);
  near(t.totals.floorArea / MM2_PER_FT2, 100, 0.01);
  assert.ok(t.totals.wallGross < before.totals.wallGross);
  // Unmarking brings it back.
  delete chase.dead;
  normalize(d);
  assert.equal(computeTakeoff(d).rooms.length, 2);
});

test('door styles are listed in the takeoff by style and size', () => {
  const d = room();
  const w = horizontalWall(d, 0);
  addOpening(d, w.id, 'door', 3 * FT, { width: 30 * IN, style: 'pocket' });
  addOpening(d, horizontalWall(d, 10 * FT).id, 'door', 4 * FT, { width: 36 * IN, style: 'barn' });
  normalize(d);
  const doors = computeTakeoff(d).materials.filter((m) => m.category === 'Doors');
  assert.equal(doors.length, 2);
  assert.match(doors[0].label, /^Pocket door/);
  assert.match(doors[1].label, /^Barn door/);
  assert.equal(doors[1].quantity, 1);
  assert.match(doors[1].detail, /track/);
});

test('ruler guides are kept with the plan and centreline dimensions migrate to interior faces', () => {
  const d = migrateDesign({
    units: 'imperial', nodes: [], walls: [], settings: { dimensionMode: 'centerline' },
    guides: [{ id: 'g1', axis: 'x', v: 1200 }, { id: 'g2', axis: 'z', v: 5 }, { id: 'g3', axis: 'y', v: 'a' }, null],
  });
  assert.deepEqual(d.guides, [{ id: 'g1', axis: 'x', v: 1200 }]);
  assert.equal(d.settings.dimensionMode, 'interior');
  assert.deepEqual(migrateDesign({ nodes: [], walls: [] }).guides, []);
  assert.equal(createDesign('metric').guides.length, 0);
});

test('guides on a wall face stay put in the real world when the face moves or splits', async () => {
  const { ensureRecord, recordForFace } = await import('../public/js/core/trim.js');
  const d = createDesign('imperial');
  d.settings.wallThickness = 0;
  addRectangle(d, { x: 0, y: 0 }, { x: 12 * FT, y: 10 * FT });
  normalize(d);
  const south = () => designFaces(d).find((f) => f.kind === 'room' && f.outward.y > 0.9);
  const world = (f, v) => f.P.x + f.dir.x * v;
  let f = south();
  // A vertical guide 4' along the face (seen from inside) and a horizontal one at 36".
  const rec = ensureRecord(d, f);
  rec.guides = [{ id: 'gx', axis: 'x', v: 4 * FT }, { id: 'gy', axis: 'y', v: 36 * IN }];
  const gx = world(f, 4 * FT);
  normalize(d);
  assert.equal(recordForFace(d, south()).guides.length, 2, 'a record with only guides is kept');

  // Move the east wall out 2': the face's left end (seen from inside, the east) moves, the guide doesn't.
  for (const nd of d.nodes) if (nd.x === 12 * FT) nd.x = 14 * FT;
  normalize(d);
  f = south();
  const moved = recordForFace(d, f).guides.find((g) => g.axis === 'x');
  near(world(f, moved.v), gx);

  // Split the room: the height guide goes to both halves, the vertical one only to its own half.
  addWallChain(d, [{ x: 10 * FT, y: 0 }, { x: 10 * FT, y: 10 * FT }]);
  normalize(d);
  const halves = designFaces(d).filter((x) => x.kind === 'room' && x.outward.y > 0.9);
  assert.equal(halves.length, 2);
  const guides = halves.map((h) => recordForFace(d, h)?.guides ?? []);
  assert.ok(guides.every((list) => list.some((g) => g.axis === 'y' && Math.abs(g.v - 36 * IN) < 0.5)));
  assert.equal(guides.flat().filter((g) => g.axis === 'x').length, 1);
  const half = halves[guides.findIndex((list) => list.some((g) => g.axis === 'x'))];
  near(world(half, recordForFace(d, half).guides.find((g) => g.axis === 'x').v), gx);
});

test('a wall face is split either side of its openings for dimensions', async () => {
  const { faceRuns } = await import('../public/js/core/faces.js');
  const d = room();
  const w = horizontalWall(d, 0);
  // 32" door 18" from the west inside corner, then a 36" window 24" further on.
  addOpening(d, w.id, 'door', 2 * IN + 18 * IN + 16 * IN, { width: 32 * IN });
  addOpening(d, w.id, 'window', 2 * IN + 18 * IN + 32 * IN + 24 * IN + 18 * IN, { width: 36 * IN });
  normalize(d);
  const face = designFaces(d).find((f) => f.kind === 'room' && f.wallIds.includes(w.id));
  const runs = faceRuns(face);
  const L = 12 * FT - 4 * IN;
  // Seen from inside, the face may run east → west; compare the sorted piece lengths.
  const walls = runs.walls.map((r) => r.s1 - r.s0).sort((a, b) => a - b);
  [18 * IN, 24 * IN, L - 18 * IN - 32 * IN - 24 * IN - 36 * IN].sort((a, b) => a - b).forEach((v, i) => near(walls[i], v));
  assert.deepEqual(runs.openings.map((r) => Math.round((r.s1 - r.s0) / IN)).sort(), [32, 36]);
  // Pieces and openings tile the face exactly.
  near([...runs.walls, ...runs.openings].reduce((sum, r) => sum + r.s1 - r.s0, 0), L);
  // No openings: one piece, the whole face.
  const north = designFaces(d).find((f) => f.kind === 'room' && !f.openings.length);
  assert.deepEqual(faceRuns(north), { walls: [{ s0: 0, s1: north.length }], openings: [] });
  // Stacked windows count as one span.
  const stacked = faceRuns({ length: 3000, openings: [{ s0: 1000, s1: 1600 }, { s0: 1200, s1: 1800 }] });
  assert.deepEqual(stacked.openings, [{ s0: 1000, s1: 1800 }]);
  assert.equal(stacked.walls.length, 2);
});
