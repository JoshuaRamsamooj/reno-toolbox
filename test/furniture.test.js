import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addOpening, addRectangle, analyze, createDesign, migrateDesign, normalize } from '../public/js/core/model.js';
import {
  FURNITURE, FURNITURE_CATEGORIES, alignPlacement, analyzeLayout, applySize, clearanceZones, createFurniture, deleteFurniture, doorZones, duplicateFurniture,
  footprint, furnitureMaterials, localShape, overlapArea, resolveItem, sideDistance, wallPlacement,
} from '../public/js/core/furniture.js';
import { computeTakeoff } from '../public/js/core/takeoff.js';
import { MM_PER_FT, MM_PER_IN } from '../public/js/core/units.js';
import { polygonArea } from '../public/js/core/geometry.js';

const FT = MM_PER_FT;
const IN = MM_PER_IN;
const near = (a, b, tol = 0.5) => assert.ok(Math.abs(a - b) <= tol, `expected ${a} ≈ ${b}`);

/** A 12' × 10' room (centrelines) with 4" walls: interior faces at x = 2" and 11' 10", y = 2" and 9' 10". */
function room() {
  const d = createDesign('imperial');
  d.settings.wallThickness = 4 * IN;
  addRectangle(d, { x: 0, y: 0 }, { x: 12 * FT, y: 10 * FT });
  normalize(d);
  return d;
}

/** An item placed flush on the nearest wall to p (no slide snapping). */
function onWall(d, type, p, size) {
  const f = createFurniture(type, p, { size });
  Object.assign(f, wallPlacement(d, analyze(d), f, p, { reach: 600, snap: false }));
  d.furniture.push(f);
  return f;
}

const issuesOf = (layout, id) => layout.issues.filter((i) => i.itemId === id);

test('catalog: every type has a category, sizes and a resolvable default', () => {
  for (const [type, def] of Object.entries(FURNITURE)) {
    assert.ok(FURNITURE_CATEGORIES[def.category], `${type} category`);
    assert.ok(def.sizes.length > 0, `${type} sizes`);
    const r = resolveItem(createFurniture(type, { x: 0, y: 0 }));
    assert.ok(r.w > 0 && r.d > 0, `${type} dimensions`);
    for (const s of ['front', 'back', 'left', 'right']) assert.ok(Number.isFinite(r.clear[s]), `${type} ${s} clearance`);
  }
  // The sizes asked for: beds, cabinets, vanities, tubs.
  const bed = FURNITURE.bed.sizes;
  assert.deepEqual(bed.find((s) => s.id === 'queen'), { id: 'queen', label: 'Queen', w: 60, d: 80, h: 24 });
  assert.equal(bed.find((s) => s.id === 'king').w, 76);
  assert.equal(bed.find((s) => s.id === 'cal-king').d, 84);
  assert.deepEqual(FURNITURE['base-cabinet'].sizes.map((s) => s.w).filter((w) => [12, 15, 18, 24, 30, 36].includes(w)), [12, 15, 18, 24, 30, 36]);
  assert.ok(FURNITURE['base-cabinet'].sizes.every((s) => s.d === 24));
  assert.deepEqual(FURNITURE['bath-vanity'].sizes.map((s) => s.w), [24, 30, 36, 48, 60, 72]);
  assert.deepEqual(FURNITURE.tub.sizes.map((s) => [s.w, s.d]), [[60, 30], [60, 32]]);
});

test('frame: angle 0 backs onto a north wall and faces south; shapes cover their area', () => {
  const r = resolveItem(createFurniture('bed', { x: 1000, y: 1000 }, { size: 'queen' }));
  near(r.uy.x, 0, 1e-9);
  near(r.uy.y, 1, 1e-9);
  near(Math.abs(polygonArea(footprint(r).outline)), 60 * 80 * IN * IN, 1);
  // L sectional: two convex parts that add up to the outline.
  const l = resolveItem(createFurniture('sectional-l', { x: 0, y: 0 }, { size: 'chaise' }));
  const shape = localShape(l);
  near(shape.parts.reduce((s, p) => s + Math.abs(polygonArea(p)), 0), Math.abs(polygonArea(shape.outline)), 1);
  // Mirroring moves the return to the other side.
  const left = localShape(resolveItem(createFurniture('sectional-l', { x: 0, y: 0 }, { opts: { side: 'left' } })));
  assert.ok(Math.min(...left.parts[1].map((p) => p.x)) < 0 && Math.max(...shape.parts[1].map((p) => p.x)) > 0);
});

test('wall placement: back flush on the nearest face, facing into the room, edges snap to corners', () => {
  const d = room();
  const a = analyze(d);
  const cab = createFurniture('base-cabinet', { x: 0, y: 0 }, { size: '24' });
  // Near the south wall: turned to face north.
  const s = wallPlacement(d, a, cab, { x: 5 * FT, y: 9 * FT }, { reach: 400, snap: false });
  near(s.y, 10 * FT - 2 * IN - 12 * IN);
  assert.equal(Math.abs(s.angle), 180);
  // Near the west wall, its edge 5" from the north corner: it turns to face east and slides into the corner.
  const w = wallPlacement(d, a, cab, { x: 1 * FT, y: 1.6 * FT }, { reach: 400, tol: 6 * IN });
  near(w.x, 2 * IN + 12 * IN);
  assert.equal(w.angle, -90);
  near(w.y, 2 * IN + 12 * IN);
  // A deep bed near a corner still picks the wall it is closest to.
  const bed = createFurniture('bed', { x: 0, y: 0 }, { size: 'queen' });
  const b = wallPlacement(d, a, bed, { x: 5 * FT, y: 1.4 * FT }, { reach: 400, snap: false });
  near(b.y, 2 * IN + 40 * IN);
  assert.equal(b.angle, 0);
  // Far from every wall: no placement.
  assert.equal(wallPlacement(d, a, cab, { x: 6 * FT, y: 5 * FT }, { reach: 100 }), null);
});

test('wall placement only uses faces on the near side of a wall', () => {
  const d = createDesign('imperial');
  d.settings.wallThickness = 4 * IN;
  addRectangle(d, { x: 0, y: 0 }, { x: 12 * FT, y: 11 * FT });
  addRectangle(d, { x: 0, y: 11 * FT }, { x: 12 * FT, y: 22 * FT });
  normalize(d);
  // Facing north (angle 0) like the room beyond the wall, but in the room above it.
  const dresser = createFurniture('dresser', { x: 0, y: 0 }, { size: 'low' });
  const p = wallPlacement(d, analyze(d), dresser, { x: 5 * FT, y: 10.5 * FT }, { reach: 600, snap: false });
  near(p.y, 11 * FT - 2 * IN - 9 * IN);
  assert.equal(Math.abs(p.angle), 180);
});

test('align placement: free pieces line up with walls and other pieces', () => {
  const d = room();
  const a = analyze(d);
  const table = createFurniture('coffee-table', { x: 0, y: 0 }, { size: 'rect' });
  // Left edge 1" from the west face → flush.
  const p = alignPlacement(d, a, table, { x: 2 * IN + 24 * IN + 1 * IN, y: 5 * FT }, { tol: 2 * IN });
  near(p.x, 2 * IN + 24 * IN);
  // Rotated off square: no alignment.
  const turned = alignPlacement(d, a, { ...table, angle: 30 }, { x: 27 * IN, y: 5 * FT }, { tol: 2 * IN });
  near(turned.x, 27 * IN);
});

test('side distance: clear floor straight out from a side, skipping what is beside it', () => {
  const r = resolveItem(createFurniture('custom', { x: 0, y: 0 }, { size: 'rect' })); // 36 × 24
  const wall = [{ a: { x: -100 * IN, y: 12 * IN + 30 * IN }, b: { x: 100 * IN, y: 12 * IN + 30 * IN } }];
  near(sideDistance(r, 'front', wall, 1e6).dist, 30 * IN);
  // A segment beside the strip (past the ends) doesn't count.
  const beside = [{ a: { x: 20 * IN, y: 13 * IN }, b: { x: 30 * IN, y: 13 * IN } }];
  assert.equal(sideDistance(r, 'front', beside, 1000).dist, 1000);
  // Behind the item doesn't count either.
  assert.equal(sideDistance(r, 'back', wall, 1000).dist, 1000);
});

test('layout checks: bed clearances, nightstands beside the pillows, one side for a twin', () => {
  const d = room();
  const bed = onWall(d, 'bed', { x: 6 * FT, y: 1 * FT }, 'queen');
  let lay = analyzeLayout(d);
  assert.deepEqual(issuesOf(lay, bed.id), []);
  near(lay.items[0].sides.left.have, 6 * FT - 30 * IN - 2 * IN, 1);
  // Nightstands at the head don't eat into the side clearance (it starts 22" from the head).
  onWall(d, 'nightstand', { x: 6 * FT - 40 * IN, y: 1 * FT }, 'square');
  lay = analyzeLayout(d);
  assert.deepEqual(issuesOf(lay, bed.id), []);
  // A king against the west wall: nothing on its left.
  const d2 = room();
  const king = createFurniture('bed', { x: 2 * IN + 38 * IN, y: 2 * IN + 40 * IN }, { size: 'king' });
  d2.furniture.push(king);
  lay = analyzeLayout(d2);
  assert.ok(issuesOf(lay, king.id).some((i) => /nothing clear on the left/.test(i.message)));
  // A twin in the same corner only needs its other side.
  const d3 = room();
  const twin = createFurniture('bed', { x: 2 * IN + 19 * IN, y: 2 * IN + 37.5 * IN }, { size: 'twin' });
  d3.furniture.push(twin);
  assert.deepEqual(issuesOf(analyzeLayout(d3), twin.id), []);
});

test('layout checks: overlaps, walls, outside the rooms, and what may share floor space', () => {
  const d = room();
  const sofa = createFurniture('sofa', { x: 6 * FT, y: 5 * FT });
  const chair = createFurniture('armchair', { x: 6 * FT + 30 * IN, y: 5 * FT });
  d.furniture.push(sofa, chair);
  let lay = analyzeLayout(d);
  assert.ok(issuesOf(lay, sofa.id).some((i) => i.kind === 'overlap'));
  // Chairs tuck under a table; a rug lies under everything.
  const d2 = room();
  const table = createFurniture('dining-rect', { x: 6 * FT, y: 5 * FT }, { size: '4' });
  const dchair = createFurniture('dining-chair', { x: 6 * FT, y: 5 * FT - 15 * IN });
  const rug = createFurniture('rug', { x: 6 * FT, y: 5 * FT }, { size: '5x8', angle: 90 });
  d2.furniture.push(table, dchair, rug);
  lay = analyzeLayout(d2);
  assert.ok(!lay.issues.some((i) => i.kind === 'overlap'));
  // A wall TV over a media console is fine; an upper cabinet over a fridge is not.
  const d3 = room();
  onWall(d3, 'tv-stand', { x: 6 * FT, y: 1 * FT }, '72');
  onWall(d3, 'tv-wall', { x: 6 * FT, y: 1 * FT }, '65');
  onWall(d3, 'fridge', { x: 6 * FT, y: 9 * FT }, 'french');
  const upper = onWall(d3, 'upper-cabinet', { x: 6 * FT, y: 9.5 * FT }, '36');
  lay = analyzeLayout(d3);
  assert.equal(lay.issues.filter((i) => i.kind === 'overlap').length, 2);
  assert.ok(issuesOf(lay, upper.id).some((i) => /refrigerator/.test(i.message)));
  // Through a wall, and outside every room.
  const d4 = room();
  const across = createFurniture('sofa', { x: 1 * IN, y: 5 * FT }, { angle: 90 });
  const outside = createFurniture('ottoman', { x: 20 * FT, y: 5 * FT });
  d4.furniture.push(across, outside);
  lay = analyzeLayout(d4);
  assert.ok(issuesOf(lay, across.id).some((i) => i.kind === 'wall'));
  assert.ok(issuesOf(lay, outside.id).some((i) => i.kind === 'outside'));
});

test('layout checks: toilet centreline and the clear floor in front', () => {
  const d = room();
  // 12" from the west face to the centreline: short of 15".
  const toilet = createFurniture('toilet', { x: 2 * IN + 12 * IN, y: 2 * IN + 15 * IN });
  d.furniture.push(toilet);
  const lay = analyzeLayout(d);
  const msg = issuesOf(lay, toilet.id).map((i) => i.message).join(' | ');
  assert.match(msg, /on the left/);
  const r = resolveItem(toilet);
  near(r.clear.left, 15 * IN - 10 * IN);
  near(r.clear.front, 21 * IN);
});

test('layout checks: door swings and doorways, windows behind tall pieces, dead space', () => {
  const d = room();
  const south = d.walls.find((w) => {
    const n = new Map(d.nodes.map((x) => [x.id, x]));
    return n.get(w.a).y === 10 * FT && n.get(w.b).y === 10 * FT;
  });
  addOpening(d, south.id, 'door', 6 * FT, { width: 32 * IN, style: 'single' });
  normalize(d);
  const zones = doorZones(d);
  assert.equal(zones.filter((z) => z.kind === 'swing').length, 1);
  assert.equal(zones.filter((z) => z.kind === 'doorway').length, 2);
  // A chair right inside the door: in its swing (whichever side it opens to, it is in the doorway at least).
  const chair = createFurniture('armchair', { x: 6 * FT, y: 10 * FT - 2 * IN - 18 * IN });
  d.furniture.push(chair);
  const lay = analyzeLayout(d);
  assert.ok(issuesOf(lay, chair.id).some((i) => i.kind === 'door' || i.kind === 'doorway'));

  // A wardrobe in front of a window (sill 3'), a low dresser under one is fine.
  const d2 = room();
  const north = d2.walls.find((w) => {
    const n = new Map(d2.nodes.map((x) => [x.id, x]));
    return n.get(w.a).y === 0 && n.get(w.b).y === 0;
  });
  addOpening(d2, north.id, 'window', 3 * FT, { width: 36 * IN, sill: 36 * IN, height: 48 * IN });
  addOpening(d2, north.id, 'window', 9 * FT, { width: 36 * IN, sill: 36 * IN, height: 48 * IN });
  normalize(d2);
  const wardrobe = onWall(d2, 'wardrobe', { x: 3 * FT, y: 1 * FT }, '2-door');
  const dresser = onWall(d2, 'dresser', { x: 9 * FT, y: 1 * FT }, 'low');
  const lay2 = analyzeLayout(d2);
  assert.ok(issuesOf(lay2, wardrobe.id).some((i) => i.kind === 'window'));
  assert.ok(!issuesOf(lay2, dresser.id).some((i) => i.kind === 'window'));

  // Dead space.
  const d3 = room();
  d3.rooms[0].dead = true;
  const box = createFurniture('ottoman', { x: 6 * FT, y: 5 * FT });
  d3.furniture.push(box);
  assert.ok(issuesOf(analyzeLayout(d3), box.id).some((i) => i.kind === 'dead'));
  assert.equal(furnitureMaterials(d3).length, 0);
});

test('kitchen: sink must sit on a cabinet; work triangle legs and total', () => {
  const d = createDesign('imperial');
  d.settings.wallThickness = 4 * IN;
  addRectangle(d, { x: 0, y: 0 }, { x: 16 * FT, y: 12 * FT });
  normalize(d);
  const cab = onWall(d, 'base-cabinet', { x: 8 * FT, y: 11 * FT }, '36');
  const sink = createFurniture('sink', { x: cab.x, y: cab.y }, { size: 'double', angle: cab.angle });
  const loose = createFurniture('cooktop', { x: 7 * FT, y: 6 * FT });
  d.furniture.push(sink, loose);
  onWall(d, 'range', { x: 1 * FT, y: 6 * FT }, '30');
  onWall(d, 'fridge', { x: 15 * FT, y: 6 * FT }, 'french');
  const lay = analyzeLayout(d);
  assert.ok(!issuesOf(lay, sink.id).some((i) => i.kind === 'counter'));
  assert.ok(issuesOf(lay, loose.id).some((i) => i.kind === 'counter'));
  deleteFurniture(d, loose.id);
  const tri = analyzeLayout(d).triangles;
  assert.equal(tri.length, 1);
  const t = tri[0];
  near(t.total, t.legs.reduce((s, l) => s + l.len, 0), 1e-6);
  // Range on the west wall and fridge on the east, ~10' 8" apart: that leg is too long.
  assert.equal(t.ok, false);
  assert.ok(t.problems.some((p) => /Cooktop – fridge/.test(p)));
});

test('TV viewing distance uses the seat facing the screen', () => {
  const d = createDesign('imperial');
  d.settings.wallThickness = 4 * IN;
  addRectangle(d, { x: 0, y: 0 }, { x: 16 * FT, y: 14 * FT });
  normalize(d);
  onWall(d, 'tv-wall', { x: 8 * FT, y: 1 * FT }, '65');
  onWall(d, 'sofa', { x: 8 * FT, y: 13 * FT }, 'std');
  onWall(d, 'armchair', { x: 1 * FT, y: 3 * FT });
  const lay = analyzeLayout(d);
  assert.equal(lay.tvs.length, 1);
  const v = lay.tvs[0];
  assert.equal(lay.items.find((x) => x.r.item.id === v.seatId).r.type, 'sofa');
  // ~11' 9" to a 65" screen: past the 2 × diagonal comfortable limit.
  assert.equal(v.ok, false);
});

test('sizes, duplicate, delete, migration and clearance overrides', () => {
  const d = room();
  const f = createFurniture('bed', { x: 6 * FT, y: 5 * FT }, { size: 'twin' });
  d.furniture.push(f);
  applySize(f, 'king');
  near(f.w, 76 * IN);
  near(f.d, 80 * IN);
  const copy = duplicateFurniture(d, f.id);
  near(copy.x - f.x, 76 * IN);
  assert.notEqual(copy.id, f.id);
  deleteFurniture(d, copy.id);
  assert.equal(d.furniture.length, 1);
  // Overrides: a 0 front clearance removes the zone.
  f.opts.clear = { front: 0 };
  assert.ok(!clearanceZones(resolveItem(f)).some((z) => z.side === 'front'));
  // Extended table seats more and is longer.
  const t = createFurniture('dining-ext', { x: 0, y: 0 }, { size: '6-8', opts: { extended: true } });
  const r = resolveItem(t);
  near(r.w, 96 * IN);
  assert.equal(r.seats, 8);
  // Migration keeps good items, drops broken ones, and older plans get an empty list.
  const m = migrateDesign({ ...d, furniture: [...d.furniture, { id: 'x', type: 'nope', x: 0, y: 0, w: 1, d: 1 }, { id: 'y', type: 'bed', x: NaN, y: 0, w: 1, d: 1 }] });
  assert.equal(m.furniture.length, 1);
  const old = migrateDesign({ units: 'imperial', nodes: [], walls: [] });
  assert.deepEqual(old.furniture, []);
  // Overlap area of two squares offset by half.
  const sq = (x) => [{ x, y: 0 }, { x: x + 10, y: 0 }, { x: x + 10, y: 10 }, { x, y: 10 }];
  near(overlapArea([sq(0)], [sq(5)]), 50, 1e-6);
});

test('takeoff: pieces counted by type and size, countertop area', () => {
  const d = room();
  onWall(d, 'base-cabinet', { x: 3 * FT, y: 9 * FT }, '36');
  onWall(d, 'base-cabinet', { x: 7 * FT, y: 9 * FT }, '36');
  onWall(d, 'toilet', { x: 11 * FT, y: 5 * FT });
  const t = computeTakeoff(d);
  const cabs = t.materials.find((m) => m.key.startsWith('furn:base-cabinet'));
  assert.equal(cabs.quantity, 2);
  assert.equal(cabs.unit, 'ea');
  assert.equal(cabs.category, 'Cabinets');
  assert.equal(t.materials.find((m) => m.key.startsWith('furn:toilet')).category, 'Fixtures');
  const top = t.materials.find((m) => m.key === 'countertop');
  near(top.quantity, (2 * 36 * 24) / 144, 1e-6);
  // Prices apply like any other line.
  d.estimate = { prices: { [cabs.key]: 250 } };
  const priced = computeTakeoff(d).pricing.lines.find((l) => l.key === cabs.key);
  assert.equal(priced.cost, 500);
});
