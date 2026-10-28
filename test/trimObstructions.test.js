import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addRectangle, createDesign, normalize } from '../public/js/core/model.js';
import { designFaces } from '../public/js/core/faces.js';
import { applySpecs, layoutBoxes, resolveFaceTrim, scopeFaces } from '../public/js/core/trim.js';
import { createFurniture, resolveItem, trimObstructions } from '../public/js/core/furniture.js';
import { setCatalog } from '../public/js/core/trimCatalog.js';
import { MM_PER_FT, MM_PER_IN } from '../public/js/core/units.js';

const IN = MM_PER_IN;
const FT = MM_PER_FT;
const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `expected ${a} ≈ ${b}`);
setCatalog(JSON.parse(readFileSync(new URL('../public/data/trim-profiles.json', import.meta.url))));

/** A 12' × 10' room (zero-thickness walls) with baseboard, a chair rail at 36" and crown on every wall. */
function room() {
  const d = createDesign('imperial');
  d.settings.wallThickness = 0;
  d.settings.ceilingHeight = 8 * FT;
  addRectangle(d, { x: 0, y: 0 }, { x: 12 * FT, y: 10 * FT });
  normalize(d);
  applySpecs(d, scopeFaces(designFaces(d), 'house'), [{ category: 'baseboard' }, { category: 'chair-rail', height: 36 * IN }, { category: 'crown' }]);
  normalize(d);
  return d;
}

/** A piece backed onto the north wall (angle 0), its left side `x` inches from the west wall. */
function againstNorth(d, type, size, x, opts = {}) {
  const f = createFurniture(type, { x: 0, y: 0 }, { size, opts });
  f.x = x * IN + f.w / 2;
  f.y = f.d / 2;
  d.furniture.push(f);
  return f;
}

const north = (d) => designFaces(d).find((f) => f.kind === 'room' && f.compass === 'North');
const pieces = (d, category) => resolveFaceTrim(d, north(d)).items.find((r) => r.item.category === category).pieces
  .map((p) => [Math.round((p.s0 / IN) * 100) / 100, Math.round((p.s1 / IN) * 100) / 100]);

test('the catalog says which pieces cut trim; each piece can override it', () => {
  const r = (type, opts) => resolveItem(createFurniture(type, { x: 0, y: 0 }, { opts }));
  for (const type of ['base-cabinet', 'upper-cabinet', 'tall-cabinet', 'bath-vanity', 'shower', 'tub', 'dishwasher']) assert.equal(r(type).cutsTrim, true, type);
  for (const type of ['sofa', 'bed', 'dresser', 'toilet', 'pedestal-sink', 'washer', 'freestanding-tub']) assert.equal(r(type).cutsTrim, false, type);
  assert.equal(r('sofa', { cutsTrim: true }).cutsTrim, true);
  assert.equal(r('base-cabinet', { cutsTrim: false }).cutsTrim, false);
});

test('base cabinets against a wall stop the baseboard and chair rail, not the crown', () => {
  const d = room();
  againstNorth(d, 'base-cabinet', '36', 24);
  againstNorth(d, 'base-cabinet', '24', 60); // a run: 24"–60" and 60"–84"
  const obs = trimObstructions(d, north(d));
  assert.equal(obs.length, 2);
  near(obs[0].top / IN, 34.5);
  assert.deepEqual(pieces(d, 'baseboard'), [[0, 24], [84, 144]]);
  assert.deepEqual(pieces(d, 'chair-rail'), [[0, 24], [84, 144]]); // the rail (33½"–36") meets the 34½" cabinets
  assert.deepEqual(pieces(d, 'crown'), [[0, 144]]);
  // Other walls are untouched.
  const east = designFaces(d).find((f) => f.kind === 'room' && f.compass === 'East');
  assert.equal(resolveFaceTrim(d, east).items.find((r) => r.item.category === 'baseboard').pieces.length, 1);
});

test('upper cabinets only cut what is as high as them; a shower takes everything up to 80"', () => {
  const d = room();
  againstNorth(d, 'upper-cabinet', '30', 24); // 54"–84" above the floor
  assert.deepEqual(pieces(d, 'baseboard'), [[0, 144]]);
  assert.deepEqual(pieces(d, 'chair-rail'), [[0, 144]]);
  assert.deepEqual(pieces(d, 'crown'), [[0, 144]]); // crown is 92⅜"–96": above the cabinets

  const e = room();
  againstNorth(e, 'shower', 'square-36', 108); // in the north-east corner
  assert.deepEqual(pieces(e, 'baseboard'), [[0, 108]]);
  assert.deepEqual(pieces(e, 'chair-rail'), [[0, 108]]);
  const east = designFaces(e).find((f) => f.kind === 'room' && f.compass === 'East');
  // The shower's side is against the east wall too: 36" of it from the north corner.
  assert.deepEqual(resolveFaceTrim(e, east).items.find((r) => r.item.category === 'baseboard').pieces.map((p) => Math.round(p.s0 / IN)), [36]);
});

test('furniture leaves trim in place unless told otherwise, and pieces off the wall never cut it', () => {
  const d = room();
  const sofa = againstNorth(d, 'sofa', 'std', 24);
  assert.deepEqual(pieces(d, 'baseboard'), [[0, 144]]);
  sofa.opts.cutsTrim = true;
  assert.deepEqual(pieces(d, 'baseboard'), [[0, 24], [108, 144]]);

  const e = room();
  const cab = againstNorth(e, 'base-cabinet', '36', 24);
  cab.y += 3 * IN; // 3" off the wall
  assert.deepEqual(pieces(e, 'baseboard'), [[0, 144]]);
  cab.y -= 3 * IN;
  cab.opts.cutsTrim = false;
  assert.deepEqual(pieces(e, 'baseboard'), [[0, 144]]);
});

test('wainscot and picture-frame boxes stay clear of built-ins', () => {
  const d = room();
  applySpecs(d, scopeFaces(designFaces(d), 'house'), [{ category: 'panel-moulding', profileId: 'wainscot-beadboard-sheet', size: 4 * FT, height: 32 * IN }]);
  normalize(d);
  againstNorth(d, 'bath-vanity', '36', 24);
  const res = resolveFaceTrim(d, north(d));
  const panel = res.items.find((r) => r.item.kind === 'wainscot').pieces[0];
  near(panel.area / (IN * IN), 144 * 32 - 36 * 32, 0.5);
  // Boxes laid out at the vanity's height go either side of it.
  const low = layoutBoxes(d, res, { bottom: 6 * IN, top: 30 * IN, gap: 4 * IN, width: 24 * IN, size: IN });
  assert.ok(low.length > 0);
  assert.ok(low.every((b) => b.s + b.w <= 24 * IN + 0.5 || b.s >= 60 * IN - 0.5));
});
