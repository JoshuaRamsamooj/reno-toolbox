import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  addOpening, addRectangle, addWall, addWallChain, analyze, createDesign, deleteOpening, deleteWall, migrateDesign, normalize, translateNodes,
} from '../public/js/core/model.js';
import { pointInPolygon } from '../public/js/core/geometry.js';
import { designFaces, faceAtPoint, faceRef, findFace } from '../public/js/core/faces.js';
import {
  applySpecs, ensureRecord, layoutBoxes, planTrimBands, makeBox, makeCasing, makePackage, makeRun, makeWainscot, parseTrimDimensions, parseTrimLength,
  drawOrder, recordForFace, resolveFaceTrim, scopeFaces, specsFromRecord, trimKindsOn, trimTakeoff,
} from '../public/js/core/trim.js';
import { getProfile, parseCatalog, setCatalog } from '../public/js/core/trimCatalog.js';
import { computeTakeoff } from '../public/js/core/takeoff.js';
import { MM_PER_FT, MM_PER_IN, MM2_PER_FT2 } from '../public/js/core/units.js';

const IN = MM_PER_IN;
const FT = MM_PER_FT;
const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `expected ${a} ≈ ${b}`);
const REVEAL = 3 / 16; // inches, the imperial default
const catalogJson = JSON.parse(readFileSync(new URL('../public/data/trim-profiles.json', import.meta.url)));
setCatalog(catalogJson);

function room(thickness = 0) {
  const d = createDesign('imperial');
  d.settings.wallThickness = thickness;
  d.settings.ceilingHeight = 8 * FT;
  addRectangle(d, { x: 0, y: 0 }, { x: 12 * FT, y: 10 * FT });
  normalize(d);
  return d;
}

/** The wall whose two ends satisfy pred. */
function wallWhere(d, pred) {
  return d.walls.find((w) => pred(d.nodes.find((n) => n.id === w.a), d.nodes.find((n) => n.id === w.b)));
}
const northWall = (d) => wallWhere(d, (a, b) => Math.abs(a.y) < 1 && Math.abs(b.y) < 1);
const roomFace = (d, compass, roomIndex = 0) => {
  const faces = designFaces(d);
  const roomId = analyze(d).rooms[roomIndex].room.id;
  return faces.find((f) => f.kind === 'room' && f.roomId === roomId && f.compass === compass);
};

/** Mutates like the app: edit, then normalise. */
function edit(d, fn) {
  fn(d);
  normalize(d);
}

function addToFace(d, compass, makeItems, roomIndex = 0) {
  edit(d, (x) => {
    const face = roomFace(x, compass, roomIndex);
    const rec = ensureRecord(x, face);
    rec.items.push(...[makeItems(x, face)].flat());
  });
}

const resolvedFace = (d, compass, roomIndex = 0) => resolveFaceTrim(d, roomFace(d, compass, roomIndex));
const lengthOf = (res, category) => res.items.flatMap((r) => r.pieces).filter((p) => p.category === category).reduce((s, p) => s + p.length, 0);

test('catalog: widths are parsed with units and bad entries are reported', () => {
  const c = parseCatalog(catalogJson);
  assert.deepEqual(c.warnings, []);
  const base = c.byId.get('base-colonial');
  near(base.widths[2], 5.25 * IN);
  near(base.defaultWidth, 5.25 * IN);
  near(c.byId.get('base-square').defaultWidth, 90);
  near(c.byId.get('wainscot-beadboard-sheet').sheetLength, 8 * FT);

  const bad = parseCatalog({
    profiles: [
      { id: 'a', name: 'A', category: 'baseboard', widths: ['3"'], unit: 'lf' },
      { id: 'a', name: 'Dup', category: 'baseboard', widths: ['3"'], unit: 'lf' },
      { id: 'b', name: 'B', category: 'skirting-board', widths: ['3"'], unit: 'lf' },
      { id: 'c', name: 'C', category: 'baseboard', widths: ['4'], unit: 'lf' },
      { id: 'd', name: 'D', category: 'panel-moulding', widths: ["4'"], unit: 'sheet' },
      { id: 'e', name: 'E', category: 'crown', widths: ['90mm'], unit: 'each' },
      { id: 'f', name: 'F', category: 'panel-moulding', widths: ['4"'], unit: 'sf', pattern: 'tartan' },
    ],
  });
  assert.deepEqual(bad.profiles.map((p) => p.id), ['a']);
  assert.equal(bad.warnings.length, 6);
});

test('typed trim lengths: bare numbers are inches (imperial) or millimetres (metric)', () => {
  near(parseTrimLength('36', 'imperial'), 36 * IN);
  near(parseTrimLength('36 1/2', 'imperial'), 36.5 * IN);
  near(parseTrimLength("3'", 'imperial'), 36 * IN);
  near(parseTrimLength('900', 'metric'), 900);
  near(parseTrimLength('2.5cm', 'metric'), 25);
  const [w, h] = parseTrimDimensions('24x18', 'imperial');
  near(w, 24 * IN);
  near(h, 18 * IN);
});

test('exterior walls have addressable exterior faces on the outside skin', () => {
  const d = room(6 * IN);
  const { exteriorFaces, rooms } = analyze(d);
  assert.equal(exteriorFaces.length, 4);
  const lengths = exteriorFaces.map((f) => Math.round(f.length / IN)).sort((a, b) => a - b);
  assert.deepEqual(lengths, [126, 126, 150, 150]); // centreline + one thickness
  for (const ext of exteriorFaces) {
    const inner = rooms[0].walls.find((w) => w.wallIds[0] === ext.wallIds[0]);
    near(inner.outward.x, -ext.outward.x);
    near(inner.outward.y, -ext.outward.y);
  }
  // A window shows on both faces, mirrored left/right.
  edit(d, (x) => addOpening(x, northWall(x).id, 'window', 3 * FT, { width: 3 * FT, height: 4 * FT, sill: 3 * FT }));
  const faces = designFaces(d);
  const inside = faces.find((f) => f.kind === 'room' && f.compass === 'North');
  const outside = faces.find((f) => f.kind === 'exterior' && f.compass === 'South');
  near(inside.openings[0].s0, 3 * FT - 18 * IN - 3 * IN); // interior face starts 3" in from the centreline corner
  near(outside.length - outside.openings[0].s1, 3 * FT - 18 * IN + 3 * IN);
  near(outside.profile[0].z, 8 * FT);
});

test('a shared interior wall has two independent faces', () => {
  const d = room(4.5 * IN);
  edit(d, (x) => addRectangle(x, { x: 12 * FT, y: 0 }, { x: 20 * FT, y: 10 * FT }));
  const shared = wallWhere(d, (a, b) => Math.abs(a.x - 12 * FT) < 1 && Math.abs(b.x - 12 * FT) < 1);
  const faces = designFaces(d).filter((f) => f.wallIds.includes(shared.id));
  assert.equal(faces.length, 2);
  assert.ok(faces.every((f) => f.kind === 'room'));
  edit(d, (x) => {
    const f = findFace(designFaces(x), faceRef(faces[0]));
    ensureRecord(x, f).items.push(makeRun(x, 'baseboard'));
  });
  const all = designFaces(d);
  assert.ok(recordForFace(d, findFace(all, faceRef(faces[0]))));
  assert.equal(recordForFace(d, findFace(all, faceRef(faces[1]))), null);
  // Plan clicks pick the side of the wall they're on.
  const mid = { x: 12 * FT, y: 5 * FT };
  assert.equal(faceAtPoint(all, { x: mid.x - 2 * IN, y: mid.y }, 12 * IN).roomId, faces.find((f) => f.outward.x > 0).roomId);
  assert.equal(faceAtPoint(all, { x: mid.x + 4 * IN, y: mid.y }, 12 * IN).roomId, faces.find((f) => f.outward.x < 0).roomId);
});

test('baseboard runs the full face and gaps at a door, stopping at its casing', () => {
  const d = room();
  edit(d, (x) => addOpening(x, northWall(x).id, 'door', 6 * FT, { width: 32 * IN, height: 80 * IN }));
  addToFace(d, 'North', (x) => makeRun(x, 'baseboard'));
  let res = resolvedFace(d, 'North');
  near(lengthOf(res, 'baseboard') / IN, 144 - 32);
  assert.equal(res.items[0].pieces.length, 2);

  addToFace(d, 'North', (x, face) => makeCasing(x, face.openings[0].opening));
  res = resolvedFace(d, 'North');
  const ext = REVEAL + 3.5;
  near(lengthOf(res, 'baseboard') / IN, 144 - 32 - 2 * ext);
  // Door casing: two legs to the top of the head, plus the mitred head.
  near(lengthOf(res, 'door-casing') / IN, 2 * (80 + ext) + 32 + 2 * ext);

  // The door moves: the gap follows it.
  edit(d, (x) => { x.openings[0].offset = 3 * FT; });
  res = resolvedFace(d, 'North');
  const [left] = res.items.find((r) => r.item.category === 'baseboard').pieces;
  near(left.s1 / IN, 36 - 16 - ext);
});

test('window casing: picture frame, or stool and apron, plus an optional sill', () => {
  const d = room();
  edit(d, (x) => addOpening(x, northWall(x).id, 'window', 6 * FT, { width: 36 * IN, height: 48 * IN, sill: 36 * IN }));
  addToFace(d, 'North', (x, face) => makeCasing(x, face.openings[0].opening));
  const ext = REVEAL + 3.5;
  let res = resolvedFace(d, 'North');
  near(lengthOf(res, 'window-casing') / IN, 2 * (48 + 2 * ext) + 2 * (36 + 2 * ext));

  edit(d, (x) => {
    const c = x.faceTrim[0].items[0];
    c.stool = { profileId: 'stool-standard', size: 3.5 * IN, horn: 0.75 * IN };
    c.apron = { profileId: 'apron-colonial', size: 3.5 * IN };
    c.sill = { profileId: 'sill-nosing', size: 1.25 * IN, horn: 0.75 * IN };
  });
  res = resolvedFace(d, 'North');
  near(lengthOf(res, 'window-casing') / IN, 2 * (48 + ext) + (36 + 2 * ext));
  near(lengthOf(res, 'window-stool') / IN, 36 + 2 * ext + 1.5);
  near(lengthOf(res, 'window-apron') / IN, 36 + 2 * ext);
  near(lengthOf(res, 'window-sill') / IN, 36 + 2 * ext + 1.5);
});

test('chair rail breaks where it meets openings and their casing', () => {
  const d = room();
  edit(d, (x) => {
    addOpening(x, northWall(x).id, 'door', 2 * FT, { width: 32 * IN, height: 80 * IN });
    addOpening(x, northWall(x).id, 'window', 8 * FT, { width: 36 * IN, height: 48 * IN, sill: 36 * IN });
  });
  addToFace(d, 'North', (x) => makeRun(x, 'chair-rail', { height: 36 * IN }));
  // Top of the rail at the sill: it passes under the bare window but not through the door.
  near(lengthOf(resolvedFace(d, 'North'), 'chair-rail') / IN, 144 - 32);
  addToFace(d, 'North', (x, face) => face.openings.map((op) => makeCasing(x, op.opening)));
  const ext = REVEAL + 3.5;
  near(lengthOf(resolvedFace(d, 'North'), 'chair-rail') / IN, 144 - (32 + 2 * ext) - (36 + 2 * ext));
});

test('crown follows a sloped ceiling', () => {
  const d = room();
  edit(d, (x) => { x.rooms[0].ceiling = { ...x.rooms[0].ceiling, type: 'shed', height: 8 * FT, peak: 10 * FT, dir: 'N' }; });
  edit(d, (x) => applySpecs(x, scopeFaces(designFaces(x), 'room', { roomId: x.rooms[0].id }), [{ category: 'crown' }]));
  near(lengthOf(resolvedFace(d, 'East'), 'crown') / IN, Math.hypot(120, 24));
  near(lengthOf(resolvedFace(d, 'North'), 'crown') / IN, 144);
});

test('wainscot area excludes openings and counts sheets', () => {
  const d = room();
  edit(d, (x) => addOpening(x, northWall(x).id, 'door', 6 * FT, { width: 32 * IN, height: 80 * IN }));
  addToFace(d, 'North', (x) => makeWainscot(x, { profileId: 'wainscot-beadboard-sheet', size: 4 * FT, height: 32 * IN }));
  const res = resolvedFace(d, 'North');
  near(res.items[0].area / (IN * IN), 144 * 32 - 32 * 32, 0.5);
  const t = computeTakeoff(d);
  const sheets = t.materials.find((m) => m.trim?.profileId === 'wainscot-beadboard-sheet');
  assert.equal(sheets.unit, 'sheets');
  assert.equal(sheets.quantity, 1); // 24.9 sq ft + 10% < one 32 sq ft sheet
  near(sheets.trim.area / MM2_PER_FT2, (144 * 32 - 32 * 32) / 144, 0.01);
});

test('wainscot is drawn to match its profile and width', () => {
  const d = room();
  edit(d, (x) => addOpening(x, northWall(x).id, 'door', 6 * FT, { width: 32 * IN, height: 80 * IN }));
  addToFace(d, 'North', (x) => makeWainscot(x, { profileId: 'wainscot-beadboard-sheet', size: 4 * FT, height: 32 * IN }));
  const marks = () => resolvedFace(d, 'North').items[0].pieces[0].marks;
  const setProfile = (profileId, size) => edit(d, (x) => Object.assign(x.faceTrim[0].items[0], { profileId, size }));
  const count = (m, kind) => m.lines.filter((l) => l.kind === kind).length;

  // Beadboard sheets: seams every 4' (at 48" and 96"; the 144" end is the corner) and grooves between.
  let m = marks();
  assert.equal(m.pattern, 'beadboard');
  assert.deepEqual([...new Set(m.lines.filter((l) => l.kind === 'seam').map((l) => Math.round(l.s0 / IN)))], [48, 96]);
  assert.ok(count(m, 'groove') > 50);
  setProfile('wainscot-beadboard-sheet', 2 * FT);
  // 2' sheets: seams at 24", 48", 96" and 120" (the one at 72" falls in the doorway).
  assert.deepEqual([...new Set(marks().lines.filter((l) => l.kind === 'seam').map((l) => Math.round(l.s0 / IN)))], [24, 48, 96, 120]);

  // Shiplap: horizontal boards at the board width, cut around the door.
  setProfile('wainscot-shiplap', 5.5 * IN);
  m = marks();
  assert.equal(m.pattern, 'shiplap');
  const heights = [...new Set(m.lines.map((l) => Math.round((l.z0 / IN) * 10) / 10))];
  assert.deepEqual(heights, [5.5, 11, 16.5, 22, 27.5]);
  assert.equal(m.lines.length, 10); // each board line broken by the door
  setProfile('wainscot-shiplap', 7.25 * IN);
  assert.deepEqual([...new Set(marks().lines.map((l) => Math.round((l.z0 / IN) * 100) / 100))], [7.25, 14.5, 21.75, 29]);

  // Board and batten: battens of the batten width, about 16" apart, none across the door.
  setProfile('wainscot-board-batten', 3.5 * IN);
  m = marks();
  assert.equal(m.pattern, 'board-batten');
  assert.ok(m.strips.length >= 8);
  assert.ok(m.strips.every((r) => Math.abs(r[1].s - r[0].s - 3.5 * IN) < 0.01));
  const door = resolvedFace(d, 'North').face.openings[0];
  assert.ok(m.strips.every((r) => r[1].s <= door.s0 + 0.01 || r[0].s >= door.s1 - 0.01 || r[3].z <= 0));

  // Plain sheets show only their seams.
  setProfile('wainscot-mdf-sheet', 1200);
  m = marks();
  assert.equal(m.pattern, 'panel');
  assert.ok(m.lines.every((l) => l.kind === 'seam'));
});

test('picture-frame boxes measure their perimeter and lay out between openings', () => {
  const d = room();
  edit(d, (x) => addOpening(x, northWall(x).id, 'door', 6 * FT, { width: 32 * IN, height: 80 * IN }));
  addToFace(d, 'North', (x) => makeBox(x, { s: 6 * IN, z: 8 * IN, w: 24 * IN, h: 18 * IN }));
  near(lengthOf(resolvedFace(d, 'North'), 'panel-moulding') / IN, 2 * (24 + 18));
  const boxes = layoutBoxes(d, resolvedFace(d, 'North'), { bottom: 8 * IN, top: 30 * IN, gap: 4 * IN, width: 24 * IN });
  // Two 56" stretches either side of the door: two boxes each, 4" apart and from the ends.
  assert.equal(boxes.length, 4);
  near(boxes[0].s / IN, 4);
  near(boxes[0].w / IN, (56 - 3 * 4) / 2);
  near(boxes[1].s / IN + boxes[1].w / IN, 56 - 4);
});

test('trim stays attached when walls move, split and merge', () => {
  const d = room();
  edit(d, (x) => addOpening(x, northWall(x).id, 'door', 9 * FT, { width: 32 * IN, height: 80 * IN }));
  addToFace(d, 'North', (x, face) => [
    makeRun(x, 'baseboard'),
    makeCasing(x, face.openings[0].opening),
    makeBox(x, { s: 12 * IN, z: 8 * IN, w: 24 * IN, h: 18 * IN }),
  ]);
  const boxS = () => d.faceTrim.flatMap((r) => r.items).find((i) => i.kind === 'box').s / IN;

  // Dragging the north wall keeps its trim.
  const north = northWall(d);
  edit(d, (x) => translateNodes(x, [north.a, north.b], { x: 0, y: -12 * IN }));
  assert.equal(d.faceTrim.length, 1);
  assert.equal(d.faceTrim[0].items.length, 3);

  // Moving the west wall out lengthens the face on the left: the box stays put in the room.
  const west = wallWhere(d, (a, b) => Math.abs(a.x) < 1 && Math.abs(b.x) < 1);
  edit(d, (x) => translateNodes(x, [west.a, west.b], { x: -24 * IN, y: 0 }));
  near(boxS(), 36);
  near(lengthOf(resolvedFace(d, 'North'), 'baseboard') / IN, 168 - 32 - 2 * (REVEAL + 3.5));

  // A new wall splits the room: both halves of the north face keep baseboard, the box stays left.
  edit(d, (x) => addWall(x, { x: 4 * FT, y: -12 * IN }, { x: 4 * FT, y: 10 * FT }));
  assert.equal(analyze(d).rooms.length, 2);
  assert.equal(d.faceTrim.length, 2);
  const kinds = d.faceTrim.map((r) => r.items.map((i) => i.kind).sort().join(','));
  assert.deepEqual(kinds.sort(), ['box,run', 'casing,run']);
  const total = trimTakeoff(d, designFaces(d)).totals.find((l) => l.category === 'baseboard');
  near(total.length / IN, 168 - 32 - 2 * (REVEAL + 3.5));

  // Deleting it merges the faces back: one baseboard, not two.
  const divider = wallWhere(d, (a, b) => Math.abs(a.x - 4 * FT) < 1 && Math.abs(b.x - 4 * FT) < 1);
  edit(d, (x) => deleteWall(x, divider.id));
  assert.equal(d.faceTrim.length, 1);
  assert.equal(d.faceTrim[0].items.filter((i) => i.kind === 'run').length, 1);

  // Casing goes with its opening.
  edit(d, (x) => deleteOpening(x, x.openings[0].id));
  assert.ok(!d.faceTrim[0].items.some((i) => i.kind === 'casing'));
});

test('bulk apply a package to the whole house in one edit; exterior faces are left alone', () => {
  const d = room();
  edit(d, (x) => {
    addRectangle(x, { x: 12 * FT, y: 0 }, { x: 20 * FT, y: 10 * FT });
  });
  const shared = wallWhere(d, (a, b) => Math.abs(a.x - 12 * FT) < 1 && Math.abs(b.x - 12 * FT) < 1);
  edit(d, (x) => {
    addOpening(x, shared.id, 'door', 5 * FT, { width: 32 * IN, height: 80 * IN });
    addOpening(x, northWall(x).id, 'window', 6 * FT, { width: 36 * IN, height: 48 * IN, sill: 36 * IN });
  });
  const pkg = makePackage('Standard Main Floor', [
    { category: 'baseboard', profileId: 'base-colonial', size: 5.25 * IN },
    { category: 'door-casing', profileId: 'casing-colonial', size: 3.5 * IN },
    { category: 'window-casing', profileId: 'wcasing-colonial', size: 3.5 * IN, stool: {}, apron: {} },
    { category: 'chair-rail', profileId: 'chair-colonial', size: 2.5 * IN, height: 36 * IN },
  ]);
  const before = JSON.stringify(d);
  edit(d, (x) => {
    x.trimPackages.push(pkg);
    applySpecs(x, scopeFaces(designFaces(x), 'house'), pkg.items);
  });
  assert.notEqual(JSON.stringify(d), before);
  const faces = designFaces(d);
  assert.equal(d.faceTrim.length, faces.filter((f) => f.kind === 'room').length);
  assert.ok(faces.filter((f) => f.kind === 'exterior').every((f) => !recordForFace(d, f)));
  // The door gets casing on both sides; the window on the inside only.
  const casings = d.faceTrim.flatMap((r) => r.items).filter((i) => i.kind === 'casing');
  assert.equal(casings.filter((c) => c.category === 'door-casing').length, 2);
  const win = casings.find((c) => c.category === 'window-casing');
  assert.ok(win.stool && win.apron && !win.sill);
  // Re-applying replaces rather than duplicates.
  edit(d, (x) => applySpecs(x, scopeFaces(designFaces(x), 'house'), pkg.items));
  assert.equal(d.faceTrim.flatMap((r) => r.items).filter((i) => i.category === 'baseboard').length, 8);
  // A face's trim can be captured back as a package.
  const specs = specsFromRecord(d.faceTrim[0]);
  assert.ok(specs.some((s) => s.category === 'chair-rail' && Math.abs(s.height - 36 * IN) < 0.01));
});

test('takeoff lists assigned trim by profile and size, with no automatic trim lines', () => {
  const d = room();
  edit(d, (x) => addRectangle(x, { x: 12 * FT, y: 0 }, { x: 20 * FT, y: 10 * FT }));
  let t = computeTakeoff(d);
  assert.ok(!t.materials.some((m) => m.category === 'Trim'));
  assert.ok(t.totals.baseboard > 0); // the potential baseboard is still reported per room
  edit(d, (x) => applySpecs(x, scopeFaces(designFaces(x), 'house'), [{ category: 'baseboard', profileId: 'base-colonial', size: 5.25 * IN }]));
  t = computeTakeoff(d);
  const lines = t.materials.filter((m) => m.category === 'Trim');
  assert.equal(lines.length, 1);
  near(lines[0].trim.length / FT, 44 + 36);
  near(lines[0].quantity, (44 + 36) * 1.1);
  assert.equal(t.rooms[0].trim.length, 1);
  assert.match(lines[0].label, /Colonial baseboard 5 1\/4"/);

  // Metric plans show the same trim in metric units.
  edit(d, (x) => { x.units = 'metric'; });
  const m = computeTakeoff(d).materials.find((x) => x.category === 'Trim');
  assert.equal(m.unit, 'm');
  assert.match(m.label, /133 mm/);
});

test('version 1 crown flags migrate to crown runs on every face of the room', () => {
  const d = room();
  const raw = JSON.parse(JSON.stringify(d));
  raw.version = 1;
  delete raw.faceTrim;
  delete raw.trimPackages;
  raw.rooms[0].crown = true;
  const m = migrateDesign(raw);
  assert.equal(m.version, 2);
  assert.ok(!('crown' in m.rooms[0]));
  assert.equal(m.faceTrim.length, 4);
  assert.ok(m.faceTrim.every((r) => r.items[0].category === 'crown' && r.items[0].profileId === getProfile('crown-cove').id));
  normalize(m);
  near(trimTakeoff(m, designFaces(m)).totals[0].length / FT, 44);
});

test('crown in a tray ceiling runs along the tray sides, separate from wall crown', () => {
  const d = createDesign('imperial');
  d.settings.wallThickness = 0;
  d.settings.ceilingHeight = 8 * FT;
  addRectangle(d, { x: 0, y: 0 }, { x: 16 * FT, y: 12 * FT });
  addRectangle(d, { x: 16 * FT, y: 0 }, { x: 26 * FT, y: 12 * FT }); // a flat-ceilinged neighbour
  normalize(d);
  const tray = d.rooms.find((r) => analyze(d).rooms.find((g) => g.room === r).area > 150 * FT * FT);
  edit(d, () => { tray.ceiling = { ...tray.ceiling, type: 'tray', height: 8 * FT, trayDepth: 12 * IN, trayInset: 24 * IN }; });
  const crown = { category: 'crown', profileId: 'crown-cove', size: 3.625 * IN };
  edit(d, (x) => applySpecs(x, scopeFaces(designFaces(x), 'house'), [crown, { ...crown, placement: 'tray' }]));

  const takeoff = () => trimTakeoff(d, designFaces(d));
  const items = d.faceTrim.flatMap((r) => r.items);
  assert.equal(items.filter((i) => i.placement === 'tray').length, 4); // only the tray room's four walls
  assert.equal(items.filter((i) => i.category === 'crown' && !i.placement).length, 8); // wall crown kept everywhere

  // Each tray side is the wall less the 24" inset at both ends, at the tray height.
  const north = designFaces(d).find((f) => f.kind === 'room' && f.roomId === tray.id && f.compass === 'North');
  const piece = resolveFaceTrim(d, north).items.find((r) => r.item.placement === 'tray').pieces[0];
  near(piece.length / IN, 192 - 48);
  near(piece.s0 / IN, 24);
  near(Math.max(...piece.poly.map((p) => p.z)) / IN, 9 * 12);
  // Same profile, so one material line: wall crown (56' + 44') plus tray crown (2 × (12' + 8')).
  near(takeoff().totals.find((l) => l.category === 'crown').length / FT, 56 + 44 + 40);

  // Re-applying replaces only the tray crown, and a package keeps the two kinds apart.
  edit(d, (x) => applySpecs(x, scopeFaces(designFaces(x), 'room', { roomId: tray.id }), [{ ...crown, placement: 'tray', size: 4.625 * IN }]));
  const after = d.faceTrim.flatMap((r) => r.items);
  assert.ok(after.filter((i) => i.placement === 'tray').every((i) => Math.abs(i.size - 4.625 * IN) < 0.01));
  assert.equal(after.filter((i) => i.category === 'crown' && !i.placement).length, 8);
  assert.deepEqual(specsFromRecord(recordForFace(d, north)).map((s) => s.placement ?? s.category), ['crown', 'tray']);

  // Without the tray the crown has nowhere to go, and comes back with it.
  edit(d, () => { tray.ceiling.type = 'flat'; });
  assert.equal(resolveFaceTrim(d, designFaces(d).find((f) => f.roomId === tray.id && f.compass === 'North')).items.find((r) => r.item.placement === 'tray').pieces.length, 0);
  edit(d, () => { tray.ceiling.type = 'tray'; });
  near(takeoff().totals.find((l) => l.size > 4 * IN).length / FT, 40);
});

test('trim shows on the plan by default; the choice is saved with the plan', () => {
  assert.equal(createDesign('imperial').settings.showTrim, true);
  const old = JSON.parse(JSON.stringify(room()));
  delete old.settings.showTrim; // plans saved before the setting existed
  assert.equal(migrateDesign(old).settings.showTrim, true);
  const hidden = room();
  hidden.settings.showTrim = false;
  assert.equal(migrateDesign(JSON.parse(JSON.stringify(hidden))).settings.showTrim, false);
});

test('plan view: baseboard and crown bands mitre at corners and stay out of the walls', () => {
  const T = 4.5 * IN;
  const depth = (item) => (item.category === 'crown' ? 3 * IN : 1 * IN);
  const insideRoom = (d, bands) => {
    const poly = analyze(d).rooms[0].polygon;
    // Nudge each point a hair towards the band's centre: points on the wall face itself count as inside.
    return bands.every((b) => {
      const c = { x: b.poly.reduce((s, p) => s + p.x, 0) / 4, y: b.poly.reduce((s, p) => s + p.y, 0) / 4 };
      return b.poly.every((p) => pointInPolygon({ x: p.x + (c.x - p.x) * 1e-3, y: p.y + (c.y - p.y) * 1e-3 }, poly));
    });
  };

  // A 12' × 10' room (4½" walls) with a door on the north wall.
  const d = room(T);
  edit(d, (x) => addOpening(x, northWall(x).id, 'door', 6 * FT, { width: 32 * IN, height: 80 * IN }));
  edit(d, (x) => applySpecs(x, scopeFaces(designFaces(x), 'house'), [{ category: 'baseboard' }, { category: 'crown' }]));
  const bands = planTrimBands(d, designFaces(d), depth);
  const base = bands.filter((b) => b.category === 'baseboard');
  assert.equal(base.length, 5); // the door splits the north run
  assert.equal(bands.filter((b) => b.category === 'crown').length, 4); // crown runs over the door
  assert.ok(insideRoom(d, bands));

  // At the room's north-west corner (inside face at 2¼", 2¼") both baseboard bands end on the
  // bisector: the same inner point, one inch in from each wall.
  const corner = { x: T / 2, y: T / 2 };
  const innerAtCorner = base.flatMap((b) => [b.poly[2], b.poly[3]]).filter((p) => Math.hypot(p.x - corner.x - IN, p.y - corner.y - IN) < 0.01);
  assert.equal(innerAtCorner.length, 2);
  const crownCorner = bands.filter((b) => b.category === 'crown').flatMap((b) => [b.poly[2], b.poly[3]])
    .filter((p) => Math.hypot(p.x - corner.x - 3 * IN, p.y - corner.y - 3 * IN) < 0.01);
  assert.equal(crownCorner.length, 2);

  // At the door the ends are square: the inner point sits straight out from the jamb.
  const door = designFaces(d).find((f) => f.kind === 'room' && f.compass === 'North').openings[0];
  const leftOfDoor = base.find((b) => Math.abs(b.poly[1].x - (T / 2 + door.s0)) < 0.01);
  near(leftOfDoor.poly[2].x, leftOfDoor.poly[1].x);
  near(leftOfDoor.poly[2].y - leftOfDoor.poly[1].y, IN);

  // An L-shaped room has an outside corner too: the mitre still stays in the room.
  const l = createDesign('imperial');
  l.settings.wallThickness = T;
  addWallChain(l, [{ x: 0, y: 0 }, { x: 16 * FT, y: 0 }, { x: 16 * FT, y: 8 * FT }, { x: 8 * FT, y: 8 * FT }, { x: 8 * FT, y: 14 * FT }, { x: 0, y: 14 * FT }], true);
  normalize(l);
  edit(l, (x) => applySpecs(x, scopeFaces(designFaces(x), 'house'), [{ category: 'baseboard' }]));
  const lBands = planTrimBands(l, designFaces(l), depth);
  assert.equal(lBands.length, 6);
  assert.ok(insideRoom(l, lBands));
  // Every band end meets its neighbour exactly: 6 corners, each shared by two inner points.
  const inner = lBands.flatMap((b) => [b.poly[2], b.poly[3]]);
  assert.ok(inner.every((p) => inner.filter((q) => Math.hypot(p.x - q.x, p.y - q.y) < 0.01).length === 2));
});

test('plan view: tray crown runs along the tray edge, mitred at the tray corners', () => {
  const d = room(0);
  edit(d, (x) => { x.rooms[0].ceiling = { ...x.rooms[0].ceiling, type: 'tray', height: 8 * FT, trayDepth: 12 * IN, trayInset: 24 * IN }; });
  edit(d, (x) => applySpecs(x, scopeFaces(designFaces(x), 'house'), [{ category: 'crown', placement: 'tray' }]));
  const bands = planTrimBands(d, designFaces(d), () => 3 * IN);
  assert.equal(bands.length, 4);
  assert.ok(bands.every((b) => b.tray));
  // Outer edges trace the tray outline (24" in from the walls); inner corners mitre 3" further in.
  const outer = bands.flatMap((b) => [b.poly[0], b.poly[1]]);
  assert.ok(outer.every((p) => [24, 120].some((v) => Math.abs(p.x / IN - v) < 0.01) && [24, 96].some((v) => Math.abs(p.y / IN - v) < 0.01)));
  const inner = bands.flatMap((b) => [b.poly[2], b.poly[3]]);
  assert.ok(inner.some((p) => Math.abs(p.x / IN - 27) < 0.01 && Math.abs(p.y / IN - 27) < 0.01));
  assert.ok(inner.every((p) => inner.filter((q) => Math.hypot(p.x - q.x, p.y - q.y) < 0.01).length === 2));
});

test('plan view: casing legs beside each cased opening, plus window stools and sills', () => {
  const T = 4.5 * IN;
  const depth = (x) => (x.part === 'leg' ? 0.75 * IN : x.size);
  const d = room(T);
  edit(d, (x) => {
    addOpening(x, northWall(x).id, 'door', 3 * FT, { width: 32 * IN, height: 80 * IN });
    addOpening(x, northWall(x).id, 'window', 8 * FT, { width: 36 * IN, height: 48 * IN, sill: 36 * IN });
  });
  // Inside: case both; the window gets a stool. Outside: brickmould round the window with a sill.
  addToFace(d, 'North', (x, face) => face.openings.map((op) => makeCasing(x, op.opening, op.opening.type === 'window' ? { stool: {} } : {})));
  edit(d, (x) => {
    const outside = designFaces(x).find((f) => f.kind === 'exterior' && f.compass === 'South');
    const win = outside.openings.find((op) => op.opening.type === 'window').opening;
    ensureRecord(x, outside).items.push(makeCasing(x, win, { profileId: 'wcasing-brickmould', size: 2 * IN, sill: {} }));
  });
  const bands = planTrimBands(d, designFaces(d), depth);
  const legs = bands.filter((b) => b.part === 'leg');
  assert.equal(legs.length, 6); // door + window inside, window outside

  // Door legs (3½" casing, 3/16" reveal) sit just outside the jambs on the room side of the wall.
  const north = designFaces(d).find((f) => f.kind === 'room' && f.compass === 'North');
  const door = north.openings.find((op) => op.opening.type === 'door');
  const ext = REVEAL + 3.5;
  const doorLegs = legs.filter((b) => b.item.category === 'door-casing').map((b) => b.poly.map((p) => ({ s: (p.x - north.P.x) / IN, y: p.y / IN })));
  assert.deepEqual(doorLegs.map((poly) => [Math.min(...poly.map((p) => p.s)), Math.max(...poly.map((p) => p.s))].map((v) => Math.round(v * 1000) / 1000)),
    [[door.s0 / IN - ext, door.s0 / IN - REVEAL], [door.s1 / IN + REVEAL, door.s1 / IN + ext]].map((r) => r.map((v) => Math.round(v * 1000) / 1000)));
  for (const poly of doorLegs) {
    near(Math.min(...poly.map((p) => p.y)), T / 2 / IN, 1e-6); // on the wall face…
    near(Math.max(...poly.map((p) => p.y)), T / 2 / IN + 0.75, 1e-6); // …¾" into the room
  }

  // The stool runs past the casing by its horns and projects its width into the room.
  const stool = bands.find((b) => b.part === 'stool');
  const xs = stool.poly.map((p) => p.x / IN);
  near(Math.max(...xs) - Math.min(...xs), 36 + 2 * ext + 1.5);
  near(Math.max(...stool.poly.map((p) => p.y / IN)), T / 2 / IN + 3.5);
  assert.ok(bands.indexOf(stool) < bands.indexOf(legs[0])); // drawn under the legs

  // Outside, the sill and brickmould legs are on the exterior face of the wall, beyond it.
  const sill = bands.find((b) => b.part === 'sill');
  assert.ok(sill.poly.every((p) => p.y <= -T / 2 + 1e-6));
  assert.ok(legs.filter((b) => b.item.profileId === 'wcasing-brickmould').every((b) => b.poly.every((p) => p.y <= -T / 2 + 1e-6)));
  // Nothing is drawn inside the wall itself.
  assert.ok(bands.every((b) => b.poly.every((p) => Math.abs(p.y) >= T / 2 - 1e-6 || p.y > T)));
});

test('remove one kind of trim from a whole room, leaving everything else', () => {
  const d = room();
  edit(d, (x) => addRectangle(x, { x: 12 * FT, y: 0 }, { x: 20 * FT, y: 10 * FT }));
  const shared = wallWhere(d, (a, b) => Math.abs(a.x - 12 * FT) < 1 && Math.abs(b.x - 12 * FT) < 1);
  edit(d, (x) => addOpening(x, shared.id, 'door', 5 * FT, { width: 32 * IN, height: 80 * IN }));
  edit(d, (x) => { x.rooms[0].ceiling = { ...x.rooms[0].ceiling, type: 'tray', trayInset: 24 * IN, trayDepth: 12 * IN }; });
  const all = [{ category: 'baseboard' }, { category: 'crown' }, { category: 'crown', placement: 'tray' }, { category: 'door-casing' }, { category: 'panel-moulding' }];
  edit(d, (x) => applySpecs(x, scopeFaces(designFaces(x), 'house'), all));
  addToFace(d, 'North', (x) => makeBox(x, { s: 6 * IN, z: 6 * IN, w: 20 * IN, h: 18 * IN }));
  const [r1, r2] = d.rooms.map((r) => r.id);
  const facesOf = (id) => designFaces(d).filter((f) => f.kind === 'room' && f.roomId === id);
  assert.deepEqual([...trimKindsOn(d, facesOf(r1))].sort(), ['baseboard', 'crown', 'crown-tray', 'door-casing', 'panel-moulding']);

  const remove = (roomId, spec) => edit(d, (x) => applySpecs(x, scopeFaces(designFaces(x), 'room', { roomId }), [{ ...spec, remove: true }]));
  remove(r1, { category: 'baseboard' });
  assert.ok(!trimKindsOn(d, facesOf(r1)).has('baseboard'));
  assert.ok(trimKindsOn(d, facesOf(r2)).has('baseboard')); // the next room keeps its baseboard
  remove(r1, { category: 'crown', placement: 'tray' });
  assert.deepEqual([...trimKindsOn(d, facesOf(r1))].sort(), ['crown', 'door-casing', 'panel-moulding']); // wall crown stays
  remove(r1, { category: 'crown' });
  remove(r1, { category: 'panel-moulding' });
  assert.equal(d.faceTrim.flatMap((r) => r.items).filter((i) => i.kind === 'box').length, 1); // boxes are kept
  remove(r1, { category: 'door-casing' });
  assert.equal(trimKindsOn(d, facesOf(r1)).size, 0);
  // The door keeps its casing on the other room's side.
  assert.equal(d.faceTrim.flatMap((r) => r.items).filter((i) => i.kind === 'casing').length, 1);
});

test('wainscot paints underneath baseboard and casing whatever order they were added in', () => {
  const d = room();
  edit(d, (x) => applySpecs(x, scopeFaces(designFaces(x), 'house'), [{ category: 'baseboard' }, { category: 'panel-moulding' }]));
  const face = designFaces(d).find((f) => f.kind === 'room' && recordForFace(d, f)?.items.length);
  const items = resolveFaceTrim(d, face).items;
  assert.equal(items[0].item.category, 'baseboard'); // stored first...
  assert.deepEqual(drawOrder(items).map((r) => r.item.kind), ['wainscot', 'run']); // ...but painted last
});

test('casing pieces meet at mitres: they tile the frame exactly, with no overlap', () => {
  const area = (poly) => Math.abs(poly.reduce((a, p, i) => { const q = poly[(i + 1) % poly.length]; return a + p.s * q.z - q.s * p.z; }, 0)) / 2;
  const d = room();
  edit(d, (x) => {
    addOpening(x, northWall(x).id, 'door', 2 * FT, { width: 32 * IN, height: 80 * IN });
    addOpening(x, northWall(x).id, 'window', 7 * FT, { width: 36 * IN, height: 48 * IN, sill: 36 * IN });
  });
  addToFace(d, 'North', (x, face) => face.openings.map((op) => makeCasing(x, op.opening)));
  for (const r of resolvedFace(d, 'North').items) {
    const { op, outer } = r;
    const w = r.item.size;
    const frame = r.pieces.filter((p) => !['stool', 'apron', 'sill'].includes(p.part));
    const inner = { s0: op.s0 - r.item.reveal, s1: op.s1 + r.item.reveal, top: op.top + r.item.reveal };
    const isDoor = op.opening.type === 'door';
    const bottom = isDoor ? 0 : op.bottom - r.item.reveal - w;
    const innerBottom = isDoor ? 0 : bottom + w;
    const expected = (outer.s1 - outer.s0) * (outer.top - bottom) - (inner.s1 - inner.s0) * (inner.top - innerBottom);
    const total = frame.reduce((a, p) => a + area(p.poly), 0);
    assert.ok(Math.abs(total - expected) < 1e-6, `${op.opening.type}: pieces cover the frame once (${total} vs ${expected})`);
    // The head and leg share the 45° diagonal from the outer corner to the inner one.
    const head = frame.find((p) => p.part === 'head').poly;
    const left = frame.find((p) => p.part === 'left leg').poly;
    const has = (poly, pt) => poly.some((q) => Math.abs(q.s - pt.s) < 1e-9 && Math.abs(q.z - pt.z) < 1e-9);
    for (const pt of [{ s: outer.s0, z: outer.top }, { s: inner.s0, z: inner.top }]) assert.ok(has(head, pt) && has(left, pt));
    assert.ok(Math.abs((outer.top - inner.top) - (inner.s0 - outer.s0)) < 1e-9, 'mitre is at 45°');
    assert.equal(frame.find((p) => p.part === 'head').length, outer.s1 - outer.s0); // cut lengths stay long-point
  }
  // With a stool, the legs stand square on it (no mitre at the bottom).
  edit(d, (x) => { for (const i of x.faceTrim.flatMap((rec) => rec.items)) if (i.category === 'window-casing') i.stool = { profileId: 'stool-standard', size: 3.5 * IN, horn: IN }; });
  const win = resolvedFace(d, 'North').items.find((r) => r.op.opening.type === 'window');
  const leg = win.pieces.find((p) => p.part === 'left leg').poly;
  assert.equal(leg[0].z, leg[1].z);
  assert.ok(!win.pieces.some((p) => p.part === 'bottom'));
});
