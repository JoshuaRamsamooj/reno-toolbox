import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addOpening, addRectangle, analyze, createDesign, deleteRoom, migrateDesign, normalize } from '../public/js/core/model.js';
import {
  assignRooms, bestFit, centredOrigin, createRun, layoutRun, resolveRun, roomRun, runAtPoint, snapOrigin, syncFloorRuns,
} from '../public/js/core/flooring.js';
import { computeTakeoff, takeoffToCsv } from '../public/js/core/takeoff.js';
import { MM_PER_FT, MM_PER_IN, MM2_PER_FT2 } from '../public/js/core/units.js';

const FT = MM_PER_FT;
const IN = MM_PER_IN;
const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `expected ${a} ≈ ${b}`);

/** A w × h room (in inches) with zero-thickness walls, so its floor is exactly w × h. */
function room(w, h) {
  const d = createDesign('imperial');
  d.settings.wallThickness = 0;
  addRectangle(d, { x: 0, y: 0 }, { x: w * IN, y: h * IN });
  normalize(d);
  return d;
}

/** A run placed by hand (no best fit): origin at the room's corner, no gap. */
function addRun(d, fields) {
  const run = createRun(d, fields.kind ?? 'plank', [d.rooms[0].id]);
  Object.assign(run, { gap: 0, origin: { x: 0, y: 0 }, angle: 0, preset: 'custom', ...fields });
  return run;
}

/** Two 12' × 10' rooms with 4 1/2" walls and a 36" cased opening in the shared wall. */
function twoRooms() {
  const d = createDesign('imperial');
  addRectangle(d, { x: 0, y: 0 }, { x: 12 * FT, y: 10 * FT });
  addRectangle(d, { x: 12 * FT, y: 0 }, { x: 24 * FT, y: 10 * FT });
  normalize(d);
  const shared = d.walls.find((w) => [w.a, w.b].every((id) => Math.abs(d.nodes.find((n) => n.id === id).x - 12 * FT) < 1));
  addOpening(d, shared.id, 'opening', 5 * FT, { width: 36 * IN });
  normalize(d);
  return d;
}

test('a square tile grid that fits exactly needs only full tiles', () => {
  const d = room(120, 96);
  const run = addRun(d, { kind: 'tile', length: 12 * IN, width: 12 * IN, joint: 0, perBox: 15, waste: 5, stagger: { mode: 'fixed', offset: 0 } });
  const la = layoutRun(d, run);
  assert.equal(la.stats.pieces, 80);
  assert.equal(la.stats.cut, 0);
  assert.equal(la.material.stock, 80);
  assert.equal(la.material.order, 84); // 80 + 5%
  assert.equal(la.material.boxes, 6); // 84 / 15 per box
  near(la.material.netArea / MM2_PER_FT2, 80, 1e-6);
  assert.equal(la.ends.v.first, 12 * IN);
  assert.equal(la.ends.u.last, 12 * IN);
});

test('grout widens the pitch and the cuts come from the remainder', () => {
  const d = room(120, 96);
  const run = addRun(d, { kind: 'tile', length: 12 * IN, width: 12 * IN, joint: IN / 4, stagger: { mode: 'fixed', offset: 0 } });
  const la = layoutRun(d, run);
  // 12 1/4" pitch: 9 full columns (110 1/4") + a 9 3/4" cut; 7 full rows + 10 1/4" cut.
  near(la.ends.u.last, 9.75 * IN);
  near(la.ends.v.last, 10.25 * IN);
  assert.equal(la.stats.full, 63);
  assert.equal(la.stats.pieces, 80);
});

test('plank end cuts reuse offcuts from earlier rows', () => {
  // 108" rows of 48" boards: 2 full + a 12" cut per row. One board gives 12", then 12" from the 33" offcut, then
  // 12" from the 18" one (3" kerf each), so 16 rows need 32 full + 6 boards for the cuts.
  const d = room(108, 96);
  const run = addRun(d, { length: 48 * IN, width: 6 * IN, stagger: { mode: 'fixed', offset: 0 } });
  const la = layoutRun(d, run);
  assert.equal(la.stats.full, 32);
  assert.equal(la.stats.cut, 16);
  assert.equal(la.material.stock, 38);
  assert.equal(la.material.reused, 10);
  assert.equal(la.stats.slivers, 0);
});

test('short plank ends and narrow rips are graded as slivers or warnings', () => {
  const d = room(100, 95);
  const run = addRun(d, { length: 48 * IN, width: 5 * IN, minCut: 6 * IN, stagger: { mode: 'fixed', offset: 0 } });
  const la = layoutRun(d, run);
  // 100" = 2 × 48" + a 4" end (below 6"); 95" = 19 rows exactly, no rip.
  assert.equal(la.stats.slivers, 19);
  near(la.stats.shortestEnd.needL, 4 * IN);
  assert.equal(la.stats.narrowestRip, null);
  assert.ok(la.guidance.some((g) => g.title === 'End pieces' && g.status === 'warn'));
  assert.ok(la.guidance.some((g) => g.title === 'Slivers' && g.status === 'warn'));
});

test('best fit balances the first and last rows and clears slivers', () => {
  // 96" across 5" boards: flush with the north wall leaves a 1" last row.
  const d = room(120, 96);
  const run = addRun(d, { length: 48 * IN, width: 5 * IN, stagger: { mode: 'fixed', offset: 16 * IN } });
  const before = layoutRun(d, run);
  near(before.ends.v.last, 1 * IN);
  assert.ok(before.stats.slivers > 0);
  run.origin = bestFit(d, run);
  const after = layoutRun(d, run);
  near(after.ends.v.first, after.ends.v.last, 0.5);
  assert.ok(after.ends.v.first >= 2.5 * IN - 0.5, `first row ${after.ends.v.first / IN}"`);
  assert.equal(after.stats.slivers, 0);
  assert.ok(after.score < before.score);
});

test('random stagger keeps the minimum joint spacing and end length in every row', () => {
  const d = room(150, 130);
  const run = addRun(d, { length: 48 * IN, width: 7 * IN, minCut: 6 * IN, stagger: { mode: 'random', min: 8 * IN, seed: 3 } });
  const la = layoutRun(d, run);
  assert.ok(la.stats.joints.adjacent >= 8 * IN - 0.5, `adjacent ${la.stats.joints.adjacent / IN}"`);
  assert.ok(la.stats.shortestEnd.needL >= 6 * IN - 0.5, `shortest end ${la.stats.shortestEnd.needL / IN}"`);
  // Deterministic for a seed; a new seed reshuffles.
  const again = layoutRun(d, run);
  assert.deepEqual(again.pieces.map((p) => p.u0), la.pieces.map((p) => p.u0));
  run.stagger.seed = 4;
  assert.notDeepEqual(layoutRun(d, run).pieces.map((p) => p.u0), la.pieces.map((p) => p.u0));
});

test('center tile and center joint put the pattern on the room centre', () => {
  const d = room(126, 96);
  const run = addRun(d, { kind: 'tile', length: 12 * IN, width: 12 * IN, joint: 0, stagger: { mode: 'fixed', offset: 0 } });
  run.origin = centredOrigin(d, run, 'tile');
  let la = layoutRun(d, run);
  near(la.ends.u.first, la.ends.u.last);
  near(la.ends.u.first, 9 * IN); // a tile centred on 63" leaves 9" at each wall
  near(la.ends.v.first, 6 * IN); // and on 48", 6"
  run.origin = centredOrigin(d, run, 'joint');
  la = layoutRun(d, run);
  near(la.ends.v.first, 12 * IN);
  near(la.ends.u.first, 3 * IN); // 63" from the joint to each wall: 5 tiles + 3"
  near(la.ends.u.first, la.ends.u.last);
});

test('a shared run continues through the doorway between its rooms', () => {
  const d = twoRooms();
  const [a, b] = d.rooms;
  const run = createRun(d, 'plank', [a.id, b.id]);
  normalize(d);
  const la = layoutRun(d, run);
  assert.equal(la.region.parts.filter((p) => p.kind === 'threshold').length, 1);
  const across = la.pieces.filter((p) => p.roomIds.length === 2);
  assert.ok(across.length > 0, 'boards run from one room through the opening into the other');
  assert.ok(across.every((p) => p.threshold));
  // One continuous pattern: a separate run per room would restart at each wall.
  assert.equal(roomRun(d, a.id, 'finish'), roomRun(d, b.id, 'finish'));
  const doorway = la.region.parts.find((p) => p.kind === 'threshold').polygon;
  const mid = { x: doorway.reduce((s, p) => s + p.x, 0) / 4, y: doorway.reduce((s, p) => s + p.y, 0) / 4 };
  assert.equal(runAtPoint(d, mid)?.id, run.id);
  assert.ok(la.guidance.some((g) => g.title === 'Continuous run'));
});

test('separate runs per room each start their own pattern', () => {
  const d = twoRooms();
  const [a, b] = d.rooms;
  const ra = createRun(d, 'tile', [a.id]);
  const rb = createRun(d, 'tile', [b.id]);
  normalize(d);
  assert.notEqual(ra.id, rb.id);
  assert.equal(layoutRun(d, ra).region.parts.some((p) => p.kind === 'threshold'), false);
  assert.ok(layoutRun(d, rb).pieces.every((p) => p.roomIds.length === 1 && p.roomIds[0] === b.id));
});

test('rooms keep one run per layer, runs follow room deletions', () => {
  const d = twoRooms();
  const [a, b] = d.rooms;
  const plank = createRun(d, 'plank', [a.id]);
  const tile = createRun(d, 'tile', [b.id]);
  const sub = createRun(d, 'subfloor', [a.id, b.id]);
  assignRooms(d, plank.id, [b.id]); // moves b out of the tile run, which empties
  normalize(d);
  assert.equal(d.floorRuns.find((r) => r.id === tile.id), undefined);
  assert.deepEqual(roomRun(d, b.id, 'finish').id, plank.id);
  assert.equal(roomRun(d, b.id, 'subfloor').id, sub.id, 'subfloor is its own layer');
  // A room listed by two runs on a layer stays with the first.
  d.floorRuns.push({ ...plank, id: 'dupe', roomIds: [a.id] });
  syncFloorRuns(d);
  assert.equal(d.floorRuns.find((r) => r.id === 'dupe'), undefined);
  deleteRoom(d, a.id);
  normalize(d);
  assert.deepEqual(d.floorRuns.find((r) => r.id === plank.id).roomIds, [b.id]);
});

test('runs survive save/load and bad records are dropped', () => {
  const d = room(120, 96);
  const run = createRun(d, 'tile', [d.rooms[0].id]);
  const loaded = migrateDesign(JSON.parse(JSON.stringify({ ...d, floorRuns: [...d.floorRuns, { id: 'x', kind: 'carpet', roomIds: [] }, null] })));
  normalize(loaded);
  assert.equal(loaded.floorRuns.length, 1);
  assert.deepEqual(loaded.floorRuns[0], run);
  assert.deepEqual(migrateDesign({ nodes: [], walls: [] }).floorRuns, []);
});

test('new runs follow the longest wall, or cross the joists for subfloor sheets', () => {
  const d = room(96, 180); // longer north–south
  const plank = createRun(d, 'plank', [d.rooms[0].id]);
  assert.equal(plank.angle, 90);
  d.settings.joists = 'NS';
  const sheet = createRun(d, 'subfloor', [d.rooms[0].id]);
  assert.equal(sheet.angle, 0, 'sheets run across north–south joists');
  assert.equal(resolveRun(sheet, d.units).unit, 'sheet');
  sheet.angle = 90;
  const la = layoutRun(d, sheet);
  assert.equal(la.guidance.find((g) => g.title === 'Strength axis').status, 'warn');
});

test('tile guidance checks the ANSI offset limit, grout and movement joints', () => {
  const d = room(300, 120);
  const run = addRun(d, { kind: 'tile', length: 24 * IN, width: 12 * IN, joint: IN / 8, gap: IN / 4, stagger: { mode: 'fixed', offset: 12 * IN + IN / 16 } });
  let g = layoutRun(d, run).guidance;
  assert.equal(g.find((x) => x.title === 'Offset').status, 'warn', 'half offset on a 24" tile');
  assert.equal(g.find((x) => x.title === 'Field movement joints').status, 'warn', '25\' floor');
  assert.equal(g.find((x) => x.title === 'Grout joint').status, 'ok');
  run.stagger.offset = (24 * IN + IN / 8) / 3;
  run.joint = 1;
  g = layoutRun(d, run).guidance;
  assert.equal(g.find((x) => x.title === 'Offset').status, 'ok');
  assert.equal(g.find((x) => x.title === 'Grout joint').status, 'warn');
});

test('dragging snaps a row edge to a wall corner', () => {
  const d = room(120, 96);
  const run = addRun(d, { length: 48 * IN, width: 5 * IN, stagger: { mode: 'fixed', offset: 16 * IN } });
  const la = layoutRun(d, run);
  const s = snapOrigin(la, { x: 30, y: 4 }, 10);
  near(s.origin.y, 0); // course edge back on the north wall
  assert.ok(s.targets.length > 0);
  const free = snapOrigin(la, { x: 30, y: 40 }, 10);
  near(free.origin.y, 40);
});

test('the takeoff counts laid-out rooms from their run and the rest by area', () => {
  const d = twoRooms();
  const [a] = d.rooms;
  const run = createRun(d, 'plank', [a.id]);
  normalize(d);
  const t = computeTakeoff(d);
  const line = t.materials.find((m) => m.key === `floor:${run.id}`);
  const la = layoutRun(d, run);
  assert.equal(line.quantity, la.material.boxes);
  assert.equal(line.unit, 'boxes');
  assert.match(line.label, /Vinyl plank 7" × 48"/);
  const generic = t.materials.find((m) => m.key === 'flooring');
  assert.match(generic.label, /without a layout/);
  near(generic.quantity, (t.rooms[1].q.floorArea / MM2_PER_FT2) * 1.1);
  assert.match(takeoffToCsv(d, t), /Vinyl plank/);
  // Every room laid out: no area-based line at all.
  assignRooms(d, run.id, d.rooms.map((r) => r.id));
  normalize(d);
  assert.equal(computeTakeoff(d).materials.find((m) => m.key === 'flooring'), undefined);
});

test('the waste allowance and box size drive the order', () => {
  const d = room(120, 96);
  const run = addRun(d, { kind: 'tile', length: 12 * IN, width: 12 * IN, joint: 0, perBox: 10, waste: 15, stagger: { mode: 'fixed', offset: 0 } });
  const la = layoutRun(d, run);
  assert.equal(la.material.order, 92); // 80 × 1.15
  assert.equal(la.material.boxes, 10);
  assert.equal(la.material.buy, 100);
  near(la.material.coverage / MM2_PER_FT2, 100, 1e-6);
});

test('the expansion gap shrinks the floor laid', () => {
  const d = room(120, 96);
  const run = addRun(d, { length: 48 * IN, width: 6 * IN, gap: IN / 2, stagger: { mode: 'fixed', offset: 0 } });
  const la = layoutRun(d, run);
  near(la.material.netArea, 119 * 95 * IN * IN, 1);
  const g = analyze(d).rooms[0];
  assert.ok(la.region.parts[0].polygon.every((p) => p.x >= g.polygon[0].x - 1));
});
