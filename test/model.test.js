import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addOpening, addRectangle, addWallChain, analyze, createDesign, deleteRoom, deleteWall, freeOpeningOffset, newOpeningPlacement, normalize,
  openingsConflict, roomElevations, setWallLength,
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

test('openings cannot overlap, except windows stacked clear of each other', () => {
  const d = design();
  addRectangle(d, { x: 0, y: 0 }, { x: 20 * FT, y: 10 * FT });
  normalize(d);
  const wallId = d.walls[0].id;
  const IN = MM_PER_IN;
  const win = addOpening(d, wallId, 'window', 5 * FT, { width: 36 * IN, height: 48 * IN, sill: 36 * IN });

  // Anything overlapping along the wall at the same height is refused.
  for (const type of ['window', 'door', 'opening']) {
    assert.throws(() => addOpening(d, wallId, type, 6 * FT, { width: 36 * IN }), /overlap/);
  }
  assert.equal(d.openings.length, 1);

  // Touching side by side is fine.
  addOpening(d, wallId, 'door', 5 * FT + 36 * IN, { width: 36 * IN });

  // A window stacked above must start strictly above the lower one's top (84").
  const above = { id: 'x', wallId, type: 'window', offset: 5 * FT, width: 24 * IN, height: 12 * IN };
  assert.ok(openingsConflict(win, { ...above, sill: 84 * IN }));
  assert.ok(!openingsConflict(win, { ...above, sill: 85 * IN }));
  assert.ok(openingsConflict(win, { ...above, type: 'door', sill: 0 }));
  addOpening(d, wallId, 'window', 5 * FT, { width: 24 * IN, height: 10 * IN, sill: 85 * IN }); // top 95", under the 8' ceiling
  assert.equal(d.openings.length, 3);

  // Dragging slides an opening up against its neighbour instead of into it.
  const door = addOpening(d, wallId, 'door', 15 * FT, { width: 32 * IN });
  const L = 20 * FT;
  near(freeOpeningOffset(d, door, 5 * FT + 40 * IN, L), 5 * FT + 54 * IN + 16 * IN);
});

test('a window clicked onto a window stacks above it, under the ceiling', () => {
  const d = design();
  d.settings.ceilingHeight = 10 * FT;
  addRectangle(d, { x: 0, y: 0 }, { x: 20 * FT, y: 10 * FT });
  normalize(d);
  const wallId = d.walls[0].id;
  const IN = MM_PER_IN;
  addOpening(d, wallId, 'window', 5 * FT, { width: 36 * IN }); // default 36" sill, 48" tall → top 84"

  const place = newOpeningPlacement(d, 'window', wallId, 5 * FT, 36 * IN);
  near(place.sill, 85 * IN);
  near(place.height, 120 * IN - 85 * IN); // shortened to fit under the 10' ceiling
  addOpening(d, wallId, 'window', 5 * FT, { width: 36 * IN, ...place });
  assert.equal(d.openings.length, 2);

  // No room left for a third, and a door is never stacked on.
  assert.match(newOpeningPlacement(d, 'window', wallId, 5 * FT, 36 * IN).blocked, /No room/);
  addOpening(d, wallId, 'door', 12 * FT, { width: 32 * IN });
  assert.match(newOpeningPlacement(d, 'window', wallId, 12 * FT, 36 * IN).blocked, /door/);
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

test('tray ceilings show above each wall at the tray height, inset from the corners', () => {
  const d = design();
  addRectangle(d, { x: 0, y: 0 }, { x: 16 * FT, y: 12 * FT });
  normalize(d);
  d.rooms[0].ceiling = { ...d.rooms[0].ceiling, type: 'tray', height: 8 * FT, trayDepth: 12 * MM_PER_IN, trayInset: 24 * MM_PER_IN };
  const g = analyze(d).rooms[0];
  const elev = roomElevations(d, g);
  for (const w of elev.walls) {
    near(w.profile[0].z, 8 * FT); // the walls stop at the perimeter height…
    near(w.tray.bottom, 8 * FT); // …and the tray rises above them
    near(w.tray.top, 9 * FT);
    near(w.tray.s0, 24 * MM_PER_IN);
    near(w.tray.s1, w.length - 24 * MM_PER_IN);
  }
  d.rooms[0].ceiling.type = 'flat';
  assert.ok(roomElevations(d, analyze(d).rooms[0]).walls.every((w) => w.tray === null));
});
