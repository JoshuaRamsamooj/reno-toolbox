import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addBulkhead, addRectangle, analyze, createDesign, normalize, roomElevations, setWallLength } from '../public/js/core/model.js';
import { computeTakeoff } from '../public/js/core/takeoff.js';
import { MM_PER_FT, MM2_PER_FT2 } from '../public/js/core/units.js';

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
