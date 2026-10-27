// The drawing canvas shared by the floor plan and the wall face editor: one
// uniform scale between world millimetres and screen pixels (so zooming and
// panning never distort), wheel zoom about the cursor, panning (right or
// middle drag, Space+drag or a Pan tool), an adaptive grid down to 1/16" or
// 1 mm, rulers with cursor marks, snap guides, a message banner, the typed
// value box, the Snap / Grid / zoom / Fit controls, and ruler guides
// (guides.js: a RulerGuides attached to the canvas sets `canvas.guides`).
//
// World y grows downward on the plan and upward (height above the floor) on
// a wall face; `yUp` picks which. Views keep their own content rendering and
// tools and use these helpers for everything that should look and behave the
// same in both.
import { MM_PER_IN, formatLength } from '../core/units.js';
import { esc, n } from './svg.js';
import { checkbox, h } from './dom.js';
import { gridSteps } from './grid.js';

export const RULER = 24; // px: width of the top and left rulers
const SNAP_PX = 8; // px: how close a target must be to snap

export class DrawingCanvas {
  /**
   * opts: svg, app, units() → 'imperial' | 'metric', yUp, minScale,
   * maxScale, scale (initial px/mm), onView() called after zoom/pan,
   * fitLabel (tooltip for the Fit button).
   */
  constructor({ svg, app, units, yUp = false, minScale = 0.004, maxScale = 30, scale = 0.06, onView, fitLabel = 'Fit (F)' }) {
    this.svg = svg;
    this.app = app;
    this.units = units;
    this.yUp = yUp;
    this.minScale = minScale;
    this.maxScale = maxScale;
    this.onView = onView ?? (() => {});
    this.fitLabel = fitLabel;
    this.view = { scale, tx: 0, ty: 0 };
    this.snapOn = true;
    this.gridOn = true;
    this.pan = null;
    this.guides = null; // RulerGuides, when the view uses them
    svg.classList.add('draw-canvas');
    svg.addEventListener('contextmenu', (e) => e.preventDefault());
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
    }, { passive: false });
  }

  get sign() {
    return this.yUp ? -1 : 1;
  }

  rect() {
    return this.svg.getBoundingClientRect();
  }

  // -------------------------------------------------------------------------
  // Coordinates

  X(x) {
    return this.view.tx + x * this.view.scale;
  }

  Y(y) {
    return this.view.ty + this.sign * y * this.view.scale;
  }

  /** World point under a pointer event, plus its screen position (sx, sy) in the canvas. */
  toWorld(e) {
    const r = this.rect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    return { x: (sx - this.view.tx) / this.view.scale, y: (sy - this.view.ty) / (this.sign * this.view.scale), sx, sy };
  }

  /** World length of `v` screen pixels. */
  px(v) {
    return v / this.view.scale;
  }

  /** SVG transform drawing world coordinates directly (for views that render in world units). */
  worldTransform() {
    const { scale: s, tx, ty } = this.view;
    return `matrix(${s} 0 0 ${this.sign * s} ${tx} ${ty})`;
  }

  // -------------------------------------------------------------------------
  // Zoom and pan

  zoomAt(sx, sy, factor) {
    const s = Math.min(this.maxScale, Math.max(this.minScale, this.view.scale * factor));
    const k = s / this.view.scale;
    this.view.tx = sx - (sx - this.view.tx) * k;
    this.view.ty = sy - (sy - this.view.ty) * k;
    this.view.scale = s;
    this.onView();
  }

  zoomBy(factor) {
    const r = this.rect();
    this.zoomAt(r.width / 2, r.height / 2, factor);
  }

  /**
   * Fits world bounds {minX, minY, maxX, maxY} inside the canvas, clear of
   * the rulers plus `margin` px on each side ({left, top, right, bottom}).
   * Returns false while the canvas has no size yet (e.g. a hidden tab).
   */
  fitTo(b, margin = {}, maxScale = this.maxScale) {
    const r = this.rect();
    if (r.width < 50 || r.height < 50) return false;
    const m = { left: 40, top: 40, right: 40, bottom: 40, ...margin };
    const left = RULER + m.left;
    const top = RULER + m.top;
    const availW = Math.max(50, r.width - left - m.right);
    const availH = Math.max(50, r.height - top - m.bottom);
    const w = Math.max(b.maxX - b.minX, 1);
    const hgt = Math.max(b.maxY - b.minY, 1);
    const k = Math.max(this.minScale, Math.min(maxScale, availW / w, availH / hgt));
    this.view.scale = k;
    this.view.tx = left + (availW - w * k) / 2 - b.minX * k;
    // Centre vertically: world maxY sits at the top when y is up, minY when it's down.
    const topWorld = this.yUp ? b.maxY : b.minY;
    this.view.ty = top + (availH - hgt * k) / 2 - this.sign * topWorld * k;
    return true;
  }

  /** True when a pointer-down should pan: right/middle button, Space held, or a pan tool. */
  wantsPan(e, panTool = false) {
    return e.button === 1 || e.button === 2 || this.app.spaceDown || (e.button === 0 && panTool);
  }

  startPan(e) {
    this.pan = { sx: e.clientX, sy: e.clientY, tx: this.view.tx, ty: this.view.ty, moved: false };
    this.svg.classList.add('panning');
  }

  /** Moves the view while panning; returns false when not panning. */
  movePan(e) {
    if (!this.pan) return false;
    this.view.tx = this.pan.tx + e.clientX - this.pan.sx;
    this.view.ty = this.pan.ty + e.clientY - this.pan.sy;
    if (Math.hypot(e.clientX - this.pan.sx, e.clientY - this.pan.sy) > 3) this.pan.moved = true;
    this.onView();
    return true;
  }

  /** Ends a pan; returns true if one was in progress. */
  endPan() {
    const was = !!this.pan;
    this.pan = null;
    this.svg.classList.remove('panning');
    return was;
  }

  // -------------------------------------------------------------------------
  // Grid and snapping

  steps() {
    return gridSteps(this.view.scale, this.units(), { fine: true });
  }

  /** Finest increment for unsnapped input: 1/16" or 1 mm. */
  get fine() {
    return this.units() === 'metric' ? 1 : MM_PER_IN / 16;
  }

  /** Step to round to when nothing closer snaps: the grid, or 1/16" / 1 mm with the grid off. */
  snapStep() {
    return this.gridOn ? this.steps().snap : this.fine;
  }

  /** Snap tolerance in world units. */
  get snapTolerance() {
    return SNAP_PX / this.view.scale;
  }

  /**
   * Snaps one coordinate: the nearest target ({v, label}) within reach,
   * else the grid. `free` (Shift) or Snap off rounds to 1/16" / 1 mm only.
   */
  snapValue(raw, targets, free = false) {
    if (free || !this.snapOn) return { v: Math.round(raw / this.fine) * this.fine, label: null };
    let best = null;
    for (const t of targets) if (Math.abs(t.v - raw) <= this.snapTolerance && (!best || Math.abs(t.v - raw) < Math.abs(best.v - raw))) best = t;
    if (best) return best;
    const step = this.snapStep();
    return { v: Math.round(raw / step) * step, label: null };
  }

  /**
   * Snaps a moving set of edges (e.g. both sides of a box): the shift that
   * lands the nearest edge on a target, else puts the first edge on the grid.
   */
  snapEdges(edges, targets, free = false) {
    if (free || !this.snapOn) return { delta: Math.round(edges[0] / this.fine) * this.fine - edges[0], guide: null };
    let best = null;
    for (const e of edges) {
      for (const t of targets) {
        const delta = t.v - e;
        if (Math.abs(delta) <= this.snapTolerance && (!best || Math.abs(delta) < Math.abs(best.delta))) best = { delta, guide: t };
      }
    }
    if (best) return best;
    const step = this.snapStep();
    return { delta: Math.round(edges[0] / step) * step - edges[0], guide: null };
  }

  toggle(flag) {
    this[flag] = !this[flag];
    this.onView();
    this.app.inspector?.render();
  }

  // -------------------------------------------------------------------------
  // Rendering helpers (screen-space SVG markup)

  /** Visible world range along an axis ('x' or 'y') between two screen positions. */
  visible(axis, from, to) {
    const a = axis === 'x' ? (from - this.view.tx) / this.view.scale : (from - this.view.ty) / (this.sign * this.view.scale);
    const b = axis === 'x' ? (to - this.view.tx) / this.view.scale : (to - this.view.ty) / (this.sign * this.view.scale);
    return [Math.min(a, b), Math.max(a, b)];
  }

  /**
   * Minor and major grid lines. opts.clip: id of a clipPath to keep the grid
   * inside (the wall on a face); opts.bounds limits the lines to world bounds.
   */
  gridSvg({ clip = null, bounds = null } = {}) {
    if (!this.gridOn) return '';
    const r = this.rect();
    const { minor, major } = this.steps();
    let [x0, x1] = this.visible('x', 0, r.width);
    let [y0, y1] = this.visible('y', 0, r.height);
    if (bounds) {
      x0 = Math.max(x0, bounds.minX);
      x1 = Math.min(x1, bounds.maxX);
      y0 = Math.max(y0, bounds.minY);
      y1 = Math.min(y1, bounds.maxY);
    }
    const out = [];
    for (const [step, cls] of [[minor, 'minor'], [major, 'major']]) {
      if (cls === 'minor' && step === major) continue;
      let d = '';
      for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) d += `M${n(this.X(x))} 0V${n(r.height)}`;
      for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) d += `M0 ${n(this.Y(y))}H${n(r.width)}`;
      out.push(`<path class="cv-grid-${cls}"${clip ? ` clip-path="url(#${clip})"` : ''} d="${d}"/>`);
    }
    return out.join('');
  }

  /**
   * Top and left rulers with major labels, optional strong marks (e.g. a
   * face's ends and the floor, plus every ruler guide) and the cursor position.
   */
  rulersSvg({ cursor = null, marks = { x: [], y: [] } } = {}) {
    const gm = this.guides?.marks();
    if (gm) marks = { x: [...(marks.x ?? []), ...gm.x], y: [...(marks.y ?? []), ...gm.y] };
    const u = this.units();
    const r = this.rect();
    const { minor, major } = this.steps();
    const label = (v) => formatLength(Math.abs(v) < 1e-6 ? 0 : v, u, { precision: 'label' });
    const isMajor = (v) => Math.abs(v / major - Math.round(v / major)) < 1e-6;
    const out = [`<rect class="cv-ruler" x="0" y="0" width="${n(r.width)}" height="${RULER}"/>`, `<rect class="cv-ruler" x="0" y="0" width="${RULER}" height="${n(r.height)}"/>`];
    let d = '';
    const [x0, x1] = this.visible('x', RULER, r.width);
    for (let x = Math.ceil(x0 / minor) * minor; x <= x1; x += minor) {
      const sx = this.X(x);
      d += `M${n(sx)} ${RULER}V${isMajor(x) ? 8 : 16}`;
      if (isMajor(x)) out.push(`<text class="cv-ruler-text" x="${n(sx + 3)}" y="10">${esc(label(x))}</text>`);
    }
    const [y0, y1] = this.visible('y', RULER, r.height);
    for (let y = Math.ceil(y0 / minor) * minor; y <= y1; y += minor) {
      const sy = this.Y(y);
      d += `M${RULER} ${n(sy)}H${isMajor(y) ? 8 : 16}`;
      if (isMajor(y)) out.push(`<text class="cv-ruler-text" transform="translate(10 ${n(sy - 3)}) rotate(-90)">${esc(label(y))}</text>`);
    }
    out.push(`<path class="cv-ruler-ticks" d="${d}"/>`);
    const markPath = [...(marks.x ?? []).map((x) => `M${n(this.X(x))} 0V${RULER}`), ...(marks.y ?? []).map((y) => `M0 ${n(this.Y(y))}H${RULER}`)].join('');
    if (markPath) out.push(`<path class="cv-ruler-mark" d="${markPath}"/>`);
    if (cursor) out.push(`<path class="cv-ruler-cursor" d="M${n(this.X(cursor.x))} 0V${RULER}M0 ${n(this.Y(cursor.y))}H${RULER}"/>`);
    out.push(`<rect class="cv-ruler corner" x="0" y="0" width="${RULER}" height="${RULER}"/>`);
    out.push(`<text class="cv-ruler-text" x="4" y="16">${u === 'metric' ? 'm' : 'ft'}</text>`);
    return out.join('');
  }

  /**
   * Dashed guides across the canvas for what a point snapped to: gx / gy are
   * {v, label} (world value and what it is), or null.
   */
  guidesSvg(gx, gy) {
    const r = this.rect();
    const out = [];
    const fmt = (v) => formatLength(v, this.units(), { precision: 'label' });
    if (gx) {
      const x = this.X(gx.v);
      out.push(`<line class="cv-guide" x1="${n(x)}" y1="${RULER}" x2="${n(x)}" y2="${n(r.height)}"/>`);
      out.push(`<text class="cv-guide-text halo" x="${n(x + 4)}" y="${RULER + 14}">${esc(gx.label)}</text>`);
    }
    if (gy) {
      const y = this.Y(gy.v);
      out.push(`<line class="cv-guide" x1="${RULER}" y1="${n(y)}" x2="${n(r.width)}" y2="${n(y)}"/>`);
      out.push(`<text class="cv-guide-text halo" x="${n(r.width - 8)}" y="${n(y - 4)}" text-anchor="end">${esc(`${gy.label} · ${fmt(gy.v)}`)}</text>`);
    }
    return out.join('');
  }

  /** Ruler guides (if the view uses them), drawn over the content and under the rulers. */
  rulerGuidesSvg() {
    return this.guides?.svg() ?? '';
  }

  /** Banner across the top of the canvas (hints and refusals). */
  messageSvg(text) {
    if (!text) return '';
    const r = this.rect();
    const w = text.length * 6.6 + 20;
    return `<g class="message" transform="translate(${n(Math.max(RULER + 8, (r.width - w) / 2))} ${RULER + 10})"><rect width="${n(w)}" height="24" rx="4"/><text x="10" y="16">${esc(text)}</text></g>`;
  }

  /** The value being typed, beside a screen point, with a hint of what it sets. */
  typedSvg(sx, sy, text, hint = '') {
    if (!text) return '';
    const label = `${text}▏${hint ? `  (${hint})` : ''}`;
    return `<g class="typed" transform="translate(${n(sx + 18)} ${n(sy + 18)})"><rect width="${n(label.length * 7 + 20)}" height="24" rx="4"/><text x="10" y="16">${esc(label)}</text></g>`;
  }

  // -------------------------------------------------------------------------
  // Controls

  /** Snap / Grid toggles and zoom − / + / Fit buttons for the canvas bar. */
  controls({ onFit, disabled = false } = {}) {
    return h('div', { class: 'cv-controls' },
      checkbox('Snap (S)', this.snapOn, (v) => { this.snapOn = v; this.onView(); }),
      checkbox('Grid (G)', this.gridOn, (v) => { this.gridOn = v; this.onView(); }),
      h('button', { class: 'icon', title: 'Zoom out', onclick: () => this.zoomBy(0.8), disabled }, '−'),
      h('button', { class: 'icon', title: 'Zoom in', onclick: () => this.zoomBy(1.25), disabled }, '+'),
      h('button', { title: this.fitLabel, onclick: () => onFit?.(), disabled }, 'Fit'));
  }
}
