import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addOpening, addRectangle, addWallChain, analyze, createDesign, deleteRoom, deleteWall, normalize,
  roomElevations, setWallLength,
} from '../public/js/core/model.js';
import { MM_PER_FT, MM_PER_IN } from '../public/js/core/units.js';

const FT = MM_PER_FT;
const near = (a, b, tol = 0.5) => assert.ok(Math.abs(a - b) <= tol, `expected ${a} ≈ ${b}`);

function design(thickness = 0) {
  const d = createDesign('imperial');
  d.settings.wallThickness = thickness;
  return d;
}

test('a rectangle produces one room with the right area', () => {
  const d = design();
  addRectangle(d, { x: 0, y: 0 }, { x: 12 * FT, y: 10 * FT });
  normalize(d);
  assert.equal(d.walls.length, 4);
  assert.equal(d.rooms.length, 1);
  const { rooms } = analyze(d);
  near(rooms[0].area, 120 * FT * FT, 1);
  assert.equal(rooms[0].walls.length, 4);
});

test('interior polygon is inset by half the wall thickness', () => {
  const d = design(4.5 * MM_PER_IN);
  addRectangle(d, { x: 0, y: 0 }, { x: 12 * FT, y: 10 * FT });
  normalize(d);
  const g = analyze(d).rooms[0];
  const lengths = g.walls.map((w) => w.length).sort((a, b) => a - b);
  near(lengths[0], 10 * FT - 4.5 * MM_PER_IN);
  near(lengths[3], 12 * FT - 4.5 * MM_PER_IN);
  assert.ok(g.walls.every((w) => w.exterior));
});

test('adjacent rectangles share a wall and form two rooms', () => {
  const d = design();
  addRectangle(d, { x: 0, y: 0 }, { x: 10 * FT, y: 10 * FT });
  normalize(d);
  // Second room shares the right edge but is shorter, creating a T-junction.
  addRectangle(d, { x: 10 * FT, y: 0 }, { x: 20 * FT, y: 6 * FT });
  normalize(d);
  assert.equal(d.rooms.length, 2);
  const { rooms, wallInfo } = analyze(d);
  const areas = rooms.map((r) => r.area / (FT * FT)).sort((a, b) => a - b);
  near(areas[0], 60, 0.01);
  near(areas[1], 100, 0.01);
  const interior = [...wallInfo.values()].filter((i) => !i.exterior);
  assert.equal(interior.length, 1, 'only the shared segment is interior');
  // The big room's east side is two collinear segments merged into one face.
  const big = rooms.find((r) => r.area > 80 * FT * FT);
  assert.equal(big.walls.length, 4);
});

test('a wall drawn across a room splits it, keeping the original name on one side', () => {
  const d = design();
  addRectangle(d, { x: 0, y: 0 }, { x: 20 * FT, y: 10 * FT });
  normalize(d);
  d.rooms[0].name = 'Living';
  addWallChain(d, [{ x: 8 * FT, y: -2 * FT }, { x: 8 * FT, y: 12 * FT }]);
  normalize(d);
  assert.equal(d.rooms.length, 2);
  assert.ok(d.rooms.some((r) => r.name === 'Living'));
  // Stubs outside the rectangle are kept as walls, but don't create rooms.
  assert.equal(d.walls.length, 4 + 3 + 2);
});

test('deleting a dividing wall merges rooms and heals the split walls', () => {
  const d = design();
  addRectangle(d, { x: 0, y: 0 }, { x: 20 * FT, y: 10 * FT });
  addWallChain(d, [{ x: 8 * FT, y: 0 }, { x: 8 * FT, y: 10 * FT }]);
  normalize(d);
  assert.equal(d.rooms.length, 2);
  const divider = d.walls.find((w) => {
    const a = d.nodes.find((n) => n.id === w.a);
    const b = d.nodes.find((n) => n.id === w.b);
    return Math.abs(a.x - 8 * FT) < 1 && Math.abs(b.x - 8 * FT) < 1;
  });
  deleteWall(d, divider.id);
  normalize(d);
  assert.equal(d.rooms.length, 1);
  assert.equal(d.walls.length, 4);
});

test('openings follow wall splits and merges', () => {
  const d = design();
  addRectangle(d, { x: 0, y: 0 }, { x: 20 * FT, y: 10 * FT });
  normalize(d);
  const top = d.walls.find((w) => {
    const a = d.nodes.find((n) => n.id === w.a);
    const b = d.nodes.find((n) => n.id === w.b);
    return a.y === 0 && b.y === 0;
  });
  const door = addOpening(d, top.id, 'door', 15 * FT);
  addWallChain(d, [{ x: 8 * FT, y: 0 }, { x: 8 * FT, y: 10 * FT }]);
  normalize(d);
  const wall = d.walls.find((w) => w.id === door.wallId);
  const a = d.nodes.find((n) => n.id === wall.a);
  near(a.x + door.offset * Math.sign(d.nodes.find((n) => n.id === wall.b).x - a.x), 15 * FT);
});

test('setWallLength stretches the plan and keeps rooms rectangular', () => {
  const d = design();
  addRectangle(d, { x: 0, y: 0 }, { x: 12 * FT, y: 10 * FT });
  normalize(d);
  const top = d.walls.find((w) => {
    const a = d.nodes.find((n) => n.id === w.a);
    const b = d.nodes.find((n) => n.id === w.b);
    return a.y === 0 && b.y === 0;
  });
  setWallLength(d, top.id, 14 * FT);
  normalize(d);
  near(analyze(d).rooms[0].area, 140 * FT * FT, 1);
});

test('deleteRoom keeps walls shared with neighbours', () => {
  const d = design();
  addRectangle(d, { x: 0, y: 0 }, { x: 10 * FT, y: 10 * FT });
  addRectangle(d, { x: 10 * FT, y: 0 }, { x: 20 * FT, y: 10 * FT });
  normalize(d);
  const right = analyze(d).rooms.find((r) => r.labelPoint.x > 10 * FT).room;
  deleteRoom(d, right.id);
  normalize(d);
  assert.equal(d.rooms.length, 1);
  assert.equal(d.walls.length, 4);
});

test('gable ceiling gives a peaked elevation on the gable-end walls', () => {
  const d = design();
  d.settings.ceilingHeight = 8 * FT;
  addRectangle(d, { x: 0, y: 0 }, { x: 12 * FT, y: 10 * FT });
  normalize(d);
  d.rooms[0].ceiling = { type: 'gable', ridge: 'EW', height: 8 * FT, peak: 12 * FT };
  const g = analyze(d).rooms[0];
  const elev = roomElevations(d, g);
  const east = elev.walls.find((w) => w.compass === 'East');
  const north = elev.walls.find((w) => w.compass === 'North');
  assert.equal(east.profile.length, 3);
  near(Math.max(...east.profile.map((p) => p.z)), 12 * FT);
  assert.ok(north.profile.every((p) => Math.abs(p.z - 8 * FT) < 0.5));
  // Sloped area: run 5', rise 4' → factor sqrt(1 + 0.64)
  near(elev.model.area, 120 * FT * FT * Math.sqrt(1 + 0.64), 10);
});

test('crossing walls are split at the intersection', () => {
  const d = design();
  addWallChain(d, [{ x: 0, y: 5 * FT }, { x: 10 * FT, y: 5 * FT }]);
  addWallChain(d, [{ x: 5 * FT, y: 0 }, { x: 5 * FT, y: 10 * FT }]);
  normalize(d);
  assert.equal(d.walls.length, 4);
  assert.equal(d.nodes.length, 5);
});
