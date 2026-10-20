import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addOpening, addRectangle, analyze, createDesign, migrateDesign, normalize } from '../public/js/core/model.js';
import {
  COMPOUNDS, FLATNESS_SPECS, READING_PRESETS, analyzeLeveling, readingUnit, bagCoverage, columnLabel, levelColor, levelGrid, setReading, LEVEL_COLOR,
} from '../public/js/core/leveling.js';
import { computeTakeoff, takeoffToCsv } from '../public/js/core/takeoff.js';
import { MM_PER_FT, MM_PER_IN, MM2_PER_FT2, formatDeviation, parseDeviation } from '../public/js/core/units.js';

const FT = MM_PER_FT;
const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `expected ${a} ≈ ${b}`);
const sqft = (mm2) => mm2 / MM2_PER_FT2;

/** A 10' × 8' room (zero-thickness walls) surveyed on a 2' grid with z(node). */
function surveyedRoom(z, { locks = [], door = false } = {}) {
  const d = createDesign('imperial');
  d.settings.wallThickness = 0;
  addRectangle(d, { x: 0, y: 0 }, { x: 10 * FT, y: 8 * FT });
  normalize(d);
  if (door) {
    const south = d.walls.find((w) => [w.a, w.b].every((id) => Math.abs(d.nodes.find((n) => n.id === id).y - 8 * FT) < 1));
    addOpening(d, south.id, 'door', 2 * FT, { width: 32 * MM_PER_IN, height: 80 * MM_PER_IN });
    normalize(d);
  }
  const g = analyze(d).rooms[0];
  const grid = levelGrid(g.polygon, 2 * FT);
  let readings = [];
  for (const nd of grid.nodes) readings = setReading(readings, nd, z(nd), 2 * FT);
  const room = d.rooms[0];
  room.leveling = { spacing: 2 * FT, readings, target: null, tolerance: FLATNESS_SPECS.standard.tolerance, locks };
  return { d, room, geom: () => analyze(d).rooms[0] };
}

test('deviation readings parse with explicit or default units and format with signs', () => {
  near(parseDeviation('+4', 'mm'), 4);
  near(parseDeviation('-6mm', 'in'), -6);
  near(parseDeviation('−3/16', 'in'), -(3 / 16) * MM_PER_IN);
  near(parseDeviation('1 1/4"', 'mm'), 1.25 * MM_PER_IN);
  near(parseDeviation('0.5cm', 'mm'), 5);
  assert.equal(parseDeviation('abc', 'mm'), null);
  assert.equal(parseDeviation('', 'mm'), null);
  assert.equal(formatDeviation(4, 'mm', { sign: true }), '+4 mm');
  assert.equal(formatDeviation(-6.5, 'mm'), '−6.5 mm');
  assert.equal(formatDeviation(-4, 'mm', { sign: true, compact: true }), '−4');
  assert.equal(formatDeviation((3 / 16) * MM_PER_IN, 'in', { sign: true }), '+3/16"');
});

test('grid nodes are centred, kept off the walls and listed in walking order', () => {
  const { geom } = surveyedRoom(() => 0);
  const grid = levelGrid(geom().polygon, 2 * FT);
  // 10' wide → 5 columns at 1', 3', 5', 7', 9'; 8' deep → 4 rows at 1', 3', 5', 7'.
  assert.equal(grid.nodes.length, 20);
  near(grid.xs[0], 1 * FT);
  near(grid.ys[3], 7 * FT);
  assert.deepEqual(grid.nodes.slice(0, 7).map((nd) => nd.label), ['A1', 'B1', 'C1', 'D1', 'E1', 'E2', 'D2']);
  assert.equal(columnLabel(26), 'AA');
});

test('setReading replaces the reading at a node and can clear it', () => {
  const node = { x: 100, y: 200 };
  let r = setReading([], node, 3, 600);
  r = setReading(r, { x: 110, y: 205 }, -2, 600);
  assert.deepEqual(r, [{ x: 110, y: 205, z: -2 }]);
  assert.deepEqual(setReading(r, node, null, 600), []);
});

test('needs three readings before analysing', () => {
  const { d, room, geom } = surveyedRoom(() => 0);
  room.leveling.readings = room.leveling.readings.slice(0, 2);
  const la = analyzeLeveling(d, geom());
  assert.equal(la.ready, false);
  assert.equal(la.nodes.filter((nd) => nd.z != null).length, 2);
});

test('a flat floor needs no work', () => {
  const { d, geom } = surveyedRoom((nd) => (nd.col % 2 ? 1 : -1));
  const la = analyzeLeveling(d, geom());
  assert.equal(la.strategy, 'none');
  assert.equal(la.bags, 0);
  assert.equal(la.grindArea, 0);
  assert.equal(la.fillArea, 0);
});

test('recommends a fill-only pour up to the highest spot less the tolerance band', () => {
  // Row 4 (south strip) is 8 mm low, one node 6 mm high.
  const { d, geom } = surveyedRoom((nd) => (nd.label === 'C2' ? 6 : nd.row === 3 ? -8 : 0));
  const la = analyzeLeveling(d, geom());
  const band = FLATNESS_SPECS.standard.tolerance / 2;
  assert.equal(la.strategy, 'fill');
  near(la.recommended, 6 - band);
  near(la.target, la.recommended);
  assert.equal(la.grindArea, 0);
  assert.equal(la.zones.length, 0);
  assert.ok(la.fillArea > 0 && la.fillArea <= 80 * MM2_PER_FT2 + 1);
  // LevelQuik RS pours from featheredge and every depth here is neat, so bags = volume / bag yield, + 10%.
  assert.ok(la.rawBags > 0);
  near(la.rawBags, la.fillVolume / (la.product.bagLitres * 1e6), 1e-9);
  assert.equal(la.bags, Math.ceil(la.rawBags * 1.1));
});

test('a doorway clearance lock shifts the recommendation to grinding the high spot', () => {
  const { d, room, geom } = surveyedRoom((nd) => (nd.label === 'C2' ? 6 : nd.row === 3 ? -8 : 0), { door: true });
  room.leveling.locks = [{ id: 'l1', openingId: d.openings[0].id, maxBuild: 2 }];
  const la = analyzeLeveling(d, geom());
  const lock = la.locks[0];
  assert.equal(lock.kind, 'doorway');
  // The door is in the low south strip; the floor there may only rise 2 mm.
  near(la.cap, lock.z + 2);
  assert.ok(la.cap < la.fillOnly);
  assert.equal(la.strategy, 'grind');
  near(la.recommended, la.cap);
  assert.equal(la.breaches.length, 0);
  assert.equal(la.zones[0].label, 'G1');
  assert.ok(la.zones[0].nodes.some((nd) => nd.label === 'C2'));
  near(la.maxCut, 6 - la.cap, 0.01);
  assert.ok(la.grindArea > 0);
});

test('a target above the clearance cap is reported as a breach', () => {
  const { d, room, geom } = surveyedRoom((nd) => (nd.label === 'C2' ? 6 : 0), { locks: [{ id: 'l1', openingId: null, maxBuild: 1 }] });
  room.leveling.target = 3;
  const la = analyzeLeveling(d, geom());
  assert.equal(la.breaches.length, 1);
  near(la.breaches[0].by, 2);
  // A previewed target overrides the stored one.
  assert.equal(analyzeLeveling(d, geom(), { target: 0.5 }).breaches.length, 0);
});

test('fill deeper than the neat limit uses the extended yield and flags the product limit', () => {
  const { d, room, geom } = surveyedRoom((nd) => (nd.row === 0 ? 0 : -60));
  room.leveling.target = 0;
  const la = analyzeLeveling(d, geom());
  const p = COMPOUNDS['cbp-levelquik-rs'];
  assert.ok(la.extendedArea > 0, 'deep area is extended with aggregate');
  assert.equal(la.overMaxArea, 0);
  near(bagCoverage(p, 60), (p.bagLitres * 1e6 * p.extendedYield) / 60);
});

test('colours: green within the band, warm above, cool below', () => {
  assert.deepEqual(levelColor(1, 2, 10), LEVEL_COLOR);
  const [r1, , b1] = levelColor(8, 2, 10);
  const [r2, , b2] = levelColor(-8, 2, 10);
  assert.ok(r1 > b1);
  assert.ok(b2 > r2);
});

test('takeoff adds compound bags and grinding for surveyed rooms', () => {
  const { d, room } = surveyedRoom((nd) => (nd.label === 'C2' ? 6 : nd.row === 3 ? -8 : 0));
  room.leveling.locks = [{ id: 'l1', openingId: null, maxBuild: 0 }];
  d.estimate = { levelProduct: 'ardex-k15', levelContingency: 10 };
  const t = computeTakeoff(d);
  const bags = t.materials.find((m) => m.key === 'self-leveler');
  const grind = t.materials.find((m) => m.key === 'grinding');
  assert.ok(bags.label.includes('ARDEX K 15'));
  assert.equal(bags.unit, 'bags');
  assert.ok(Number.isInteger(bags.quantity) && bags.quantity > 0);
  assert.ok(grind.quantity > 0);
  assert.match(takeoffToCsv(d, t), /Self-leveling compound.*,\d+,bags,/);
  near(sqft(t.rooms[0].leveling.grindArea), grind.quantity);
});

test('migration keeps valid readings and drops malformed ones', () => {
  const d = migrateDesign({ units: 'metric', rooms: [{ id: 'r1', name: 'A', leveling: { readings: [{ x: 1, y: 2, z: 3 }, { x: 'bad' }], locks: 'nope' } }] });
  assert.deepEqual(d.rooms[0].leveling.readings, [{ x: 1, y: 2, z: 3 }]);
  assert.deepEqual(d.rooms[0].leveling.locks, []);
});

test('reading presets run high to low through zero, in the plan\'s reading unit', () => {
  assert.deepEqual(READING_PRESETS.in.map((mm) => formatDeviation(mm, 'in', { sign: true })),
    ['+1"', '+3/4"', '+1/2"', '+1/4"', '+1/8"', '±0"', '−1/8"', '−1/4"', '−1/2"', '−3/4"', '−1"']);
  assert.deepEqual(READING_PRESETS.mm, [20, 15, 10, 6, 3, 0, -3, -6, -10, -15, -20]);
  assert.equal(readingUnit(createDesign('imperial')), 'in');
  assert.equal(readingUnit(createDesign('metric')), 'mm');
  const d = createDesign('imperial');
  d.settings.readingUnit = 'mm';
  assert.equal(readingUnit(d), 'mm');
});

/** Two 10' × 8' rooms side by side (shared wall at x = 10'), joined by a door unless `opening` is 'window'. */
function linkedRooms({ west = () => 0, east = () => 0, opening = 'door' } = {}) {
  const d = createDesign('imperial');
  d.settings.wallThickness = 0;
  addRectangle(d, { x: 0, y: 0 }, { x: 10 * FT, y: 8 * FT });
  addRectangle(d, { x: 10 * FT, y: 0 }, { x: 20 * FT, y: 8 * FT });
  normalize(d);
  const shared = d.walls.find((w) => [w.a, w.b].every((id) => Math.abs(d.nodes.find((n) => n.id === id).x - 10 * FT) < 1));
  addOpening(d, shared.id, opening, 4 * FT, opening === 'window' ? { width: 32 * MM_PER_IN, height: 36 * MM_PER_IN, sill: 36 * MM_PER_IN } : { width: 32 * MM_PER_IN, height: 80 * MM_PER_IN });
  normalize(d);
  const geoms = analyze(d).rooms;
  const byX = (g) => Math.min(...g.polygon.map((p) => p.x));
  const [gw, ge] = [...geoms].sort((p, q) => byX(p) - byX(q));
  for (const [g, z] of [[gw, west], [ge, east]]) {
    if (!z) continue;
    const grid = levelGrid(g.polygon, 2 * FT);
    let readings = [];
    for (const nd of grid.nodes) readings = setReading(readings, nd, z(nd), 2 * FT);
    g.room.leveling = { spacing: 2 * FT, readings, target: null, tolerance: FLATNESS_SPECS.standard.tolerance, locks: [] };
  }
  const find = (room) => analyze(d).rooms.find((g) => g.room.id === room.id);
  return { d, west: gw.room, east: ge.room, geom: find };
}

test('rooms joined by a door are leveled as one floor with a shared target', () => {
  const { d, west, east, geom } = linkedRooms({ west: () => 0, east: (nd) => (nd.label === 'C2' ? 8 : -4) });
  const lw = analyzeLeveling(d, geom(west));
  const le = analyzeLeveling(d, geom(east));
  assert.equal(lw.linked, true);
  assert.deepEqual(lw.group.ids, [west.id, east.id]);
  assert.deepEqual(le.group.ids, lw.group.ids);
  // One recommendation from the highest spot anywhere (east C2) applies to both rooms.
  near(lw.recommended, 8 - lw.band);
  near(le.target, lw.target);
  near(lw.fillArea, le.fillArea);
  // Each room keeps its own grid; the shares add up to the whole.
  assert.equal(lw.nodes[0].label, 'A1');
  assert.equal(lw.members.length, 2);
  const shares = [...lw.byRoom.values()];
  near(shares.reduce((s, x) => s + x.rawBags, 0), lw.rawBags, 1e-9);
  near(shares.reduce((s, x) => s + x.fillArea, 0), lw.fillArea, 1);
  // The surface is continuous: the west room's own readings are all 0, yet just
  // inside the shared wall it is pulled toward the east room's (mostly −4) readings.
  const edge = { x: 9.8 * FT, y: 3 * FT };
  assert.ok(lw.surface.at(edge) < -0.5);
  west.leveling.linked = false;
  const alone = analyzeLeveling(d, geom(west));
  assert.equal(alone.linked, false);
  near(alone.surface.at(edge), 0);
});

test('the shared target and tolerance come from the first room; a lock in one room caps both', () => {
  const { d, west, east, geom } = linkedRooms({ west: () => 0, east: (nd) => (nd.label === 'C2' ? 8 : 0) });
  west.leveling.target = 1;
  east.leveling.target = 5;
  east.leveling.locks = [{ id: 'l1', openingId: null, maxBuild: 0.5 }];
  const le = analyzeLeveling(d, geom(east));
  near(le.target, 1);
  assert.equal(le.breaches.length, 1);
  assert.equal(le.breaches[0].room.id, east.id);
  assert.ok(analyzeLeveling(d, geom(west)).breaches.length === 1, 'the lock applies to the west room too');
});

test('linking stops at windows, unsurveyed rooms and rooms switched off', () => {
  const win = linkedRooms({ opening: 'window' });
  assert.equal(analyzeLeveling(win.d, win.geom(win.west)).linked, false);
  const half = linkedRooms({ east: null });
  assert.equal(analyzeLeveling(half.d, half.geom(half.west)).linked, false);
  const off = linkedRooms();
  off.east.leveling.linked = false;
  const lw = analyzeLeveling(off.d, off.geom(off.west));
  assert.equal(lw.linked, false);
  assert.deepEqual(lw.group.ids, [off.west.id]);
});

test('takeoff splits a linked group per room without double counting', () => {
  const { d, west, east, geom } = linkedRooms({ west: (nd) => (nd.row === 3 ? -6 : 0), east: (nd) => (nd.label === 'C2' ? 8 : -4) });
  const la = analyzeLeveling(d, geom(west));
  const t = computeTakeoff(d);
  const bags = t.materials.find((m) => m.key === 'self-leveler');
  assert.equal(bags.quantity, la.bags);
  const rw = t.rooms.find((r) => r.id === west.id).leveling;
  const re = t.rooms.find((r) => r.id === east.id).leveling;
  near(rw.fillArea + re.fillArea, la.fillArea, 1);
  assert.ok(rw.fillArea > 0 && re.fillArea > 0);
});

test('a flat high area sitting exactly on the band edge does not speckle into grind zones', () => {
  // Half the room is uniformly at the highest reading; the fill-only target puts it exactly one band below.
  const { d, geom } = surveyedRoom((nd) => (nd.row < 2 ? -(1 / 4) * MM_PER_IN : -(1 / 2) * MM_PER_IN));
  const la = analyzeLeveling(d, geom());
  assert.equal(la.strategy, 'fill');
  assert.equal(la.zones.length, 0);
  assert.equal(la.grindArea, 0);
  assert.equal(la.maxCut, 0);
});

test('minimize pour grinds down to the lowest spot so no compound is needed', () => {
  const { d, room, geom } = surveyedRoom((nd) => (nd.label === 'C2' ? 6 : nd.row === 3 ? -8 : 0));
  room.leveling.minimize = 'pour';
  const la = analyzeLeveling(d, geom());
  assert.equal(la.minimize, 'pour');
  assert.equal(la.strategy, 'grind-only');
  near(la.recommended, -8 + la.band);
  near(la.target, la.recommended);
  assert.equal(la.bags, 0);
  assert.equal(la.fillArea, 0);
  assert.ok(la.grindArea > 0);
  near(la.maxCut, 6 - la.recommended);
  // Both plans are reported whichever is chosen; minimize grinding still means no grinding.
  assert.equal(la.options.grind.grindArea, 0);
  assert.ok(la.options.grind.bags > 0);
  assert.equal(la.options.pour.bags, 0);
});

test('both optimised plans stay under the clearance locks', () => {
  const { d, room, geom } = surveyedRoom((nd) => (nd.label === 'C2' ? 6 : nd.row === 3 ? -8 : 0), { locks: [{ id: 'l1', openingId: null, maxBuild: -9 }] });
  for (const minimize of ['grind', 'pour']) {
    room.leveling.minimize = minimize;
    const la = analyzeLeveling(d, geom());
    near(la.recommended, -9);
    assert.equal(la.options[minimize].capped, true);
    assert.equal(la.breaches.length, 0);
    assert.equal(la.bags, 0);
  }
  // A looser lock binds only the grind-minimizing plan, which wants the floor higher.
  room.leveling.locks = [{ id: 'l1', openingId: null, maxBuild: 1 }];
  const la = analyzeLeveling(d, geom());
  assert.equal(la.options.grind.capped, true);
  near(la.options.grind.target, 1);
  assert.equal(la.options.pour.capped, false);
});
