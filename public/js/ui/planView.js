// Top-down plan editor: an SVG canvas with pan/zoom, snapping and the
// drawing tools (walls, rooms, doors, windows, openings, select/edit).
import {
  add, closestPointOnSegment, dist, dot, lineIntersection, norm, perp, scale, segmentIntersection, sub,
} from '../core/geometry.js';
import {
  addOpening, addRectangle, addWallChain, analyze, designBounds, findNodeNear, indexDesign, nodeDegrees,
  openingGeometry, rectangleCorners, resolveRoomCeiling, translateNodes,
} from '../core/model.js';
import { ceilingModel } from '../core/ceiling.js';
import { resolveBulkheads } from '../core/bulkhead.js';
import { MM_PER_IN, formatArea, formatLength, parseDimensions, parseLength, unitDefaults } from '../core/units.js';
import { esc, n, pts, tag, uprightAngle } from './svg.js';

const IMPERIAL_STEPS = [0.5, 1, 3, 6, 12, 24, 60, 120, 240, 600, 1200].map((i) => i * MM_PER_IN);
const IMPERIAL_MAJOR = [12, 60, 120, 600, 1200, 6000].map((i) => i * MM_PER_IN);
const METRIC_STEPS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const METRIC_MAJOR = [1000, 5000, 10000, 50000, 100000];
const ANGLE_SNAP = (10 * Math.PI) / 180;
const TYPABLE = /^[0-9.'"\/\- xXmMcC]$/;

export const TOOLS = {
  select: { label: 'Select', key: 'V', hint: 'Click to select, Shift+click to add · drag a box to select several (→ fully inside, ← touching) · drag corners, walls or openings to move · Del deletes · right-drag or Space+drag pans' },
  wall: { label: 'Wall', key: 'W', hint: 'Click to start, click to add corners · type a length + Enter for exact walls · Shift = free angle · Enter/Esc/double-click to finish' },
  rect: { label: 'Room', key: 'R', hint: 'Drag (or click two corners) to add a rectangular room · type interior size like 12x10 + Enter' },
  door: { label: 'Door', key: 'D', hint: 'Click on a wall to place a door · select it afterwards to flip the swing or change the size' },
  window: { label: 'Window', key: 'N', hint: 'Click on a wall to place a window · select it afterwards to set width, height and sill' },
  opening: { label: 'Opening', key: 'O', hint: 'Click on a wall to place a cased opening (no door)' },
};

export class PlanView {
  constructor(app, svg) {
    this.app = app;
    this.svg = svg;
    this.view = { scale: 0.06, tx: 0, ty: 0 };
    this.tool = 'select';
    this.draw = null;
    this.cursor = null;
    this.typed = '';
    this.drag = null;
    this.hover = null;
    this.message = '';
    this.svg.innerHTML = '<g class="grid"></g><g class="world"></g><g class="overlay"></g>';
    this.gridLayer = svg.querySelector('.grid');
    this.worldLayer = svg.querySelector('.world');
    this.overlayLayer = svg.querySelector('.overlay');
    this.bindEvents();
    new ResizeObserver(() => this.render()).observe(svg);
  }

  get design() {
    return this.app.design;
  }

  get units() {
    return this.design.units;
  }

  // -------------------------------------------------------------------------
  // Coordinates, zoom, grid

  toWorld(e) {
    const r = this.svg.getBoundingClientRect();
    return { x: (e.clientX - r.left - this.view.tx) / this.view.scale, y: (e.clientY - r.top - this.view.ty) / this.view.scale };
  }

  toScreen(p) {
    return { x: p.x * this.view.scale + this.view.tx, y: p.y * this.view.scale + this.view.ty };
  }

  px(v) {
    return v / this.view.scale;
  }

  zoomAt(screen, factor) {
    const s = Math.min(2, Math.max(0.004, this.view.scale * factor));
    const k = s / this.view.scale;
    this.view.tx = screen.x - (screen.x - this.view.tx) * k;
    this.view.ty = screen.y - (screen.y - this.view.ty) * k;
    this.view.scale = s;
    this.render();
  }

  zoomBy(factor) {
    const r = this.svg.getBoundingClientRect();
    this.zoomAt({ x: r.width / 2, y: r.height / 2 }, factor);
  }

  fit() {
    const r = this.svg.getBoundingClientRect();
    const b = designBounds(this.design) ?? { minX: 0, minY: 0, width: 12000, height: 9000 };
    const w = Math.max(b.width, 3000);
    const h = Math.max(b.height, 3000);
    const s = Math.min((r.width - 160) / w, (r.height - 160) / h);
    this.view.scale = Math.max(0.004, Math.min(0.5, s || 0.06));
    this.view.tx = r.width / 2 - (b.minX + b.width / 2) * this.view.scale;
    this.view.ty = r.height / 2 - (b.minY + b.height / 2) * this.view.scale;
    this.render();
  }

  gridSteps() {
    const s = this.view.scale;
    const steps = this.units === 'metric' ? METRIC_STEPS : IMPERIAL_STEPS;
    const majors = this.units === 'metric' ? METRIC_MAJOR : IMPERIAL_MAJOR;
    const snap = steps.find((v) => v * s >= 7) ?? steps[steps.length - 1];
    const major = majors.find((v) => v * s >= 60) ?? majors[majors.length - 1];
    const minor = steps.find((v) => v * s >= 14 && major % v < 1e-6) ?? major;
    return { snap, minor, major };
  }

  // -------------------------------------------------------------------------
  // Snapping

  /**
   * Snaps a raw world point. opts.from enables angle snapping (45° steps)
   * and length inference relative to the previous point; opts.free disables
   * angle snapping; opts.excludeNodes skips nodes being dragged.
   */
  snap(raw, opts = {}) {
    const tol = this.px(10);
    const { snap: step } = this.gridSteps();
    const exclude = new Set(opts.excludeNodes ?? []);
    const extra = opts.extraPoints ?? [];
    const candidates = [...this.design.nodes.filter((nd) => !exclude.has(nd.id)), ...extra];
    const idx = indexDesign(this.design);

    let bestNode = null;
    let bestD = tol;
    for (const nd of candidates) {
      const d = dist(nd, raw);
      if (d < bestD) {
        bestNode = nd;
        bestD = d;
      }
    }
    if (bestNode) return { p: { x: bestNode.x, y: bestNode.y }, kind: 'node', nodeId: bestNode.id, guides: [] };

    const walls = this.design.walls.filter((w) => !exclude.has(w.a) && !exclude.has(w.b));

    if (opts.from && !opts.free) {
      const v = sub(raw, opts.from);
      const ang = Math.atan2(v.y, v.x);
      const snapped = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
      if (Math.abs(ang - snapped) < ANGLE_SNAP && Math.hypot(v.x, v.y) > tol) {
        const dir = { x: Math.round(Math.cos(snapped) * 1e9) / 1e9, y: Math.round(Math.sin(snapped) * 1e9) / 1e9 };
        const along = dot(v, dir);
        // Inference: stop where the ray meets another node's axis or a wall.
        let best = null;
        let bestDelta = tol;
        for (const nd of candidates) {
          for (const axis of ['x', 'y']) {
            if (Math.abs(dir[axis]) < 1e-9) continue;
            const t = (nd[axis] - opts.from[axis]) / dir[axis];
            if (t <= 0) continue;
            const delta = Math.abs(t - along);
            if (delta < bestDelta) {
              bestDelta = delta;
              best = { t, guide: { from: nd, axis } };
            }
          }
        }
        for (const w of walls) {
          const A = idx.nodes.get(w.a);
          const B = idx.nodes.get(w.b);
          const hit = segmentIntersection(opts.from, add(opts.from, dir), A, B);
          if (!hit || hit.t <= 0 || hit.u < 0 || hit.u > 1) continue;
          const delta = Math.abs(hit.t - along);
          if (delta <= bestDelta + 1e-6) {
            bestDelta = delta;
            best = { t: hit.t, wall: w };
          }
        }
        if (best) {
          const p = add(opts.from, scale(dir, best.t));
          const guides = best.guide ? [{ a: best.guide.from, b: p }] : [];
          return { p, kind: best.wall ? 'wall' : 'aligned', guides, dir };
        }
        const t = Math.max(step, Math.round(along / step) * step);
        return { p: add(opts.from, scale(dir, t)), kind: 'angle', guides: [], dir };
      }
    }

    let bestWall = null;
    bestD = tol;
    for (const w of walls) {
      const c = closestPointOnSegment(raw, idx.nodes.get(w.a), idx.nodes.get(w.b));
      if (c.dist < bestD) {
        bestD = c.dist;
        bestWall = { w, c };
      }
    }
    if (bestWall) return { p: bestWall.c.point, kind: 'wall', wallId: bestWall.w.id, guides: [] };

    const p = { x: Math.round(raw.x / step) * step, y: Math.round(raw.y / step) * step };
    const guides = [];
    let kind = 'grid';
    for (const axis of ['x', 'y']) {
      let bestAxis = null;
      let bestAxisD = tol;
      for (const nd of candidates) {
        const d = Math.abs(nd[axis] - raw[axis]);
        if (d < bestAxisD) {
          bestAxisD = d;
          bestAxis = nd;
        }
      }
      if (bestAxis) {
        p[axis] = bestAxis[axis];
        guides.push({ a: bestAxis, b: p });
        kind = 'aligned';
      }
    }
    return { p, kind, guides };
  }

  // -------------------------------------------------------------------------
  // Tools

  setTool(tool) {
    if (!TOOLS[tool]) return;
    this.finishDrawing(true);
    this.tool = tool;
    this.typed = '';
    this.message = '';
    this.svg.dataset.tool = tool;
    this.app.emit('tool', tool);
    this.render();
  }

  finishDrawing(commit = true) {
    const dr = this.draw;
    this.draw = null;
    this.typed = '';
    if (commit && dr?.type === 'wall' && dr.points.length >= 2) {
      const closed = dr.closed;
      this.app.change('Draw walls', (d) => addWallChain(d, dr.points, closed));
    }
    this.render();
  }

  commitRect(start, corner) {
    if (Math.abs(start.x - corner.x) < 10 || Math.abs(start.y - corner.y) < 10) return;
    this.app.change('Add room', (d) => addRectangle(d, start, corner));
    this.draw = null;
    this.typed = '';
  }

  /** Corner for the room tool so that the *interior* size lands on the snap grid. */
  rectCorner(raw, start) {
    const s = this.snap(raw, {});
    if (s.kind !== 'grid') return s;
    const t = this.design.settings.wallThickness;
    const { snap: step } = this.gridSteps();
    const fix = (axis) => {
      const delta = raw[axis] - start[axis];
      const sign = Math.sign(delta) || 1;
      const interior = Math.max(step, Math.round((Math.abs(delta) - t) / step) * step);
      return start[axis] + sign * (interior + t);
    };
    return { ...s, p: { x: fix('x'), y: fix('y') } };
  }

  openingTarget(raw) {
    const d = this.design;
    const idx = indexDesign(d);
    let best = null;
    let bestD = Infinity;
    for (const w of d.walls) {
      const A = idx.nodes.get(w.a);
      const B = idx.nodes.get(w.b);
      const c = closestPointOnSegment(raw, A, B);
      const limit = w.thickness / 2 + this.px(14);
      if (c.dist < limit && c.dist < bestD) {
        bestD = c.dist;
        best = { wall: w, A, B, L: dist(A, B), t: c.t };
      }
    }
    if (!best) return null;
    const def = unitDefaults(d.units)[this.tool];
    const width = Math.min(def.width, best.L);
    const fine = d.units === 'metric' ? 10 : MM_PER_IN;
    let offset = Math.round((best.t * best.L) / fine) * fine;
    if (Math.abs(offset - best.L / 2) < this.px(8)) offset = best.L / 2;
    offset = Math.min(Math.max(offset, width / 2), best.L - width / 2);
    return { wallId: best.wall.id, offset, width };
  }

  /**
   * Walls and openings inside a selection box. Dragging left→right selects
   * items fully inside ("window"); right→left selects anything touched
   * ("crossing").
   */
  itemsInBox(a, b) {
    const box = { minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) };
    const crossing = b.x < a.x;
    const test = (p, q) => (crossing ? segmentTouchesBox(p, q, box) : inBox(p, box) && inBox(q, box));
    const d = this.design;
    const idx = indexDesign(d);
    const items = [];
    for (const w of d.walls) if (test(idx.nodes.get(w.a), idx.nodes.get(w.b))) items.push({ type: 'wall', id: w.id });
    for (const o of d.openings) {
      const g = openingGeometry(d, o, idx);
      if (g && test(g.start, g.end)) items.push({ type: 'opening', id: o.id });
    }
    return items;
  }

  /** Selected, or highlighted by an in-progress selection box. */
  isActive(type, id) {
    return this.app.isSelected(type, id) || !!this.marqueeHits?.some((i) => i.type === type && i.id === id);
  }

  hitTest(p) {
    const d = this.design;
    const idx = indexDesign(d);
    const tol = this.px(6);
    for (const o of d.openings) {
      const g = openingGeometry(d, o, idx);
      if (g && closestPointOnSegment(p, g.start, g.end).dist < g.wall.thickness / 2 + tol) return { type: 'opening', id: o.id };
    }
    for (const nd of d.nodes) if (dist(nd, p) < this.px(8)) return { type: 'node', id: nd.id };
    for (const w of d.walls) {
      const c = closestPointOnSegment(p, idx.nodes.get(w.a), idx.nodes.get(w.b));
      if (c.dist < w.thickness / 2 + tol) return { type: 'wall', id: w.id };
    }
    const analysis = analyze(d);
    const room = analysis.rooms
      .filter((g) => g.room && pointInPoly(p, g.polygon))
      .sort((a, b) => a.area - b.area)[0];
    if (room) return { type: 'room', id: room.room.id };
    return null;
  }

  // -------------------------------------------------------------------------
  // Events

  bindEvents() {
    const svg = this.svg;
    svg.addEventListener('contextmenu', (e) => e.preventDefault());
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      this.zoomAt({ x: e.clientX - r.left, y: e.clientY - r.top }, factor);
    }, { passive: false });
    svg.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    svg.addEventListener('pointermove', (e) => this.onPointerMove(e));
    svg.addEventListener('pointerup', (e) => this.onPointerUp(e));
    svg.addEventListener('pointerleave', () => {
      if (!this.drag) {
        this.cursor = null;
        this.render();
      }
    });
    svg.addEventListener('dblclick', (e) => this.onDoubleClick(e));
  }

  onPointerDown(e) {
    const raw = this.toWorld(e);
    this.svg.setPointerCapture(e.pointerId);
    if (e.button === 1 || e.button === 2 || this.app.spaceDown) {
      this.drag = { type: 'pan', sx: e.clientX, sy: e.clientY, tx: this.view.tx, ty: this.view.ty };
      return;
    }
    if (e.button !== 0) return;

    if (this.tool === 'wall') {
      const last = this.draw?.points.at(-1);
      const s = this.snap(raw, { from: last, free: e.shiftKey, extraPoints: this.draw?.points ?? [] });
      this.cursor = s;
      if (!this.draw) {
        this.draw = { type: 'wall', points: [s.p] };
      } else {
        this.addWallPoint(s);
      }
      this.render();
      return;
    }

    if (this.tool === 'rect') {
      if (!this.draw) {
        const s = this.snap(raw, {});
        this.draw = { type: 'rect', start: s.p, downAt: { x: e.clientX, y: e.clientY } };
        this.cursor = s;
      } else {
        this.commitRect(this.draw.start, this.rectCorner(raw, this.draw.start).p);
      }
      this.render();
      return;
    }

    if (this.tool in { door: 1, window: 1, opening: 1 }) {
      const target = this.openingTarget(raw);
      if (!target) {
        this.flash('Click on a wall to place it');
        return;
      }
      const type = this.tool;
      let created = null;
      this.app.change(`Add ${type}`, (d) => {
        created = addOpening(d, target.wallId, type, target.offset, { width: target.width });
      });
      if (created) this.app.select({ type: 'opening', id: created.id });
      return;
    }

    // Select tool
    const hit = this.hitTest(raw);
    if (e.shiftKey && hit) {
      this.app.toggleSelect(hit);
      return;
    }
    if (!hit || hit.type === 'room') {
      // Box selection; a plain click (no drag) selects the room or clears.
      this.drag = { type: 'marquee', start: raw, end: raw, sx: e.clientX, sy: e.clientY, hit, additive: e.shiftKey, moved: false };
      return;
    }
    this.app.select(hit);
    const d = this.design;
    if (hit.type === 'node') {
      this.drag = { type: 'node', id: hit.id, start: raw, moved: false };
    } else if (hit.type === 'wall') {
      const w = d.walls.find((x) => x.id === hit.id);
      const idx = indexDesign(d);
      const A = idx.nodes.get(w.a);
      const B = idx.nodes.get(w.b);
      this.drag = {
        type: 'wall', id: w.id, start: raw, moved: false,
        normal: perp(norm(sub(B, A))),
        orig: { [A.id]: { x: A.x, y: A.y }, [B.id]: { x: B.x, y: B.y } },
      };
    } else if (hit.type === 'opening') {
      this.drag = { type: 'opening', id: hit.id, start: raw, moved: false };
    }
  }

  addWallPoint(s) {
    const dr = this.draw;
    const p = s.p;
    if (dist(p, dr.points.at(-1)) < 1) return;
    if (dr.points.length >= 3 && dist(p, dr.points[0]) < 1) {
      dr.closed = true;
      this.finishDrawing(true);
      return;
    }
    dr.points.push(p);
    // Landing on existing structure ends the chain: no extra click needed.
    if (dr.points.length >= 2 && this.onStructure(p)) this.finishDrawing(true);
  }

  /** True when p is on an existing corner or wall centreline. */
  onStructure(p) {
    if (findNodeNear(this.design, p, 1)) return true;
    const idx = indexDesign(this.design);
    return this.design.walls.some((w) => closestPointOnSegment(p, idx.nodes.get(w.a), idx.nodes.get(w.b)).dist < 1);
  }

  onPointerMove(e) {
    const raw = this.toWorld(e);
    const dr = this.drag;
    if (dr?.type === 'pan') {
      this.view.tx = dr.tx + e.clientX - dr.sx;
      this.view.ty = dr.ty + e.clientY - dr.sy;
      if (Math.hypot(e.clientX - dr.sx, e.clientY - dr.sy) > 3) dr.click = false;
      this.render();
      return;
    }
    if (dr?.type === 'marquee') {
      if (Math.hypot(e.clientX - dr.sx, e.clientY - dr.sy) > 4) dr.moved = true;
      dr.end = raw;
      this.marqueeHits = dr.moved ? this.itemsInBox(dr.start, dr.end) : null;
      this.render();
      return;
    }
    if (dr && (dr.type === 'node' || dr.type === 'wall' || dr.type === 'opening')) {
      if (!dr.moved && dist(raw, dr.start) < this.px(3)) return;
      if (!dr.moved) {
        dr.moved = true;
        this.app.beginLive();
      }
      this.dragUpdate(dr, raw, e);
      this.app.live();
      return;
    }

    this.cursor = null;
    if (this.tool === 'wall') {
      const last = this.draw?.points.at(-1);
      this.cursor = this.snap(raw, { from: last, free: e.shiftKey, extraPoints: this.draw?.points ?? [] });
    } else if (this.tool === 'rect') {
      this.cursor = this.draw ? this.rectCorner(raw, this.draw.start) : this.snap(raw, {});
    } else if (this.tool in { door: 1, window: 1, opening: 1 }) {
      this.cursor = { p: raw, opening: this.openingTarget(raw) };
    } else {
      const hit = this.hitTest(raw);
      if (JSON.stringify(hit) !== JSON.stringify(this.hover)) this.hover = hit;
      this.cursor = { p: raw };
    }
    this.app.emit('cursor', this.cursor?.p);
    this.render();
  }

  dragUpdate(dr, raw, e) {
    const d = this.design;
    const idx = indexDesign(d);
    if (dr.type === 'node') {
      const node = idx.nodes.get(dr.id);
      const s = this.snap(raw, { excludeNodes: [dr.id], free: true });
      node.x = s.p.x;
      node.y = s.p.y;
      this.cursor = s;
    } else if (dr.type === 'wall') {
      const { snap: step } = this.gridSteps();
      let k = dot(sub(raw, dr.start), dr.normal);
      if (!e.shiftKey) k = Math.round(k / step) * step;
      for (const [id, o] of Object.entries(dr.orig)) {
        const nd = idx.nodes.get(id);
        nd.x = o.x + dr.normal.x * k;
        nd.y = o.y + dr.normal.y * k;
      }
      this.cursor = { p: raw };
    } else if (dr.type === 'opening') {
      const o = d.openings.find((x) => x.id === dr.id);
      const g = openingGeometry(d, o, idx);
      const fine = d.units === 'metric' ? 10 : MM_PER_IN;
      let offset = dot(sub(raw, g.A), g.dir);
      if (!e.shiftKey) offset = Math.round(offset / fine) * fine;
      if (Math.abs(offset - g.length / 2) < this.px(8)) offset = g.length / 2;
      o.offset = Math.min(Math.max(offset, o.width / 2), g.length - o.width / 2);
    }
  }

  onPointerUp(e) {
    const dr = this.drag;
    this.drag = null;
    if (this.svg.hasPointerCapture(e.pointerId)) this.svg.releasePointerCapture(e.pointerId);
    if (dr?.type === 'marquee') {
      this.marqueeHits = null;
      if (!dr.moved) {
        if (!dr.additive) this.app.select(dr.hit);
      } else {
        const items = this.itemsInBox(dr.start, dr.end);
        this.app.selectMany(dr.additive ? [...this.app.selectedItems(), ...items] : items);
      }
      this.render();
      return;
    }
    if (dr && dr.moved) {
      this.app.endLive(dr.type === 'opening' ? 'Move opening' : dr.type === 'wall' ? 'Move wall' : 'Move corner');
      return;
    }
    if (this.tool === 'rect' && this.draw?.downAt) {
      // Drag-to-draw: release far enough from the press point commits the room.
      const moved = Math.hypot(e.clientX - this.draw.downAt.x, e.clientY - this.draw.downAt.y);
      if (moved > 8) this.commitRect(this.draw.start, this.rectCorner(this.toWorld(e), this.draw.start).p);
      else this.draw.downAt = null;
      this.render();
    }
  }

  onDoubleClick(e) {
    if (this.tool === 'wall' && this.draw) {
      // The second click of the double-click already added a duplicate point.
      this.finishDrawing(true);
      return;
    }
    if (this.tool === 'select') {
      const hit = this.hitTest(this.toWorld(e));
      if (hit) this.app.emit('focus-inspector', hit);
    }
  }

  /** Keyboard input routed from the app; returns true when consumed. */
  onKey(e) {
    const drawing = (this.tool === 'wall' && this.draw) || (this.tool === 'rect' && this.draw);
    if (drawing && e.key.length === 1 && TYPABLE.test(e.key) && !e.ctrlKey && !e.metaKey) {
      this.typed += e.key;
      this.message = '';
      this.render();
      return true;
    }
    if (drawing && e.key === 'Backspace' && this.typed) {
      this.typed = this.typed.slice(0, -1);
      this.render();
      return true;
    }
    if (e.key === 'Enter' && drawing) {
      if (this.typed.trim()) this.applyTyped();
      else this.finishDrawing(true);
      return true;
    }
    if (e.key === 'Escape') {
      if (this.typed) this.typed = '';
      else if (this.draw) this.finishDrawing(this.tool === 'wall');
      else if (this.tool !== 'select') this.setTool('select');
      else this.app.select(null);
      this.render();
      return true;
    }
    return false;
  }

  applyTyped() {
    const text = this.typed.trim();
    if (this.tool === 'wall') {
      const L = parseLength(text, this.units);
      const last = this.draw.points.at(-1);
      const target = this.cursor?.p;
      if (L == null || L <= 0) return this.flash(`Couldn't read "${text}" as a length`);
      if (!target || dist(target, last) < 1) return this.flash('Point the mouse in the direction of the wall first');
      const dir = this.cursor.dir ?? norm(sub(target, last));
      this.typed = '';
      this.addWallPoint({ p: add(last, scale(dir, L)), kind: 'typed' });
      if (this.draw) this.cursor = { p: this.draw.points.at(-1) };
    } else if (this.tool === 'rect') {
      const dims = parseDimensions(text, this.units);
      if (!dims) return this.flash(`Type the interior size as width x depth, e.g. ${this.units === 'metric' ? '3.6x4.2' : "12x10'6"}`);
      const t = this.design.settings.wallThickness;
      const start = this.draw.start;
      const c = this.cursor?.p ?? add(start, { x: 1, y: 1 });
      const sx = Math.sign(c.x - start.x) || 1;
      const sy = Math.sign(c.y - start.y) || 1;
      this.commitRect(start, { x: start.x + sx * (dims[0] + t), y: start.y + sy * (dims[1] + t) });
    }
    this.render();
  }

  flash(msg) {
    this.message = msg;
    this.render();
  }

  // -------------------------------------------------------------------------
  // Rendering

  render() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = null;
      this.renderNow();
    });
  }

  renderNow() {
    const { scale: s, tx, ty } = this.view;
    this.worldLayer.setAttribute('transform', `matrix(${s} 0 0 ${s} ${tx} ${ty})`);
    this.gridLayer.innerHTML = this.renderGrid();
    const analysis = analyze(this.design);
    this.worldLayer.innerHTML = [
      this.renderRooms(analysis),
      this.renderWalls(analysis),
      this.renderOpenings(analysis),
      this.renderDimensions(analysis),
      this.renderRoomLabels(analysis),
      this.renderSelection(analysis),
      this.renderPreview(),
    ].join('');
    this.overlayLayer.innerHTML = this.renderOverlay();
  }

  renderGrid() {
    const r = this.svg.getBoundingClientRect();
    const { minor, major } = this.gridSteps();
    const s = this.view.scale;
    const x0 = -this.view.tx / s;
    const y0 = -this.view.ty / s;
    const x1 = x0 + r.width / s;
    const y1 = y0 + r.height / s;
    const lines = [];
    for (const [step, cls] of [[minor, 'minor'], [major, 'major']]) {
      if (step === major && cls === 'minor') continue;
      let d = '';
      for (let x = Math.floor(x0 / step) * step; x <= x1; x += step) {
        const sx = n(x * s + this.view.tx);
        d += `M${sx} 0V${n(r.height)}`;
      }
      for (let y = Math.floor(y0 / step) * step; y <= y1; y += step) {
        const sy = n(y * s + this.view.ty);
        d += `M0 ${sy}H${n(r.width)}`;
      }
      lines.push(`<path class="grid-${cls}" d="${d}"/>`);
    }
    return lines.join('');
  }

  renderRooms(analysis) {
    const hov = this.hover;
    return analysis.rooms
      .map((g) => {
        const id = g.room?.id;
        const cls = ['room', id && this.app.isSelected('room', id) && 'selected', hov?.type === 'room' && hov.id === id && 'hover'].filter(Boolean).join(' ');
        let extra = '';
        const spec = resolveRoomCeiling(this.design, g.room);
        if (spec.type !== 'flat') extra = this.renderCeilingHint(g, spec);
        extra += this.renderBulkheads(g, spec);
        return tag('polygon', { class: cls, points: pts(g.polygon) }) + extra;
      })
      .join('');
  }

  /** Bulkhead footprints: tinted, dashed boxes labelled with their underside height. */
  renderBulkheads(g, spec) {
    return resolveBulkheads(g.room, g.walls, spec, this.units)
      .map((r) => {
        const sw = this.px(1.2);
        let out = tag('polygon', { class: 'bulkhead', points: pts(r.footprint), 'stroke-width': sw, 'stroke-dasharray': `${n(this.px(5))} ${n(this.px(3))}` }, null);
        const len = r.s1 - r.s0;
        if (r.depth * this.view.scale >= 13 && len * this.view.scale >= 70) {
          const c = { x: r.footprint.reduce((a, p) => a + p.x, 0) / 4, y: r.footprint.reduce((a, p) => a + p.y, 0) / 4 };
          out += this.label(c, `bulkhead @ ${formatLength(r.bottom, this.units, { precision: 'label' })}`, uprightAngle(r.face.dir), 'bulkhead-label', 10);
        }
        return out;
      })
      .join('');
  }

  /** Dashed plan markers showing the ceiling profile (ridge, slope arrow, tray outline). */
  renderCeilingHint(g, spec) {
    const model = ceilingModel(spec, g.polygon);
    const b = boundsOf(g.polygon);
    const sw = this.px(1.2);
    const dash = `${n(this.px(6))} ${n(this.px(5))}`;
    if (spec.type === 'tray' && model.tray) {
      return tag('polygon', { class: 'ceiling-hint', points: pts(model.tray.polygon), 'stroke-width': sw, 'stroke-dasharray': dash }, null);
    }
    if (spec.type === 'gable') {
      const mid = spec.ridge === 'EW' ? { y: (b.minY + b.maxY) / 2 } : { x: (b.minX + b.maxX) / 2 };
      const a = spec.ridge === 'EW' ? { x: b.minX, y: mid.y } : { x: mid.x, y: b.minY };
      const c = spec.ridge === 'EW' ? { x: b.maxX, y: mid.y } : { x: mid.x, y: b.maxY };
      return tag('line', { class: 'ceiling-hint', x1: a.x, y1: a.y, x2: c.x, y2: c.y, 'stroke-width': sw, 'stroke-dasharray': dash }, null);
    }
    if (spec.type === 'shed') {
      const v = { N: { x: 0, y: -1 }, S: { x: 0, y: 1 }, E: { x: 1, y: 0 }, W: { x: -1, y: 0 } }[spec.dir];
      // Sit below the room label so the two don't collide.
      const c = { x: g.labelPoint.x, y: Math.min(g.labelPoint.y + this.px(40), b.maxY - this.px(12)) };
      const half = Math.min(b.maxX - b.minX, b.maxY - b.minY) * 0.3;
      const tip = add(c, scale(v, half));
      const tail = add(c, scale(v, -half));
      const h = this.px(9);
      const side = perp(v);
      const head = [tip, add(add(tip, scale(v, -h)), scale(side, h * 0.6)), add(add(tip, scale(v, -h)), scale(side, -h * 0.6))];
      return tag('line', { class: 'ceiling-hint', x1: tail.x, y1: tail.y, x2: tip.x, y2: tip.y, 'stroke-width': sw, 'stroke-dasharray': dash }, null) +
        tag('polygon', { class: 'ceiling-arrow', points: pts(head) }, null);
    }
    return '';
  }

  renderWalls(analysis) {
    const d = this.design;
    const idx = analysis.idx;
    const deg = nodeDegrees(d);
    const byNode = new Map();
    for (const w of d.walls) {
      for (const id of [w.a, w.b]) {
        if (!byNode.has(id)) byNode.set(id, []);
        byNode.get(id).push(w);
      }
    }
    const out = [];
    for (const w of d.walls) {
      const A = idx.nodes.get(w.a);
      const B = idx.nodes.get(w.b);
      const u = norm(sub(B, A));
      const nrm = scale(perp(u), w.thickness / 2);
      const endA = endCorners(A, u, w, byNode.get(w.a), idx, deg.get(w.a));
      const endB = endCorners(B, scale(u, -1), w, byNode.get(w.b), idx, deg.get(w.b));
      // At B the away-direction is reversed, so its "plus" side is the wall's minus side.
      const poly = [endA.plus ?? add(A, nrm), endB.minus ?? add(B, nrm), endB.plus ?? sub(B, nrm), endA.minus ?? sub(A, nrm)];
      const info = analysis.wallInfo.get(w.id);
      const cls = ['wall', info?.exterior && 'exterior', this.isActive('wall', w.id) && 'selected', this.hover?.type === 'wall' && this.hover.id === w.id && 'hover']
        .filter(Boolean).join(' ');
      out.push(tag('polygon', { class: cls, points: pts(poly) }, null));
    }
    return `<g class="walls">${out.join('')}</g>`;
  }

  renderOpenings(analysis) {
    const d = this.design;
    const idx = analysis.idx;
    const sw = this.px(1.25);
    const out = [];
    for (const o of d.openings) {
      const g = openingGeometry(d, o, idx);
      if (!g) continue;
      const t = g.wall.thickness / 2 + this.px(0.6);
      const nn = g.normal;
      const cut = [add(g.start, scale(nn, t)), add(g.end, scale(nn, t)), sub(g.end, scale(nn, t)), sub(g.start, scale(nn, t))];
      const selected = this.isActive('opening', o.id);
      const hover = this.hover?.type === 'opening' && this.hover.id === o.id;
      const cls = `opening ${o.type}${selected ? ' selected' : ''}${hover ? ' hover' : ''}`;
      let body = tag('polygon', { class: 'cut', points: pts(cut) }, null);
      body += tag('line', { class: 'jamb', x1: cut[0].x, y1: cut[0].y, x2: cut[3].x, y2: cut[3].y, 'stroke-width': sw }, null);
      body += tag('line', { class: 'jamb', x1: cut[1].x, y1: cut[1].y, x2: cut[2].x, y2: cut[2].y, 'stroke-width': sw }, null);
      if (o.type === 'window') {
        const tw = g.wall.thickness / 2;
        for (const k of [tw, 0, -tw]) {
          const a = add(g.start, scale(nn, k));
          const b = add(g.end, scale(nn, k));
          body += tag('line', { class: 'glass', x1: a.x, y1: a.y, x2: b.x, y2: b.y, 'stroke-width': sw }, null);
        }
      } else if (o.type === 'door') {
        const side = o.flipY ? -1 : 1;
        const hinge = o.flipX ? g.end : g.start;
        const other = o.flipX ? g.start : g.end;
        const face = scale(nn, (side * g.wall.thickness) / 2);
        const H = add(hinge, face);
        const J = add(other, face);
        const leaf = add(H, scale(nn, side * o.width));
        const sweep = crossZ(sub(leaf, H), sub(J, H)) > 0 ? 1 : 0;
        body += tag('line', { class: 'leaf', x1: H.x, y1: H.y, x2: leaf.x, y2: leaf.y, 'stroke-width': this.px(2) }, null);
        body += tag('path', { class: 'swing', d: `M${n(leaf.x)} ${n(leaf.y)}A${n(o.width)} ${n(o.width)} 0 0 ${sweep} ${n(J.x)} ${n(J.y)}`, 'stroke-width': sw }, null);
      } else {
        const a = g.start;
        const b = g.end;
        body += tag('line', { class: 'header', x1: a.x, y1: a.y, x2: b.x, y2: b.y, 'stroke-width': sw, 'stroke-dasharray': `${n(this.px(5))} ${n(this.px(4))}` }, null);
      }
      out.push(`<g class="${cls}">${body}</g>`);
    }
    return out.join('');
  }

  label(p, text, angle, cls, size) {
    const fs = this.px(size);
    return tag('text', {
      class: cls, x: p.x, y: p.y, 'font-size': fs, 'text-anchor': 'middle', 'dominant-baseline': 'central',
      transform: angle ? `rotate(${n(angle)} ${n(p.x)} ${n(p.y)})` : undefined,
    }, esc(text));
  }

  renderDimensions(analysis) {
    const mode = this.design.settings.dimensionMode;
    if (mode === 'off') return '';
    const out = [];
    const units = this.units;
    if (mode === 'interior') {
      for (const g of analysis.rooms) {
        for (const w of g.walls) {
          if (w.length * this.view.scale < 28) continue;
          const mid = add(w.P, scale(sub(w.Q, w.P), 0.5));
          const p = add(mid, scale(perp(w.dir), this.px(11)));
          out.push(this.label(p, formatLength(w.length, units, { precision: 'label' }), uprightAngle(w.dir), 'dim', 11));
        }
      }
    }
    // Centreline labels: all walls in centreline mode, otherwise walls that bound no room.
    const idx = analysis.idx;
    for (const w of this.design.walls) {
      const info = analysis.wallInfo.get(w.id);
      if (mode === 'interior' && info.roomSides.some(Boolean)) continue;
      const A = idx.nodes.get(w.a);
      const B = idx.nodes.get(w.b);
      const L = dist(A, B);
      if (L * this.view.scale < 28) continue;
      const u = norm(sub(B, A));
      let side = perp(u);
      if (info.roomSides[0] && !info.roomSides[1]) side = scale(side, -1);
      const p = add(add(A, scale(u, L / 2)), scale(side, w.thickness / 2 + this.px(10)));
      out.push(this.label(p, formatLength(L, units, { precision: 'label' }), uprightAngle(u), 'dim centerline', 11));
    }
    return `<g class="dims">${out.join('')}</g>`;
  }

  renderRoomLabels(analysis) {
    const units = this.units;
    return analysis.rooms
      .map((g) => {
        const p = g.labelPoint;
        const spec = resolveRoomCeiling(this.design, g.room);
        const h = formatLength(spec.height, units, { precision: 'label' });
        const ceiling = spec.type === 'flat' ? `${h} clg`
          : spec.type === 'tray' ? `${h} tray`
          : `${h}–${formatLength(spec.peak, units, { precision: 'label' })} ${spec.type === 'gable' ? 'vault' : 'shed'}`;
        const fs = 13;
        return [
          this.label({ x: p.x, y: p.y - this.px(fs) }, g.room?.name ?? 'Room', 0, 'room-name', fs),
          this.label(p, formatArea(g.area, units), 0, 'room-area', 11),
          this.label({ x: p.x, y: p.y + this.px(13) }, ceiling, 0, 'room-area', 10),
        ].join('');
      })
      .join('');
  }

  renderSelection(analysis) {
    const d = this.design;
    const sel = this.app.selection;
    const out = [];
    const idx = analysis.idx;
    if (this.tool === 'select') {
      const r = this.px(3.5);
      for (const nd of d.nodes) {
        const active = this.app.isSelected('node', nd.id) || (this.hover?.type === 'node' && this.hover.id === nd.id);
        out.push(tag('circle', { class: `node${active ? ' active' : ''}`, cx: nd.x, cy: nd.y, r: active ? r * 1.5 : r }, null));
      }
    }
    if (sel?.type === 'wall') {
      const w = idx.walls.get(sel.id);
      if (w) {
        const A = idx.nodes.get(w.a);
        const B = idx.nodes.get(w.b);
        const u = norm(sub(B, A));
        const info = analysis.wallInfo.get(w.id);
        let side = scale(perp(u), -1);
        if (info.roomSides[1] && !info.roomSides[0]) side = scale(side, -1);
        const off = w.thickness / 2 + this.px(26);
        out.push(this.dimensionLine(add(A, scale(side, off)), add(B, scale(side, off)), formatLength(dist(A, B), this.units), 'sel-dim'));
        out.push(this.label(add(A, scale(side, -w.thickness / 2 - this.px(9))), 'A', 0, 'end-label', 10));
        out.push(this.label(add(B, scale(side, -w.thickness / 2 - this.px(9))), 'B', 0, 'end-label', 10));
      }
    }
    if (sel?.type === 'opening') {
      const o = d.openings.find((x) => x.id === sel.id);
      const g = o && openingGeometry(d, o, idx);
      if (g) {
        const off = scale(g.normal, -(g.wall.thickness / 2 + this.px(22)));
        const L1 = dist(g.A, g.start);
        const L2 = dist(g.end, g.B);
        if (L1 > 1) out.push(this.dimensionLine(add(g.A, off), add(g.start, off), formatLength(L1, this.units, { precision: 'label' }), 'sel-dim'));
        if (L2 > 1) out.push(this.dimensionLine(add(g.end, off), add(g.B, off), formatLength(L2, this.units, { precision: 'label' }), 'sel-dim'));
        out.push(this.dimensionLine(add(g.start, off), add(g.end, off), formatLength(o.width, this.units, { precision: 'label' }), 'sel-dim strong'));
      }
    }
    return out.join('');
  }

  dimensionLine(a, b, text, cls) {
    const u = norm(sub(b, a));
    const tick = scale(perp(u), this.px(5));
    const sw = this.px(1);
    const mid = add(a, scale(sub(b, a), 0.5));
    return `<g class="${cls}">${tag('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, 'stroke-width': sw }, null)}${
      tag('line', { x1: a.x - tick.x, y1: a.y - tick.y, x2: a.x + tick.x, y2: a.y + tick.y, 'stroke-width': sw }, null)}${
      tag('line', { x1: b.x - tick.x, y1: b.y - tick.y, x2: b.x + tick.x, y2: b.y + tick.y, 'stroke-width': sw }, null)}${
      this.label(add(mid, scale(perp(u), -this.px(9) * Math.sign(perp(u).y || 1))), text, uprightAngle(u), 'dim-text', 11)}</g>`;
  }

  renderPreview() {
    const out = [];
    const c = this.cursor;
    const sw = this.px(1);
    for (const g of c?.guides ?? []) {
      out.push(tag('line', { class: 'guide', x1: g.a.x, y1: g.a.y, x2: g.b.x, y2: g.b.y, 'stroke-width': sw, 'stroke-dasharray': `${n(this.px(4))} ${n(this.px(4))}` }, null));
    }
    if (this.drag?.type === 'marquee' && this.drag.moved) {
      const { start: a, end: b } = this.drag;
      const crossing = b.x < a.x;
      out.push(tag('rect', {
        class: `marquee${crossing ? ' crossing' : ''}`, x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
        width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y), 'stroke-width': sw,
        'stroke-dasharray': crossing ? `${n(this.px(5))} ${n(this.px(3))}` : undefined,
      }, null));
    }
    const t = this.design.settings.wallThickness;
    if (this.tool === 'wall' && this.draw) {
      const ptsList = [...this.draw.points];
      if (c?.p) ptsList.push(c.p);
      out.push(tag('polyline', { class: 'preview-wall', points: pts(ptsList), 'stroke-width': t }, null));
      out.push(tag('polyline', { class: 'preview-line', points: pts(ptsList), 'stroke-width': sw }, null));
      for (let i = 0; i + 1 < ptsList.length; i++) {
        const a = ptsList[i];
        const b = ptsList[i + 1];
        const L = dist(a, b);
        if (L < 1) continue;
        const u = norm(sub(b, a));
        const off = scale(perp(u), -(t / 2 + this.px(20)));
        out.push(this.dimensionLine(add(a, off), add(b, off), formatLength(L, this.units, { precision: 'label' }), 'preview-dim'));
      }
    }
    if (this.tool === 'rect' && this.draw && c?.p) {
      const corners = rectangleCorners(this.draw.start, c.p);
      out.push(tag('polygon', { class: 'preview-wall rect', points: pts(corners), 'stroke-width': t }, null));
      out.push(tag('polygon', { class: 'preview-line', points: pts(corners), 'stroke-width': sw }, null));
      const w = Math.abs(c.p.x - this.draw.start.x) - t;
      const h = Math.abs(c.p.y - this.draw.start.y) - t;
      if (w > 0 && h > 0) {
        const mid = { x: (c.p.x + this.draw.start.x) / 2, y: (c.p.y + this.draw.start.y) / 2 };
        out.push(this.label(mid, `${formatLength(w, this.units, { precision: 'label' })} × ${formatLength(h, this.units, { precision: 'label' })}`, 0, 'preview-size', 13));
        out.push(this.label({ x: mid.x, y: mid.y + this.px(16) }, 'interior', 0, 'preview-size sub', 10));
      }
    }
    if (c?.opening) {
      const d = this.design;
      const w = d.walls.find((x) => x.id === c.opening.wallId);
      const idx = indexDesign(d);
      const A = idx.nodes.get(w.a);
      const B = idx.nodes.get(w.b);
      const u = norm(sub(B, A));
      const center = add(A, scale(u, c.opening.offset));
      const a = add(center, scale(u, -c.opening.width / 2));
      const b = add(center, scale(u, c.opening.width / 2));
      out.push(tag('line', { class: 'preview-opening', x1: a.x, y1: a.y, x2: b.x, y2: b.y, 'stroke-width': w.thickness + this.px(4) }, null));
      const off = scale(perp(u), -(w.thickness / 2 + this.px(18)));
      const L1 = dist(A, a);
      const L2 = dist(b, B);
      if (L1 > 1) out.push(this.dimensionLine(add(A, off), add(a, off), formatLength(L1, this.units, { precision: 'label' }), 'preview-dim'));
      if (L2 > 1) out.push(this.dimensionLine(add(b, off), add(B, off), formatLength(L2, this.units, { precision: 'label' }), 'preview-dim'));
    }
    if (c?.p && (this.tool === 'wall' || this.tool === 'rect')) {
      const r = this.px(c.kind === 'node' ? 6 : 4);
      out.push(tag('circle', { class: `snap snap-${c.kind ?? 'none'}`, cx: c.p.x, cy: c.p.y, r, 'stroke-width': this.px(1.5) }, null));
    }
    return out.join('');
  }

  renderOverlay() {
    const out = [];
    const anchor = this.cursor?.p ?? this.draw?.points?.at(-1) ?? this.draw?.start;
    if ((this.typed || this.message) && anchor) {
      const s = this.toScreen(anchor);
      const text = this.typed ? `${this.typed}▏` : this.message;
      const w = Math.max(60, text.length * 7.4 + 20);
      const cls = this.typed ? 'typed' : 'message';
      out.push(`<g class="${cls}" transform="translate(${n(s.x + 18)} ${n(s.y + 18)})"><rect width="${n(w)}" height="24" rx="4"/><text x="10" y="16">${esc(text)}</text></g>`);
    }
    return out.join('');
  }
}

// ---------------------------------------------------------------------------
// Local helpers

function inBox(p, box) {
  return p.x >= box.minX && p.x <= box.maxX && p.y >= box.minY && p.y <= box.maxY;
}

function segmentTouchesBox(p, q, box) {
  if (inBox(p, box) || inBox(q, box)) return true;
  const c = [{ x: box.minX, y: box.minY }, { x: box.maxX, y: box.minY }, { x: box.maxX, y: box.maxY }, { x: box.minX, y: box.maxY }];
  for (let i = 0; i < 4; i++) {
    const hit = segmentIntersection(p, q, c[i], c[(i + 1) % 4]);
    if (hit && hit.t >= 0 && hit.t <= 1 && hit.u >= 0 && hit.u <= 1) return true;
  }
  return false;
}

function crossZ(a, b) {
  return a.x * b.y - a.y * b.x;
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

function boundsOf(poly) {
  return {
    minX: Math.min(...poly.map((p) => p.x)),
    maxX: Math.max(...poly.map((p) => p.x)),
    minY: Math.min(...poly.map((p) => p.y)),
    maxY: Math.max(...poly.map((p) => p.y)),
  };
}

/**
 * Corner points of a wall band at node N, where u1 points away from N along
 * the wall. Returns {plus, minus} on the +perp(u1) / -perp(u1) sides, or
 * nulls to use a plain square end.
 */
function endCorners(N, u1, wall, wallsAtNode, idx, degree) {
  const half = wall.thickness / 2;
  const p1 = perp(u1);
  if (degree === 2) {
    const other = wallsAtNode.find((w) => w !== wall);
    const O = idx.nodes.get(other.a === N.id ? other.b : other.a);
    const u2 = norm(sub(O, N));
    const p2 = perp(u2);
    const h2 = other.thickness / 2;
    const plus = lineIntersection(add(N, scale(p1, half)), u1, sub(N, scale(p2, h2)), u2);
    const minus = lineIntersection(sub(N, scale(p1, half)), u1, add(N, scale(p2, h2)), u2);
    const limit = Math.max(half, h2) * 4;
    if (plus && minus && dist(plus, N) < limit && dist(minus, N) < limit) return { plus, minus };
  }
  if (degree >= 2) {
    const back = scale(u1, -half);
    return { plus: add(add(N, back), scale(p1, half)), minus: sub(add(N, back), scale(p1, half)) };
  }
  return { plus: add(N, scale(p1, half)), minus: sub(N, scale(p1, half)) };
}
