// Top-down plan editor: an SVG canvas with pan/zoom, snapping and the
// drawing tools (walls, rooms, doors, windows, openings, select/edit).
import {
  add, closestPointOnSegment, dist, dot, lineIntersection, norm, perp, scale, segmentIntersection, sub,
} from '../core/geometry.js';
import {
  addOpening, addRectangle, addWallChain, analyze, designBounds, findNodeNear, freeOpeningOffset, newOpeningPlacement,
  indexDesign, nodeDegrees, openingGeometry, rectangleCorners, resolveRoomCeiling, translateNodes,
} from '../core/model.js';
import { ceilingModel } from '../core/ceiling.js';
import { resolveBulkheads } from '../core/bulkhead.js';
import { MAX_READING, READING_PRESETS, analyzeLeveling, connectedRooms, readingUnit, resolveLeveling, setReading } from '../core/leveling.js';
import { MM_PER_IN, formatArea, formatDeviation, formatLength, parseDeviation, parseDimensions, parseLength, unitDefaults } from '../core/units.js';
import { esc, n, pts, tag, uprightAngle } from './svg.js';
import { renderHeatmap, renderLegend, renderSurvey } from './levelLayer.js';
import { h } from './dom.js';
import { DrawingCanvas } from './canvas.js';
import { designFaces, faceAtPoint, faceKey, faceRef } from '../core/faces.js';
import { planTrimBands } from '../core/trim.js';

const ANGLE_SNAP = (10 * Math.PI) / 180;
const TYPABLE = /^[0-9.'"\/\- xXmMcC]$/;
const READING_TYPABLE = /^[0-9.+\-−\/"' mMcCiInN]$/;

export const TOOLS = {
  select: { label: 'Select', key: 'V', hint: 'Click to select, Shift+click to add · drag a box to select several (→ fully inside, ← touching) · drag corners, walls or openings to move · Del deletes · right-drag or Space+drag pans' },
  pan: { label: 'Pan', key: 'P', hint: 'Drag to move around the plan · scroll to zoom · Space+drag or right-drag also pans with any tool' },
  wall: { label: 'Wall', key: 'W', hint: 'Click to start, click to add corners · type a length + Enter for exact walls · Shift = free angle · Enter/Esc/double-click to finish' },
  rect: { label: 'Room', key: 'R', hint: 'Drag (or click two corners) to add a rectangular room · type interior size like 12x10 + Enter' },
  door: { label: 'Door', key: 'D', hint: 'Click on a wall to place a door · select it afterwards to flip the swing or change the size' },
  window: { label: 'Window', key: 'N', hint: 'Click on a wall to place a window · select it afterwards to set width, height and sill' },
  opening: { label: 'Opening', key: 'O', hint: 'Click on a wall to place a cased opening (no door)' },
  trim: { label: 'Trim', key: 'T', hint: 'Hover the side of a wall and click to open that face in the trim editor · each side of a wall (and the outside of exterior walls) has its own trim' },
  level: { label: 'Level', key: 'L', hint: 'Click a room, then a grid node · tap a preset reading in the bar, or type any value + Enter · quick entry jumps to the next node · Tab skips, arrows move, Del clears, Esc stops' },
};

export class PlanView {
  constructor(app, svg) {
    this.app = app;
    this.svg = svg;
    this.canvas = new DrawingCanvas({ svg, app, units: () => this.units, minScale: 0.004, maxScale: 2, scale: 0.06, onView: () => this.render(), fitLabel: 'Fit the plan (F)' });
    this.tool = 'select';
    this.draw = null;
    this.cursor = null;
    this.typed = '';
    this.drag = null;
    this.hover = null;
    this.message = '';
    // Leveling survey: the node being typed into, the number overlay, auto-advance,
    // and a target previewed while the inspector slider is dragged.
    this.levelEntry = null;
    this.levelNumbers = true;
    this.levelQuick = true;
    this.levelPreview = null;
    this.svg.innerHTML = '<g class="grid"></g><g class="world"></g><g class="overlay"></g>';
    this.gridLayer = svg.querySelector('.grid');
    this.worldLayer = svg.querySelector('.world');
    this.overlayLayer = svg.querySelector('.overlay');
    // Level tool entry bar (preset readings + custom value), docked over the canvas.
    this.palette = h('div', { class: 'lvl-palette', hidden: true });
    svg.parentElement.append(this.palette);
    // Canvas bar (same controls as the wall face editor), above the drawing.
    this.bar = h('div', { class: 'cv-bar' });
    svg.parentElement.insertBefore(this.bar, svg);
    this.renderBar();
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

  get view() {
    return this.canvas.view;
  }

  toWorld(e) {
    const p = this.canvas.toWorld(e);
    return { x: p.x, y: p.y };
  }

  toScreen(p) {
    return { x: this.canvas.X(p.x), y: this.canvas.Y(p.y) };
  }

  px(v) {
    return this.canvas.px(v);
  }

  zoomAt(screen, factor) {
    this.canvas.zoomAt(screen.x, screen.y, factor);
  }

  zoomBy(factor) {
    this.canvas.zoomBy(factor);
  }

  fit() {
    const b = designBounds(this.design) ?? { minX: 0, minY: 0, width: 12000, height: 9000 };
    // At least 3 m × 3 m, centred on the plan.
    const w = Math.max(b.width, 3000);
    const hgt = Math.max(b.height, 3000);
    const cx = b.minX + b.width / 2;
    const cy = b.minY + b.height / 2;
    this.canvas.fitTo({ minX: cx - w / 2, maxX: cx + w / 2, minY: cy - hgt / 2, maxY: cy + hgt / 2 }, { left: 56, top: 56, right: 80, bottom: 80 }, 0.5);
    this.render();
  }

  gridSteps() {
    return this.canvas.steps();
  }

  /** Grid step for snapping: the grid, or 1/16" / 1 mm with the grid or snapping off. */
  snapStep() {
    return this.canvas.snapOn ? this.canvas.snapStep() : this.canvas.fine;
  }

  /** The Snap / Grid / zoom / Fit bar, rebuilt when a toggle changes. */
  renderBar() {
    const key = `${this.canvas.snapOn}|${this.canvas.gridOn}`;
    if (this.barKey === key) return;
    this.barKey = key;
    this.bar.replaceChildren(
      h('span', { class: 'cv-title' }, 'Floor plan'),
      h('span', { class: 'spacer' }),
      this.canvas.controls({ onFit: () => this.fit() }));
  }

  // -------------------------------------------------------------------------
  // Snapping

  /**
   * Snaps a raw world point. opts.from enables angle snapping (45° steps)
   * and length inference relative to the previous point; opts.free disables
   * angle snapping; opts.excludeNodes skips nodes being dragged.
   */
  snap(raw, opts = {}) {
    // Snapping off: only round to 1/16" / 1 mm (Shift still frees the angle).
    if (!this.canvas.snapOn) {
      const f = this.canvas.fine;
      return { p: { x: Math.round(raw.x / f) * f, y: Math.round(raw.y / f) * f }, kind: 'free', guides: [] };
    }
    const tol = this.px(10);
    const step = this.snapStep();
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
    this.levelEntry = null;
    this.svg.dataset.tool = tool;
    if (tool === 'level' && this.app.selection?.type !== 'room') {
      const g = this.levelRoom(analyze(this.design), true);
      if (g?.room) this.app.select({ type: 'room', id: g.room.id });
    }
    this.app.emit('tool', tool);
    this.render();
  }

  // -------------------------------------------------------------------------
  // Leveling survey

  /**
   * Room being surveyed: the selected room (or the room of a selected wall
   * or opening). With `fallback`, the first room that has readings, else
   * the first room.
   */
  levelRoom(analysis, fallback = false) {
    const sel = this.app.selection;
    const d = this.design;
    let g = null;
    if (sel?.type === 'room') g = analysis.rooms.find((x) => x.room?.id === sel.id);
    if (!g && sel?.type === 'wall') g = analysis.rooms.find((x) => x.wallIds.includes(sel.id));
    if (!g && sel?.type === 'opening') {
      const o = d.openings.find((x) => x.id === sel.id);
      g = o && analysis.rooms.find((x) => x.wallIds.includes(o.wallId));
    }
    if (!g && fallback) g = analysis.rooms.find((x) => x.room?.leveling?.readings?.length) ?? analysis.rooms[0];
    return g?.room ? g : null;
  }

  /**
   * Leveling analysis for a room (and the rooms linked to it), using the
   * slider preview target when one is active for its group.
   */
  levelAnalysis(g, analysis) {
    const d = this.design;
    // Memoised on the whole plan (linked rooms depend on each other): the plan re-renders on every mouse move.
    const key = JSON.stringify([d.nodes, d.walls, d.openings, d.rooms, d.estimate, d.units, this.levelPreview]);
    this.levelCache ??= new Map();
    const hit = this.levelCache.get(g.room?.id);
    if (hit?.key === key) return hit.la;
    const la = analyzeLeveling(d, g, { analysis, preview: this.levelPreview ?? undefined });
    this.levelCache.set(g.room?.id, { key, la });
    return la;
  }

  /** The survey node under the mouse in any room of the active group: {geom, node} or null. */
  levelNodeAt(raw, la) {
    let best = null;
    let bestD = Math.max(this.px(12), la.grid.spacing * 0.25);
    for (const m of la.members) {
      for (const nd of m.nodes) {
        const dd = dist(nd, raw);
        if (dd < bestD) {
          best = { geom: m.geom, node: nd };
          bestD = dd;
        }
      }
    }
    return best;
  }

  /** Current survey target: room geometry, analysis and the node being typed into. */
  levelContext() {
    const analysis = analyze(this.design);
    const g = this.levelRoom(analysis);
    if (!g) return null;
    const la = this.levelAnalysis(g, analysis);
    const entry = this.levelEntry?.roomId === g.room.id ? la.nodes.find((nd) => nd.key === this.levelEntry.key) : null;
    return { g, la, node: entry ?? null };
  }

  /** Makes `node` of room `g` the entry target, selecting that room when it's a linked neighbour. */
  startLevelEntry(g, node) {
    this.levelEntry = node ? { roomId: g.room.id, key: node.key } : null;
    this.typed = '';
    this.message = '';
    if (node && this.app.selection?.type === 'room' && this.app.selection.id !== g.room.id) this.app.select({ type: 'room', id: g.room.id });
    this.render();
  }

  /**
   * Rooms a survey walks through from `g`: g first, then rooms reachable
   * through doors and openings with linking on (surveyed or not yet), nearest first.
   */
  surveyRooms(g, analysis) {
    const linked = (x) => resolveLeveling(x.room, this.design.units).linked !== false;
    const self = analysis.rooms.find((x) => x.room?.id === g.room.id) ?? g;
    const order = [self];
    if (!linked(self)) return order;
    for (let k = 0; k < order.length; k++) {
      for (const next of connectedRooms(this.design, order[k], analysis)) if (linked(next) && !order.includes(next)) order.push(next);
    }
    return order;
  }

  /**
   * Steps through nodes in walking order. Past the last node, entry carries
   * on in the nearest linked room that still has empty nodes, else ends with a summary.
   */
  stepLevelEntry(ctx, step) {
    const { g, la, node } = ctx;
    const i = la.nodes.indexOf(node) + step;
    if (i < 0) return this.startLevelEntry(g, la.nodes[0]);
    if (i >= la.nodes.length) {
      const analysis = analyze(this.design);
      const rooms = this.surveyRooms(g, analysis).slice(1).map((geom) => ({ geom, nodes: this.levelAnalysis(geom, analysis).nodes }));
      const next = rooms.find((r) => r.nodes.some((nd) => nd.z == null));
      if (next) {
        this.app.toast(`${g.room.name} done: continuing in ${next.geom.room.name}`);
        return this.startLevelEntry(next.geom, next.nodes.find((nd) => nd.z == null));
      }
      this.startLevelEntry(g, null);
      const all = la.members.flatMap((m) => m.nodes);
      const done = all.filter((nd) => nd.z != null).length;
      const where = la.linked ? ` in ${la.members.length} linked rooms` : '';
      this.app.toast(done === all.length ? `Survey complete: all ${done} nodes measured${where}` : `End of grid: ${done} of ${all.length} nodes measured${where}`);
      return;
    }
    this.startLevelEntry(g, la.nodes[i]);
  }

  /** Arrow keys: the nearest node in that grid direction (skipping gaps in L-shaped rooms). */
  moveLevelEntry(ctx, dc, dr) {
    const { g, la, node } = ctx;
    const ahead = la.nodes
      .filter((nd) => (dc ? Math.sign(nd.col - node.col) === dc && nd.row === node.row : Math.sign(nd.row - node.row) === dr && nd.col === node.col))
      .sort((p, q) => Math.abs(p.col - node.col) + Math.abs(p.row - node.row) - (Math.abs(q.col - node.col) + Math.abs(q.row - node.row)));
    if (ahead[0]) this.startLevelEntry(g, ahead[0]);
  }

  commitReading(g, node, z) {
    const roomId = g.room.id;
    this.app.change(z == null ? `Clear reading ${node.label}` : `Reading ${node.label}`, (d) => {
      const room = d.rooms.find((r) => r.id === roomId);
      const lv = resolveLeveling(room, d.units);
      room.leveling = { ...lv, readings: setReading(lv.readings, node, z, lv.spacing) };
    });
  }

  /** The node a reading goes to: the active one, else the first empty node. */
  entryTarget(ctx) {
    return ctx.node ?? ctx.la.nodes.find((nd) => nd.z == null) ?? ctx.la.nodes[0] ?? null;
  }

  /** Saves z at the target node, then moves on (quick entry) or stays there. */
  enterReading(ctx, z) {
    const node = this.entryTarget(ctx);
    if (!node) return;
    this.levelEntry = { roomId: ctx.g.room.id, key: node.key };
    this.typed = '';
    this.message = '';
    this.commitReading(ctx.g, node, z);
    if (this.levelQuick) this.stepLevelEntry(this.levelContext() ?? { ...ctx, node }, 1);
    else this.render();
  }

  /** Parses typed text and enters it; empty text skips ahead (quick entry) or stops. Returns true when saved. */
  submitTyped(ctx, raw) {
    const text = raw.trim();
    if (!text) {
      if (!ctx.node) return false;
      if (this.levelQuick) this.stepLevelEntry(ctx, 1);
      else this.startLevelEntry(ctx.g, null);
      return false;
    }
    const unit = readingUnit(this.design);
    const z = parseDeviation(text, unit);
    if (z == null) {
      this.flash(`Couldn't read "${text}": try ${unit === 'in' ? '+1/4, -3/8 or 5mm' : '+4, -6 or -1/8"'}`);
      return false;
    }
    if (Math.abs(z) > MAX_READING) {
      this.flash(`${formatDeviation(z, unit, { sign: true })} looks too large. Bare numbers are ${unit === 'in' ? 'inches' : 'mm'} (see panel)`);
      return false;
    }
    this.enterReading(ctx, z);
    return true;
  }

  /** Builds the entry bar for a reading unit: preset buttons, a custom value box and prev/next/clear. */
  buildPalette(unit) {
    const keepFocus = (e) => e.preventDefault(); // clicks must not pull focus off the plan
    const withCtx = (fn) => () => {
      const ctx = this.levelContext();
      if (ctx?.la.nodes.length) fn(ctx);
    };
    const step = (dir) => withCtx((ctx) => (ctx.node ? this.stepLevelEntry(ctx, dir) : this.startLevelEntry(ctx.g, this.entryTarget(ctx))));
    this.paletteLabel = h('span', { class: 'lvl-pal-node' });
    this.paletteButtons = READING_PRESETS[unit].map((z) => ({
      z,
      el: h('button', {
        class: `lvl-preset ${z > 0 ? 'hi' : z < 0 ? 'lo' : 'zero'}`, title: `Reading ${formatDeviation(z, unit, { sign: true })}`,
        onmousedown: keepFocus, onclick: withCtx((ctx) => this.enterReading(ctx, z)),
      }, formatDeviation(z, unit, { sign: true, compact: true }).replace(/"$/, '').replace('±', '')),
    }));
    const input = h('input', {
      type: 'text', class: 'lvl-pal-input', spellcheck: false, autocomplete: 'off', 'aria-label': 'Other reading',
      placeholder: unit === 'in' ? 'Other, e.g. 3/8' : 'Other, e.g. -7',
    });
    input.addEventListener('input', () => {
      const ctx = this.levelContext();
      const target = ctx && !ctx.node && this.entryTarget(ctx);
      if (target) this.levelEntry = { roomId: ctx.g.room.id, key: target.key };
      this.typed = input.value;
      this.message = '';
      this.render();
    });
    input.addEventListener('keydown', (e) => {
      const ctx = this.levelContext();
      if (!ctx) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        if (this.submitTyped(ctx, input.value) || !input.value.trim()) input.value = '';
      } else if (e.key === 'Tab') {
        e.preventDefault();
        step(e.shiftKey ? -1 : 1)();
      } else if (e.key === 'Escape') {
        input.value = '';
        this.typed = '';
        input.blur();
        this.startLevelEntry(ctx.g, null);
      } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && ctx.node) {
        e.preventDefault();
        this.moveLevelEntry(ctx, 0, e.key === 'ArrowDown' ? 1 : -1);
      }
    });
    this.paletteInput = input;
    this.palette.dataset.unit = unit;
    this.palette.replaceChildren(
      this.paletteLabel,
      h('div', { class: 'lvl-pal-presets', role: 'group', 'aria-label': 'Preset readings' }, this.paletteButtons.map((b) => b.el)),
      input,
      h('div', { class: 'lvl-pal-nav' },
        h('button', { class: 'icon', title: 'Previous node (Shift+Tab)', onmousedown: keepFocus, onclick: step(-1) }, '‹'),
        h('button', { class: 'icon', title: 'Next node (Tab)', onmousedown: keepFocus, onclick: step(1) }, '›'),
        h('button', {
          class: 'icon', title: 'Clear this reading (Del)', onmousedown: keepFocus,
          onclick: withCtx((ctx) => ctx.node?.z != null && this.commitReading(ctx.g, ctx.node, null)),
        }, '⌫')),
    );
  }

  /** Shows the entry bar for the surveyed room and syncs its node label, highlighted preset and typed text. */
  updatePalette(level) {
    const la = level?.la;
    this.palette.hidden = !la?.nodes.length;
    if (this.palette.hidden) return;
    if (this.palette.dataset.unit !== level.unit) this.buildPalette(level.unit);
    const nd = level.entryNode;
    const next = nd ?? la.nodes.find((x) => x.z == null);
    this.paletteLabel.replaceChildren(nd ? nd.label : next ? `Next ${next.label}` : 'Done', h('small', {}, level.unit === 'in' ? 'inches' : 'mm'));
    for (const b of this.paletteButtons) b.el.classList.toggle('active', nd?.z != null && Math.abs(nd.z - b.z) < 0.01);
    if (document.activeElement !== this.paletteInput) this.paletteInput.value = this.typed;
  }

  /** Keyboard handling for the Level tool; returns true when consumed. */
  onLevelKey(e) {
    const ctx = this.levelContext();
    if (!ctx) return false;
    const { g, la, node } = ctx;
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    if (!node) {
      // Typing a reading with nothing active starts at the first empty node.
      if (plain && e.key.length === 1 && /[0-9.+\-−]/.test(e.key) && la.nodes.length) {
        this.startLevelEntry(g, la.nodes.find((nd) => nd.z == null) ?? la.nodes[0]);
        this.typed = e.key;
        this.render();
        return true;
      }
      return e.key === 'Delete' || e.key === 'Backspace'; // never delete the room from here
    }
    if (plain && e.key.length === 1 && READING_TYPABLE.test(e.key)) {
      this.typed += e.key;
      this.message = '';
      this.render();
      return true;
    }
    switch (e.key) {
      case 'Enter':
        this.submitTyped(ctx, this.typed);
        return true;
      case 'Tab':
        this.stepLevelEntry(ctx, e.shiftKey ? -1 : 1);
        return true;
      case 'ArrowRight': this.moveLevelEntry(ctx, 1, 0); return true;
      case 'ArrowLeft': this.moveLevelEntry(ctx, -1, 0); return true;
      case 'ArrowDown': this.moveLevelEntry(ctx, 0, 1); return true;
      case 'ArrowUp': this.moveLevelEntry(ctx, 0, -1); return true;
      case 'Backspace':
        if (this.typed) this.typed = this.typed.slice(0, -1);
        this.render();
        return true;
      case 'Delete':
        if (node.z != null) this.commitReading(g, node, null);
        return true;
      case 'Escape':
        if (this.typed) {
          this.typed = '';
          this.render();
        } else {
          this.startLevelEntry(g, null);
        }
        return true;
      default:
        return false;
    }
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
    const step = this.snapStep();
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
    // Kept under bulkheads; windows stack above existing windows.
    const place = newOpeningPlacement(d, this.tool, best.wall.id, offset, width);
    return { wallId: best.wall.id, offset, width, blocked: null, ...place };
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
    svg.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    svg.addEventListener('pointermove', (e) => this.onPointerMove(e));
    svg.addEventListener('pointerup', (e) => this.onPointerUp(e));
    svg.addEventListener('pointerleave', () => {
      if (!this.drag && !this.canvas.pan) {
        this.cursor = null;
        this.render();
      }
    });
    svg.addEventListener('dblclick', (e) => this.onDoubleClick(e));
  }

  onPointerDown(e) {
    const raw = this.toWorld(e);
    this.svg.setPointerCapture(e.pointerId);
    if (this.canvas.wantsPan(e, this.tool === 'pan')) {
      this.canvas.startPan(e);
      return;
    }
    if (e.button !== 0) return;

    if (this.tool === 'level') {
      const ctx = this.levelContext();
      const hit = ctx && this.levelNodeAt(raw, ctx.la);
      if (hit) {
        this.startLevelEntry(hit.geom, hit.node);
        return;
      }
      const room = this.hitTest(raw);
      this.levelEntry = null;
      this.typed = '';
      this.app.select(room?.type === 'room' ? room : this.app.selection);
      this.render();
      return;
    }

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
      if (target.blocked) {
        this.flash(target.blocked);
        return;
      }
      const type = this.tool;
      let created = null;
      this.app.change(`Add ${type}`, (d) => {
        created = addOpening(d, target.wallId, type, target.offset, { width: target.width, sill: target.sill, height: target.height });
      });
      if (created) this.app.select({ type: 'opening', id: created.id });
      return;
    }

    if (this.tool === 'trim') {
      const face = faceAtPoint(designFaces(this.design), raw, this.px(16));
      if (face) this.app.openFace(faceRef(face));
      else this.flash('Click on the side of a wall');
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
    if (this.canvas.movePan(e)) return;
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
    } else if (this.tool === 'pan') {
      this.hover = null;
      this.cursor = { p: raw };
    } else if (this.tool === 'trim') {
      this.hover = null;
      const face = faceAtPoint(designFaces(this.design), raw, this.px(16));
      this.hoverFace = face ? faceKey(faceRef(face)) : null;
      this.cursor = { p: raw };
    } else if (this.tool === 'level') {
      const ctx = this.levelContext();
      this.hover = null;
      const hit = ctx && this.levelNodeAt(raw, ctx.la);
      this.levelHover = hit ? { roomId: hit.geom.room.id, key: hit.node.key } : null;
      this.cursor = { p: raw };
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
      const step = this.snapStep();
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
      const fine = this.canvas.snapOn ? (d.units === 'metric' ? 10 : MM_PER_IN) : this.canvas.fine;
      let offset = dot(sub(raw, g.A), g.dir);
      if (!e.shiftKey) offset = Math.round(offset / fine) * fine;
      if (this.canvas.snapOn && Math.abs(offset - g.length / 2) < this.px(8)) offset = g.length / 2;
      // Slide up against neighbours rather than overlapping them.
      o.offset = freeOpeningOffset(d, o, offset, g.length) ?? o.offset;
    }
  }

  onPointerUp(e) {
    const dr = this.drag;
    this.drag = null;
    if (this.svg.hasPointerCapture(e.pointerId)) this.svg.releasePointerCapture(e.pointerId);
    if (this.canvas.endPan()) return;
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
    if (this.tool === 'level' && this.onLevelKey(e)) return true;
    if (!e.ctrlKey && !e.metaKey && !e.altKey && !this.typed && (e.key === 's' || e.key === 'g' || e.key === 'S' || e.key === 'G')) {
      this.canvas.toggle(e.key.toLowerCase() === 's' ? 'snapOn' : 'gridOn');
      return true;
    }
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
    this.worldLayer.setAttribute('transform', this.canvas.worldTransform());
    this.gridLayer.innerHTML = this.canvas.gridSvg();
    this.renderBar();
    const analysis = analyze(this.design);
    const level = this.tool === 'level' ? this.renderLevel(analysis) : null;
    this.worldLayer.innerHTML = [
      this.renderRooms(analysis),
      level?.heat,
      this.renderWalls(analysis),
      this.renderOpenings(analysis),
      this.renderFaceTrim(analysis),
      this.renderDimensions(analysis),
      level ? '' : this.renderRoomLabels(analysis),
      level?.survey,
      this.renderSelection(analysis),
      this.renderPreview(),
    ].join('');
    const cur = this.cursor?.p;
    this.overlayLayer.innerHTML = this.renderOverlay(level) + this.canvas.rulersSvg({ cursor: cur && { x: cur.x, y: cur.y } });
    this.updatePalette(level);
  }

  /**
   * Heatmaps for every surveyed room (one continuous map per linked group);
   * grids, readings and call-outs for the active room's group.
   */
  renderLevel(analysis) {
    const active = this.levelRoom(analysis);
    const unit = readingUnit(this.design);
    const drawn = new Set();
    let heat = '';
    let survey = '';
    let activeLa = null;
    for (const g of analysis.rooms) {
      const isActive = g === active;
      if (!g.room || (!isActive && !g.room.leveling?.readings?.length)) continue;
      const la = this.levelAnalysis(g, analysis);
      if (isActive) activeLa = la;
      if (drawn.has(g.room.id)) continue;
      la.group.ids.forEach((id) => drawn.add(id));
      heat += renderHeatmap(this, la);
    }
    if (activeLa) {
      survey = renderSurvey(this, activeLa, { unit, numbers: this.levelNumbers, entry: this.levelEntry, hover: this.levelHover });
    }
    const entryNode = activeLa && this.levelEntry?.roomId === active.room.id ? activeLa.nodes.find((nd) => nd.key === this.levelEntry.key) : null;
    return { heat, survey, la: activeLa, entryNode, unit };
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

  /**
   * Trim on the plan (unless turned off in the plan settings): baseboard as a
   * solid band along the floor line, crown (and tray crown) as a dashed band
   * at its projection, both mitred where they meet at corners, and casing
   * legs, stools and sills around cased doors and windows. With the Trim
   * tool, the face under the mouse is always highlighted and named.
   */
  renderFaceTrim(analysis) {
    const trimTool = this.tool === 'trim';
    const showTrim = this.design.settings.showTrim !== false && this.design.faceTrim.length > 0;
    if (!trimTool && !showTrim) return '';
    const faces = designFaces(this.design, analysis);
    const out = [];
    if (showTrim) {
      // Real depth off the wall (¾" baseboard and casing, crown ≈ 70% of its width, stools and
      // sills their width), but never thinner than a few pixels.
      const stock = this.units === 'metric' ? 18 : 0.75 * MM_PER_IN;
      const depth = (x) => {
        if (x.category === 'crown') return Math.max(x.size * 0.7, this.px(7));
        if (x.part === 'leg') return Math.max(stock, this.px(4.5));
        if (x.part === 'stool' || x.part === 'sill') return Math.max(x.size, this.px(5));
        return Math.max(stock, this.px(3.5));
      };
      const bands = planTrimBands(this.design, faces, depth);
      // Crown first (it is overhead), then baseboard at the floor line, then casing, which the baseboard stops against.
      const layer = (b) => (b.category === 'crown' ? 0 : b.part === 'run' ? 1 : 2);
      for (const b of [...bands].sort((p, q) => layer(p) - layer(q))) {
        const crown = b.category === 'crown';
        const cls = crown ? 'crown' : b.part === 'run' ? 'baseboard' : b.part === 'leg' ? 'casing' : 'stool';
        out.push(tag('polygon', {
          class: `plan-trim ${cls}`, points: pts(b.poly), 'stroke-width': this.px(1),
          'stroke-dasharray': crown ? `${n(this.px(4))} ${n(this.px(3))}` : undefined,
        }, null));
      }
    }
    if (trimTool) {
      const f = faces.find((x) => this.hoverFace === faceKey(faceRef(x)));
      if (f) {
        const off = scale(f.outward, -this.px(4));
        const a = add(f.P, off);
        const b = add(f.Q, off);
        out.push(tag('line', { class: 'face-line hover', x1: a.x, y1: a.y, x2: b.x, y2: b.y, 'stroke-width': this.px(5) }, null));
        const mid = add(add(f.P, scale(sub(f.Q, f.P), 0.5)), scale(f.outward, -this.px(18)));
        out.push(this.label(mid, `${f.name} – click to edit trim`, uprightAngle(f.dir), 'face-label', 11));
      }
    }
    return `<g class="face-trim">${out.join('')}</g>`;
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
      out.push(tag('line', { class: `preview-opening${c.opening.blocked ? ' blocked' : ''}`, x1: a.x, y1: a.y, x2: b.x, y2: b.y, 'stroke-width': w.thickness + this.px(4) }, null));
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

  renderOverlay(level) {
    const out = [];
    if (level?.la?.ready) out.push(renderLegend(level.la, level.unit));
    if (level?.entryNode) {
      // Reading entry box beside the active node; messages stack below it.
      const nd = level.entryNode;
      const s = this.toScreen(nd);
      const current = nd.z != null ? formatDeviation(nd.z, level.unit, { sign: true }) : '';
      const text = `${nd.label}  ${this.typed || current}▏`;
      const w = Math.max(80, text.length * 7.4 + 20);
      out.push(`<g class="typed" transform="translate(${n(s.x + 16)} ${n(s.y - 34)})"><rect width="${n(w)}" height="24" rx="4"/><text x="10" y="16">${esc(text)}</text></g>`);
      if (this.message) {
        const mw = Math.max(60, this.message.length * 6.6 + 20);
        out.push(`<g class="message" transform="translate(${n(s.x + 16)} ${n(s.y - 6)})"><rect width="${n(mw)}" height="24" rx="4"/><text x="10" y="16">${esc(this.message)}</text></g>`);
      }
      return out.join('');
    }
    // Typed values sit by the cursor, messages in the banner, as on a wall face.
    const anchor = this.cursor?.p ?? this.draw?.points?.at(-1) ?? this.draw?.start;
    if (this.typed && anchor) {
      const s = this.toScreen(anchor);
      out.push(this.canvas.typedSvg(s.x, s.y, this.typed, this.tool === 'rect' ? 'interior W x D' : 'length'));
    }
    out.push(this.canvas.messageSvg(this.message));
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
