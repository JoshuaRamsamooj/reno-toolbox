import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addBulkhead, addOpening, addRectangle, analyze, createDesign, freeOpeningOffset, newOpeningPlacement, newOpeningProblem,
  normalize, openingProblems, roomElevations, setWallLength, wallHeadroom,
} from '../public/js/core/model.js';
import { computeTakeoff } from '../public/js/core/takeoff.js';
import { MM_PER_FT, MM_PER_IN, MM2_PER_FT2 } from '../public/js/core/units.js';

const FT = MM_PER_FT;
const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `expected ${a} ≈ ${b}`);
const sqft = (mm2) => mm2 / MM2_PER_FT2;

// 12' × 10' room, zero-thickness walls, 8' ceiling.
function room() {
  const d = createDesign('imperial');
  d.settings.wallThickness = 0;
  d.settings.ceilingHeight = 8 * FT;
  addRectangle(d, { x: 0, y: 0 }, { x: 12 * FT, y: 10 * FT });
  normalize(d);
  const g = analyze(d).rooms[0];
  const north = g.walls.find((w) => w.compass === 'North');
  return { d, roomId: g.room.id, northWall: north.wallIds[0] };
}

function bulkhead(d, roomId, wallId, props) {
  const bh = addBulkhead(d, roomId, wallId);
  Object.assign(bh, props);
  normalize(d);
  return bh;
}

test('full-length bulkhead covers the host wall and the ends of the side walls', () => {
  const { d, roomId, northWall } = room();
  bulkhead(d, roomId, northWall, { depth: 2 * FT, bottom: 7 * FT });
  const g = analyze(d).rooms[0];
  const elev = roomElevations(d, g);
  const bands = Object.fromEntries(elev.walls.map((w) => [w.compass, w.bands.map((b) => Math.round((b.s1 - b.s0) / FT))]));
  assert.deepEqual(bands, { North: [12], East: [2], South: [], West: [2] });

  const t = computeTakeoff(d);
  near(sqft(t.totals.wallGross), 352);
  near(sqft(t.totals.wallNet), 352 - 12 - 2 - 2);
  near(sqft(t.totals.exteriorWallNet), 352, 0.01); // insulation still runs behind it
  near(sqft(t.totals.bulkheadArea), 24 + 12); // soffit + fascia, no open ends
  near(sqft(t.totals.ceilingArea), 120 - 24);
  near(sqft(t.totals.ceilingInsulation), 120);
  near(t.totals.bulkheadBead / FT, 12);
});

test('partial bulkhead adds end caps and corner bead at its open ends', () => {
  const { d, roomId, northWall } = room();
  bulkhead(d, roomId, northWall, { depth: 2 * FT, bottom: 7 * FT, start: 3 * FT, length: 4 * FT });
  const t = computeTakeoff(d);
  near(sqft(t.totals.wallNet), 352 - 4);
  near(sqft(t.totals.bulkheadArea), 8 + 4 + 2 * 2);
  near(t.totals.bulkheadBead / FT, 4 + 2 * (2 + 1));
  assert.ok(t.materials.some((m) => m.key === 'corner-bead'));
});

test('default underside follows the ceiling height and bulkheads survive plan edits', () => {
  const { d, roomId, northWall } = room();
  bulkhead(d, roomId, northWall, { depth: 2 * FT });
  d.rooms[0].ceiling.height = 9 * FT;
  let elev = roomElevations(d, analyze(d).rooms[0]);
  near(elev.bulkheads[0].bottom / FT, 8);
  setWallLength(d, northWall, 14 * FT);
  normalize(d);
  elev = roomElevations(d, analyze(d).rooms[0]);
  assert.equal(d.rooms[0].bulkheads.length, 1);
  near((elev.bulkheads[0].s1 - elev.bulkheads[0].s0) / FT, 14);
});

test('doors and windows must stay below a bulkhead on their wall', () => {
  const IN = MM_PER_IN;
  const { d, roomId, northWall } = room();
  bulkhead(d, roomId, northWall, { depth: 2 * FT, bottom: 78 * IN, start: 3 * FT, length: 4 * FT });
  const [span] = wallHeadroom(d, northWall).bulkheads;
  near((span.o1 - span.o0) / FT, 4);
  const under = (span.o0 + span.o1) / 2;
  const clear = span.o0 > 6 * FT ? 2 * FT : 10 * FT;

  // A standard 80" door doesn't fit under a 78" bulkhead; placing one shortens it.
  assert.throws(() => addOpening(d, northWall, 'door', under, { width: 32 * IN, height: 80 * IN }), /bulkhead/);
  const door = newOpeningPlacement(d, 'door', northWall, under, 32 * IN);
  near(door.height / IN, 78);
  addOpening(d, northWall, 'door', under, { width: 32 * IN, height: door.height });
  addOpening(d, northWall, 'door', clear, { width: 32 * IN, height: 80 * IN }); // not under it

  // Windows too: the default 36" sill + 48" height would reach 84".
  const { d: d2, roomId: r2, northWall: w2 } = room();
  bulkhead(d2, r2, w2, { depth: 2 * FT, bottom: 78 * IN, start: 3 * FT, length: 4 * FT });
  const [span2] = wallHeadroom(d2, w2).bulkheads;
  const mid = (span2.o0 + span2.o1) / 2;
  near(newOpeningPlacement(d2, 'window', w2, mid, 24 * IN).height / IN, 42);

  // Dragging a full-height door along the wall stops at the bulkhead's edge.
  const tall = d.openings.find((o) => o.offset === clear);
  const stop = freeOpeningOffset(d, tall, under, 12 * FT);
  assert.ok(Math.abs(stop - under) >= 2 * FT + 16 * IN - 1, `door slid under the bulkhead to ${stop / IN}"`);

  // Lowering the bulkhead into the existing door is detected.
  const before = openingProblems(d);
  assert.equal(before.size, 0);
  d.rooms[0].bulkheads[0].bottom = 70 * IN;
  assert.match(newOpeningProblem(before, d), /above the bulkhead/);
});
