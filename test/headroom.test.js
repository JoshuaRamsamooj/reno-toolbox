// Openings must stay below the ceiling (and bulkheads) above them. Each
// test simulates an edit the way App.change() checks it: problems before,
// edit, normalize, then look for a new problem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addOpening, addRectangle, addWallChain, analyze, createDesign, freeOpeningOffset, newOpeningPlacement,
  newOpeningProblem, normalize, openingProblem, openingProblems, setWallLength, wallHeadroom, wallLength,
} from '../public/js/core/model.js';
import { MM_PER_FT, MM_PER_IN } from '../public/js/core/units.js';

const FT = MM_PER_FT;
const IN = MM_PER_IN;
const near = (a, b, tol = 0.5) => assert.ok(Math.abs(a - b) <= tol, `expected ${a} ≈ ${b}`);

// 12' × 10' room, zero-thickness walls, 8' (96") ceiling.
function room() {
  const d = createDesign('imperial');
  d.settings.wallThickness = 0;
  d.settings.ceilingHeight = 8 * FT;
  addRectangle(d, { x: 0, y: 0 }, { x: 12 * FT, y: 10 * FT });
  normalize(d);
  const g = analyze(d).rooms[0];
  const wall = (compass) => g.walls.find((w) => w.compass === compass).wallIds[0];
  return { d, wall };
}

/** Applies an edit like App.change() and returns the problem it introduces, if any. */
function tryEdit(d, fn) {
  const before = openingProblems(d);
  fn(d);
  normalize(d);
  return newOpeningProblem(before, d);
}

const find = (d, o) => d.openings.find((x) => x.id === o.id);

test('raising a window sill pushes its top through the ceiling', () => {
  const { d, wall } = room();
  const win = addOpening(d, wall('North'), 'window', 6 * FT, { width: 36 * IN, sill: 36 * IN, height: 48 * IN });
  assert.equal(tryEdit(d, (x) => { find(x, win).sill = 48 * IN; }), null); // top exactly at the ceiling is fine
  assert.match(tryEdit(d, (x) => { find(x, win).sill = 49 * IN; }), /top of the window would be above the ceiling/);
});

test('a taller window reaches through the ceiling', () => {
  const { d, wall } = room();
  const win = addOpening(d, wall('North'), 'window', 6 * FT, { width: 36 * IN, sill: 36 * IN, height: 48 * IN });
  assert.match(tryEdit(d, (x) => { find(x, win).height = 61 * IN; }), /above the ceiling/);
});

test('doors and cased openings cannot be taller than the ceiling', () => {
  const { d, wall } = room();
  const door = addOpening(d, wall('North'), 'door', 3 * FT, { width: 32 * IN });
  const opening = addOpening(d, wall('North'), 'opening', 9 * FT, { width: 36 * IN });
  assert.match(tryEdit(d, (x) => { find(x, door).height = 97 * IN; }), /top of the door would be above the ceiling/);
  assert.match(tryEdit(d, (x) => { find(x, opening).height = 97 * IN; }), /top of the opening would be above the ceiling/);
});

test('changing a high window into a door keeps it under the ceiling', () => {
  const { d, wall } = room();
  const win = addOpening(d, wall('North'), 'window', 6 * FT, { width: 36 * IN, sill: 60 * IN, height: 30 * IN });
  // A door ignores the sill and stands on the floor, so its height is what counts.
  assert.equal(tryEdit(d, (x) => { find(x, win).type = 'door'; }), null);
  assert.match(tryEdit(d, (x) => { Object.assign(find(x, win), { type: 'door', height: 100 * IN }); }), /above the ceiling/);
});

test('adding an opening taller than the ceiling is refused', () => {
  const { d, wall } = room();
  assert.throws(() => addOpening(d, wall('North'), 'door', 6 * FT, { width: 32 * IN, height: 100 * IN }), /above the ceiling/);
  assert.equal(d.openings.length, 0);
});

test('lowering the room ceiling under existing openings is refused', () => {
  const { d, wall } = room();
  addOpening(d, wall('North'), 'window', 6 * FT, { width: 36 * IN, sill: 36 * IN, height: 48 * IN }); // top 84"
  assert.equal(tryEdit(d, (x) => { x.rooms[0].ceiling.height = 84 * IN; }), null);
  assert.match(tryEdit(d, (x) => { x.rooms[0].ceiling.height = 80 * IN; }), /above the ceiling/);
});

test('lowering the default ceiling height only matters to rooms that inherit it', () => {
  const { d, wall } = room();
  addOpening(d, wall('North'), 'door', 6 * FT, { width: 32 * IN, height: 80 * IN });
  assert.match(tryEdit(structuredClone(d), (x) => { x.settings.ceilingHeight = 78 * IN; }), /above the ceiling/);
  d.rooms[0].ceiling.height = 8 * FT; // explicit height: no longer follows the default
  assert.equal(tryEdit(d, (x) => { x.settings.ceilingHeight = 78 * IN; }), null);
});

test('switching a gable ceiling to flat strands a window in the gable end', () => {
  const { d, wall } = room();
  // Ridge runs east–west, so the east wall is a gable end peaking at 12' in its middle.
  Object.assign(d.rooms[0].ceiling, { type: 'gable', ridge: 'EW', peak: 12 * FT });
  normalize(d);
  const east = wall('East');
  const L = wallLength(d, d.walls.find((w) => w.id === east));
  addOpening(d, east, 'window', L / 2, { width: 24 * IN, sill: 96 * IN, height: 30 * IN });
  assert.match(tryEdit(d, (x) => { x.rooms[0].ceiling.type = 'flat'; }), /above the ceiling/);
});

test('a window slid along a sloped wall stops where the ceiling comes down to it', () => {
  const { d, wall } = room();
  // Shed rising to the north: 8' at the south wall, 10' at the north wall.
  Object.assign(d.rooms[0].ceiling, { type: 'shed', dir: 'N', peak: 10 * FT });
  normalize(d);
  const east = wall('East');
  const L = wallLength(d, d.walls.find((w) => w.id === east));
  const profile = wallHeadroom(d, east).ceilings[0];
  const highEnd = profile[0].z > profile.at(-1).z ? 0 : L;
  const lowEnd = L - highEnd;
  const half = 12 * IN;
  const startAt = highEnd === 0 ? 2 * FT : L - 2 * FT;
  const win = addOpening(d, east, 'window', startAt, { width: 2 * half, sill: 84 * IN, height: 24 * IN }); // top 108"

  // Moving it to the low end (96") is refused...
  const lowAt = lowEnd === 0 ? 2 * FT : L - 2 * FT;
  assert.match(tryEdit(structuredClone(d), (x) => { x.openings[0].offset = lowAt; }), /above the ceiling/);

  // ...and dragging it there stops right where the ceiling is 108".
  const stop = freeOpeningOffset(d, win, lowAt, L);
  assert.equal(openingProblem(d, { ...win, offset: stop }), null);
  const towardLow = Math.sign(lowAt - stop);
  assert.match(openingProblem(d, { ...win, offset: stop + towardLow * IN }), /above the ceiling/);
  near(Math.abs(stop - L / 2), half, 1); // ceiling is 108" at mid-wall, so the low edge stops there
});

test('a new opening is shortened to fit a low ceiling, or refused when there is no headroom', () => {
  const { d, wall } = room();
  d.rooms[0].ceiling.height = 78 * IN;
  normalize(d);
  near(newOpeningPlacement(d, 'door', wall('North'), 3 * FT, 32 * IN).height / IN, 78);
  near(newOpeningPlacement(d, 'window', wall('North'), 9 * FT, 36 * IN).height / IN, 42); // sill 36" stays

  d.rooms[0].ceiling.height = 40 * IN;
  normalize(d);
  assert.match(newOpeningPlacement(d, 'window', wall('North'), 9 * FT, 36 * IN).blocked, /headroom/);
});

test('a wall shared by two rooms is limited by the lower ceiling', () => {
  const d = createDesign('imperial');
  d.settings.wallThickness = 0;
  d.settings.ceilingHeight = 8 * FT;
  addRectangle(d, { x: 0, y: 0 }, { x: 10 * FT, y: 10 * FT });
  addRectangle(d, { x: 10 * FT, y: 0 }, { x: 20 * FT, y: 10 * FT });
  normalize(d);
  const { wallInfo } = analyze(d);
  const shared = [...wallInfo.values()].find((i) => !i.exterior).wall.id;
  d.rooms[0].ceiling.height = 9 * FT;
  d.rooms[1].ceiling.height = 7 * FT;
  normalize(d);
  assert.throws(() => addOpening(d, shared, 'door', 5 * FT, { width: 32 * IN, height: 86 * IN }), /above the ceiling \(7'/);
  addOpening(d, shared, 'door', 5 * FT, { width: 32 * IN, height: 84 * IN });
});

test('a wall that bounds no room is limited by the default ceiling height', () => {
  const d = createDesign('imperial');
  d.settings.wallThickness = 0;
  d.settings.ceilingHeight = 8 * FT;
  addWallChain(d, [{ x: 0, y: 0 }, { x: 12 * FT, y: 0 }]);
  normalize(d);
  const id = d.walls[0].id;
  assert.throws(() => addOpening(d, id, 'door', 6 * FT, { width: 32 * IN, height: 97 * IN }), /above the ceiling/);
  addOpening(d, id, 'door', 6 * FT, { width: 32 * IN, height: 96 * IN });
});

test('shortening a wall until its openings collide is refused', () => {
  const { d, wall } = room();
  const north = wall('North');
  addOpening(d, north, 'door', 2 * FT, { width: 32 * IN });
  addOpening(d, north, 'window', 10 * FT, { width: 36 * IN });
  assert.match(tryEdit(d, (x) => setWallLength(x, north, 5 * FT)), /overlap/);
});
