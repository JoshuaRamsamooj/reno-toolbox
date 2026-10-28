// Wall face editor: an isolated, to-scale elevation of one wall face, where
// trim is drawn and edited. World coordinates are millimetres in face space
// (s from the face's left end as seen facing the wall, z above the finished
// floor) and the view maps them to the screen with one uniform scale, so
// lengths and heights stay true at any zoom or pan. Trim is stored on the
// design (see core/trim.js) and every edit goes through app.change or a
// live drag, so it is all undoable.
import { analyze, doorStyle } from '../core/model.js';
import { profileHeightAt } from '../core/ceiling.js';
import { designFaces, faceKey, faceRef, faceTitle, findFace, parseFaceKey } from '../core/faces.js';
import { faceCutMarks } from '../core/trimCuts.js';
import { cutMarksSvg, cutToggles } from './cutPlan.js';
import { obstructionSvg } from './elevationView.js';
import {
  drawOrder, ensureRecord, faceTrimLines, isTrayCrown, itemLabel, layoutBoxes, specKey, makeBox, makeCasing, makeRun, makeWainscot, parseTrimDimensions, parseTrimLength,
  recordForFace, resolveFaceTrim, specFromItem, specsFromRecord, trimDefaults,
} from '../core/trim.js';
import { TRIM_CATEGORIES, defaultProfile, getProfile, profileLabel } from '../core/trimCatalog.js';
import { MM_PER_IN, areaUnit, areaValue, formatLength, lengthValue } from '../core/units.js';
import { doorMarksSvg, esc, n, wainscotMarksSvg } from './svg.js';
import { field, h, lengthInput } from './dom.js';
import { DrawingCanvas } from './canvas.js';
import { RulerGuides } from './guides.js';
import {
  SCOPE_LABELS, applyToScope, clearScope, faceSummary, packageApplier, packageManager, profilePicker, quickApply, quickRemove, removeFromScope,
  saveFaceAsPackage, trimLengthOpts,
  windowParts,
} from './trimPanels.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const TYPABLE = /^[0-9.'"\/\- xXmMcC]$/;
const HANDLE = 5; // px half-size

export const FACE_TOOLS = {
  select: { label: 'Select', key: 'V', hint: 'Click trim to select one piece (a run between openings, a casing leg or head) · drag to move, drag handles to resize or trim a run · Del removes the clicked piece, or the whole item when it is the last (Shift+Del: that kind from the whole room) · arrows nudge (Shift = more) · type a value + Enter to set a selected rail, wainscot or box · drag from a ruler for a guide, Shift+drag a guide to pull another off it (type a distance + Enter)' },
  baseboard: { label: 'Baseboard', key: 'B', category: 'baseboard', hint: 'Click to run baseboard along the whole face (gaps at doors are automatic) · drag to draw a partial run' },
  shoe: { label: 'Shoe', key: 'H', category: 'shoe', hint: 'Click to run shoe moulding (or quarter round) along the floor at the foot of the baseboard · gaps at doors and stops at casing like baseboard · drag for a partial run' },
  crown: { label: 'Crown', key: 'C', category: 'crown', hint: 'Click to run crown along the ceiling (follows slopes, gaps at bulkheads) · click inside a dashed tray outline for crown in the tray · drag for a partial run' },
  'chair-rail': { label: 'Chair rail', key: 'R', category: 'chair-rail', hint: 'Click at a height for a full-width rail (height = top edge, snaps to sills and heads) · drag for a partial run · or type a height like 36 + Enter' },
  casing: { label: 'Casing', key: 'O', hint: 'Click a door, window or opening to case it on this side of the wall' },
  box: { label: 'Panel box', key: 'M', category: 'panel-moulding', hint: 'Drag a picture-frame box (snaps to openings, trim and the grid) · type a size like 24x18 + Enter to place one exactly' },
  wainscot: { label: 'Wainscot', key: 'W', category: 'panel-moulding', hint: 'Click for wainscot along the whole face at the default height · type a height + Enter · drag for part of the wall' },
  pan: { label: 'Pan', key: 'P', hint: 'Drag to move around · scroll to zoom · right-drag, middle-drag or Space+drag pans with any tool' },
};

const OPENING_NAMES = { door: 'door', window: 'window', opening: 'opening' };

export class FaceEditor {
  constructor(app, el) {
    this.app = app;
    this.el = el;
    this.tool = 'select';
    this.sel = null; // { id, seg }
    this.drag = null;
    this.hover = null;
    this.cursor = null;
    this.typed = '';
    this.message = '';
    this.toolSpecs = {};
    this.fittedKey = null;
    this.header = h('div', { class: 'fe-header' });
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.classList.add('fe-canvas');
    this.empty = h('div', { class: 'fe-empty', hidden: true });
    this.el.append(this.header, this.empty, this.svg);
    // Height is up on a wall face; zoom from a whole house wall down to 1/16".
    this.canvas = new DrawingCanvas({
      svg: this.svg, app, units: () => this.units, yUp: true, minScale: 0.01, maxScale: 30, scale: 0.2,
      onView: () => this.renderCanvas(), fitLabel: 'Fit the face (F)',
    });
    // Ruler guides, as on the plan; kept on the face's trim record in face coordinates (x = s, y = z).
    this.selGuide = null;
    this.rulers = this.rulerGuides();
    this.bindEvents();
    new ResizeObserver(() => this.renderCanvas()).observe(this.svg);
  }

  get design() {
    return this.app.design;
  }

  get units() {
    return this.design.units;
  }

  // -------------------------------------------------------------------------
  // Data

  context() {
    const d = this.design;
    const faces = designFaces(d, analyze(d));
    const face = findFace(faces, this.app.trimFace);
    if (!face) return { faces, face: null };
    const resolved = resolveFaceTrim(d, face);
    return { faces, face, resolved, record: resolved.record };
  }

  findItem(id) {
    for (const r of this.design.faceTrim) {
      const item = r.items.find((i) => i.id === id);
      if (item) return item;
    }
    return null;
  }

  selectedResolved(c = this.ctx) {
    return this.sel ? c?.resolved?.items.find((r) => r.item.id === this.sel.id) ?? null : null;
  }

  /** Mutates the item with this id as one undoable step. */
  editItem(id, label, fn) {
    this.app.change(label, (d) => {
      for (const r of d.faceTrim) {
        const item = r.items.find((i) => i.id === id);
        if (item) fn(item, r);
      }
    });
  }

  /** Adds items to the current face as one undoable step and selects the first. */
  addItems(label, make) {
    let first = null;
    this.app.change(label, (d) => {
      const face = findFace(designFaces(d), this.app.trimFace);
      if (!face) return;
      const items = [make(d, face)].flat().filter(Boolean);
      ensureRecord(d, face).items.push(...items);
      first = items[0] ?? null;
    });
    if (first && this.findItem(first.id)) this.sel = { id: first.id, seg: null };
    this.app.refresh();
  }

  /** Profile and width a creation tool uses, remembered per tool. */
  toolSpec(tool) {
    if (this.toolSpecs[tool]) return this.toolSpecs[tool];
    const def = trimDefaults(this.units);
    const category = FACE_TOOLS[tool]?.category;
    const filter = tool === 'box' ? (p) => p.unit === 'lf' : tool === 'wainscot' ? (p) => p.unit !== 'lf' : undefined;
    const p = category ? defaultProfile(category, filter) : null;
    const spec = { profileId: p?.id ?? null, size: p?.defaultWidth ?? null };
    if (tool === 'chair-rail') spec.height = def.chairRail;
    if (tool === 'wainscot') spec.height = def.wainscot;
    this.toolSpecs[tool] = spec;
    return spec;
  }

  // -------------------------------------------------------------------------
  // View

  get view() {
    return this.canvas.view;
  }

  get snapOn() {
    return this.canvas.snapOn;
  }

  get gridOn() {
    return this.canvas.gridOn;
  }

  X(s) {
    return this.canvas.X(s);
  }

  Y(z) {
    return this.canvas.Y(z);
  }

  toFace(e) {
    const p = this.canvas.toWorld(e);
    return { s: p.x, z: p.y, x: p.sx, y: p.sy };
  }

  fit(render = true) {
    const c = this.ctx ?? this.context();
    if (!c.face) return false;
    const L = Math.max(c.face.length, 300);
    const H = Math.max(...c.face.profile.map((p) => p.z), c.face.tray?.top ?? 0, 300);
    if (!this.canvas.fitTo({ minX: 0, minY: 0, maxX: L, maxY: H }, { left: 60, top: 40, right: 50, bottom: 80 })) return false;
    this.fittedKey = this.fitKey(c.face);
    if (render) this.renderCanvas();
    return true;
  }

  /** Refit when another face opens or this one changes size (e.g. a new ceiling height). */
  fitKey(face) {
    return `${faceKey(this.app.trimFace)}|${Math.round(face.length)}|${Math.round(Math.max(...face.profile.map((p) => p.z), face.tray?.top ?? 0))}`;
  }

  zoomBy(factor) {
    this.canvas.zoomBy(factor);
  }

  /** Finest increment for free (unsnapped) input: 1/16" or 1 mm. */
  get fine() {
    return this.canvas.fine;
  }

  // -------------------------------------------------------------------------
  // Snapping

  /** Edges worth snapping to: corners, floor, ceiling, openings, casing, bulkheads, other trim and (unless `guides` is false) ruler guides. */
  snapTargets(excludeId, guides = true) {
    const c = this.ctx;
    const { face, resolved } = c;
    const s = [{ v: 0, label: 'corner' }, { v: face.length, label: 'corner' }, { v: face.length / 2, label: 'centre of wall' }];
    const z = [{ v: 0, label: 'floor' }];
    if (guides) for (const g of this.faceGuides()) (g.axis === 'x' ? s : z).push({ v: g.v, label: 'guide' });
    for (const op of face.openings) {
      const name = OPENING_NAMES[op.opening.type];
      s.push({ v: op.s0, label: `${name} edge` }, { v: op.s1, label: `${name} edge` }, { v: (op.s0 + op.s1) / 2, label: `${name} centre` });
      z.push({ v: op.top, label: `${name} head` });
      if (op.bottom > 0) z.push({ v: op.bottom, label: 'window sill' });
    }
    for (const env of resolved.envelopes) {
      if (!env.casing) continue;
      s.push({ v: env.s0, label: 'casing edge' }, { v: env.s1, label: 'casing edge' });
      z.push({ v: env.top, label: 'top of casing' });
      if (env.op.opening.type === 'window') z.push({ v: env.bottom, label: 'bottom of window trim' });
    }
    for (const ob of resolved.obstructions ?? []) {
      const label = ob.name.toLowerCase();
      s.push({ v: ob.s0, label }, { v: ob.s1, label });
      z.push({ v: ob.top, label: `top of ${label}` });
      if (ob.bottom > 0) z.push({ v: ob.bottom, label: `bottom of ${label}` });
    }
    for (const b of face.bands ?? []) {
      s.push({ v: b.s0, label: 'bulkhead' }, { v: b.s1, label: 'bulkhead' });
      z.push({ v: b.bottom, label: 'bulkhead' });
    }
    if (face.tray?.edge) {
      s.push({ v: face.tray.edge.s0, label: 'tray edge' }, { v: face.tray.edge.s1, label: 'tray edge' });
      z.push({ v: face.tray.top, label: 'tray ceiling' });
    }
    for (const r of resolved.items) {
      if (r.item.id === excludeId) continue;
      const label = itemLabel(r.item).toLowerCase();
      for (const p of r.pieces) {
        const bb = bbox(p.poly);
        s.push({ v: bb.s0, label }, { v: bb.s1, label });
        z.push({ v: bb.z0, label: `bottom of ${label}` }, { v: bb.z1, label: `top of ${label}` });
      }
    }
    return { s, z };
  }

  /** Snaps one coordinate: nearest target within 8 px, else the grid (or 1/16" / 1 mm). */
  snapValue(raw, targets, free) {
    return this.canvas.snapValue(raw, targets, free);
  }

  snapPoint(p, { free = false, excludeId = null } = {}) {
    const t = this.snapTargets(excludeId);
    const s = this.snapValue(p.s, t.s, free);
    const ceiling = profileHeightAt(this.ctx.face.profile, s.v);
    const z = this.snapValue(p.z, [...t.z, { v: ceiling, label: 'ceiling' }], free);
    return { s: s.v, z: z.v, guideS: s.label ? s : null, guideZ: z.label ? z : null };
  }

  /** True when a face point is up in the tray, above this wall's top. */
  inTray(p) {
    const face = this.ctx?.face;
    const t = face?.tray;
    if (!t?.edge || !p) return false;
    const lo = Math.min(t.edge.s0, t.edge.s1);
    const hi = Math.max(t.edge.s0, t.edge.s1);
    return p.s >= lo && p.s <= hi && p.z > profileHeightAt(face.profile, p.s) && p.z <= t.top + 12 / this.view.scale;
  }

  /** Snaps a moving set of edges (e.g. both sides of a box) to targets or the grid. */
  snapEdges(edges, targets, free) {
    return this.canvas.snapEdges(edges, targets, free);
  }

  // -------------------------------------------------------------------------
  // Ruler guides (guides.js does the work)

  /** The open face's guides. */
  faceGuides() {
    const face = this.ctx?.face;
    return (face && recordForFace(this.design, face)?.guides) || [];
  }

  rulerGuides() {
    const fe = this;
    return new RulerGuides(this.canvas, {
      list: () => this.faceGuides(),
      save: (label, fn) => this.app.change(label, (d) => {
        const face = findFace(designFaces(d), this.app.trimFace);
        if (!face) return;
        const rec = ensureRecord(d, face);
        rec.guides ??= [];
        fn(rec.guides);
      }),
      // Everything the trim tools snap to (corners, floor, openings, casing, trim) is also a reference for typed distances.
      targets: (axis) => {
        if (!this.ctx?.face) return [];
        const t = this.snapTargets(null, false);
        return (axis === 'x' ? t.s : t.z).map((x) => ({ ...x, ref: true }));
      },
      parse: (text) => parseTrimLength(text, this.units),
      get example() { return fe.units === 'metric' ? '450 or 1.2m' : '18 or 3\'6"'; },
      canGrab: () => this.tool === 'select',
      isSelected: (id) => this.selGuide === id,
      select: (id) => {
        this.selGuide = id;
        this.sel = null;
        this.app.inspector.render();
      },
      render: () => this.renderCanvas(),
      flash: (msg) => this.flash(msg),
    });
  }

  deleteGuide(id) {
    this.app.change('Delete guide', (d) => {
      for (const r of d.faceTrim) if (r.guides) r.guides = r.guides.filter((g) => g.id !== id);
    });
    this.selGuide = null;
    this.app.refresh();
  }

  // -------------------------------------------------------------------------
  // Hit testing

  handles(r) {
    if (!r) return [];
    const it = r.item;
    const face = this.ctx.face;
    if (it.kind === 'run') {
      const zAt = (s) => (it.category === 'baseboard' || it.category === 'shoe' ? it.size / 2 : it.category === 'chair-rail' ? it.height - it.size / 2
        : isTrayCrown(it) ? (face.tray?.top ?? 0) - it.size / 2 : profileHeightAt(face.profile, s) - it.size / 2);
      return [{ key: 'start', s: r.a, z: zAt(r.a) }, { key: 'end', s: r.b, z: zAt(r.b) }];
    }
    if (it.kind === 'box') {
      const { s, z, w, h: hh } = it;
      return [
        { key: 'sw', s, z }, { key: 's', s: s + w / 2, z }, { key: 'se', s: s + w, z },
        { key: 'w', s, z: z + hh / 2 }, { key: 'e', s: s + w, z: z + hh / 2 },
        { key: 'nw', s, z: z + hh }, { key: 'n', s: s + w / 2, z: z + hh }, { key: 'ne', s: s + w, z: z + hh },
      ];
    }
    if (it.kind === 'wainscot') return [{ key: 'start', s: r.a, z: it.height / 2 }, { key: 'end', s: r.b, z: it.height / 2 }, { key: 'top', s: (r.a + r.b) / 2, z: it.height }];
    return [];
  }

  hitHandle(p) {
    const r = this.selectedResolved();
    for (const hd of this.handles(r)) {
      if (Math.abs(this.X(hd.s) - p.x) <= HANDLE + 3 && Math.abs(this.Y(hd.z) - p.y) <= HANDLE + 3) return { r, handle: hd.key };
    }
    return null;
  }

  /** Topmost trim piece under a screen point. */
  hitItem(p) {
    const order = drawOrder(this.ctx.resolved.items).reverse();
    for (const r of order) {
      for (const [i, piece] of r.pieces.entries()) {
        const poly = piece.poly.map((q) => ({ x: this.X(q.s), y: this.Y(q.z) }));
        const bb = screenBox(poly);
        const thin = bb.w < 8 || bb.h < 8;
        if (pointInPoly(p, poly) || (thin && p.x >= bb.x0 - 4 && p.x <= bb.x1 + 4 && p.y >= bb.y0 - 4 && p.y <= bb.y1 + 4)) {
          return { r, seg: r.item.kind === 'run' || r.item.kind === 'casing' ? i : null };
        }
      }
    }
    return null;
  }

  hitOpening(p) {
    const { face } = this.ctx;
    const s = (p.x - this.view.tx) / this.view.scale;
    const z = (this.view.ty - p.y) / this.view.scale;
    const pad = 6 / this.view.scale;
    return face.openings.find((op) => s >= op.s0 - pad && s <= op.s1 + pad && z >= op.bottom - pad && z <= op.top + pad) ?? null;
  }

  // -------------------------------------------------------------------------
  // Events

  bindEvents() {
    const svg = this.svg;
    svg.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    svg.addEventListener('pointermove', (e) => this.onPointerMove(e));
    svg.addEventListener('pointerup', (e) => this.onPointerUp(e));
    svg.addEventListener('pointerleave', () => {
      if (!this.drag) {
        this.cursor = null;
        this.renderCanvas();
      }
    });
    svg.addEventListener('dblclick', () => {
      if (this.sel) this.app.inspector.focus();
    });
  }

  onPointerDown(e) {
    if (!this.ctx?.face) return;
    const p = this.toFace(e);
    const scr = this.canvas.toWorld(e);
    this.svg.setPointerCapture(e.pointerId);
    if (this.rulers.pointerDown(e, scr)) return;
    if (this.canvas.wantsPan(e, this.tool === 'pan')) {
      this.canvas.startPan(e);
      return;
    }
    if (e.button !== 0) return;
    const free = e.shiftKey;
    const tool = this.tool;
    if (tool === 'select') {
      const hh = this.hitHandle(p);
      if (hh) {
        const it = hh.r.item;
        this.drag = { type: 'handle', id: it.id, handle: hh.handle, orig: { ...it }, start: p, sx: e.clientX, sy: e.clientY, moved: false };
        return;
      }
      const hit = this.hitItem(p);
      // Off the trim, a guide under the mouse wins (Shift+drag pulls a copy off it).
      if (!hit && this.rulers.grab(e, scr)) return;
      this.selGuide = null;
      this.sel = hit ? { id: hit.r.item.id, seg: hit.seg } : null;
      if (hit && (hit.r.item.kind === 'box' || (hit.r.item.kind === 'run' && hit.r.item.category === 'chair-rail'))) {
        this.drag = { type: 'move', id: hit.r.item.id, orig: { ...hit.r.item }, start: p, sx: e.clientX, sy: e.clientY, moved: false };
      }
      this.app.inspector.render();
      this.renderCanvas();
      return;
    }
    if (tool === 'casing') {
      const op = this.hitOpening(p);
      if (!op) return this.flash('Click on a door, window or opening');
      const existing = this.ctx.record?.items.find((i) => i.kind === 'casing' && i.openingId === op.opening.id);
      if (existing) {
        this.sel = { id: existing.id, seg: null };
        this.flash('Already cased on this side; selected it');
        this.app.inspector.render();
        return;
      }
      const spec = this.toolSpecs[op.opening.type === 'window' ? 'window-casing' : 'door-casing'] ?? {};
      this.addItems(`Case ${OPENING_NAMES[op.opening.type]}`, (d) => makeCasing(d, op.opening, spec));
      return;
    }
    const sp = this.snapPoint(p, { free });
    if (tool === 'baseboard' || tool === 'shoe' || tool === 'crown' || tool === 'chair-rail' || tool === 'wainscot') {
      const tray = tool === 'crown' && this.inTray(p);
      this.drag = { type: 'draw-span', tool, tray, s0: sp.s, z: sp.z, cur: sp, sx: e.clientX, sy: e.clientY, moved: false };
    } else if (tool === 'box') {
      this.drag = { type: 'draw-box', start: sp, cur: sp, sx: e.clientX, sy: e.clientY, moved: false };
    }
    this.cursor = sp;
    this.renderCanvas();
  }

  onPointerMove(e) {
    if (!this.ctx?.face) return;
    const p = this.toFace(e);
    const dr = this.drag;
    if (this.canvas.movePan(e)) return;
    if (this.rulers.pointerMove(e, this.canvas.toWorld(e), !!dr)) return;
    if (dr && !dr.moved && Math.hypot(e.clientX - dr.sx, e.clientY - dr.sy) > 3) {
      dr.moved = true;
      if (dr.type === 'move' || dr.type === 'handle') this.app.beginLive();
    }
    const free = e.shiftKey;
    if (dr?.type === 'draw-span' || dr?.type === 'draw-box') {
      dr.cur = this.snapPoint(p, { free });
      this.cursor = dr.cur;
    } else if (dr?.moved && (dr.type === 'move' || dr.type === 'handle')) {
      this.dragItem(dr, p, free);
      this.app.live();
      this.showCoords(this.cursor);
      return;
    } else if (!dr) {
      this.cursorRaw = p;
      this.cursor = this.tool === 'select' || this.tool === 'pan' ? { s: p.s, z: p.z } : this.snapPoint(p, { free });
      this.hover = this.tool === 'select' ? this.hitHandle(p)?.handle ?? this.hitItem(p)?.r.item.id ?? null
        : this.tool === 'casing' ? this.hitOpening(p)?.opening.id ?? null : null;
      this.svg.style.cursor = this.tool === 'select' && this.hitHandle(p) ? 'grab' : '';
    }
    this.showCoords(this.cursor);
    this.renderCanvas();
  }

  dragItem(dr, p, free) {
    const it = this.findItem(dr.id);
    if (!it) return;
    const o = dr.orig;
    const ds = p.s - dr.start.s;
    const dz = p.z - dr.start.z;
    const L = this.ctx.face.length;
    const t = this.snapTargets(it.id);
    const minSize = Math.max(2 * it.size, this.fine * 4);
    let guideS = null;
    let guideZ = null;
    if (dr.type === 'move' && it.kind === 'box') {
      const sx = this.snapEdges([o.s + ds, o.s + o.w + ds], t.s, free);
      const sz = this.snapEdges([o.z + dz, o.z + o.h + dz], t.z, free);
      it.s = o.s + ds + sx.delta;
      it.z = Math.max(0, o.z + dz + sz.delta);
      guideS = sx.guide && { ...sx.guide };
      guideZ = sz.guide && { ...sz.guide };
      this.cursor = { s: it.s, z: it.z, guideS, guideZ };
    } else if (dr.type === 'move' && it.kind === 'run') {
      const sz = this.snapEdges([o.height + dz, o.height - o.size + dz], t.z, free);
      it.height = Math.max(it.size, o.height + dz + sz.delta);
      guideZ = sz.guide;
      this.cursor = { s: p.s, z: it.height, guideZ };
    } else if (dr.type === 'handle') {
      const sp = this.snapPoint(p, { free, excludeId: it.id });
      guideS = sp.guideS;
      guideZ = sp.guideZ;
      if (it.kind === 'run' || it.kind === 'wainscot') {
        // Runs reach the face ends; tray crown reaches the ends of the tray side.
        const edge = isTrayCrown(it) ? this.ctx.face.tray?.edge : null;
        const lo = edge ? Math.min(edge.s0, edge.s1) : 0;
        const hi = edge ? Math.max(edge.s0, edge.s1) : L;
        if (dr.handle === 'start') {
          const v = Math.min(Math.max(sp.s, lo), (it.end ?? hi) - minSize);
          it.start = v <= lo + 0.5 ? null : v;
        } else if (dr.handle === 'end') {
          const v = Math.max(Math.min(sp.s, hi), (it.start ?? lo) + minSize);
          it.end = v >= hi - 0.5 ? null : v;
        } else if (dr.handle === 'top') {
          it.height = Math.max(minSize, sp.z);
        }
      } else if (it.kind === 'box') {
        let { s, z, w, h: hh } = o;
        const hd = dr.handle;
        if (hd.includes('w')) { const right = s + w; s = Math.min(sp.s, right - minSize); w = right - s; }
        if (hd.includes('e')) w = Math.max(minSize, sp.s - s);
        if (hd.startsWith('s')) { const topZ = z + hh; z = Math.max(0, Math.min(sp.z, topZ - minSize)); hh = topZ - z; }
        if (hd.startsWith('n')) hh = Math.max(minSize, sp.z - z);
        Object.assign(it, { s, z, w, h: hh });
      }
      this.cursor = { s: sp.s, z: sp.z, guideS, guideZ };
    }
  }

  onPointerUp(e) {
    const dr = this.drag;
    this.drag = null;
    if (this.svg.hasPointerCapture(e.pointerId)) this.svg.releasePointerCapture(e.pointerId);
    if (this.canvas.endPan() || this.rulers.pointerUp() || !dr) return;
    if (dr.type === 'move' || dr.type === 'handle') {
      if (dr.moved) this.app.endLive(dr.type === 'move' ? 'Move trim' : 'Resize trim');
      return;
    }
    if (dr.type === 'draw-span') {
      const a = Math.min(dr.s0, dr.cur.s);
      const b = Math.max(dr.s0, dr.cur.s);
      const placement = dr.tray ? 'tray' : null;
      if (dr.moved && b - a > this.fine * 4) this.createSpan(dr.tool, { start: a, end: b, z: dr.z, placement });
      else this.createSpan(dr.tool, { z: dr.z, full: true, placement });
    } else if (dr.type === 'draw-box') {
      const s = Math.min(dr.start.s, dr.cur.s);
      const z = Math.min(dr.start.z, dr.cur.z);
      const w = Math.abs(dr.cur.s - dr.start.s);
      const hh = Math.abs(dr.cur.z - dr.start.z);
      if (dr.moved && w > this.fine * 8 && hh > this.fine * 8) this.createBox(s, z, w, hh);
      else this.flash('Drag out a box, or type a size like ' + (this.units === 'metric' ? '600x450' : '24x18') + ' + Enter');
    }
    this.renderCanvas();
  }

  /** Runs and wainscot: full width on a click, or start–end from a drag. */
  createSpan(tool, { start = null, end = null, z, full = false, placement = null }) {
    const spec = { ...this.toolSpec(tool) };
    const edge = placement === 'tray' ? this.ctx.face.tray?.edge : null;
    if (placement === 'tray' && !edge) return this.flash('There is no tray ceiling above this wall');
    const lo = edge ? Math.min(edge.s0, edge.s1) : 0;
    const hi = edge ? Math.max(edge.s0, edge.s1) : this.ctx.face.length;
    const clampEnd = (v) => (v == null ? null : Math.min(Math.max(v, lo), hi));
    start = clampEnd(start);
    end = clampEnd(end);
    if (start != null && start <= lo + 0.5) start = null;
    if (end != null && end >= hi - 0.5) end = null;
    if (placement === 'tray') {
      const existing = full && this.ctx.record?.items.find((i) => isTrayCrown(i) && i.start == null && i.end == null);
      if (existing) {
        this.sel = { id: existing.id, seg: null };
        this.flash('This tray side already has crown; selected it');
        this.app.inspector.render();
        return;
      }
      this.addItems('Add tray crown', (d) => makeRun(d, 'crown', { ...spec, start, end, placement: 'tray' }));
      return;
    }
    if (tool === 'wainscot') {
      this.addItems('Add wainscot', (d) => makeWainscot(d, { ...spec, start, end }));
      return;
    }
    if (full && tool !== 'chair-rail') {
      const existing = this.ctx.record?.items.find((i) => i.kind === 'run' && i.category === tool && !isTrayCrown(i) && i.start == null && i.end == null);
      if (existing) {
        this.sel = { id: existing.id, seg: null };
        this.flash(`This face already has ${TRIM_CATEGORIES[tool].label.toLowerCase()}; selected it (drag to add a partial run)`);
        this.app.inspector.render();
        return;
      }
    }
    if (tool === 'chair-rail') spec.height = Math.max(z, spec.size ?? 0);
    this.addItems(`Add ${TRIM_CATEGORIES[tool].label.toLowerCase()}`, (d) => makeRun(d, tool, { ...spec, start, end }));
  }

  createBox(s, z, w, hh) {
    const spec = this.toolSpec('box');
    this.addItems('Add panel box', (d) => makeBox(d, { s, z, w, h: hh, ...spec }));
  }

  // -------------------------------------------------------------------------
  // Keyboard (routed from the app while the Trim tab is showing)

  onKey(e) {
    if (!this.ctx?.face) return false;
    // Ruler guides: a typed distance + Enter while dragging one, or straight after placing it.
    if (this.rulers.key(e)) return true;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (this.selGuide && !mod && !this.typed && (k === 'Delete' || k === 'Backspace' || k === 'Escape')) {
      if (k === 'Escape') this.selGuide = null;
      else this.deleteGuide(this.selGuide);
      this.app.inspector.render();
      this.renderCanvas();
      return true;
    }
    if (!mod && k.length === 1 && TYPABLE.test(k) && (this.typed || /[0-9.]/.test(k))) {
      this.typed += k;
      this.message = '';
      this.renderCanvas();
      return true;
    }
    if (k === 'Backspace' && this.typed) {
      this.typed = this.typed.slice(0, -1);
      this.renderCanvas();
      return true;
    }
    if (k === 'Enter' && this.typed) {
      this.applyTyped(this.typed.trim());
      return true;
    }
    if (k === 'Escape') {
      if (this.typed) this.typed = '';
      else if (this.drag) this.drag = null;
      else if (this.sel) this.sel = null;
      else if (this.tool !== 'select') this.setTool('select');
      this.message = '';
      this.app.inspector.render();
      this.renderCanvas();
      return true;
    }
    const r = this.selectedResolved();
    if ((k === 'Delete' || k === 'Backspace') && r) {
      const spec = specFromItem(r.item);
      if (e.shiftKey && spec && this.ctx.face.kind === 'room') {
        this.sel = null;
        removeFromScope(this.app, specKey(spec), 'room', { face: this.ctx.face });
      } else if (this.sel.seg != null && r.pieces[this.sel.seg]) {
        this.removePiece(r, this.sel.seg);
      } else {
        this.deleteItem(r.item.id);
      }
      return true;
    }
    if (mod && k.toLowerCase() === 'd' && r?.item.kind === 'box') {
      const it = r.item;
      this.addItems('Duplicate box', (d) => makeBox(d, { ...it, s: it.s + it.w + trimDefaults(this.units).boxGap }));
      return true;
    }
    if (mod) return false;
    if (k.toLowerCase() === 'x' && r && this.sel.seg != null && r.pieces[this.sel.seg]) {
      this.removePiece(r, this.sel.seg);
      return true;
    }
    if (k.startsWith('Arrow') && r) {
      this.nudge(r.item, k, e.shiftKey);
      return true;
    }
    if (e.altKey) return false;
    const key = k.toUpperCase();
    if (key === 'F') return this.fit(), true;
    if (key === 'G') return this.toggle('gridOn'), true;
    if (key === 'S') return this.toggle('snapOn'), true;
    for (const [name, tool] of Object.entries(FACE_TOOLS)) {
      if (tool.key === key) {
        this.setTool(name);
        return true;
      }
    }
    return false;
  }

  toggle(flag) {
    this.canvas.toggle(flag);
    this.render();
  }

  applyTyped(text) {
    const u = this.units;
    const r = this.selectedResolved();
    const it = r?.item;
    const tool = this.tool;
    const done = () => {
      this.typed = '';
      this.renderCanvas();
    };
    if (tool === 'box' || (tool === 'select' && it?.kind === 'box')) {
      const dims = parseTrimDimensions(text, u);
      if (!dims) return this.flash(`Type a box size as width x height, e.g. ${u === 'metric' ? '600x450' : '24x18'}`);
      if (tool === 'select') {
        done();
        return this.editItem(it.id, 'Resize box', (x) => { x.w = dims[0]; x.h = dims[1]; });
      }
      const dr = this.drag?.type === 'draw-box' ? this.drag : null;
      const origin = dr?.start ?? this.cursor;
      if (!origin) return this.flash('Point at where the box\'s bottom-left corner goes, then type its size');
      const sx = dr && dr.cur.s < dr.start.s ? -1 : 1;
      const sz = dr && dr.cur.z < dr.start.z ? -1 : 1;
      this.drag = null;
      done();
      return this.createBox(sx > 0 ? origin.s : origin.s - dims[0], sz > 0 ? origin.z : origin.z - dims[1], dims[0], dims[1]);
    }
    const mm = parseTrimLength(text, u);
    if (mm == null || mm <= 0) return this.flash(`Couldn't read "${text}" as a length`);
    if (tool === 'chair-rail' || tool === 'wainscot') {
      this.toolSpec(tool).height = mm;
      done();
      return this.createSpan(tool, { z: mm, full: true });
    }
    if (tool === 'select' && it?.kind === 'run' && it.category === 'chair-rail') {
      done();
      return this.editItem(it.id, 'Chair rail height', (x) => { x.height = mm; });
    }
    if (tool === 'select' && it?.kind === 'wainscot') {
      done();
      return this.editItem(it.id, 'Wainscot height', (x) => { x.height = mm; });
    }
    this.flash('Typed values set a chair rail or wainscot height, or a box size. Select one first, or pick its tool.');
  }

  nudge(it, key, big) {
    const step = big ? (this.units === 'metric' ? 10 : MM_PER_IN) : this.fine;
    const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
    const dz = key === 'ArrowDown' ? -step : key === 'ArrowUp' ? step : 0;
    if (it.kind === 'box') this.editItem(it.id, 'Nudge box', (x) => { x.s += dx; x.z = Math.max(0, x.z + dz); });
    else if (it.kind === 'run' && it.category === 'chair-rail' && dz) this.editItem(it.id, 'Nudge chair rail', (x) => { x.height += dz; });
    else if (it.kind === 'wainscot' && dz) this.editItem(it.id, 'Nudge wainscot', (x) => { x.height = Math.max(this.fine, x.height + dz); });
  }

  deleteItem(id) {
    this.app.change('Delete trim', (d) => {
      for (const r of d.faceTrim) r.items = r.items.filter((i) => i.id !== id);
    });
    this.sel = null;
    this.app.refresh();
  }

  /**
   * Takes one piece off: a run's piece between openings (remembered by what
   * bounds it, so it stays off when the openings move), a casing leg, head or
   * bottom, or a window's stool, apron or sill. The last piece deletes the item.
   */
  removePiece(r, seg) {
    const piece = r.pieces[seg];
    if (!piece) return;
    if (r.pieces.length === 1) {
      this.deleteItem(r.item.id);
      return;
    }
    if (r.item.kind === 'casing') {
      const part = piece.part;
      this.editItem(r.item.id, `Remove ${part}`, (x) => {
        if (['stool', 'apron', 'sill'].includes(part)) x[part] = null;
        else x.omit = [...new Set([...(x.omit ?? []), part])];
      });
    } else if (piece.key && !piece.key.includes('cut')) {
      this.editItem(r.item.id, 'Remove piece of run', (x) => { x.omit = [...new Set([...(x.omit ?? []), piece.key])]; });
    } else {
      // Bounded by a positional cut: remove it by position as well.
      this.editItem(r.item.id, 'Remove piece of run', (x) => { x.cuts = [...(x.cuts ?? []), { s0: piece.s0, s1: piece.s1 }]; });
    }
    this.sel = { id: r.item.id, seg: null };
  }

  setTool(tool) {
    if (!FACE_TOOLS[tool]) return;
    this.tool = tool;
    this.rulers.cancel();
    this.typed = '';
    this.message = '';
    this.drag = null;
    this.render();
    this.app.inspector.render();
  }

  flash(msg) {
    this.message = msg;
    this.renderCanvas();
  }

  showCoords(p) {
    const el = document.querySelector('#coords');
    if (!el) return;
    el.textContent = p ? `${formatLength(p.s, this.units)} from left · ${formatLength(p.z, this.units)} AFF` : '';
  }

  // -------------------------------------------------------------------------
  // Rendering

  render() {
    this.ctx = this.context();
    if (this.sel && !this.findItem(this.sel.id)) this.sel = null;
    this.renderHeader();
    const hint = document.querySelector('#hint');
    if (hint && this.app.tab === 'trim') hint.textContent = FACE_TOOLS[this.tool].hint;
    if (!this.ctx.face) {
      this.svg.style.display = 'none';
      this.empty.hidden = false;
      this.empty.replaceChildren(...this.facePickerList());
      return;
    }
    this.svg.style.display = '';
    this.empty.hidden = true;
    if (this.fittedKey !== this.fitKey(this.ctx.face)) this.fit(false);
    this.renderNow();
  }

  renderCanvas() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = null;
      if (this.app.tab !== 'trim') return;
      this.ctx = this.context();
      if (this.ctx.face) {
        if (this.fittedKey !== this.fitKey(this.ctx.face)) this.fit(false);
        this.renderNow();
      }
    });
  }

  facePickerList() {
    const faces = this.ctx.faces;
    if (!faces.length) return [h('h2', {}, 'No wall faces yet'), h('p', {}, 'Draw rooms on the Plan tab first. Every side of every wall becomes a face you can trim.')];
    const groups = new Map();
    for (const f of faces) {
      const key = f.kind === 'room' ? f.room.room?.name ?? 'Room' : 'Exterior';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(f);
    }
    return [
      h('h2', {}, 'Pick a wall face to trim'),
      h('p', { class: 'muted' }, 'Or use the Trim tool (T) on the plan and click the side of a wall. Bulk options and packages are in the panel on the right.'),
      h('div', { class: 'face-groups' }, [...groups].map(([name, list]) => h('div', { class: 'face-group' },
        h('h3', {}, name),
        list.map((f) => h('button', { class: 'face-pick', onclick: () => this.app.openFace(faceRef(f)) },
          h('span', {}, f.kind === 'room' ? faceTitle(f, f.number) : `${f.number}. ${f.compass} face`),
          h('span', { class: 'muted small' }, ` ${formatLength(f.length, this.units, { precision: 'label' })}`),
          faceSummary(this.design, f) ? h('span', { class: 'chip small' }, faceSummary(this.design, f)) : null))))),
    ];
  }

  renderHeader() {
    const c = this.ctx;
    const u = this.units;
    const options = [];
    const groups = new Map();
    for (const f of c.faces) {
      const key = f.kind === 'room' ? f.room.room?.name ?? 'Room' : 'Exterior';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(f);
    }
    const current = c.face ? faceKey(faceRef(c.face)) : '';
    if (!c.face) options.push(h('option', { value: '', selected: true }, 'Choose a wall face…'));
    for (const [name, list] of groups) {
      options.push(h('optgroup', { label: name }, list.map((f) => {
        const key = faceKey(faceRef(f));
        return h('option', { value: key, selected: key === current }, `${f.kind === 'room' ? faceTitle(f, f.number) : `${f.number}. ${f.compass} face`} · ${formatLength(f.length, u, { precision: 'label' })}${recordForFace(this.design, f) ? ' ●' : ''}`);
      })));
    }
    const picker = h('select', { class: 'face-select' }, options);
    picker.addEventListener('change', () => {
      const ref = parseFaceKey(picker.value);
      if (ref) this.app.openFace(ref);
    });
    const tools = Object.entries(FACE_TOOLS).map(([key, t]) => h('button', {
      class: `fe-tool${this.tool === key ? ' active' : ''}`, title: `${t.label} (${t.key})`, onclick: () => this.setTool(key), disabled: !c.face,
    }, t.label));
    const f = c.face;
    const zs = f ? f.profile.map((p) => p.z) : [];
    const heights = f ? (Math.max(...zs) - Math.min(...zs) > 1 ? `${formatLength(Math.min(...zs), u, { precision: 'label' })}–${formatLength(Math.max(...zs), u, { precision: 'label' })}` : formatLength(zs[0], u, { precision: 'label' })) : '';
    this.header.replaceChildren(
      h('div', { class: 'fe-row' },
        h('label', { class: 'fe-face' }, 'Wall face ', picker),
        f ? h('span', { class: 'chip' }, `${formatLength(f.length, u)} long`) : null,
        f ? h('span', { class: 'chip' }, `${heights} high`) : null,
        f && f.openings.length ? h('span', { class: 'chip' }, `${f.openings.length} opening${f.openings.length > 1 ? 's' : ''}`) : null,
        f?.kind === 'exterior' ? h('span', { class: 'chip ext' }, 'exterior side') : null,
        h('span', { class: 'spacer' }),
        f && this.design.faceTrim.length ? cutToggles(this.app) : null,
        h('button', { onclick: () => this.app.showTab('plan') }, '← Plan'),
      ),
      h('div', { class: 'fe-row' },
        h('div', { class: 'fe-tools' }, tools),
        h('span', { class: 'spacer' }),
        this.canvas.controls({ onFit: () => this.fit(), disabled: !f }),
      ),
    );
  }

  renderNow() {
    const c = this.ctx;
    const r = this.svg.getBoundingClientRect();
    const out = [];
    out.push(DEFS);
    out.push(this.renderWall(c, r));
    out.push(this.renderOpenings(c));
    out.push(this.renderTrim(c));
    out.push(this.renderFaceDims(c));
    out.push(this.renderSelection(c));
    out.push(this.renderPreview(c, r));
    out.push(this.canvas.rulerGuidesSvg());
    out.push(this.renderRulers(c, r));
    out.push(this.renderMessage(r));
    this.svg.innerHTML = out.join('');
  }

  wallPoints(face) {
    const L = face.length;
    return [{ s: 0, z: 0 }, { s: L, z: 0 }, ...[...face.profile].reverse()];
  }

  renderWall(c, r) {
    const { face } = c;
    const poly = this.wallPoints(face).map((p) => `${n(this.X(p.s))},${n(this.Y(p.z))}`).join(' ');
    const out = [`<clipPath id="fe-clip"><polygon points="${poly}"/></clipPath>`];
    out.push(`<polygon class="fe-wall${face.kind === 'exterior' ? ' exterior' : ''}" points="${poly}"/>`);
    if (face.tray) {
      // The tray ceiling beyond the wall top, for reference (trim is drawn on the wall below it).
      const t = face.tray;
      out.push(`<polygon class="fe-tray" points="${n(this.X(t.s0))},${n(this.Y(t.bottom))} ${n(this.X(t.s0))},${n(this.Y(t.top))} ${n(this.X(t.s1))},${n(this.Y(t.top))} ${n(this.X(t.s1))},${n(this.Y(t.bottom))}"/>`);
      const fmt = (v) => formatLength(v, this.units, { precision: 'label' });
      out.push(text((this.X(t.s0) + this.X(t.s1)) / 2, this.Y(t.top) - 6, `tray ${fmt(t.top)} (+${fmt(t.top - t.bottom)})`, 'fe-dim-text', 'middle', true));
    }
    const top = Math.max(...face.profile.map((p) => p.z));
    out.push(this.canvas.gridSvg({ clip: 'fe-clip', bounds: { minX: 0, maxX: face.length, minY: 0, maxY: top } }));
    out.push(`<line class="fe-floor" x1="${n(this.X(0) - 30)}" y1="${n(this.Y(0))}" x2="${n(this.X(face.length) + 30)}" y2="${n(this.Y(0))}"/>`);
    // Stub walls meeting this face, coming out toward the viewer.
    for (const j of face.junctions ?? []) {
      const ss = [j.s0, ...face.profile.map((p) => p.s).filter((s) => s > j.s0 && s < j.s1), j.s1];
      const top = ss.map((s) => `${n(this.X(s))},${n(this.Y(profileHeightAt(face.profile, s)))}`).reverse();
      out.push(`<polygon class="fe-junction" points="${n(this.X(j.s0))},${n(this.Y(0))} ${n(this.X(j.s1))},${n(this.Y(0))} ${top.join(' ')}"><title>Stub wall</title></polygon>`);
    }
    for (const b of face.bands ?? []) {
      const ss = [b.s0, ...face.profile.map((p) => p.s).filter((s) => s > b.s0 && s < b.s1), b.s1];
      const top = ss.map((s) => `${n(this.X(s))},${n(this.Y(Math.max(b.bottom, profileHeightAt(face.profile, s))))}`);
      const bottom = ss.map((s) => `${n(this.X(s))},${n(this.Y(Math.min(b.bottom, profileHeightAt(face.profile, s))))}`).reverse();
      out.push(`<polygon class="fe-bulkhead" points="${[...top, ...bottom].join(' ')}"/>`);
    }
    return out.join('');
  }

  renderOpenings(c) {
    const u = this.units;
    const out = [];
    for (const op of c.face.openings) {
      const o = op.opening;
      const x = this.X(op.s0);
      const y = this.Y(op.top);
      const w = (op.s1 - op.s0) * this.view.scale;
      const hh = (op.top - op.bottom) * this.view.scale;
      const hover = this.tool === 'casing' && this.hover === o.id;
      out.push(`<rect class="fe-opening ${o.type}${hover ? ' hover' : ''}" x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(hh)}"/>`);
      if (o.type === 'window') {
        out.push(`<line class="fe-sash" x1="${n(x)}" y1="${n(y + hh / 2)}" x2="${n(x + w)}" y2="${n(y + hh / 2)}"/>`);
      } else if (o.type === 'door') {
        out.push(doorMarksSvg(doorStyle(o), x, y, w, hh, op.forward === !o.flipX, 'fe'));
      }
      if (w > 40 && hh > 24) {
        const label = `${formatLength(o.width, u, { precision: 'label' })} × ${formatLength(o.height, u, { precision: 'label' })}`;
        out.push(text(x + w / 2, y + 14, label, 'fe-op-label', 'middle'));
        if (o.type === 'window') out.push(text(x + w / 2, y + 28, `sill ${formatLength(op.bottom, u, { precision: 'label' })}`, 'fe-op-label', 'middle'));
      }
    }
    return out.join('');
  }

  piecePath(poly, holes = []) {
    const ring = (pts) => `M${pts.map((p) => `${n(this.X(p.s))} ${n(this.Y(p.z))}`).join('L')}Z`;
    return ring(poly) + holes.map(ring).join('');
  }

  renderTrim(c) {
    const out = [];
    const u = this.units;
    const cuts = this.app.showTrimCuts && c.resolved.items.length ? this.app.trimCuts() : null;
    const marks = cuts ? faceCutMarks(cuts.plan, cuts.mode, faceKey(faceRef(c.face))) : null;
    for (const ob of c.resolved.obstructions ?? []) out.push(obstructionSvg(ob, (v) => this.X(v), (v) => this.Y(v), c.face.profile, 'fe'));
    for (const r of drawOrder(c.resolved.items)) {
      const it = r.item;
      const selected = this.sel?.id === it.id;
      const hover = this.hover === it.id;
      const cls = `fe-trim tc-${it.kind === 'wainscot' ? 'wainscot' : it.category}${selected ? ' selected' : ''}${hover ? ' hover' : ''}`;
      r.pieces.forEach((p, i) => {
        const holes = p.hole ? [p.hole] : p.holes ?? [];
        const segSel = selected && this.sel.seg === i ? ' seg' : '';
        const pat = p.marks ? ` pat-${p.marks.pattern}` : '';
        out.push(`<path class="${cls}${segSel}${pat}" fill-rule="evenodd" d="${this.piecePath(p.poly, holes)}"/>`);
        const wmarks = p.marks && marks ? { ...p.marks, lines: p.marks.lines.filter((l) => l.kind !== 'seam') } : p.marks;
        if (wmarks) out.push(wainscotMarksSvg(wmarks, (v) => this.X(v), (v) => this.Y(v), this.view.scale));
      });
      // Always-on labels: heights of rails and wainscot, sizes of boxes.
      if (it.kind === 'run' && it.category === 'chair-rail' && r.pieces.length) {
        out.push(text(this.X(r.pieces[0].s0) + 4, this.Y(it.height) - 4, `${formatLength(it.height, u, { precision: 'label' })} AFF`, 'fe-label', 'start'));
      } else if (it.kind === 'wainscot' && r.pieces.length) {
        out.push(text(this.X(r.a) + 4, this.Y(it.height) - 4, `wainscot ${formatLength(it.height, u, { precision: 'label' })}`, 'fe-label', 'start'));
      } else if (it.kind === 'box') {
        const label = `${formatLength(it.w, u, { precision: 'label' })} × ${formatLength(it.h, u, { precision: 'label' })}`;
        if (it.w * this.view.scale > label.length * 6 + 10 && it.h * this.view.scale > 30) out.push(text(this.X(it.s + it.w / 2), this.Y(it.z + it.h / 2), label, 'fe-label', 'middle', true));
      }
    }
    if (marks) out.push(cutMarksSvg(marks, (v) => this.X(v), (v) => this.Y(v), this.view.scale));
    return out.join('');
  }

  renderFaceDims(c) {
    const { face } = c;
    const u = this.units;
    const fmt = (v) => formatLength(v, u, { precision: 'label' });
    const L = face.length;
    const out = [];
    const base = this.Y(0);
    const stops = [0, L];
    for (const op of face.openings) stops.push(Math.max(0, Math.min(L, op.s0)), Math.max(0, Math.min(L, op.s1)));
    const uniq = [...new Set(stops.map((s) => Math.round(s * 10) / 10))].sort((a, b) => a - b);
    if (uniq.length > 2) out.push(this.hChain(uniq, base + 22, fmt));
    out.push(this.hChain([0, L], base + (uniq.length > 2 ? 46 : 24), () => formatLength(L, u)));
    const first = face.profile[0];
    const last = face.profile[face.profile.length - 1];
    out.push(this.vDim(this.X(0) - 18, 0, first.z, fmt(first.z), 'end'));
    if (Math.abs(last.z - first.z) > 1) out.push(this.vDim(this.X(L) + 18, 0, last.z, fmt(last.z), 'start'));
    for (const p of face.profile.slice(1, -1)) out.push(text(this.X(p.s), this.Y(p.z) - 6, `${fmt(p.z)}`, 'fe-dim-text', 'middle'));
    return out.join('');
  }

  hChain(stops, y, fmt, cls = 'fe-dim') {
    let s = `<g class="${cls}"><line x1="${n(this.X(stops[0]))}" y1="${n(y)}" x2="${n(this.X(stops[stops.length - 1]))}" y2="${n(y)}"/>`;
    for (const v of stops) s += `<line x1="${n(this.X(v))}" y1="${n(y - 5)}" x2="${n(this.X(v))}" y2="${n(y + 5)}"/>`;
    for (let i = 0; i + 1 < stops.length; i++) {
      const w = (stops[i + 1] - stops[i]) * this.view.scale;
      const label = fmt(stops[i + 1] - stops[i]);
      if (w < label.length * 6 + 6) continue;
      s += text(this.X((stops[i] + stops[i + 1]) / 2), y - 5, label, 'fe-dim-text', 'middle', true);
    }
    return `${s}</g>`;
  }

  vDim(x, z0, z1, label, anchor, cls = 'fe-dim') {
    const y0 = this.Y(z0);
    const y1 = this.Y(z1);
    const tx = anchor === 'end' ? x - 5 : x + 5;
    return `<g class="${cls}"><line x1="${n(x)}" y1="${n(y0)}" x2="${n(x)}" y2="${n(y1)}"/>` +
      `<line x1="${n(x - 4)}" y1="${n(y0)}" x2="${n(x + 4)}" y2="${n(y0)}"/><line x1="${n(x - 4)}" y1="${n(y1)}" x2="${n(x + 4)}" y2="${n(y1)}"/>` +
      `${text(tx, (y0 + y1) / 2 + 4, label, 'fe-dim-text', anchor, true)}</g>`;
  }

  /** Dimension lines for the selected item, so placements can be read exactly. */
  renderSelection(c) {
    const r = this.selectedResolved(c);
    if (!r) return '';
    const it = r.item;
    const u = this.units;
    const fmt = (v) => formatLength(v, u, { precision: 'label' });
    const out = [];
    const face = c.face;
    if (it.kind === 'run') {
      const y = it.category === 'crown' ? this.Y(minZ(r.pieces)) + 16 : this.Y(maxZ(r.pieces)) - 14;
      for (const p of r.pieces) out.push(this.hChain([p.s0, p.s1], y, () => (it.category === 'crown' && Math.abs(p.length - (p.s1 - p.s0)) > 1 ? `${fmt(p.length)} along slope` : fmt(p.length)), 'fe-dim sel'));
      if (it.category === 'chair-rail' && r.pieces.length) out.push(this.vDim(this.X(r.pieces[0].s0) - 12, 0, it.height, `${fmt(it.height)} AFF`, 'end', 'fe-dim sel'));
      for (const cut of it.cuts ?? []) {
        const top = isTrayCrown(it) ? face.tray?.top ?? 0 : profileHeightAt(face.profile, cut.s0);
        const [z0, z1] = it.category === 'baseboard' || it.category === 'shoe' ? [0, it.size] : it.category === 'chair-rail' ? [it.height - it.size, it.height] : [top - it.size, top];
        out.push(`<rect class="fe-cut" x="${n(this.X(cut.s0))}" y="${n(this.Y(z1))}" width="${n((cut.s1 - cut.s0) * this.view.scale)}" height="${n((z1 - z0) * this.view.scale)}"/>`);
      }
    } else if (it.kind === 'box') {
      out.push(this.hChain([it.s, it.s + it.w], this.Y(it.z + it.h) - 12, fmt, 'fe-dim sel'));
      out.push(this.vDim(this.X(it.s + it.w) + 12, it.z, it.z + it.h, fmt(it.h), 'start', 'fe-dim sel'));
      if (it.z > 1) out.push(this.vDim(this.X(it.s) - 12, 0, it.z, `${fmt(it.z)} AFF`, 'end', 'fe-dim sel'));
      // Clearances to the nearest edges left and right at the box's mid-height.
      const zMid = it.z + it.h / 2;
      const t = this.snapTargets(it.id).s;
      const left = Math.max(0, ...t.map((x) => x.v).filter((v) => v <= it.s + 0.5));
      const right = Math.min(face.length, ...t.map((x) => x.v).filter((v) => v >= it.s + it.w - 0.5));
      if (it.s - left > 1) out.push(this.hChain([left, it.s], this.Y(zMid), fmt, 'fe-dim sel'));
      if (right - it.s - it.w > 1) out.push(this.hChain([it.s + it.w, right], this.Y(zMid), fmt, 'fe-dim sel'));
    } else if (it.kind === 'wainscot') {
      out.push(this.vDim(this.X(r.a) - 12, 0, it.height, fmt(it.height), 'end', 'fe-dim sel'));
      out.push(this.hChain([r.a, r.b], this.Y(it.height) - 14, fmt, 'fe-dim sel'));
    } else if (it.kind === 'casing') {
      for (const p of r.pieces) {
        const bb = bbox(p.poly);
        const vertical = bb.z1 - bb.z0 > bb.s1 - bb.s0;
        const x = vertical ? this.X(p.part === 'left leg' ? bb.s0 : bb.s1) + (p.part === 'left leg' ? -6 : 6) : this.X((bb.s0 + bb.s1) / 2);
        const y = vertical ? this.Y((bb.z0 + bb.z1) / 2) : this.Y(p.part === 'head' ? bb.z1 : bb.z0) + (p.part === 'head' ? -6 : 14);
        out.push(text(x, y, `${p.part} ${fmt(p.length)}`, 'fe-dim-text sel', vertical ? (p.part === 'left leg' ? 'end' : 'start') : 'middle', true));
      }
    }
    for (const hd of this.handles(r)) {
      out.push(`<rect class="fe-handle${this.hover === hd.key ? ' hover' : ''}" x="${n(this.X(hd.s) - HANDLE)}" y="${n(this.Y(hd.z) - HANDLE)}" width="${HANDLE * 2}" height="${HANDLE * 2}"/>`);
    }
    return out.join('');
  }

  /** Ghosts of what the active tool would add, snap guides and the live readout. */
  renderPreview(c, r) {
    const out = [];
    const cur = this.cursor;
    const u = this.units;
    const fmt = (v) => formatLength(v, u, { precision: 'label' });
    const face = c.face;
    const L = face.length;
    const dr = this.drag;
    if (cur && !this.canvas.pan) out.push(this.canvas.guidesSvg(cur.guideS && { v: cur.s, label: cur.guideS.label }, cur.guideZ && { v: cur.z, label: cur.guideZ.label }));
    const tool = this.tool;
    const spec = FACE_TOOLS[tool]?.category ? this.toolSpec(tool) : null;
    const size = spec?.size ?? 0;
    const band = (s0, s1, z0, z1, cls = 'fe-ghost') => `<rect class="${cls}" x="${n(this.X(s0))}" y="${n(this.Y(z1))}" width="${n((s1 - s0) * this.view.scale)}" height="${n(Math.max(1, (z1 - z0) * this.view.scale))}"/>`;
    if (dr?.type === 'draw-span') {
      const a = Math.min(dr.s0, dr.cur.s);
      const b = Math.max(dr.s0, dr.cur.s);
      const edge = dr.tray ? face.tray.edge : null;
      const [s0, s1] = dr.moved ? [a, b] : edge ? [Math.min(edge.s0, edge.s1), Math.max(edge.s0, edge.s1)] : [0, L];
      const z = dr.tray ? [face.tray.top - size, face.tray.top] : dr.tool === 'baseboard' || dr.tool === 'shoe' ? [0, size] : dr.tool === 'crown' ? [profileHeightAt(face.profile, s0) - size, profileHeightAt(face.profile, s0)]
        : dr.tool === 'wainscot' ? [0, spec.height] : [dr.z - size, dr.z];
      out.push(band(s0, s1, z[0], z[1]));
      if (dr.moved) out.push(this.hChain([s0, s1], this.Y(z[1]) - 12, fmt, 'fe-dim sel'));
    } else if (dr?.type === 'draw-box') {
      const s = Math.min(dr.start.s, dr.cur.s);
      const z = Math.min(dr.start.z, dr.cur.z);
      const w = Math.abs(dr.cur.s - dr.start.s);
      const hh = Math.abs(dr.cur.z - dr.start.z);
      out.push(`<rect class="fe-ghost box" x="${n(this.X(s))}" y="${n(this.Y(z + hh))}" width="${n(w * this.view.scale)}" height="${n(hh * this.view.scale)}"/>`);
      out.push(this.hChain([s, s + w], this.Y(z + hh) - 12, fmt, 'fe-dim sel'));
      out.push(this.vDim(this.X(s + w) + 12, z, z + hh, fmt(hh), 'start', 'fe-dim sel'));
      if (z > 1) out.push(this.vDim(this.X(s) - 12, 0, z, `${fmt(z)} AFF`, 'end', 'fe-dim sel'));
    } else if (cur && !dr) {
      if (tool === 'chair-rail') {
        out.push(band(0, L, cur.z - size, cur.z));
        out.push(text(this.X(cur.s) + 12, this.Y(cur.z) - 6, `${fmt(cur.z)} AFF (top of rail)`, 'fe-readout', 'start', true));
      } else if (tool === 'baseboard' || tool === 'shoe') out.push(band(0, L, 0, size));
      else if (tool === 'crown' && this.inTray(this.cursorRaw)) {
        const t = face.tray;
        out.push(band(Math.min(t.edge.s0, t.edge.s1), Math.max(t.edge.s0, t.edge.s1), t.top - size, t.top));
        out.push(text(this.X(cur.s) + 12, this.Y(t.top) + 18, 'crown in the tray', 'fe-readout', 'start', true));
      } else if (tool === 'crown') {
        const top = face.profile;
        const pts = [...top.map((p) => `${n(this.X(p.s))},${n(this.Y(p.z))}`), ...[...top].reverse().map((p) => `${n(this.X(p.s))},${n(this.Y(p.z - size))}`)];
        out.push(`<polygon class="fe-ghost" points="${pts.join(' ')}"/>`);
      } else if (tool === 'wainscot') {
        out.push(band(0, L, 0, spec.height));
        out.push(text(this.X(cur.s) + 12, this.Y(spec.height) - 6, `${fmt(spec.height)} high (type a height + Enter to change)`, 'fe-readout', 'start', true));
      } else if (tool === 'box') {
        out.push(`<circle class="fe-snap" cx="${n(this.X(cur.s))}" cy="${n(this.Y(cur.z))}" r="4"/>`);
        out.push(text(this.X(cur.s) + 10, this.Y(cur.z) - 8, `${fmt(cur.s)} from left · ${fmt(cur.z)} AFF`, 'fe-readout', 'start', true));
      }
    }
    if (this.typed) {
      const anchor = dr?.cur ?? cur;
      const hint = tool === 'box' || this.selectedResolved()?.item.kind === 'box' ? 'W x H' : 'height';
      out.push(this.canvas.typedSvg(anchor ? this.X(anchor.s) : 62, anchor ? this.Y(anchor.z) : 62, this.typed, `${hint}, bare = ${u === 'metric' ? 'mm' : 'inches'}`));
    }
    return out.join('');
  }

  renderRulers(c) {
    const cur = this.drag?.cur ?? this.cursor;
    return this.canvas.rulersSvg({ cursor: cur && { x: cur.s, y: cur.z }, marks: { x: [0, c.face.length], y: [0] } });
  }

  renderMessage() {
    return this.canvas.messageSvg(this.message);
  }

  // -------------------------------------------------------------------------
  // Side panel (shown in the inspector while the Trim tab is open)

  panel() {
    // The inspector renders before the canvas on a refresh, so read the design afresh.
    const c = (this.ctx = this.context());
    if (this.sel && !this.findItem(this.sel.id)) this.sel = null;
    const d = this.design;
    const u = d.units;
    if (!c.face) {
      return h('div', { class: 'panel' },
        h('div', { class: 'panel-kicker' }, 'Trim'),
        h('h2', {}, 'Whole house'),
        h('p', { class: 'muted small' }, 'Assign trim to every interior wall face at once. Each action is one Undo.'),
        quickApply(this.app, {}, 'house', { tray: c.faces.some((f) => f.tray?.edge) }),
        h('h3', {}, 'Packages'),
        packageApplier(this.app, {}, ['house']),
        ...packageManager(this.app),
        h('h3', {}, 'Remove trim'),
        quickRemove(this.app, {}, 'house'),
        h('div', { class: 'button-row' }, h('button', { class: 'danger', onclick: () => clearScope(this.app, 'house', {}) }, 'Clear all trim')),
      );
    }
    if (this.selGuide && !this.faceGuides().some((g) => g.id === this.selGuide)) this.selGuide = null;
    if (this.selGuide) return this.guidePanel(c);
    const r = this.selectedResolved();
    if (r) return this.itemPanel(c, r);
    return this.facePanel(c);
  }

  /** A ruler guide on this face: which way it runs, where it is and the guides either side. */
  guidePanel(c) {
    const g = this.faceGuides().find((x) => x.id === this.selGuide);
    const fmt = (v) => formatLength(v, this.units, { precision: 'label' });
    const [before, after] = this.rulers.neighbours(g);
    const vertical = g.axis === 'x';
    const entry = this.rulers.entry?.id === g.id ? this.rulers.entry : null;
    return h('div', { class: 'panel' },
      h('div', { class: 'panel-kicker' }, `${vertical ? 'Vertical' : 'Horizontal'} guide · ${c.face.name}`),
      h('div', { class: 'stats' },
        vertical ? h('div', { class: 'stat' }, h('span', {}, 'From left corner'), h('strong', {}, fmt(g.v))) : h('div', { class: 'stat' }, h('span', {}, 'Above floor'), h('strong', {}, fmt(g.v))),
        h('div', { class: 'stat' }, h('span', {}, `Guide ${vertical ? 'left' : 'below'}`), h('strong', {}, before == null ? '–' : fmt(g.v - before))),
        h('div', { class: 'stat' }, h('span', {}, `Guide ${vertical ? 'right' : 'above'}`), h('strong', {}, after == null ? '–' : fmt(after - g.v)))),
      entry?.ref ? h('p', { class: 'lvl-callout small' }, `Type a distance + Enter to place it that far from the ${entry.ref.label}. Bare numbers are ${this.units === 'metric' ? 'mm' : 'inches'}.`) : null,
      h('p', { class: 'muted small' }, 'Trim snaps to guides. Drag to move it, Shift+drag to pull another guide off it, or drag it onto its ruler to delete it. Guides stay with this wall face.'),
      h('div', { class: 'button-row' }, h('button', { class: 'danger', onclick: () => this.deleteGuide(g.id) }, 'Delete guide (Del)')),
    );
  }

  facePanel(c) {
    const d = this.design;
    const u = d.units;
    const face = c.face;
    const target = { face };
    const items = c.resolved.items;
    const scopes = face.kind === 'room' ? ['face', 'room', 'house'] : ['face'];
    const toolSection = FACE_TOOLS[this.tool]?.category ? this.toolPanel(this.tool) : this.tool === 'casing' ? this.casingToolPanel() : null;
    return h('div', { class: 'panel' },
      h('div', { class: 'panel-kicker' }, face.kind === 'room' ? 'Wall face' : 'Exterior face'),
      h('h2', {}, face.name),
      toolSection,
      h('h3', {}, `Trim on this face (${items.length})`),
      items.length
        ? h('ul', { class: 'trim-list' }, items.map((x) => h('li', {},
          h('button', { class: 'link', onclick: () => { this.sel = { id: x.item.id, seg: null }; this.app.inspector.render(); this.renderCanvas(); } }, itemLabel(x.item)),
          h('span', { class: 'muted small' }, ` ${profileLabel(x.item.profileId, x.item.size, u, x.item.category)}`),
          h('span', { class: 'qty' }, quantityText(x, u)))))
        : h('p', { class: 'muted small' }, 'Nothing yet. Pick a tool above the drawing, or add the defaults:'),
      h('div', { class: 'quick-apply' },
        h('button', { onclick: () => this.createSpan('baseboard', { full: true }) }, '+ Baseboard'),
        h('button', { onclick: () => this.createSpan('shoe', { full: true }) }, '+ Shoe'),
        h('button', { onclick: () => this.createSpan('crown', { full: true }) }, '+ Crown'),
        face.tray?.edge ? h('button', { onclick: () => this.createSpan('crown', { full: true, placement: 'tray' }) }, '+ Tray crown') : null,
        h('button', { onclick: () => this.createSpan('chair-rail', { full: true, z: this.toolSpec('chair-rail').height }) }, '+ Chair rail'),
        h('button', { onclick: () => applyToScope(this.app, 'Case openings', [{ category: 'door-casing', ...this.toolSpecs['door-casing'] }, { category: 'window-casing', ...this.toolSpecs['window-casing'] }], 'face', target), disabled: !face.openings.length }, '+ Case openings'),
        h('button', { onclick: () => this.createSpan('wainscot', { full: true }) }, '+ Wainscot'),
      ),
      this.quantityTable(faceTrimLines(c.resolved), u),
      h('h3', {}, 'Copy this face\'s trim'),
      h('p', { class: 'muted small' }, 'Runs, casing and wainscot (one of each kind) replace the same kinds on the other faces. Boxes stay here.'),
      h('div', { class: 'button-row' },
        face.kind === 'room' ? h('button', { onclick: () => applyToScope(this.app, 'Copy trim to room', specsFromRecord(c.record), 'room', target), disabled: !items.length }, 'To whole room') : null,
        face.kind === 'room' ? h('button', { onclick: () => applyToScope(this.app, 'Copy trim to house', specsFromRecord(c.record), 'house', target), disabled: !items.length }, 'To whole house') : null,
        h('button', { onclick: () => saveFaceAsPackage(this.app, specsFromRecord(c.record)), disabled: !items.length }, 'Save as package…'),
      ),
      h('h3', {}, 'Packages'),
      packageApplier(this.app, target, scopes),
      ...packageManager(this.app),
      h('h3', {}, 'Remove trim'),
      face.kind === 'room' ? quickRemove(this.app, target, 'room') : null,
      face.kind === 'room' ? quickRemove(this.app, target, 'house') : null,
      h('p', { class: 'muted small' }, 'Clear everything on:'),
      h('div', { class: 'button-row' }, scopes.map((scope) => h('button', { class: 'danger', onclick: () => clearScope(this.app, scope, target) }, SCOPE_LABELS[scope]))),
      h('p', { class: 'muted small' }, `Bare numbers are ${u === 'metric' ? 'millimetres' : 'inches'} here (e.g. ${u === 'metric' ? '900' : '36'}). "Left" is as seen facing the wall.`),
    );
  }

  /** Profile, width and height a creation tool will use. */
  toolPanel(tool) {
    const u = this.units;
    const spec = this.toolSpec(tool);
    const category = FACE_TOOLS[tool].category;
    const set = (patch) => {
      Object.assign(spec, patch);
      this.app.inspector.render();
      this.renderCanvas();
    };
    return h('div', { class: 'subcard' },
      h('strong', {}, `New ${FACE_TOOLS[tool].label.toLowerCase()}`),
      profilePicker(u, category, tool === 'box' ? 'box' : tool === 'wainscot' ? 'wainscot' : null, spec.profileId, spec.size, set),
      spec.height != null ? field(tool === 'chair-rail' ? 'Default height AFF (top of rail)' : 'Height', lengthInput(spec.height, u, (mm) => set({ height: mm }), trimLengthOpts(u, { min: 1 }))) : null,
    );
  }

  casingToolPanel() {
    const u = this.units;
    const parts = [['door-casing', 'New door casing'], ['window-casing', 'New window casing']];
    return h('div', {}, parts.map(([category, title]) => {
      const p = defaultProfile(category);
      this.toolSpecs[category] ??= { profileId: p?.id ?? null, size: p?.defaultWidth ?? null, stool: null, apron: null, sill: null };
      const spec = this.toolSpecs[category];
      const set = (patch) => {
        Object.assign(spec, patch);
        this.app.inspector.render();
      };
      return h('div', { class: 'subcard' },
        h('strong', {}, title),
        profilePicker(u, category, null, spec.profileId, spec.size, set),
        category === 'window-casing' ? windowParts(u, spec, (key, on) => set({ [key]: on ? {} : null }), (key, pick) => set({ [key]: { ...(spec[key] ?? {}), ...pick } })) : null);
    }));
  }

  quantityTable(lines, u) {
    if (!lines.length) return null;
    return h('table', { class: 'data compact' },
      h('tbody', {}, lines.map((l) => h('tr', {},
        h('td', {}, `${TRIM_CATEGORIES[l.category]?.label ?? 'Trim'} – ${profileLabel(l.profileId, l.size, u, l.category)}`),
        h('td', { class: 'num' }, lineText(l, u))))));
  }

  itemPanel(c, r) {
    const u = this.units;
    const it = r.item;
    const face = c.face;
    const L = face.length;
    const edit = (label, fn) => this.editItem(it.id, label, fn);
    const opts = (extra) => trimLengthOpts(u, extra);
    const fields = [];
    const kind = it.kind === 'box' ? 'box' : it.kind === 'wainscot' ? 'wainscot' : null;
    fields.push(profilePicker(u, it.category, kind, it.profileId, it.size, (pick) => edit('Trim profile', (x) => Object.assign(x, pick))));
    if (it.kind === 'run') {
      if (it.category === 'chair-rail') fields.push(field('Height AFF (top of rail)', lengthInput(it.height, u, (mm) => edit('Chair rail height', (x) => { x.height = mm; }), opts({ min: 1 }))));
      fields.push(h('div', { class: 'field-row' },
        field('Starts at', lengthInput(it.start, u, (mm) => edit('Run start', (x) => { x.start = mm; }), opts({ allowEmpty: true, placeholder: 'Left corner' }))),
        field('Ends at', lengthInput(it.end, u, (mm) => edit('Run end', (x) => { x.end = mm; }), opts({ allowEmpty: true, placeholder: `Right corner (${formatLength(L, u, { precision: 'label' })})` })))));
      fields.push(h('h3', {}, `Pieces (${r.pieces.length})`));
      fields.push(h('ul', { class: 'trim-list' }, r.pieces.map((p, i) => h('li', { class: this.sel.seg === i ? 'active' : '' },
        h('button', { class: 'link', onclick: () => { this.sel = { id: it.id, seg: i }; this.app.inspector.render(); this.renderCanvas(); } }, `${formatLength(p.s0, u, { precision: 'label' })} → ${formatLength(p.s1, u, { precision: 'label' })}`),
        h('span', { class: 'qty' }, formatLength(p.length, u, { precision: 'label' })),
        h('button', { class: 'link danger', title: 'Remove this piece (Del or X)', onclick: () => this.removePiece(r, i) }, '✕')))));
      const gaps = r.gaps.filter((g) => g.reason !== 'bulkhead').length;
      fields.push(h('p', { class: 'muted small' }, `${gaps ? `The run is split at ${gaps} gap${gaps > 1 ? 's' : ''} (openings, stub walls, built-ins); the gaps follow them. ` : ''}Remove a piece with ✕ or Del: it stays off when openings move. Drag the end handles to shorten the run.`));
      const removed = (it.omit?.length ?? 0) + (it.cuts?.length ?? 0);
      if (removed) fields.push(h('button', { class: 'link', onclick: () => edit('Restore run', (x) => { x.cuts = []; delete x.omit; }) }, `Restore ${removed} removed piece${removed > 1 ? 's' : ''}`));
    } else if (it.kind === 'casing') {
      const o = r.op.opening;
      fields.push(field('Reveal (set back from the jamb)', lengthInput(it.reveal, u, (mm) => edit('Casing reveal', (x) => { x.reveal = mm; }), opts())));
      if (o.type === 'window') {
        fields.push(h('h3', {}, 'Window options'));
        fields.push(...windowParts(u, it,
          (key, on) => edit(`Window ${key}`, (x) => {
            x[key] = null;
            if (on) {
              const cat = `window-${key}`;
              const p = defaultProfile(cat) ?? (key === 'apron' ? getProfile(x.profileId) : null);
              x[key] = { profileId: p?.id ?? null, size: p?.defaultWidth ?? x.size };
              if (key !== 'apron') x[key].horn = trimDefaults(u).horn;
            }
          }),
          (key, pick) => edit(`Window ${key}`, (x) => { x[key] = { ...x[key], ...pick }; })));
        fields.push(h('p', { class: 'muted small' }, it.stool ? 'Stool replaces the bottom casing; the legs stand on it.' : 'Without a stool the casing is a picture frame on all four sides.'));
      }
      fields.push(h('h3', {}, `Pieces (${r.pieces.length})`));
      fields.push(h('ul', { class: 'trim-list' }, r.pieces.map((p, i) => h('li', { class: this.sel.seg === i ? 'active' : '' },
        h('button', { class: 'link', onclick: () => { this.sel = { id: it.id, seg: i }; this.app.inspector.render(); this.renderCanvas(); } }, p.part),
        h('span', { class: 'qty' }, formatLength(p.length, u, { precision: 'label' })),
        h('button', { class: 'link danger', title: 'Remove this piece (Del or X)', onclick: () => this.removePiece(r, i) }, '✕')))));
      if (it.omit?.length) {
        fields.push(h('button', { class: 'link', onclick: () => edit('Restore casing', (x) => { delete x.omit; }) }, `Restore ${it.omit.join(', ')}`));
      }
    } else if (it.kind === 'box') {
      fields.push(h('div', { class: 'field-row' },
        field('From left', lengthInput(it.s, u, (mm) => edit('Move box', (x) => { x.s = mm; }), opts({ min: -Infinity }))),
        field('Bottom AFF', lengthInput(it.z, u, (mm) => edit('Move box', (x) => { x.z = mm; }), opts()))));
      fields.push(h('div', { class: 'field-row' },
        field('Width', lengthInput(it.w, u, (mm) => edit('Resize box', (x) => { x.w = mm; }), opts({ min: 1 }))),
        field('Height', lengthInput(it.h, u, (mm) => edit('Resize box', (x) => { x.h = mm; }), opts({ min: 1 })))));
      fields.push(h('div', { class: 'button-row' },
        h('button', { onclick: () => this.centreBox(it) }, 'Centre between neighbours'),
        h('button', { onclick: () => this.addItems('Duplicate box', (d) => makeBox(d, { ...it, s: it.s + it.w + trimDefaults(u).boxGap })) }, 'Duplicate (Ctrl+D)')));
      fields.push(h('h3', {}, 'Repeat across the face'));
      fields.push(h('p', { class: 'muted small' }, 'Replaces the boxes on this face with evenly spaced ones at this box\'s height, close to its width, filling each stretch between openings.'));
      const gapInput = lengthInput(this.boxGap ?? trimDefaults(u).boxGap, u, (mm) => { this.boxGap = mm; this.app.inspector.render(); }, opts({ min: 1 }));
      fields.push(field('Gap between boxes', gapInput));
      fields.push(h('button', { onclick: () => this.repeatBoxes(c, it) }, 'Lay out boxes'));
    } else if (it.kind === 'wainscot') {
      fields.push(field('Height', lengthInput(it.height, u, (mm) => edit('Wainscot height', (x) => { x.height = mm; }), opts({ min: 1 }))));
      fields.push(h('div', { class: 'field-row' },
        field('Starts at', lengthInput(it.start, u, (mm) => edit('Wainscot start', (x) => { x.start = mm; }), opts({ allowEmpty: true, placeholder: 'Left corner' }))),
        field('Ends at', lengthInput(it.end, u, (mm) => edit('Wainscot end', (x) => { x.end = mm; }), opts({ allowEmpty: true, placeholder: 'Right corner' })))));
    }
    const spec = specFromItem(it);
    return h('div', { class: 'panel' },
      h('div', { class: 'panel-kicker' }, `${itemLabel(it)} · ${face.name}`),
      h('div', { class: 'stats' }, h('div', { class: 'stat' }, h('span', {}, 'Quantity'), h('strong', {}, quantityText(r, u)))),
      ...fields,
      spec && face.kind === 'room' ? h('h3', {}, 'Apply to more walls') : null,
      spec && face.kind === 'room' ? h('div', { class: 'button-row' },
        h('button', { onclick: () => applyToScope(this.app, `${itemLabel(it)} for room`, [spec], 'room', { face }) }, 'Whole room'),
        h('button', { onclick: () => applyToScope(this.app, `${itemLabel(it)} for house`, [spec], 'house', { face }) }, 'Whole house')) : null,
      h('div', { class: 'button-row' },
        h('button', { onclick: () => { this.sel = null; this.app.inspector.render(); this.renderCanvas(); } }, 'Done'),
        h('button', { class: 'danger', onclick: () => this.deleteItem(it.id) }, 'Delete')),
      spec && face.kind === 'room' ? h('div', { class: 'button-row' },
        h('button', { class: 'danger', title: `Delete all ${itemLabel(it).toLowerCase()} from every wall of this room (Shift+Del)`, onclick: () => this.removeKind(it, 'room') }, 'Delete from whole room'),
        h('button', { class: 'danger', title: `Delete all ${itemLabel(it).toLowerCase()} from every room`, onclick: () => this.removeKind(it, 'house') }, 'Delete from whole house')) : null,
    );
  }

  /** Deletes this kind of trim (e.g. all baseboard) from the face's room or the whole house. */
  removeKind(it, scope) {
    this.sel = null;
    removeFromScope(this.app, specKey(specFromItem(it)), scope, { face: this.ctx.face });
  }

  centreBox(it) {
    const t = this.snapTargets(it.id).s.map((x) => x.v);
    const left = Math.max(0, ...t.filter((v) => v <= it.s + 0.5));
    const right = Math.min(this.ctx.face.length, ...t.filter((v) => v >= it.s + it.w - 0.5));
    this.editItem(it.id, 'Centre box', (x) => { x.s = (left + right) / 2 - x.w / 2; });
  }

  repeatBoxes(c, it) {
    const gap = this.boxGap ?? trimDefaults(this.units).boxGap;
    const boxes = layoutBoxes(this.design, c.resolved, { bottom: it.z, top: it.z + it.h, gap, width: it.w, profileId: it.profileId, size: it.size });
    if (!boxes.length) return this.app.toast('No room for boxes at that height', 'error');
    this.app.change('Lay out boxes', (d) => {
      const face = findFace(designFaces(d), this.app.trimFace);
      const rec = ensureRecord(d, face);
      rec.items = [...rec.items.filter((i) => i.kind !== 'box'), ...boxes];
    });
    this.sel = { id: boxes[0].id, seg: null };
    this.app.refresh();
    this.app.toast(`Laid out ${boxes.length} boxes`);
  }
}

// ---------------------------------------------------------------------------
// Helpers

function bbox(poly) {
  const ss = poly.map((p) => p.s);
  const zs = poly.map((p) => p.z);
  return { s0: Math.min(...ss), s1: Math.max(...ss), z0: Math.min(...zs), z1: Math.max(...zs) };
}

const minZ = (pieces) => Math.min(...pieces.flatMap((p) => p.poly.map((q) => q.z)));
const maxZ = (pieces) => Math.max(...pieces.flatMap((p) => p.poly.map((q) => q.z)));

function screenBox(poly) {
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  return { x0, x1, y0, y1, w: x1 - x0, h: y1 - y0 };
}

function pointInPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function text(x, y, body, cls, anchor = 'start', halo = false) {
  return `<text class="${cls}${halo ? ' halo' : ''}" x="${n(x)}" y="${n(y)}" text-anchor="${anchor}">${esc(body)}</text>`;
}

/** The estimate quantity of a line in its profile's unit. */
function lineText(l, u) {
  if (l.unit === 'lf') return `${lengthValue(l.length, u).toFixed(2)} ${u === 'metric' ? 'm' : 'lf'}`;
  const area = `${areaValue(l.area, u).toFixed(1)} ${areaUnit(u)}`;
  if (l.unit !== 'sheet') return area;
  const p = getProfile(l.profileId);
  const sheets = p ? Math.ceil(l.area / (l.size * p.sheetLength) - 1e-9) : 0;
  return `${area} · ${sheets} sheet${sheets === 1 ? '' : 's'}`;
}

function quantityText(r, u) {
  return faceTrimLines({ items: [r] }).map((l) => lineText(l, u)).join(' + ');
}

const DEFS = '<defs><pattern id="fe-bh-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="8" height="8" fill="#fdf3e4"/><line x1="0" y1="0" x2="0" y2="8" stroke="#e8b26a" stroke-width="1.4"/></pattern></defs>';
