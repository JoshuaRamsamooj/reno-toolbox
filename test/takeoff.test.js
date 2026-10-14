import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addOpening, addRectangle, createDesign, normalize } from '../public/js/core/model.js';
import { computeTakeoff, takeoffToCsv } from '../public/js/core/takeoff.js';
import { MM_PER_FT, MM_PER_IN, MM2_PER_FT2 } from '../public/js/core/units.js';

const FT = MM_PER_FT;
const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `expected ${a} ≈ ${b}`);
const sqft = (mm2) => mm2 / MM2_PER_FT2;

function twoRooms() {
  const d = createDesign('imperial');
  d.settings.wallThickness = 0;
  d.settings.ceilingHeight = 8 * FT;
  addRectangle(d, { x: 0, y: 0 }, { x: 10 * FT, y: 10 * FT });
  addRectangle(d, { x: 10 * FT, y: 0 }, { x: 20 * FT, y: 6 * FT });
  normalize(d);
  return d;
}

test('wall, floor and ceiling quantities for two rooms', () => {
  const d = twoRooms();
  const t = computeTakeoff(d);
  near(sqft(t.totals.floorArea), 160);
  near(sqft(t.totals.ceilingArea), 160);
  // Perimeters 40' and 32', 8' walls.
  near(sqft(t.totals.wallGross), (40 + 32) * 8);
  // Shared segment (6' × 8') is interior on both sides; everything else is exterior.
  near(sqft(t.totals.exteriorWallNet), (40 + 32) * 8 - 2 * 6 * 8);
});

test('openings reduce wall area and baseboard, and add casing', () => {
  const d = twoRooms();
  // Door in the shared wall (x = 10', from y=0 to 6'), window on the big room's west wall.
  const shared = d.walls.find((w) => {
    const [a, b] = [w.a, w.b].map((id) => d.nodes.find((n) => n.id === id));
    return Math.abs(a.x - 10 * FT) < 1 && Math.abs(b.x - 10 * FT) < 1 && Math.max(a.y, b.y) <= 6 * FT + 1;
  });
  addOpening(d, shared.id, 'door', 3 * FT, { width: 32 * MM_PER_IN, height: 80 * MM_PER_IN });
  const west = d.walls.find((w) => {
    const [a, b] = [w.a, w.b].map((id) => d.nodes.find((n) => n.id === id));
    return a.x === 0 && b.x === 0;
  });
  addOpening(d, west.id, 'window', 5 * FT, { width: 3 * FT, height: 4 * FT, sill: 3 * FT });
  const t = computeTakeoff(d);
  const doorArea = (32 / 12) * (80 / 12);
  near(sqft(t.totals.openingArea), 2 * doorArea + 12);
  near(sqft(t.totals.exteriorWallNet), (40 + 32) * 8 - 96 - 12);
  near(t.totals.baseboard / FT, 72 - 2 * (32 / 12));
  near(t.totals.doorCasing / FT, 2 * ((2 * 80 + 32) / 12));
  near(t.totals.windowCasing / FT, 14);
  assert.equal(t.counts.door, 1);
  assert.equal(t.totals.doors, 2, 'door counted from both sides');
  const csv = takeoffToCsv(d, t);
  assert.match(csv, /^Room,Ceiling,Floor \(sq ft\)/);
  assert.match(csv, /TOTAL/);
});

test('materials apply waste and sheet sizes', () => {
  const d = twoRooms();
  const t = computeTakeoff(d);
  const drywall = t.materials.find((m) => m.key === 'drywall');
  // (576 walls + 160 ceiling) × 1.12 / 32 = 25.76 → 26 sheets
  assert.equal(drywall.quantity, 26);
  const floor = t.materials.find((m) => m.key === 'flooring');
  near(floor.quantity, 176);
});
