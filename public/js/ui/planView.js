// Top-down plan editor: an SVG canvas with pan/zoom, snapping and the
// drawing tools (walls, rooms, doors, windows, openings, select/edit).
import {
  add, closestPointOnSegment, dist, dot, lineIntersection, norm, perp, scale, segmentIntersection, sub,
} from '../core/geometry.js';
import {
  BARN_OVERLAP, addOpening, addRectangle, addWallChain, analyze, designBounds, doorStyle, findNodeNear, freeOpeningOffset, newOpeningPlacement,
  facesOfWall, indexDesign, nodeDegrees, openingGeometry, rectangleCorners, resolveRoomCeiling, translateNodes, uid, wallFaceSpans,
} from '../core/model.js';
import { ceilingModel } from '../core/ceiling.js';
import { resolveBulkheads } from '../core/bulkhead.js';
import { MAX_READING, READING_PRESETS, analyzeLeveling, connectedRooms, readingUnit, resolveLeveling, setReading } from '../core/leveling.js';
import { MM_PER_IN, formatArea, formatDeviation, formatLength, parseDeviation, parseDimensions, parseLength, unitDefaults } from '../core/units.js';
import { esc, n, pts, tag, uprightAngle } from './svg.js';
import { renderHeatmap, renderLegend, renderSurvey } from './levelLayer.js';
import { layoutRun, resolveRun, runAtPoint, runLayer, snapOrigin } from '../core/flooring.js';
import { renderFloorLegend, renderFloorMarks, renderFloorRun } from './floorLayer.js';
import { checkbox, h } from './dom.js';
import { DrawingCanvas } from './canvas.js';
import { RulerGuides } from './guides.js';
import { designFaces, faceAtPoint, faceKey, faceRef, faceRuns } from '../core/faces.js';
import { planTrimBands } from '../core/trim.js';
import {
  FURNITURE, alignPlacement, analyzeLayout, createFurniture, duplicateFurniture, footprint, resolveItem, toLocal, toWorld, wallPlacement, wrapAngle,
} from '../core/furniture.js';
import { applianceTag, furnitureGroup } from './layoutLayer.js';

const ANGLE_SNAP = (10 * Math.PI) / 180;
const TYPABLE = /^[0-9.'"\/\- xXmMcC]$/;
const READING_TYPABLE = /^[0-9.+\-−\/"' mMcCiInN]$/;

export const TOOLS = {
  select: { label: 'Select', key: 'V', hint: 'Click to select, Shift+click to add · drag a box to select several (→ fully inside, ← touching; guides it crosses) · drag corners, walls, openings or guides to move (drag any selected wall to move the whole selection; Shift locks the move horizontal or vertical, Alt moves without snapping) · drag from a ruler for a guide, Shift+drag a guide to pull a second one off it (type a distance + Enter) · Del deletes · right-drag or Space+drag pans' },
  pan: { label: 'Pan', key: 'P', hint: 'Drag to move around the plan · scroll to zoom · Space+drag or right-drag also pans with any tool' },
  wall: { label: 'Wall', key: 'W', hint: 'Click to start, click to add corners · type a length + Enter for exact walls · Shift = free angle · Enter/Esc/double-click to finish' },
  rect: { label: 'Room', key: 'R', hint: 'Drag (or click two corners) to add a rectangular room · type interior size like 12x10 + Enter' },
  door: { label: 'Door', key: 'D', hint: 'Click on a wall to place a door (in the last style you picked) · select it afterwards to set the style (single, double, sliding, pocket, barn), flip it or change the size' },
  window: { label: 'Window', key: 'N', hint: 'Click on a wall to place a window · select it afterwards to set width, height and sill' },
  opening: { label: 'Opening', key: 'O', hint: 'Click on a wall to place a cased opening (no door)' },
  layout: { label: 'Layout', key: 'U', hint: 'Pick furniture, cabinets, fixtures or appliances in the panel, then click to place (Shift+click to place another) · wall pieces turn to face the room and sit flush on the nearest wall, sliding to corners, jambs and their neighbours · Q / E rotate 90° (Shift 15°) · drag to move (Shift locks the axis, Alt = no snapping) · Ctrl+D duplicates beside · arrows nudge · Esc stops placing' },
  measure: { label: 'Measure', key: 'M', hint: 'Hover the side of a wall for its length, click to pin it · drag (or click, click) between two points, snapping to corners, wall faces and jambs · Shift = free angle · Del removes the last · Esc clears' },
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
    // Flooring layer: shown or not, which layer (finish floor or subfloor) is drawn and
    // edited, the run picked in the panel when no room is selected, and drag snap targets.
    this.showFlooring = false;
    this.floorLayer = 'finish';
    this.floorRunId = null;
    this.floorSnap = null;
    // Measure tool: pinned measurements ({a, b} or a wall face), the one being drawn, and the face under the mouse.
    this.measures = [];
    this.measuring = null;
    this.measureHover = null;
    // Style for new doors: the last one picked in the inspector.
    this.newDoorStyle = 'single';
    // Layout planning: furniture shown or not, clearance zones ('selected' or 'all'), the item
    // being placed ({ type, size, angle, ghost }) and the catalog's search and open sections.
    this.showFurniture = true;
    this.showClearances = 'all';
    this.placing = null;
    this.layoutSearch = '';
    this.layoutOpen = new Set(['bedroom']);
    this.rulers = this.rulerGuides();
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
    const key = `${this.canvas.snapOn}|${this.canvas.gridOn}|${this.showFlooring}|${this.showFurniture}`;
    if (this.barKey === key) return;
    this.barKey = key;
    this.bar.replaceChildren(
      h('span', { class: 'cv-title' }, 'Floor plan'),
      h('span', { class: 'cv-layer', title: 'Show the flooring layout; drag it on the plan to move the pattern' },
        checkbox('Flooring (Shift+F)', this.showFlooring, (v) => this.setFlooring(v))),
      h('span', { class: 'cv-layer', title: 'Show furniture, cabinets, fixtures and appliances (always shown with the Layout tool)' },
        checkbox('Furniture', this.showFurniture, (v) => {
          this.showFurniture = v;
          this.render();
        })),
      h('span', { class: 'spacer' }),
      this.canvas.controls({ onFit: () => this.fit() }));
  }

  // -------------------------------------------------------------------------
  // Snapping

  /**
   * Snaps a raw world point. opts.from enables angle snapping (45° steps)
   * and length inference relative to the previous point; opts.free disables
   * angle snapping; opts.excludeNodes skips nodes being dragged. Ruler guides
   * snap like corners where they cross (each other or a wall) and like
   * alignment lines elsewhere.
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
    const rulerGuides = this.design.guides ?? [];
    let bestCross = null;
    bestD = tol;
    for (const q of this.guidePoints(walls, idx)) {
      const d = dist(q, raw);
      if (d < bestD) {
        bestCross = q;
        bestD = d;
      }
    }
    if (bestCross) return { p: bestCross, kind: 'guide', guides: [] };

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
        for (const g of rulerGuides) {
          if (Math.abs(dir[g.axis]) < 1e-9) continue;
          const t = (g.v - opts.from[g.axis]) / dir[g.axis];
          const delta = Math.abs(t - along);
          if (t > 0 && delta < bestDelta) {
            bestDelta = delta;
            best = { t, onGuide: true };
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
          return { p, kind: best.wall ? 'wall' : best.onGuide ? 'guide' : 'aligned', guides, dir };
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
      let onGuide = null;
      for (const g of rulerGuides) {
        const d = Math.abs(g.v - raw[axis]);
        if (g.axis === axis && d < bestAxisD) {
          bestAxisD = d;
          onGuide = g;
        }
      }
      if (onGuide) {
        p[axis] = onGuide.v;
        kind = 'guide';
      } else if (bestAxis) {
        p[axis] = bestAxis[axis];
        guides.push({ a: bestAxis, b: p });
        if (kind === 'grid') kind = 'aligned';
      }
    }
    return { p, kind, guides };
  }

  /** Where ruler guides cross each other or a wall centreline. */
  guidePoints(walls, idx = indexDesign(this.design)) {
    const out = this.rulers.crossings();
    for (const g of this.design.guides) {
      for (const w of walls) {
        const A = idx.nodes.get(w.a);
        const B = idx.nodes.get(w.b);
        const a = A[g.axis];
        const b = B[g.axis];
        if (Math.abs(b - a) < 1e-9 || (a - g.v) * (b - g.v) > 0) continue;
        out.push(add(A, scale(sub(B, A), (g.v - a) / (b - a))));
      }
    }
    return out;
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
    this.measures = [];
    this.measuring = null;
    this.measureHover = null;
    this.rulers.cancel();
    if (tool !== 'layout') this.placing = null;
    this.svg.dataset.tool = tool;
    this.svg.classList.remove('floor-grab');
    if (tool === 'level' && this.app.selection?.type !== 'room') {
      const g = this.levelRoom(analyze(this.design), true);
      if (g?.room) this.app.select({ type: 'room', id: g.room.id });
    }
    this.app.emit('tool', tool);
    this.render();
  }

  // -------------------------------------------------------------------------
  // Flooring layout

  setFlooring(on) {
    this.showFlooring = on;
    this.floorSnap = null;
    this.svg.classList.toggle('flooring-on', on);
    if (on && this.tool === 'level') this.setTool('select');
    this.render();
    this.app.inspector.render();
  }

  /** Layout of a run, memoised on the plan geometry and the run (the plan re-renders on every mouse move). */
  floorLayout(run, analysis) {
    const d = this.design;
    const key = JSON.stringify([d.nodes, d.walls, d.openings, d.rooms.map((r) => [r.id, r.name]), d.units, d.settings.joists, run]);
    this.floorCache ??= new Map();
    const hit = this.floorCache.get(run.id);
    if (hit?.key === key) return hit.layout;
    const layout = layoutRun(d, run, { analysis });
    this.floorCache.set(run.id, { key, layout });
    if (this.floorCache.size > 40) this.floorCache.delete(this.floorCache.keys().next().value);
    return layout;
  }

  /**
   * The run being edited on the current layer: the selected room's, else the
   * one picked in the panel, else the first. Null when the selected room has none.
   */
  activeFloorRun() {
    const runs = this.design.floorRuns.filter((r) => runLayer(r) === this.floorLayer);
    const sel = this.app.selection;
    if (sel?.type === 'room') return runs.find((r) => r.roomIds.includes(sel.id)) ?? null;
    return runs.find((r) => r.id === this.floorRunId) ?? runs[0] ?? null;
  }

  /** Re-renders the inspector once per frame while a layout is dragged (live takeoff). */
  scheduleInspector() {
    if (this.inspectorRaf) return;
    this.inspectorRaf = requestAnimationFrame(() => {
      this.inspectorRaf = null;
      this.app.inspector.render();
    });
  }

  /** Arrow keys move the active run's pattern by 1/8" or 1 mm (Shift: 1" or 10 mm). */
  nudgeFloor(e) {
    const run = this.activeFloorRun();
    if (!run) return false;
    const metric = this.units === 'metric';
    const step = e.shiftKey ? (metric ? 10 : MM_PER_IN) : (metric ? 1 : MM_PER_IN / 8);
    const dx = { ArrowLeft: -1, ArrowRight: 1 }[e.key] ?? 0;
    const dy = { ArrowUp: -1, ArrowDown: 1 }[e.key] ?? 0;
    this.app.change('Nudge flooring', (d) => {
      const r = d.floorRuns.find((x) => x.id === run.id);
      const o = resolveRun(r, d.units).origin;
      r.origin = { x: o.x + dx * step, y: o.y + dy * step };
    });
    return true;
  }

  /**
   * Layout layers for the current flooring layer: every run's pieces, its
   * doorway strips (drawn over the walls, with those openings' cuts left
   * open), and marks for the active run.
   */
  renderFlooring(analysis) {
    const active = this.activeFloorRun();
    let under = '';
    let doorways = '';
    let marks = '';
    let layout = null;
    const openings = new Set();
    for (const run of this.design.floorRuns) {
      if (runLayer(run) !== this.floorLayer) continue;
      const la = this.floorLayout(run, analysis);
      under += renderFloorRun(this, la, { active: run === active });
      doorways += renderFloorRun(this, la, { active: run === active, thresholds: true });
      for (const p of la.region.parts) if (p.kind === 'threshold') openings.add(p.opening.id);
      if (run === active) {
        layout = la;
        marks = renderFloorMarks(this, la, { snap: this.floorSnap });
      }
    }
    return { under, doorways, marks, layout, openings };
  }

  // -------------------------------------------------------------------------
  // Ruler guides (guides.js does the work; the plan keeps them in design.guides)

  /** What a plan guide on `axis` snaps to: wall faces parallel to it (also references for typed distances), then wall centrelines through corners. */
  guideTargets(axis, exceptId = null) {
    const analysis = analyze(this.design);
    const targets = [];
    for (const g of analysis.rooms) {
      for (const f of g.walls) if (Math.abs(f.dir[axis]) < 1e-6) targets.push({ v: f.P[axis], label: g.dead ? 'dead space face' : 'interior face', ref: true });
    }
    for (const f of analysis.exteriorFaces) if (Math.abs(f.dir[axis]) < 1e-6) targets.push({ v: f.P[axis], label: 'exterior face', ref: true });
    for (const nd of this.design.nodes) targets.push({ v: nd[axis], label: 'wall centreline' });
    return targets;
  }

  rulerGuides() {
    const plan = this;
    return new RulerGuides(this.canvas, {
      list: () => this.design.guides,
      save: (label, fn) => this.app.change(label, (d) => fn(d.guides)),
      targets: (axis, id) => this.guideTargets(axis, id),
      parse: (text) => parseLength(text, this.units),
      get example() { return plan.units === 'metric' ? '450mm or 1.2' : '18" or 3\'6"'; },
      canGrab: () => this.tool === 'select',
      isSelected: (id) => this.isActive('guide', id),
      select: (id, additive) => (additive ? this.app.toggleSelect({ type: 'guide', id }) : this.app.select({ type: 'guide', id })),
      render: () => this.render(),
      flash: (msg) => this.flash(msg),
    });
  }

  // -------------------------------------------------------------------------
  // Measure tool

  /** Wall faces to measure: every room's (dead space too) and the outside of the building. */
  measureFaces(analysis) {
    return [
      ...analysis.rooms.flatMap((g) => g.walls.map((f) => ({ ...f, where: `${g.dead ? 'Dead space' : g.room?.name ?? 'Room'} – ${f.compass} wall` }))),
      ...analysis.exteriorFaces.map((f) => ({ ...f, where: `Exterior – ${f.compass} face` })),
    ];
  }

  /**
   * Snaps a measuring point: face corners, door and window jambs and guide
   * crossings first; from a first point, 45° directions that stop on the
   * wall face they reach (so a measure across a room gives its clear size);
   * else the nearest face line or guide. Shift frees the angle.
   */
  measureSnap(raw, from = null, free = false) {
    const fine = this.canvas.fine;
    const round = (p) => ({ x: Math.round(p.x / fine) * fine, y: Math.round(p.y / fine) * fine });
    if (!this.canvas.snapOn) return { p: round(raw), kind: 'free' };
    const tol = this.px(10);
    const analysis = analyze(this.design);
    const faces = this.measureFaces(analysis);
    const guides = this.design.guides;
    const points = [];
    for (const f of faces) {
      points.push({ p: f.P, kind: 'node' }, { p: f.Q, kind: 'node' });
      for (const op of f.openings) for (const s of [op.s0, op.s1]) if (s > 0 && s < f.length) points.push({ p: add(f.P, scale(f.dir, s)), kind: 'node' });
    }
    for (const q of this.guidePoints(this.design.walls, analysis.idx)) points.push({ p: q, kind: 'guide' });
    let best = null;
    let bestD = tol;
    for (const c of points) {
      const d = dist(c.p, raw);
      if (d < bestD) {
        best = c;
        bestD = d;
      }
    }
    if (best) return { p: { x: best.p.x, y: best.p.y }, kind: best.kind };

    if (from && !free) {
      const v = sub(raw, from);
      const ang = Math.atan2(v.y, v.x);
      const snapped = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
      if (Math.abs(ang - snapped) < ANGLE_SNAP && Math.hypot(v.x, v.y) > tol) {
        const dir = { x: Math.round(Math.cos(snapped) * 1e9) / 1e9, y: Math.round(Math.sin(snapped) * 1e9) / 1e9 };
        const along = dot(v, dir);
        let hit = null;
        let bestDelta = tol;
        for (const f of faces) {
          const x = segmentIntersection(from, add(from, dir), f.P, f.Q);
          if (!x || x.t <= 0.5 || x.u < -1e-6 || x.u > 1 + 1e-6) continue;
          if (Math.abs(x.t - along) < bestDelta) {
            bestDelta = Math.abs(x.t - along);
            hit = { t: x.t, kind: 'wall' };
          }
        }
        for (const g of guides) {
          if (Math.abs(dir[g.axis]) < 1e-9) continue;
          const t = (g.v - from[g.axis]) / dir[g.axis];
          if (t > 0.5 && Math.abs(t - along) < bestDelta) {
            bestDelta = Math.abs(t - along);
            hit = { t, kind: 'guide' };
          }
        }
        return { p: add(from, scale(dir, hit ? hit.t : Math.round(along / fine) * fine)), kind: hit?.kind ?? 'angle' };
      }
    }
    let onLine = null;
    bestD = tol;
    for (const f of faces) {
      const c = closestPointOnSegment(raw, f.P, f.Q);
      if (c.dist < bestD) {
        bestD = c.dist;
        onLine = { p: c.point, kind: 'wall' };
      }
    }
    for (const g of guides) {
      const d = Math.abs(raw[g.axis] - g.v);
      if (d < bestD) {
        bestD = d;
        onLine = { p: { ...raw, [g.axis]: g.v }, kind: 'guide' };
      }
    }
    return onLine ?? { p: round(raw), kind: 'free' };
  }

  /** A pinned wall face measurement: its corners, the room side to draw on, and what it is. */
  faceMeasure(f) {
    return { kind: 'face', a: f.P, b: f.Q, side: perp(f.dir), exterior: f.kind === 'exterior', where: f.where };
  }

  addMeasure(m) {
    const last = this.measures.at(-1);
    const repeat = last && last.kind === m.kind && dist(last.a, m.a) < 0.5 && dist(last.b, m.b) < 0.5;
    if (dist(m.a, m.b) > 1 && !repeat) this.measures.push(m);
    this.measuring = null;
    this.app.inspector.render();
    this.render();
  }

  removeMeasure(i) {
    this.measures.splice(i, 1);
    this.app.inspector.render();
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
    if (!g && fallback) g = analysis.rooms.find((x) => x.room?.leveling?.readings?.length && !x.dead) ?? analysis.rooms.find((x) => !x.dead);
    return g?.room && !g.dead ? g : null; // dead space is never surveyed
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
   * Walls, openings and guides inside a selection box. Dragging left→right
   * selects items fully inside ("window"); right→left selects anything
   * touched ("crossing").
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
    if (this.furnitureVisible()) {
      for (const f of d.furniture) {
        const outline = footprint(resolveItem(f)).outline;
        const hit = crossing
          ? outline.some((p, i) => segmentTouchesBox(p, outline[(i + 1) % outline.length], box)) || pointInPoly({ x: box.minX, y: box.minY }, outline)
          : outline.every((p) => inBox(p, box));
        if (hit) items.push({ type: 'furniture', id: f.id });
      }
    }
    // Guides are endless lines, so in either direction a box picks the ones it crosses.
    for (const id of this.rulers.inBox(box)) items.push({ type: 'guide', id });
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
    // The Layout tool picks furniture first; otherwise walls and openings win where they overlap it.
    const furniture = this.furnitureVisible() ? this.furnitureAt(p) : null;
    if (furniture && this.tool === 'layout') return furniture;
    for (const o of d.openings) {
      const g = openingGeometry(d, o, idx);
      if (g && closestPointOnSegment(p, g.start, g.end).dist < g.wall.thickness / 2 + tol) return { type: 'opening', id: o.id };
    }
    for (const nd of d.nodes) if (dist(nd, p) < this.px(8)) return { type: 'node', id: nd.id };
    for (const w of d.walls) {
      const c = closestPointOnSegment(p, idx.nodes.get(w.a), idx.nodes.get(w.b));
      if (c.dist < w.thickness / 2 + tol) return { type: 'wall', id: w.id };
    }
    if (furniture) return furniture;
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
    const scr = this.canvas.toWorld(e);
    const raw = { x: scr.x, y: scr.y };
    this.svg.setPointerCapture(e.pointerId);
    if (this.rulers.pointerDown(e, scr)) return;
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
        const style = type === 'door' ? { style: this.newDoorStyle } : {};
        created = addOpening(d, target.wallId, type, target.offset, { width: target.width, sill: target.sill, height: target.height, ...style });
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

    if (this.tool === 'measure') {
      const s = this.measureSnap(raw, this.measuring?.a, e.shiftKey);
      if (this.measuring) {
        // Second click of a click, click measure.
        this.addMeasure({ kind: 'line', a: this.measuring.a, b: s.p });
        return;
      }
      const face = faceAtPoint(this.measureFaces(analyze(this.design)), raw, this.px(16));
      this.measuring = { a: s.p, b: s.p, face, sx: e.clientX, sy: e.clientY, pressed: true, moved: false };
      this.measureHover = null;
      this.cursor = s;
      this.render();
      return;
    }

    if (this.tool === 'layout' && this.placing) {
      // Click places the item where its preview is; Shift+click places it and keeps placing.
      this.updateGhost(raw, e);
      const ghost = this.placing.ghost;
      let created = null;
      this.app.change(`Add ${FURNITURE[ghost.type].name.toLowerCase()}`, (d) => {
        created = { ...structuredClone(ghost), id: uid('u') };
        d.furniture.push(created);
      });
      if (!e.shiftKey) {
        this.placing = null;
        if (created) this.app.select({ type: 'furniture', id: created.id });
      }
      this.app.inspector.render();
      this.render();
      return;
    }

    // Select tool (and the Layout tool between placements)
    const hit = this.hitTest(raw);
    // Over empty floor or a room, a guide under the mouse wins (Shift+drag pulls a copy off it).
    if ((!hit || hit.type === 'room') && this.rulers.grab(e, scr)) return;
    // Shift+click adds or removes. Shift held from the press on a selected wall or corner locks its
    // move instead; letting go without moving still removes it from the selection.
    const movable = !!hit && (hit.type === 'wall' || hit.type === 'node' || hit.type === 'furniture');
    const shiftDrag = e.shiftKey && movable && this.app.isSelected(hit.type, hit.id);
    if (e.shiftKey && hit && !shiftDrag) {
      this.app.toggleSelect(hit);
      return;
    }
    if (this.showFlooring && (!hit || hit.type === 'room')) {
      // Flooring on: dragging a floored room moves its run's pattern; a click still selects.
      const analysis = analyze(this.design);
      const run = runAtPoint(this.design, raw, analysis, this.floorLayer) ?? runAtPoint(this.design, raw, analysis);
      if (run) {
        this.floorLayer = runLayer(run);
        this.drag = { type: 'floor', runId: run.id, start: raw, origin: { ...resolveRun(run, this.units).origin }, hit, sx: e.clientX, sy: e.clientY, moved: false };
        return;
      }
    }
    if (!hit || hit.type === 'room') {
      // Box selection; a plain click (no drag) selects the room or clears.
      this.drag = { type: 'marquee', start: raw, end: raw, sx: e.clientX, sy: e.clientY, hit, additive: e.shiftKey, moved: false };
      return;
    }
    // Pressing on a wall, corner or piece of furniture that is part of a multiple selection moves the whole selection.
    if (movable && this.app.selectedItems().length > 1 && this.app.isSelected(hit.type, hit.id)) {
      const ids = this.selectionNodes();
      const furn = this.selectedFurniture();
      if (ids.length || furn.length) {
        const nodes = this.design.nodes.filter((nd) => ids.includes(nd.id));
        // The moving corner nearest the press point is the one that snaps (furniture moves on the grid).
        const anchor = hit.type === 'furniture' || !nodes.length ? null : nodes.reduce((best, nd) => (dist(nd, raw) < dist(best, raw) ? nd : best));
        const pressed = hit.type === 'furniture' ? furn.find((f) => f.id === hit.id) : null;
        this.drag = {
          type: 'group', ids, anchor: anchor?.id ?? null, anchorPt: anchor ? { x: anchor.x, y: anchor.y } : pressed ? { x: pressed.x, y: pressed.y } : { ...raw },
          start: raw, moved: false, hit, toggleOnClick: shiftDrag,
          orig: Object.fromEntries(nodes.map((nd) => [nd.id, { x: nd.x, y: nd.y }])),
          furn: Object.fromEntries(furn.map((f) => [f.id, { x: f.x, y: f.y }])),
        };
        return;
      }
    }
    this.app.select(hit);
    const d = this.design;
    if (hit.type === 'node') {
      const nd = d.nodes.find((x) => x.id === hit.id);
      this.drag = { type: 'node', id: hit.id, start: raw, orig: { x: nd.x, y: nd.y }, moved: false, hit, toggleOnClick: shiftDrag };
    } else if (hit.type === 'wall') {
      const w = d.walls.find((x) => x.id === hit.id);
      const idx = indexDesign(d);
      const A = idx.nodes.get(w.a);
      const B = idx.nodes.get(w.b);
      this.drag = {
        type: 'wall', id: w.id, start: raw, moved: false, hit, toggleOnClick: shiftDrag,
        normal: perp(norm(sub(B, A))),
        orig: { [A.id]: { x: A.x, y: A.y }, [B.id]: { x: B.x, y: B.y } },
      };
    } else if (hit.type === 'opening') {
      this.drag = { type: 'opening', id: hit.id, start: raw, moved: false };
    } else if (hit.type === 'furniture') {
      const f = d.furniture.find((x) => x.id === hit.id);
      this.drag = { type: 'furniture', id: f.id, start: raw, orig: { x: f.x, y: f.y }, moved: false, hit, toggleOnClick: shiftDrag };
    }
  }

  // -------------------------------------------------------------------------
  // Layout planning

  /** Furniture is drawn (and can be picked) when its layer is on, and always with the Layout tool. */
  furnitureVisible() {
    return this.showFurniture || this.tool === 'layout';
  }

  selectedFurniture() {
    const ids = new Set(this.app.selectedItems().filter((i) => i.type === 'furniture').map((i) => i.id));
    return this.design.furniture.filter((f) => ids.has(f.id));
  }

  /** The topmost item under p: overhead, then counter, floor and rugs (the reverse of the drawing order). */
  furnitureAt(p) {
    const rank = (r) => (r.mount === 'overhead' ? 0 : r.mount === 'counter' ? 1 : r.mount === 'rug' ? 4 : r.tuck ? 2 : 3);
    const hits = this.design.furniture.map((f) => resolveItem(f)).filter((r) => pointInPoly(p, footprint(r).outline));
    hits.sort((a, b) => rank(a) - rank(b) || a.w * a.d - b.w * b.d);
    return hits.length ? { type: 'furniture', id: hits[0].item.id } : null;
  }

  /** Starts placing a catalog item (size id optional) with the Layout tool. */
  startPlacing(type, size) {
    if (this.tool !== 'layout') this.setTool('layout');
    const angle = this.placing?.angle ?? 0;
    const ghost = createFurniture(type, this.cursor?.p ?? { x: 0, y: 0 }, { size, angle });
    this.placing = { type, size: ghost.size, angle, ghost, guides: [], shown: !!this.cursor?.p };
    this.app.select(null);
    this.app.inspector.render();
    this.render();
  }

  updateGhost(raw, e) {
    const pl = this.placing;
    pl.ghost.angle = pl.angle;
    const placed = this.placeFurniture(pl.ghost, raw, e);
    Object.assign(pl.ghost, { x: placed.x, y: placed.y, angle: placed.angle });
    pl.guides = placed.guides;
    pl.shown = true;
  }

  /**
   * Where an item dragged (or previewed) to `target` lands: wall pieces sit
   * flush on the nearest wall face, facing the room; anything else keeps its
   * angle and lines up with walls and other items, else the grid. Shift
   * (axis) locks the move; Alt or Snap off only rounds to 1/16" or 1 mm.
   */
  placeFurniture(item, target, e, axis = null, from = null) {
    const keep = (p) => {
      if (axis && from) p[axis === 'x' ? 'y' : 'x'] = from[axis === 'x' ? 'y' : 'x'];
      return p;
    };
    if (e.altKey || !this.canvas.snapOn) {
      const f = this.canvas.fine;
      return { ...keep({ x: Math.round(target.x / f) * f, y: Math.round(target.y / f) * f }), angle: item.angle, guides: [] };
    }
    const analysis = analyze(this.design);
    if (!axis && FURNITURE[item.type]?.wall) {
      const wp = wallPlacement(this.design, analysis, item, target, { reach: Math.max(this.px(28), 150), tol: this.px(8) });
      if (wp) return wp;
    }
    const ap = alignPlacement(this.design, analysis, item, target, { tol: this.px(8) });
    const step = this.snapStep();
    if (ap.x === target.x) ap.x = Math.round(target.x / step) * step;
    if (ap.y === target.y) ap.y = Math.round(target.y / step) * step;
    return { ...keep({ x: ap.x, y: ap.y }), angle: item.angle, guides: ap.guides };
  }

  /** Layout checks, memoised on the plan and the furniture (the plan re-renders on every mouse move). */
  layoutAnalysis(analysis) {
    const d = this.design;
    const key = JSON.stringify([d.nodes, d.walls, d.openings, d.rooms.map((r) => [r.id, r.name, r.dead]), d.furniture, d.units]);
    if (this.layoutCache?.key !== key) this.layoutCache = { key, layout: analyzeLayout(d, analysis) };
    return this.layoutCache.layout;
  }

  /** Layout keys: Esc stops placing, Q / E rotate, Ctrl+D duplicates, arrows nudge the selected furniture. */
  onLayoutKey(e) {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    const selected = this.selectedFurniture();
    if (this.placing && e.key === 'Escape') {
      this.placing = null;
      this.app.inspector.render();
      this.render();
      return true;
    }
    if (!mod && !e.altKey && (key === 'q' || key === 'e') && (this.placing || selected.length)) {
      const step = (e.shiftKey ? 15 : 90) * (key === 'q' ? -1 : 1);
      if (this.placing) {
        this.placing.angle = wrapAngle(this.placing.angle + step);
        this.placing.ghost.angle = this.placing.angle;
        this.render();
      } else {
        const ids = new Set(selected.map((f) => f.id));
        this.app.change('Rotate furniture', (d) => d.furniture.filter((f) => ids.has(f.id)).forEach((f) => { f.angle = wrapAngle(f.angle + step); }));
      }
      return true;
    }
    if (mod && !e.altKey && key === 'd' && selected.length) {
      let copies = [];
      this.app.change(selected.length > 1 ? 'Duplicate furniture' : `Duplicate ${resolveItem(selected[0]).name.toLowerCase()}`, (d) => {
        copies = selected.map((f) => duplicateFurniture(d, f.id)).filter(Boolean);
      });
      this.app.selectMany(copies.map((c) => ({ type: 'furniture', id: c.id })));
      return true;
    }
    if (!mod && !e.altKey && e.key.startsWith('Arrow') && selected.length && !this.draw) {
      const fine = this.units === 'metric' ? 10 : MM_PER_IN;
      const step = fine * (e.shiftKey ? (this.units === 'metric' ? 10 : 12) : 1);
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      const ids = new Set(selected.map((f) => f.id));
      this.app.change('Nudge furniture', (d) => d.furniture.filter((f) => ids.has(f.id)).forEach((f) => {
        f.x += dx;
        f.y += dy;
      }));
      return true;
    }
    return false;
  }

  /** Shift locks a move to horizontal or vertical: whichever way it has gone further from where it started. */
  lockAxis(delta, e) {
    if (!e.shiftKey) return { delta, axis: null };
    const axis = Math.abs(delta.x) >= Math.abs(delta.y) ? 'x' : 'y';
    return { delta: axis === 'x' ? { x: delta.x, y: 0 } : { x: 0, y: delta.y }, axis };
  }

  /**
   * Where a moved point lands, from where it started (`from`) and where the
   * drag puts it (`target`). Unlocked, it snaps like any point; locked to an
   * axis it only slides along it, snapping to corners and guides in line
   * (else the grid), with the lock drawn as a guide line. Alt, or Snap off,
   * only rounds to 1/16" or 1 mm. Returns a cursor { p, kind, guides }.
   */
  moveSnap(target, from, axis, excludeNodes, e) {
    const start = { x: from.x, y: from.y };
    const other = axis === 'x' ? 'y' : 'x';
    if (e.altKey || !this.canvas.snapOn) {
      const f = this.canvas.fine;
      const p = { x: Math.round(target.x / f) * f, y: Math.round(target.y / f) * f };
      if (axis) p[other] = start[other];
      return { p, kind: 'free', guides: axis ? [{ a: start, b: p }] : [] };
    }
    if (!axis) return this.snap(target, { excludeNodes, free: true });
    const exclude = new Set(excludeNodes);
    const targets = [
      ...this.design.nodes.filter((nd) => !exclude.has(nd.id)).map((nd) => ({ v: nd[axis], label: 'corner', from: nd })),
      ...this.design.guides.filter((g) => g.axis === axis).map((g) => ({ v: g.v, label: 'guide' })),
    ];
    const s = this.canvas.snapValue(target[axis], targets);
    const p = { ...start, [axis]: s.v };
    const guides = [{ a: start, b: p }];
    if (s.from) guides.push({ a: s.from, b: p });
    return { p, kind: s.label === 'guide' ? 'guide' : s.label ? 'aligned' : 'grid', guides };
  }

  /** Corners moved by dragging the selection: those of selected walls and rooms, and selected corners. */
  selectionNodes() {
    const d = this.design;
    const items = this.app.selectedItems();
    const wallIds = new Set(items.filter((i) => i.type === 'wall').map((i) => i.id));
    const roomIds = new Set(items.filter((i) => i.type === 'room').map((i) => i.id));
    if (roomIds.size) {
      for (const g of analyze(d).rooms) if (roomIds.has(g.room?.id)) [...g.wallIds, ...g.spurWallIds].forEach((id) => wallIds.add(id));
    }
    const ids = new Set(items.filter((i) => i.type === 'node').map((i) => i.id));
    for (const w of d.walls) {
      if (!wallIds.has(w.id)) continue;
      ids.add(w.a);
      ids.add(w.b);
    }
    return [...ids];
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
    const scr = this.canvas.toWorld(e);
    const raw = { x: scr.x, y: scr.y };
    const dr = this.drag;
    if (this.canvas.movePan(e)) return;
    if (this.rulers.pointerMove(e, scr, !!dr)) return;
    if (dr?.type === 'marquee') {
      if (Math.hypot(e.clientX - dr.sx, e.clientY - dr.sy) > 4) dr.moved = true;
      dr.end = raw;
      this.marqueeHits = dr.moved ? this.itemsInBox(dr.start, dr.end) : null;
      this.render();
      return;
    }
    if (dr?.type === 'floor') {
      if (!dr.moved && Math.hypot(e.clientX - dr.sx, e.clientY - dr.sy) < 4) return;
      if (!dr.moved) {
        dr.moved = true;
        if (dr.hit?.type === 'room') this.app.select(dr.hit);
        this.app.beginLive();
      }
      const run = this.design.floorRuns.find((r) => r.id === dr.runId);
      // Shift locks the pattern's move to horizontal or vertical; Alt moves it without snapping.
      const { delta, axis } = this.lockAxis(sub(raw, dr.start), e);
      let origin = add(dr.origin, delta);
      this.floorSnap = null;
      if (this.canvas.snapOn && !e.altKey) {
        const snapped = snapOrigin(this.floorLayout(run, analyze(this.design)), origin, this.px(8));
        origin = snapped.origin;
        if (axis) origin[axis === 'x' ? 'y' : 'x'] = dr.origin[axis === 'x' ? 'y' : 'x'];
        this.floorSnap = snapped.targets;
      }
      run.origin = { x: Math.round(origin.x * 10) / 10, y: Math.round(origin.y * 10) / 10 };
      this.cursor = { p: raw };
      this.app.live();
      this.scheduleInspector();
      return;
    }
    if (dr && (dr.type === 'node' || dr.type === 'wall' || dr.type === 'opening' || dr.type === 'group' || dr.type === 'furniture')) {
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
    } else if (this.tool === 'measure') {
      const m = this.measuring;
      this.hover = null;
      if (m?.pressed && Math.hypot(e.clientX - m.sx, e.clientY - m.sy) > 4) m.moved = true;
      this.cursor = this.measureSnap(raw, m?.a, e.shiftKey);
      if (m) m.b = this.cursor.p;
      this.measureHover = m ? null : faceAtPoint(this.measureFaces(analyze(this.design)), raw, this.px(16));
    } else if (this.tool === 'layout' && this.placing) {
      this.hover = null;
      this.updateGhost(raw, e);
      this.cursor = { p: raw, guides: this.placing.guides };
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
      const grab = this.tool === 'select' && this.showFlooring && (!hit || hit.type === 'room') && !!runAtPoint(this.design, raw);
      this.svg.classList.toggle('floor-grab', grab);
    }
    this.app.emit('cursor', this.cursor?.p);
    this.render();
  }

  dragUpdate(dr, raw, e) {
    const d = this.design;
    const idx = indexDesign(d);
    if (dr.type === 'group') {
      // Everything moves by one offset: where the anchor corner lands (furniture alone moves on the grid).
      const from = dr.anchorPt;
      const { delta, axis } = this.lockAxis(sub(raw, dr.start), e);
      let s;
      if (dr.anchor) {
        s = this.moveSnap(add(from, delta), from, axis, dr.ids, e);
      } else {
        const step = e.altKey || !this.canvas.snapOn ? this.canvas.fine : this.snapStep();
        const p = { x: from.x + Math.round(delta.x / step) * step, y: from.y + Math.round(delta.y / step) * step };
        s = { p, kind: 'grid', guides: axis ? [{ a: from, b: p }] : [] };
      }
      this.cursor = s;
      const k = sub(s.p, from);
      for (const id of dr.ids) {
        const nd = idx.nodes.get(id);
        nd.x = dr.orig[id].x + k.x;
        nd.y = dr.orig[id].y + k.y;
      }
      for (const [id, o] of Object.entries(dr.furn ?? {})) {
        const f = d.furniture.find((x) => x.id === id);
        if (!f) continue;
        f.x = o.x + k.x;
        f.y = o.y + k.y;
      }
    } else if (dr.type === 'node') {
      const node = idx.nodes.get(dr.id);
      const { delta, axis } = this.lockAxis(sub(raw, dr.start), e);
      const s = this.moveSnap(add(dr.orig, delta), dr.orig, axis, [dr.id], e);
      node.x = s.p.x;
      node.y = s.p.y;
      this.cursor = s;
    } else if (dr.type === 'wall') {
      // A wall already slides only at right angles to itself; Alt frees it from the grid.
      const step = this.snapStep();
      let k = dot(sub(raw, dr.start), dr.normal);
      if (!e.altKey) k = Math.round(k / step) * step;
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
      if (!e.altKey) offset = Math.round(offset / fine) * fine;
      if (this.canvas.snapOn && Math.abs(offset - g.length / 2) < this.px(8)) offset = g.length / 2;
      // Slide up against neighbours rather than overlapping them.
      o.offset = freeOpeningOffset(d, o, offset, g.length) ?? o.offset;
    } else if (dr.type === 'furniture') {
      const f = d.furniture.find((x) => x.id === dr.id);
      const { delta, axis } = this.lockAxis(sub(raw, dr.start), e);
      const placed = this.placeFurniture(f, add(dr.orig, delta), e, axis, dr.orig);
      Object.assign(f, { x: placed.x, y: placed.y, angle: placed.angle ?? f.angle });
      this.cursor = { p: raw, guides: placed.guides };
    }
  }

  onPointerUp(e) {
    const dr = this.drag;
    this.drag = null;
    if (this.svg.hasPointerCapture(e.pointerId)) this.svg.releasePointerCapture(e.pointerId);
    if (this.canvas.endPan()) return;
    if (this.rulers.pointerUp()) return;
    const m = this.tool === 'measure' ? this.measuring : null;
    if (m?.pressed) {
      // A drag measures point to point; a click on a wall face pins its length;
      // any other click starts a click, click measure.
      m.pressed = false;
      if (m.moved) this.addMeasure({ kind: 'line', a: m.a, b: m.b });
      else if (m.face) this.addMeasure(this.faceMeasure(m.face));
      this.render();
      return;
    }
    if (dr?.type === 'floor') {
      this.floorSnap = null;
      if (dr.moved) this.app.endLive('Move flooring layout');
      else this.app.select(dr.hit?.type === 'room' ? dr.hit : null);
      this.render();
      return;
    }
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
      this.app.endLive({ opening: 'Move opening', wall: 'Move wall', group: 'Move selection', furniture: 'Move furniture' }[dr.type] ?? 'Move corner');
      return;
    }
    if (dr?.toggleOnClick) {
      this.app.toggleSelect(dr.hit);
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
    // Ruler guides: a typed distance + Enter while dragging one, or straight after placing it.
    if (this.rulers.key(e)) return true;
    if (this.tool === 'level' && this.onLevelKey(e)) return true;
    if (this.onLayoutKey(e)) return true;
    if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'f' && !this.typed) {
      this.setFlooring(!this.showFlooring);
      return true;
    }
    if (this.showFlooring && !this.draw && !e.ctrlKey && !e.metaKey && e.key.startsWith('Arrow') && this.nudgeFloor(e)) return true;
    if (!e.ctrlKey && !e.metaKey && !e.altKey && !this.typed && (e.key === 's' || e.key === 'g' || e.key === 'S' || e.key === 'G')) {
      this.canvas.toggle(e.key.toLowerCase() === 's' ? 'snapOn' : 'gridOn');
      return true;
    }
    if (this.tool === 'measure' && !e.ctrlKey && !e.metaKey) {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (this.measuring) this.measuring = null;
        else if (this.measures.length) this.removeMeasure(this.measures.length - 1);
        this.render();
        return true; // never deletes the selection from here
      }
      if (e.key === 'Escape' && (this.measuring || this.measures.length)) {
        if (this.measuring) this.measuring = null;
        else this.measures = [];
        this.app.inspector.render();
        this.render();
        return true;
      }
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
    this.svg.classList.toggle('placing', !!this.placing);
    this.gridLayer.innerHTML = this.canvas.gridSvg();
    this.renderBar();
    const analysis = analyze(this.design);
    const level = this.tool === 'level' ? this.renderLevel(analysis) : null;
    const floor = this.showFlooring && !level ? this.renderFlooring(analysis) : null;
    const layout = this.currentLayout(analysis, level);
    this.worldLayer.innerHTML = [
      this.renderRooms(analysis),
      floor?.under,
      level?.heat,
      layout ? this.renderFurniture(layout, 'rug') : '',
      layout ? this.renderClearances(layout) : '',
      this.renderWalls(analysis),
      floor?.doorways,
      this.renderOpenings(analysis, floor?.openings),
      this.renderFaceTrim(analysis),
      layout ? this.renderFurniture(layout) : '',
      this.renderDimensions(analysis),
      level ? '' : this.renderRoomLabels(analysis),
      level?.survey,
      floor?.marks,
      this.renderSelection(analysis),
      layout ? this.renderLayoutMarks(layout) : '',
      this.renderMeasures(),
      this.renderPreview(analysis),
    ].join('');
    const cur = this.cursor?.p;
    const legend = floor?.layout ? renderFloorLegend(floor.layout, this.units, this.drag?.type === 'floor' && this.drag.moved, this.canvas.rect().height) : '';
    this.overlayLayer.innerHTML = this.canvas.rulerGuidesSvg() + this.renderOverlay(level) + legend + this.canvas.rulersSvg({ cursor: cur && { x: cur.x, y: cur.y } });
    this.updatePalette(level);
  }

  /**
   * The layout to draw, or null when furniture is hidden (or the Level tool
   * is on). While placing, the preview is checked as if it were placed.
   */
  currentLayout(analysis, level) {
    const d = this.design;
    const ghost = this.placing?.shown && this.cursor ? this.placing.ghost : null;
    this.lastGhostIssue = null;
    if (level || !this.furnitureVisible() || (!d.furniture.length && !ghost)) return null;
    if (!ghost) return this.layoutAnalysis(analysis);
    const layout = analyzeLayout({ ...d, furniture: [...d.furniture, ghost] }, analysis);
    layout.ghostId = ghost.id;
    this.lastGhostIssue = layout.items.find((x) => x.r.item.id === ghost.id)?.issues[0]?.message ?? null;
    return layout;
  }

  /** Is this layout item the focus: selected, being dragged or the placing preview? */
  furnitureFocus(layout, id) {
    return id === layout.ghostId || this.app.isSelected('furniture', id) || (this.drag?.type === 'furniture' && this.drag.id === id);
  }

  /**
   * Furniture symbols: rugs (layer 'rug') under the walls, the rest above
   * them; chairs under tables, then floor pieces, counter pieces and
   * overhead units (dashed). Items with problems are outlined red (errors)
   * or amber (warnings).
   */
  renderFurniture(layout, layer = 'main') {
    const sw = this.px(1);
    const rank = (r) => (r.mount === 'rug' ? 0 : r.tuck ? 1 : r.mount === 'floor' ? 2 : r.mount === 'counter' ? 3 : 4);
    const items = layout.items.filter((x) => (layer === 'rug') === (x.r.mount === 'rug')).sort((a, b) => rank(a.r) - rank(b.r));
    const out = [];
    for (const x of items) {
      const id = x.r.item.id;
      const state = x.issues.some((i) => i.severity === 'error') ? ' error' : x.issues.length ? ' warn' : '';
      const active = this.isActive('furniture', id) ? ' active' : '';
      const hover = this.hover?.type === 'furniture' && this.hover.id === id ? ' hover' : '';
      const ghost = id === layout.ghostId ? ' ghost' : '';
      out.push(furnitureGroup(x.r, sw, `fu fu-${x.r.mount} fu-${x.r.def.category}${state}${active}${hover}${ghost}`));
      const min = Math.min(x.r.w, x.r.d);
      const text = applianceTag(x.r);
      if (text && min > this.px(20)) out.push(this.label(x.r.c, text, uprightAngle(x.r.ux), 'fu-tag', 9));
      else if (this.tool === 'layout' && min > this.px(54) && x.r.mount !== 'rug') {
        out.push(this.label(toWorld(x.r, 0, x.r.d * 0.12), x.r.name, uprightAngle(x.r.ux), 'fu-name', 10));
      }
    }
    return out.join('');
  }

  /**
   * Clear floor each piece needs (bed sides, in front of cabinets and
   * appliances, around tables...): every piece's with the Layout tool
   * ('all'), otherwise the selected one's. Zones short of what they need
   * are red.
   */
  renderClearances(layout) {
    const all = this.tool === 'layout' && this.showClearances === 'all';
    const out = [];
    for (const x of layout.items) {
      const focus = this.furnitureFocus(layout, x.r.item.id);
      if (!x.zones.length || (!all && !focus)) continue;
      const short = (side) => {
        const s = x.sides[side];
        return !!s && s.need > 0 && s.have < s.need - MM_PER_IN / 2;
      };
      for (const z of x.zones) {
        let bad = short(z.side);
        // Twin beds and bunks only need one side clear.
        if (bad && x.r.oneSide && (z.side === 'left' || z.side === 'right')) bad = short(z.side === 'left' ? 'right' : 'left');
        out.push(tag('polygon', { class: `clear-zone${bad ? ' short' : ''}${focus ? ' focus' : ''}`, points: pts(z.poly), 'stroke-width': this.px(1) }, null));
      }
    }
    return out.join('');
  }

  /**
   * On top of the plan: the clear distance from each side of the focused
   * piece to the nearest wall or piece (out to 10'), red where it is less
   * than the piece needs; and with the Layout tool, the kitchen work
   * triangle and TV viewing distances.
   */
  renderLayoutMarks(layout) {
    const out = [];
    const fmt = (v) => formatLength(v, this.units, { precision: 'label' });
    const focus = layout.items.filter((x) => this.furnitureFocus(layout, x.r.item.id));
    if (focus.length === 1) {
      const x = focus[0];
      const { r } = x;
      for (const [side, s] of Object.entries(x.sides)) {
        if (!s.at || s.have < 1) continue;
        const l = toLocal(r, s.at);
        const from = side === 'front' ? toWorld(r, l.x, r.d / 2) : side === 'back' ? toWorld(r, l.x, -r.d / 2) : side === 'left' ? toWorld(r, -r.w / 2, l.y) : toWorld(r, r.w / 2, l.y);
        const bad = s.need > 0 && s.have < s.need - MM_PER_IN / 2;
        out.push(this.dimensionLine(from, s.at, fmt(s.have), `fu-gap${bad ? ' short' : ''}`));
      }
    }
    if (this.tool === 'layout') {
      for (const t of layout.triangles) {
        out.push(tag('polygon', { class: `work-triangle${t.ok ? ' ok' : ' bad'}`, points: pts(t.points), 'stroke-width': this.px(1.5), 'stroke-dasharray': `${n(this.px(6))} ${n(this.px(4))}` }, null));
        t.points.forEach((p, i) => {
          const q = t.points[(i + 1) % 3];
          const leg = t.legs[i];
          const bad = leg.len < 48 * MM_PER_IN || leg.len > 108 * MM_PER_IN;
          out.push(this.label(scale(add(p, q), 0.5), fmt(leg.len), 0, `work-leg${bad ? ' bad' : ''}`, 10));
        });
      }
      const idx = new Map(layout.items.map((x) => [x.r.item.id, x]));
      for (const v of layout.tvs) {
        const tv = idx.get(v.tvId)?.r;
        const seat = idx.get(v.seatId)?.r;
        if (!tv || !seat) continue;
        const a = toWorld(tv, 0, tv.d / 2);
        out.push(tag('line', { class: `tv-line${v.ok ? ' ok' : ' bad'}`, x1: a.x, y1: a.y, x2: seat.c.x, y2: seat.c.y, 'stroke-width': this.px(1), 'stroke-dasharray': `${n(this.px(2))} ${n(this.px(3))}` }, null));
        out.push(this.label(scale(add(a, seat.c), 0.5), `${fmt(v.distance)} to the screen`, uprightAngle(sub(seat.c, a)), `tv-text${v.ok ? '' : ' bad'}`, 10));
      }
    }
    return out.join('');
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
    // Dead space is hatched, at a constant spacing on screen.
    const k = this.px(9);
    const hatch = analysis.rooms.some((g) => g.dead)
      ? `<defs><pattern id="dead-hatch" patternUnits="userSpaceOnUse" width="${n(k)}" height="${n(k)}" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="${n(k)}" class="dead-hatch" stroke-width="${n(this.px(1))}"/></pattern></defs>`
      : '';
    return hatch + analysis.rooms
      .map((g) => {
        const id = g.room?.id;
        const cls = ['room', g.dead && 'dead', id && this.app.isSelected('room', id) && 'selected', hov?.type === 'room' && hov.id === id && 'hover'].filter(Boolean).join(' ');
        if (g.dead) return tag('polygon', { class: cls, points: pts(g.polygon) }) + tag('polygon', { class: 'dead-fill', points: pts(g.polygon) }, null);
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
    const outlines = wallOutlines(d, analysis.idx);
    const out = [];
    for (const w of d.walls) {
      const poly = outlines.get(w.id);
      const info = analysis.wallInfo.get(w.id);
      const cls = ['wall', info?.exterior && 'exterior', this.isActive('wall', w.id) && 'selected', this.hover?.type === 'wall' && this.hover.id === w.id && 'hover']
        .filter(Boolean).join(' ');
      out.push(tag('polygon', { class: cls, points: pts(poly) }, null));
    }
    return `<g class="walls">${out.join('')}</g>`;
  }

  /** `floored`: ids of openings a flooring run is drawn through (their cut is left open to show it). */
  renderOpenings(analysis, floored = null) {
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
      let body = tag('polygon', { class: floored?.has(o.id) ? 'cut floored' : 'cut', points: pts(cut) }, null);
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
        body += this.doorSymbol(o, g, sw);
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
   * Plan symbol for each door style: a leaf and swing arc (two half-width
   * leaves for a pair), two overlapping bypass panels in the wall, a slab
   * half drawn into its dashed pocket, or a barn slab hung open on the face
   * beside the opening with its track. Sliding doors open toward the hinge
   * side (flipX); swings and barn doors are on the flipY side of the wall.
   */
  doorSymbol(o, g, sw) {
    const T = g.wall.thickness;
    const nn = g.normal;
    const side = o.flipY ? -1 : 1;
    const style = doorStyle(o);
    const face = scale(nn, (side * T) / 2);
    const swing = (H, width, J) => {
      const leaf = add(H, scale(nn, side * width));
      const sweep = crossZ(sub(leaf, H), sub(J, H)) > 0 ? 1 : 0;
      return tag('line', { class: 'leaf', x1: H.x, y1: H.y, x2: leaf.x, y2: leaf.y, 'stroke-width': this.px(2) }, null) +
        tag('path', { class: 'swing', d: `M${n(leaf.x)} ${n(leaf.y)}A${n(width)} ${n(width)} 0 0 ${sweep} ${n(J.x)} ${n(J.y)}`, 'stroke-width': sw }, null);
    };
    if (style === 'single') {
      const hinge = o.flipX ? g.end : g.start;
      const other = o.flipX ? g.start : g.end;
      return swing(add(hinge, face), o.width, add(other, face));
    }
    if (style === 'double') {
      const mid = add(g.center, face);
      return swing(add(g.start, face), o.width / 2, mid) + swing(add(g.end, face), o.width / 2, mid);
    }
    // Sliding styles: panels as thin boxes from s0 to s1 along the wall (from the opening's start), k off the centreline.
    const panel = (s0, s1, k, thick, cls, dash) => {
      const a = add(add(g.start, scale(g.dir, s0)), scale(nn, k));
      const b = add(add(g.start, scale(g.dir, s1)), scale(nn, k));
      const hh = scale(nn, thick / 2);
      return tag('polygon', { class: cls, points: pts([add(a, hh), add(b, hh), sub(b, hh), sub(a, hh)]), 'stroke-width': sw, 'stroke-dasharray': dash }, null);
    };
    const thick = Math.max(Math.min(T * 0.22, 45), this.px(2.5));
    const w = o.width;
    const toStart = !o.flipX;
    if (style === 'sliding') {
      const lap = Math.min(w * 0.05, 50);
      return panel(0, w / 2 + lap, thick * 0.6, thick, 'slab') + panel(w / 2 - lap, w, -thick * 0.6, thick, 'slab');
    }
    if (style === 'pocket') {
      const dash = `${n(this.px(4))} ${n(this.px(3))}`;
      return (toStart ? panel(-w, 0, 0, thick * 1.8, 'pocket', dash) + panel(-w / 2, w / 2, 0, thick, 'slab')
        : panel(w, 2 * w, 0, thick * 1.8, 'pocket', dash) + panel(w / 2, 1.5 * w, 0, thick, 'slab'));
    }
    // Barn: the slab laps the opening by BARN_OVERLAP each side when shut; its track spans shut and open.
    const slab = w + 2 * BARN_OVERLAP;
    const k = side * (T / 2 + thick / 2 + this.px(1.5));
    const [t0, t1] = toStart ? [-slab, w + BARN_OVERLAP] : [-BARN_OVERLAP, w + slab];
    const a = add(add(g.start, scale(g.dir, t0)), scale(nn, k));
    const b = add(add(g.start, scale(g.dir, t1)), scale(nn, k));
    return tag('line', { class: 'track', x1: a.x, y1: a.y, x2: b.x, y2: b.y, 'stroke-width': sw, 'stroke-dasharray': `${n(this.px(6))} ${n(this.px(2))}` }, null) +
      panel(toStart ? -slab : w, toStart ? 0 : w + slab, k, thick, 'slab');
  }

  /**
   * Trim on the plan (unless turned off in the plan settings): baseboard (with any shoe moulding in front of it) as a
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
        if (x.category === 'shoe') return Math.max(x.size * 0.67, this.px(2.5)); // ½" deep for ¾" shoe
        if (x.part === 'leg') return Math.max(stock, this.px(4.5));
        if (x.part === 'stool' || x.part === 'sill') return Math.max(x.size, this.px(5));
        return Math.max(stock, this.px(3.5));
      };
      const bands = planTrimBands(this.design, faces, depth);
      // Crown first (it is overhead), then baseboard at the floor line, then casing, which the baseboard stops against.
      const layer = (b) => (b.category === 'crown' ? 0 : b.part === 'run' ? 1 : 2);
      for (const b of [...bands].sort((p, q) => layer(p) - layer(q))) {
        const crown = b.category === 'crown';
        const cls = crown ? 'crown' : b.part === 'run' ? (b.category === 'shoe' ? 'shoe' : 'baseboard') : b.part === 'leg' ? 'casing' : 'stool';
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

  /**
   * Wall face lengths: the interior faces of every room, plus the outside
   * of the building in 'both' mode, split either side of any openings. Walls with no face (free-standing, or
   * stubs inside a room) show the length of each side.
   */
  renderDimensions(analysis) {
    const mode = this.design.settings.dimensionMode;
    if (mode === 'off') return '';
    const out = [];
    const fmt = (v) => formatLength(v, this.units, { precision: 'label' });
    const covered = new Set();
    // A face's region is on its perp(dir) side, so labels sit just inside the room (or outside the building).
    // A face with doors, windows or openings is labelled piece by piece: the wall either side of each
    // opening, plus the opening's own width (muted), instead of the whole run.
    const faceLabel = (f, cls) => {
      const at = (s0, s1, text, c, size, minPx) => {
        if ((s1 - s0) * this.view.scale < minPx) return;
        const mid = add(f.P, scale(f.dir, (s0 + s1) / 2));
        out.push(this.label(add(mid, scale(perp(f.dir), this.px(11))), text, uprightAngle(f.dir), c, size));
      };
      const runs = faceRuns(f);
      if (!runs.openings.length) return at(0, f.length, fmt(f.length), cls, 11, 28);
      for (const w of runs.walls) at(w.s0, w.s1, fmt(w.s1 - w.s0), cls, 11, 24);
      for (const o of runs.openings) at(o.s0, o.s1, fmt(o.s1 - o.s0), `${cls} opening-width`, 9.5, 30);
    };
    for (const g of analysis.rooms) {
      for (const f of g.walls) {
        f.wallIds.forEach((id) => covered.add(id));
        faceLabel(f, g.dead ? 'dim dead' : 'dim');
      }
    }
    for (const f of analysis.exteriorFaces) {
      f.wallIds.forEach((id) => covered.add(id));
      if (mode === 'both') faceLabel(f, 'dim exterior');
    }
    const outlines = wallOutlines(this.design, analysis.idx);
    for (const w of this.design.walls) {
      if (covered.has(w.id)) continue;
      for (const [p, q, side] of outlineSides(outlines.get(w.id))) {
        const L = dist(p, q);
        if (L * this.view.scale < 28) continue;
        const mid = add(p, scale(sub(q, p), 0.5));
        out.push(this.label(add(mid, scale(side, this.px(10))), fmt(L), uprightAngle(sub(q, p)), 'dim', 11));
      }
    }
    return `<g class="dims">${out.join('')}</g>`;
  }

  /**
   * Gap dimensions from an opening (spans from wallFaceSpans) to the corners
   * of each face it sits in, drawn just off the face on its own side, plus
   * the opening's width on the first face when `width` is set.
   */
  faceGapDims(spans, cls, width = false) {
    const out = [];
    const fmt = (v) => formatLength(v, this.units, { precision: 'label' });
    spans.forEach(({ face: f, s0, s1 }, i) => {
      const off = scale(perp(f.dir), this.px(22));
      const at = (s) => add(add(f.P, scale(f.dir, s)), off);
      if (s0 > 1) out.push(this.dimensionLine(at(0), at(s0), fmt(s0), cls));
      if (f.length - s1 > 1) out.push(this.dimensionLine(at(s1), at(f.length), fmt(f.length - s1), cls));
      if (width && i === 0) out.push(this.dimensionLine(at(Math.max(0, s0)), at(Math.min(f.length, s1)), fmt(s1 - s0), `${cls} strong`));
    });
    return out.join('');
  }

  renderRoomLabels(analysis) {
    const units = this.units;
    return analysis.rooms
      .map((g) => {
        const p = g.labelPoint;
        if (g.dead) {
          return this.label({ x: p.x, y: p.y - this.px(7) }, 'Dead space', 0, 'room-name dead', 12) +
            this.label({ x: p.x, y: p.y + this.px(7) }, formatArea(g.area, units), 0, 'room-area', 10);
        }
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
        // The length of each face along the wall (interior, and exterior when there is one), not the centreline.
        const faces = facesOfWall(analysis, w.id);
        for (const f of faces) {
          const off = scale(perp(f.dir), this.px(26));
          out.push(this.dimensionLine(add(f.P, off), add(f.Q, off), formatLength(f.length, this.units), 'sel-dim'));
        }
        if (!faces.length) {
          for (const [p, q, s2] of outlineSides(wallOutlines(d, idx).get(w.id))) {
            const off = scale(s2, this.px(20));
            out.push(this.dimensionLine(add(p, off), add(q, off), formatLength(dist(p, q), this.units), 'sel-dim'));
          }
        }
        out.push(this.label(add(A, scale(side, -w.thickness / 2 - this.px(9))), 'A', 0, 'end-label', 10));
        out.push(this.label(add(B, scale(side, -w.thickness / 2 - this.px(9))), 'B', 0, 'end-label', 10));
      }
    }
    if (sel?.type === 'opening') {
      const o = d.openings.find((x) => x.id === sel.id);
      const g = o && openingGeometry(d, o, idx);
      const spans = g ? wallFaceSpans(analysis, o.wallId, o.offset, o.width) : [];
      if (spans.length) {
        // Gaps to the corners of each face the opening is in: what you measure on site.
        out.push(this.faceGapDims(spans, 'sel-dim', true));
      } else if (g) {
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

  renderPreview(analysis) {
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
      const spans = wallFaceSpans(analysis, w.id, c.opening.offset, c.opening.width);
      if (spans.length) {
        out.push(this.faceGapDims(spans, 'preview-dim'));
      } else {
        const off = scale(perp(u), -(w.thickness / 2 + this.px(18)));
        const L1 = dist(A, a);
        const L2 = dist(b, B);
        if (L1 > 1) out.push(this.dimensionLine(add(A, off), add(a, off), formatLength(L1, this.units, { precision: 'label' }), 'preview-dim'));
        if (L2 > 1) out.push(this.dimensionLine(add(b, off), add(B, off), formatLength(L2, this.units, { precision: 'label' }), 'preview-dim'));
      }
    }
    if (c?.p && (this.tool === 'wall' || this.tool === 'rect' || this.tool === 'measure')) {
      const r = this.px(c.kind === 'node' ? 6 : 4);
      out.push(tag('circle', { class: `snap snap-${c.kind ?? 'none'}`, cx: c.p.x, cy: c.p.y, r, 'stroke-width': this.px(1.5) }, null));
    }
    return out.join('');
  }

  /** Pinned measurements (the latest strongest), the one being drawn, and the wall face under the mouse. */
  renderMeasures() {
    if (this.tool !== 'measure') return '';
    const out = this.measures.map((m, i) => this.measureSvg(m, i === this.measures.length - 1 ? 'measure' : 'measure old'));
    const m = this.measuring;
    if (m && dist(m.a, m.b) > 1) out.push(this.measureSvg({ kind: 'line', a: m.a, b: m.b }, 'measure live'));
    else if (m) out.push(tag('circle', { class: 'measure-end', cx: m.a.x, cy: m.a.y, r: this.px(3) }, null));
    else if (this.measureHover) out.push(this.measureSvg(this.faceMeasure(this.measureHover), 'measure hover'));
    return out.join('');
  }

  measureSvg(m, cls) {
    const fmt = (v) => formatLength(v, this.units, { precision: 'label' });
    const L = dist(m.a, m.b);
    const sw = this.px(1);
    if (m.kind === 'face') {
      const off = scale(m.side, this.px(16));
      const ext = (p) => tag('line', { class: 'measure-ext', x1: p.x, y1: p.y, x2: p.x + off.x * 1.3, y2: p.y + off.y * 1.3, 'stroke-width': sw }, null);
      return `<g class="${cls}">${tag('line', { class: 'measure-face', x1: m.a.x, y1: m.a.y, x2: m.b.x, y2: m.b.y, 'stroke-width': this.px(3) }, null)}${ext(m.a)}${ext(m.b)}${
        this.dimensionLine(add(m.a, off), add(m.b, off), `${fmt(L)} ${m.exterior ? 'exterior' : 'interior'}`, 'measure-dim')}</g>`;
    }
    let body = '';
    const dx = Math.abs(m.b.x - m.a.x);
    const dy = Math.abs(m.b.y - m.a.y);
    if (dx > 1 && dy > 1) {
      // Diagonal: dashed legs with the horizontal and vertical components.
      const c = { x: m.b.x, y: m.a.y };
      body += tag('polyline', { class: 'measure-leg', points: pts([m.a, c, m.b]), 'stroke-width': sw, 'stroke-dasharray': `${n(this.px(4))} ${n(this.px(3))}` }, null);
      body += this.label(add(scale(add(m.a, c), 0.5), { x: 0, y: this.px(m.b.y > m.a.y ? -9 : 9) }), fmt(dx), 0, 'measure-leg-text', 10);
      body += this.label(add(scale(add(c, m.b), 0.5), { x: this.px(m.b.x > m.a.x ? 9 : -9), y: 0 }), fmt(dy), -90, 'measure-leg-text', 10);
    }
    body += this.dimensionLine(m.a, m.b, fmt(L), 'measure-dim');
    for (const p of [m.a, m.b]) body += tag('circle', { class: 'measure-end', cx: p.x, cy: p.y, r: this.px(2.5) }, null);
    return `<g class="${cls}">${body}</g>`;
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
    // While placing: what is wrong with the spot under the mouse.
    const ghostIssue = this.placing?.shown ? this.lastGhostIssue : null;
    out.push(this.canvas.messageSvg(this.message || ghostIssue || ''));
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

/** Each wall's outline [A+, B+, B−, A−] by wall id: mitred where two walls meet, squared at junctions and free ends. */
function wallOutlines(d, idx) {
  const deg = nodeDegrees(d);
  const byNode = new Map();
  for (const w of d.walls) {
    for (const id of [w.a, w.b]) {
      if (!byNode.has(id)) byNode.set(id, []);
      byNode.get(id).push(w);
    }
  }
  const out = new Map();
  for (const w of d.walls) {
    const A = idx.nodes.get(w.a);
    const B = idx.nodes.get(w.b);
    const u = norm(sub(B, A));
    const nrm = scale(perp(u), w.thickness / 2);
    const endA = endCorners(A, u, w, byNode.get(w.a), idx, deg.get(w.a));
    const endB = endCorners(B, scale(u, -1), w, byNode.get(w.b), idx, deg.get(w.b));
    // At B the away-direction is reversed, so its "plus" side is the wall's minus side.
    out.set(w.id, [endA.plus ?? add(A, nrm), endB.minus ?? add(B, nrm), endB.plus ?? sub(B, nrm), endA.minus ?? sub(A, nrm)]);
  }
  return out;
}

/** The two long sides of a wall outline, each as [p, q, outward unit normal]. */
function outlineSides(poly) {
  const c = scale(add(add(poly[0], poly[1]), add(poly[2], poly[3])), 0.25);
  return [[poly[0], poly[1]], [poly[3], poly[2]]].map(([p, q]) => {
    let side = perp(norm(sub(q, p)));
    if (dot(side, sub(p, c)) < 0) side = scale(side, -1);
    return [p, q, side];
  });
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
