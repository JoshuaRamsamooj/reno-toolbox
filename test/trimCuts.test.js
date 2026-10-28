import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addOpening, addRectangle, analyze, createDesign, normalize } from '../public/js/core/model.js';
import { designFaces, faceKey, faceRef } from '../public/js/core/faces.js';
import { applySpecs, ensureRecord, makeBox, makeCasing, makeWainscot, planTrimCutMarks, scopeFaces } from '../public/js/core/trim.js';
import { parseCatalog, setCatalog } from '../public/js/core/trimCatalog.js';
import { cutMode, faceCutMarks, planCutLookup, trimCutPlan } from '../public/js/core/trimCuts.js';
import { computeTakeoff, takeoffToCsv, trimCutSummary } from '../public/js/core/takeoff.js';
import { MM_PER_FT, MM_PER_IN } from '../public/js/core/units.js';

const IN = MM_PER_IN;
const FT = MM_PER_FT;
const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `expected ${a} ≈ ${b}`);
const catalogJson = JSON.parse(readFileSync(new URL('../public/data/trim-profiles.json', import.meta.url)));
setCatalog(catalogJson);

const BASE = { category: 'baseboard', profileId: 'base-colonial', size: 5.25 * IN };
const BASE_KEY = 'baseboard|base-colonial|13335';

function edit(d, fn) {
  fn(d);
  normalize(d);
}

/** Rooms from [x0, y0, x1, y1] rectangles in feet, zero-thickness walls, 8' ceilings. */
function plan(rects) {
  const d = createDesign('imperial');
  d.settings.wallThickness = 0;
  d.settings.ceilingHeight = 8 * FT;
  for (const [x0, y0, x1, y1] of rects) edit(d, (x) => addRectangle(x, { x: x0 * FT, y: y0 * FT }, { x: x1 * FT, y: y1 * FT }));
  return d;
}

const allRoomFaces = (d) => scopeFaces(designFaces(d), 'house');
const cutPlan = (d, opts = {}) => trimCutPlan(d, designFaces(d), { trimLength: 16 * FT, ...opts });
const lengths = (st) => st.cuts.map((c) => Math.round((c.length / FT) * 100) / 100).sort((a, b) => b - a);

test('a 10\' × 10\' room in 14\' baseboard: 3 lengths with joins, or 4 with none', () => {
  const d = plan([[0, 0, 10, 10]]);
  edit(d, (x) => applySpecs(x, allRoomFaces(x), [BASE]));
  const [g] = cutPlan(d, { stockLengths: { [BASE_KEY]: 14 * FT } }).groups;
  assert.equal(g.code, 'B');
  near(g.stock / FT, 14);
  near(g.net / FT, 40);

  const least = g.plans.material;
  assert.equal(least.count, 3);
  assert.equal(least.joins, 2); // one wall pieced from the three offcuts
  const joined = g.pieces.filter((p) => least.segments.get(p.id).length > 1);
  assert.equal(joined.length, 1);
  assert.deepEqual(least.segments.get(joined[0].id).map((s) => Math.round((s.t1 - s.t0) / FT)).sort(), [2, 4, 4]);

  const fewest = g.plans.joins;
  assert.equal(fewest.count, 4);
  assert.equal(fewest.joins, 0);
  assert.ok(fewest.sticks.every((st) => st.cuts.length === 1 && Math.abs(st.offcut - 4 * FT) < 1)); // a 4' offcut each, for use elsewhere
  // Sticks are numbered around the room and tagged by kind.
  assert.deepEqual(fewest.sticks.map((st) => st.tag), ['B-1', 'B-2', 'B-3', 'B-4']);
});

test('the estimate follows the toggle, and the difference shows in amount and price', () => {
  const d = plan([[0, 0, 10, 10]]);
  edit(d, (x) => applySpecs(x, allRoomFaces(x), [BASE]));
  d.estimate = { trimWaste: 0, stockLengths: { [BASE_KEY]: 14 * FT }, prices: { [`trim:${BASE_KEY}`]: 1.5 }, taxRate: 10 };
  assert.equal(cutMode(d), 'material');
  let t = computeTakeoff(d);
  let line = t.materials.find((m) => m.key === `trim:${BASE_KEY}`);
  near(line.quantity, 42);
  assert.match(line.detail, /^3 × 14' \(3 from the cut plan, least material, 2 joins/);
  near(t.pricing.total, 42 * 1.5 * 1.1);

  d.estimate.trimOptimize = true;
  assert.equal(cutMode(d), 'joins');
  t = computeTakeoff(d);
  line = t.materials.find((m) => m.key === `trim:${BASE_KEY}`);
  near(line.quantity, 56);
  assert.match(line.detail, /^4 × 14' \(4 from the cut plan, fewest joins, 0 joins/);
  near(t.pricing.total, 56 * 1.5 * 1.1);

  // Both plans are priced either way, so the views can show the difference.
  const s = trimCutSummary(d);
  assert.equal(s.mode, 'joins');
  near(s.byMode.joins.pricing.total - s.byMode.material.pricing.total, 14 * 1.5 * 1.1);

  // Left over is what is bought less what is installed: the four 4' offcuts.
  near(line.cuts.leftover / FT, 16);
  assert.equal(line.cuts.spare, 0);

  // Waste is added on top of the cut plan, in whole lengths, and left over follows it.
  d.estimate.trimWaste = 10;
  line = computeTakeoff(d).materials.find((m) => m.key === `trim:${BASE_KEY}`);
  near(line.quantity, 5 * 14);
  near(line.net, 4 * 14); // the cut plan's lengths, before the waste allowance
  assert.equal(line.cuts.spare, 1);
  near(line.cuts.leftover / FT, 16 + 14);
  d.estimate.trimOptimize = false;
  line = computeTakeoff(d).materials.find((m) => m.key === `trim:${BASE_KEY}`);
  near(line.cuts.leftover / FT, 4 * 14 - 40); // 3 lengths + 1 spare
});

test('fewest joins: only runs longer than the stock are joined, never with a short tail', () => {
  const d = plan([[0, 0, 30, 10]]);
  edit(d, (x) => applySpecs(x, allRoomFaces(x), [BASE]));
  const [g] = cutPlan(d).groups;
  const long = g.pieces.filter((p) => p.length > 16 * FT);
  assert.equal(long.length, 2);
  for (const p of long) {
    const segs = g.plans.joins.segments.get(p.id);
    assert.equal(segs.length, 2); // 30' in 16' stock: one join
    assert.ok(segs.every((s) => s.t1 - s.t0 <= 16 * FT + 0.5));
  }
  assert.equal(g.plans.joins.joins, 2);

  // 17' in 16' stock would leave a 1' tail: the join moves to the middle instead.
  const e = plan([[0, 0, 17, 6]]);
  edit(e, (x) => applySpecs(x, allRoomFaces(x), [BASE]));
  const [h] = cutPlan(e).groups;
  const p17 = h.pieces.find((p) => p.length > 16 * FT);
  assert.deepEqual(h.plans.joins.segments.get(p17.id).map((s) => (s.t1 - s.t0) / FT), [8.5, 8.5]);
});

test('offcuts are reused for short runs elsewhere in the house', () => {
  // A 10' × 10' room and a 4' × 2' closet: 52' of baseboard in 14' stock.
  const d = plan([[0, 0, 10, 10], [10, 0, 14, 2]]);
  edit(d, (x) => applySpecs(x, allRoomFaces(x), [BASE]));
  const [g] = cutPlan(d, { stockLengths: { [BASE_KEY]: 14 * FT } }).groups;
  // The room's walls are split by the closet's corner, so count the closet's 4' and 2' pieces.
  const closetId = analyze(d).rooms.find((r) => Math.abs(r.area - 8 * FT * FT) < 1).room.id;
  const closet = g.pieces.filter((p) => p.roomId === closetId);
  assert.equal(closet.length, 4);
  const fewest = g.plans.joins;
  assert.equal(fewest.joins, 0);
  // Every closet piece shares a stick with a room piece.
  for (const p of closet) {
    const n = fewest.segments.get(p.id)[0].stick;
    assert.ok(fewest.sticks[n - 1].cuts.some((c) => c.piece.roomId !== closetId), `closet piece on its own stick ${n}`);
  }
  assert.ok(fewest.count <= 5);
  assert.ok(g.plans.material.count <= fewest.count);
});

test('least material never needs more stock, or more joins for the same stock, than fewest joins', () => {
  for (const rects of [[[0, 0, 8, 8]], [[0, 0, 12, 10], [12, 0, 20, 10]], [[0, 0, 31, 7]], [[0, 0, 13, 13], [13, 0, 16, 3]]]) {
    const d = plan(rects);
    edit(d, (x) => applySpecs(x, allRoomFaces(x), [BASE]));
    for (const stock of [8, 12, 14, 16]) {
      const [g] = cutPlan(d, { stockLengths: { [BASE_KEY]: stock * FT } }).groups;
      const { material, joins } = g.plans;
      assert.ok(material.count <= joins.count);
      if (material.count === joins.count) assert.ok(material.joins <= joins.joins);
      assert.equal(material.count, Math.max(Math.ceil(g.net / g.stock - 1e-6), material.count)); // lower bound
      for (const p of [material, joins]) {
        // Every piece is covered end to end, and no stick is over-filled.
        for (const piece of g.pieces) {
          const segs = p.segments.get(piece.id);
          near(segs[0].t0, 0);
          near(segs.at(-1).t1, piece.length, 0.01);
          for (let i = 1; i < segs.length; i++) near(segs[i].t0, segs[i - 1].t1);
        }
        for (const st of p.sticks) assert.ok(st.used <= g.stock + 0.5);
      }
    }
  }
});

test('casing, stools, aprons, boxes and sloped crown are cut as straight lengths', () => {
  const d = plan([[0, 0, 12, 10]]);
  const north = () => designFaces(d).find((f) => f.kind === 'room' && f.compass === 'North');
  edit(d, (x) => {
    const wall = x.walls.find((w) => [w.a, w.b].every((id) => Math.abs(x.nodes.find((nd) => nd.id === id).y) < 1));
    addOpening(x, wall.id, 'door', 3 * FT, { width: 32 * IN, height: 80 * IN });
    addOpening(x, wall.id, 'window', 8 * FT, { width: 36 * IN, height: 48 * IN, sill: 36 * IN });
  });
  edit(d, (x) => {
    const face = designFaces(x).find((f) => f.kind === 'room' && f.compass === 'North');
    ensureRecord(x, face).items.push(
      ...face.openings.map((op) => makeCasing(x, op.opening, op.opening.type === 'window' ? { stool: {}, apron: {} } : {})),
      makeBox(x, { s: 6 * FT, z: 6 * IN, w: 20 * IN, h: 14 * IN }),
    );
  });
  // Gable ceiling with an east–west ridge: crown on the east and west walls turns at the peak.
  edit(d, (x) => { x.rooms[0].ceiling = { type: 'gable', height: 8 * FT, peak: 10 * FT, ridge: 'EW' }; });
  edit(d, (x) => applySpecs(x, allRoomFaces(x), [{ category: 'crown' }]));
  const p = cutPlan(d);
  const parts = (cat) => p.groups.filter((g) => g.category === cat).flatMap((g) => g.pieces).filter((pc) => pc.face === faceKey(faceRef(north())));
  const ext = 3 / 16 + 3.5;
  assert.deepEqual(parts('door-casing').map((c) => c.part).sort(), ['head', 'left leg', 'right leg']);
  near(parts('door-casing').find((c) => c.part === 'head').length / IN, 32 + 2 * ext);
  assert.deepEqual(parts('window-casing').map((c) => c.part).sort(), ['head', 'left leg', 'right leg']);
  assert.equal(parts('window-stool').length, 1);
  assert.equal(parts('window-apron').length, 1);
  assert.deepEqual(parts('panel-moulding').map((c) => Math.round(c.length / IN)).sort(), [14, 14, 20, 20]);
  // Legs run up the face, heads across it.
  const leg = parts('door-casing').find((c) => c.part === 'left leg');
  near(leg.a.s, leg.b.s);
  assert.ok(leg.b.z > leg.a.z);

  const east = designFaces(d).find((f) => f.kind === 'room' && f.compass === 'East');
  const crown = p.groups.find((g) => g.category === 'crown').pieces.filter((c) => c.face === faceKey(faceRef(east)));
  assert.equal(crown.length, 2);
  for (const c of crown) near(c.length / IN, Math.hypot(60, 24));
  // Each kind of stock gets its own tag letter.
  assert.deepEqual(p.groups.map((g) => g.code), ['C', 'P', 'D', 'W', 'T', 'A']);
});

test('sheet wainscot: panels between doors, seams are joins, sheets from panels per sheet', () => {
  const d = plan([[0, 0, 12, 10]]);
  edit(d, (x) => {
    const wall = x.walls.find((w) => [w.a, w.b].every((id) => Math.abs(x.nodes.find((nd) => nd.id === id).y) < 1));
    addOpening(x, wall.id, 'door', 6 * FT, { width: 32 * IN, height: 80 * IN });
  });
  edit(d, (x) => applySpecs(x, allRoomFaces(x), [{ category: 'panel-moulding', profileId: 'wainscot-beadboard-sheet', size: 4 * FT, height: 32 * IN }]));
  const [g] = cutPlan(d).groups;
  assert.equal(g.kind, 'sheet');
  assert.equal(g.code, 'K');
  near(g.stock / IN, 48);
  assert.equal(g.perSheet, 3); // 96" sheet / 32" panels
  // North: two 56" stretches beside the door; the other walls 120", 144", 120".
  assert.deepEqual(g.pieces.map((p) => Math.round(p.length / IN)).sort((a, b) => a - b), [56, 56, 120, 120, 144]);
  const fewest = g.plans.joins;
  assert.equal(fewest.joins, 1 + 1 + 2 + 2 + 2); // one seam in each 56" stretch, two in the others
  assert.equal(fewest.sheets, Math.ceil(fewest.count / 3));
  const t = computeTakeoff(d);
  const sheets = t.materials.find((m) => m.trim?.profileId === 'wainscot-beadboard-sheet');
  assert.equal(sheets.cuts.count, g.plans.material.sheets);
  // Left over is the sheet area bought less the panelling's net area.
  near(sheets.cuts.leftover, sheets.quantity * 4 * FT * 8 * FT - sheets.trim.area, 1);
});

test('shiplap: each course is a run of boards in the board length', () => {
  const d = plan([[0, 0, 20, 10]]);
  edit(d, (x) => applySpecs(x, allRoomFaces(x), [{ category: 'panel-moulding', profileId: 'wainscot-shiplap', size: 5.5 * IN, height: 33 * IN }]));
  d.estimate = { stockLengths: { 'panel-moulding|wainscot-shiplap|13970': 12 * FT } };
  const [g] = cutPlan(d, { stockLengths: d.estimate.stockLengths }).groups;
  assert.equal(g.kind, 'boards');
  near(g.stock / FT, 12);
  assert.equal(g.pieces.length, 6 * 4); // six 5½" courses on each of four walls
  // The 20' walls need one join per course with fewest joins; the 10' walls none.
  assert.equal(g.plans.joins.joins, 6 * 2);
  const line = computeTakeoff(d).materials.find((m) => m.trim?.profileId === 'wainscot-shiplap');
  assert.match(line.detail, /× 12' boards/);
});

test('stock length: the plan\'s override, else the catalog, else the default trim length', () => {
  const cat = parseCatalog({ profiles: [
    { id: 'b14', name: 'B14', category: 'baseboard', widths: ['3"'], unit: 'lf', stockLength: "14'" },
    { id: 'bad', name: 'Bad', category: 'baseboard', widths: ['3"'], unit: 'lf', stockLength: '14' },
  ] });
  near(cat.byId.get('b14').stockLength / FT, 14);
  assert.ok(!cat.byId.has('bad'));
  assert.match(cat.warnings[0], /stockLength/);

  setCatalog({ profiles: [...catalogJson.profiles, { id: 'b14', name: 'B14', category: 'baseboard', widths: ['3"'], unit: 'lf', stockLength: "14'" }] });
  try {
    const d = plan([[0, 0, 10, 10]]);
    edit(d, (x) => applySpecs(x, allRoomFaces(x), [BASE, { category: 'chair-rail', profileId: 'chair-colonial', size: 2.5 * IN, height: 36 * IN }]));
    edit(d, (x) => applySpecs(x, allRoomFaces(x), [{ category: 'baseboard', profileId: 'b14', size: 3 * IN }]));
    const p = cutPlan(d, { trimLength: 12 * FT, stockLengths: { 'chair-rail|chair-colonial|6350': 8 * FT } });
    const base = p.groups.find((g) => g.category === 'baseboard');
    const rail = p.groups.find((g) => g.category === 'chair-rail');
    assert.equal(base.stockSource, 'catalog');
    near(base.stock / FT, 14);
    assert.equal(rail.stockSource, 'plan');
    near(rail.stock / FT, 8);
    edit(d, (x) => applySpecs(x, allRoomFaces(x), [BASE]));
    const def = cutPlan(d, { trimLength: 12 * FT }).groups.find((g) => g.category === 'baseboard');
    assert.equal(def.stockSource, 'default');
    near(def.stock / FT, 12);
  } finally {
    setCatalog(catalogJson);
  }
});

test('joins are drawn across the trim on elevations and on the plan', () => {
  const d = plan([[0, 0, 10, 10]]);
  edit(d, (x) => applySpecs(x, allRoomFaces(x), [BASE]));
  const faces = designFaces(d);
  const p = cutPlan(d, { stockLengths: { [BASE_KEY]: 14 * FT } });
  const g = p.groups[0];
  const joinedFace = g.pieces.find((pc) => g.plans.material.segments.get(pc.id).length > 1).face;

  const marks = faceCutMarks(p, 'material', joinedFace);
  assert.equal(marks.joins.length, 2);
  for (const j of marks.joins) {
    near(j.a.s, j.b.s); // straight up through the baseboard
    near(Math.min(j.a.z, j.b.z), 0);
    near(Math.max(j.a.z, j.b.z) / IN, 5.25);
  }
  assert.equal(marks.labels.length, 3);
  assert.equal(faceCutMarks(p, 'joins', joinedFace).joins.length, 0);

  const depth = () => 0.75 * IN;
  const planMarks = planTrimCutMarks(d, faces, depth, planCutLookup(p, 'material'));
  assert.equal(planMarks.filter((m) => m.part === 'join').length, 2);
  assert.equal(planMarks.filter((m) => m.part === 'cut').length, 6); // 4 walls, one of them in 3 lengths
  for (const m of planMarks.filter((x) => x.part === 'join')) near(Math.hypot(m.b.x - m.a.x, m.b.y - m.a.y) / IN, 0.75);
  assert.equal(planTrimCutMarks(d, faces, depth, planCutLookup(p, 'joins')).filter((m) => m.part === 'join').length, 0);
});

test('the CSV carries the cut list for the plan in use', () => {
  const d = plan([[0, 0, 10, 10]]);
  edit(d, (x) => applySpecs(x, allRoomFaces(x), [BASE]));
  d.estimate = { trimOptimize: true, stockLengths: { [BASE_KEY]: 14 * FT } };
  const csv = takeoffToCsv(d, computeTakeoff(d));
  assert.match(csv, /Trim cut list \(fewest joins\)/);
  assert.equal(csv.split('\n').filter((r) => /^B-\d,/.test(r)).length, 4);
});

test('board and batten stays an area estimate', () => {
  const d = plan([[0, 0, 10, 10]]);
  edit(d, (x) => applySpecs(x, allRoomFaces(x), [{ category: 'panel-moulding', profileId: 'wainscot-board-batten', size: 2.5 * IN, height: 36 * IN }]));
  assert.equal(cutPlan(d).groups.length, 0);
  const line = computeTakeoff(d).materials.find((m) => m.trim?.profileId === 'wainscot-board-batten');
  assert.equal(line.cuts, undefined);
  assert.match(line.detail, /net \+ 10% waste/);
});
