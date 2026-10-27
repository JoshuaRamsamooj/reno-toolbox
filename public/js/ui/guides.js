// Ruler guides on the shared drawing canvas, identical on the floor plan and
// on a wall face: drag from the top ruler for a horizontal guide or from the
// left ruler for a vertical one; drag a guide to move it, Shift+drag (or
// Alt+drag) to pull a second guide off it, and drop it back on its ruler to
// delete it. While dragging, or straight after letting go, a typed distance
// + Enter places the guide exactly that far from its reference: the guide
// it was pulled off, else the nearest parallel snap target the view marks as
// a reference (a wall face, a corner, the floor...) or other guide.
//
// Guides are { id, axis: 'x' | 'y', v } in world units: axis 'x' is a
// vertical line at x = v, axis 'y' a horizontal line at y = v. The view
// keeps them in its own data and supplies (all functions):
//   list()                 the guides
//   save(label, fn)        one undoable edit: fn(list) mutates the stored list
//   targets(axis, id)      snap targets [{ v, label, ref }] for a guide on axis
//                          (other guides are added here); ref: usable as a
//                          reference for typed distances
//   parse(text)            typed text → world length, or null
//   example                sample distances for hints, e.g. `18" or 3'6"`
//   canGrab()              whether existing guides can be picked up now
//   isSelected(id), select(id, additive)
//   render(), flash(message)
import { RULER } from './canvas.js';
import { formatLength } from '../core/units.js';
import { esc, n } from './svg.js';
import { uid } from '../core/model.js';

const TYPABLE = /^[0-9.'"\/\- mMcC]$/;
const GRAB_PX = 4;

export class RulerGuides {
  constructor(canvas, view) {
    this.canvas = canvas;
    this.view = view;
    this.drag = null; // { axis, id (null for a new guide), srcId, v, start, ref, shiftCopy, remove, moved, label, at, atWorld }
    this.entry = null; // a guide just placed, waiting for a typed distance: { id, ref, dir, at }
    this.typed = '';
    this.hoverId = null;
    this.hoverAt = null;
    canvas.guides = this;
  }

  get units() {
    return this.canvas.units();
  }

  find(id) {
    return this.view.list().find((g) => g.id === id) ?? null;
  }

  // -------------------------------------------------------------------------
  // Hit testing

  /** 'x' over the left ruler (pulls a vertical guide), 'y' over the top ruler, else null. */
  rulerAt(scr) {
    if (scr.sy < RULER && scr.sx >= RULER) return 'y';
    if (scr.sx < RULER && scr.sy >= RULER) return 'x';
    return null;
  }

  /** The guide within a few pixels of a screen point, or null. */
  at(scr) {
    let best = null;
    let bestD = GRAB_PX;
    for (const g of this.view.list()) {
      const d = Math.abs(g.axis === 'x' ? this.canvas.X(g.v) - scr.sx : this.canvas.Y(g.v) - scr.sy);
      if (d <= bestD) {
        best = g;
        bestD = d;
      }
    }
    return best;
  }

  /** Ids of the guides crossing a world box {minX, maxX, minY, maxY}: guides are endless, so any crossing counts. */
  inBox(box) {
    return this.view.list().filter((g) => (g.axis === 'x' ? g.v >= box.minX && g.v <= box.maxX : g.v >= box.minY && g.v <= box.maxY)).map((g) => g.id);
  }

  /** Where vertical and horizontal guides cross. */
  crossings() {
    const all = this.view.list();
    return all.filter((g) => g.axis === 'x').flatMap((gx) => all.filter((g) => g.axis === 'y').map((gy) => ({ x: gx.v, y: gy.v })));
  }

  /** The nearest parallel guide on each side of guide g: [before, after] values (or null). */
  neighbours(g) {
    const others = this.view.list().filter((x) => x.axis === g.axis && x.id !== g.id).map((x) => x.v);
    const before = others.filter((v) => v < g.v - 0.5);
    const after = others.filter((v) => v > g.v + 0.5);
    return [before.length ? Math.max(...before) : null, after.length ? Math.min(...after) : null];
  }

  // -------------------------------------------------------------------------
  // Pointer events (views call these first and stop when they return true)

  /** Pulls a new guide out of a ruler. Any press ends a pending typed entry. */
  pointerDown(e, scr) {
    this.endEntry();
    const axis = e.button === 0 && !this.canvas.app.spaceDown ? this.rulerAt(scr) : null;
    if (!axis) return false;
    // The guide appears once the mouse leaves the ruler.
    this.drag = { axis, id: null, v: scr[axis], start: scr[axis], remove: true, moved: false };
    this.typed = '';
    return true;
  }

  /**
   * Picks up the guide under the mouse, if any (views call this where a guide
   * should win, e.g. over empty floor with the Select tool). Shift or Alt
   * pulls a new guide off it instead; a click without moving selects it.
   */
  grab(e, scr) {
    const g = this.view.canGrab() ? this.at(scr) : null;
    if (!g) return false;
    const copy = e.shiftKey || e.altKey;
    this.drag = { axis: g.axis, id: copy ? null : g.id, srcId: g.id, v: g.v, start: g.v, ref: copy ? g.v : null, shiftCopy: e.shiftKey, remove: false, moved: false };
    this.typed = '';
    return true;
  }

  /** Moves a dragged guide (true), else tracks the guide under the mouse and the ruler cursor (false). */
  pointerMove(e, scr, busy = false) {
    const dr = this.drag;
    if (dr) {
      // Shift frees a guide from snapping, except while it is the Shift that pulled the guide out (then Alt does).
      const free = dr.shiftCopy ? e.altKey : e.shiftKey;
      let targets = this.snapTargets(dr.axis, dr.id);
      if (dr.ref != null) targets = targets.filter((t) => Math.abs(t.v - dr.ref) > 0.5); // don't fall back onto the source
      const s = this.canvas.snapValue(scr[dr.axis], targets, free);
      Object.assign(dr, { v: s.v, label: s.label, moved: true, at: scr, atWorld: { x: scr.x, y: scr.y } });
      dr.remove = dr.axis === 'x' ? scr.sx < RULER : scr.sy < RULER;
      this.view.render();
      return true;
    }
    const over = !busy && this.view.canGrab() ? this.at(scr) : null;
    this.hoverId = over?.id ?? null;
    this.hoverAt = over ? scr : null;
    this.canvas.svg.dataset.ruler = (busy ? null : this.rulerAt(scr)) ?? over?.axis ?? '';
    return false;
  }

  pointerUp() {
    const dr = this.drag;
    if (!dr) return false;
    this.drag = null;
    this.finish(dr);
    return true;
  }

  // -------------------------------------------------------------------------
  // Placing

  snapTargets(axis, exceptId) {
    const others = this.view.list().filter((g) => g.axis === axis && g.id !== exceptId).map((g) => ({ v: g.v, label: 'guide', ref: true }));
    return [...others, ...this.view.targets(axis, exceptId)];
  }

  /**
   * What a guide measures from: the guide it was pulled off, else the
   * nearest parallel reference target or guide, else (an existing guide
   * being moved) where it started. {v, label} or null.
   */
  reference(dr) {
    if (dr.ref != null) return { v: dr.ref, label: 'guide it came from' };
    const near = this.snapTargets(dr.axis, dr.id).filter((t) => t.ref).sort((p, q) => Math.abs(p.v - dr.v) - Math.abs(q.v - dr.v))[0];
    if (near) return { v: near.v, label: near.label };
    return dr.id && dr.start != null ? { v: dr.start, label: 'where it was' } : null;
  }

  finish(dr) {
    const v = this.view;
    if (dr.srcId && !dr.moved) {
      v.select(dr.srcId, dr.shiftCopy);
    } else if (dr.remove) {
      if (dr.id) v.save('Delete guide', (list) => { list.splice(list.findIndex((g) => g.id === dr.id), 1); });
    } else if (dr.moved) {
      const id = dr.id ?? uid('g');
      if (dr.id) {
        v.save('Move guide', (list) => {
          const g = list.find((x) => x.id === id);
          if (g) g.v = dr.v;
        });
      } else {
        v.save('Add guide', (list) => { list.push({ id, axis: dr.axis, v: dr.v }); });
      }
      this.startEntry(id, dr);
    }
    v.render();
  }

  /** A guide just placed or moved stays ready for a typed distance until the next click, Esc or tool change. */
  startEntry(id, dr) {
    const g = this.find(id);
    if (!g) return;
    this.entry = { id, ref: this.reference({ ...dr, id, v: g.v }), dir: Math.sign(g.v - (dr.start ?? g.v)) || 1, at: dr.atWorld ?? null };
    this.typed = '';
    this.view.select(id, false);
  }

  endEntry() {
    this.entry = null;
    this.typed = '';
  }

  /** Drops any drag and entry (e.g. on a tool change). */
  cancel() {
    this.drag = null;
    this.endEntry();
  }

  /**
   * The position `this.typed` away from `ref`, on the side the guide is on
   * (or, sitting on the reference, the side it was dragged toward). Null,
   * with a message, when the text isn't a length or there is no reference.
   */
  typedValue(ref, v, dir) {
    const L = this.view.parse(this.typed.trim());
    this.typed = '';
    if (L == null || L < 0) {
      this.view.flash(`Couldn't read that as a distance: try ${this.view.example}`);
      return null;
    }
    if (!ref) {
      this.view.flash('Nothing to measure from yet: Shift+drag the new guide off another one');
      return null;
    }
    return ref.v + (Math.sign(v - ref.v) || dir || 1) * L;
  }

  // -------------------------------------------------------------------------
  // Keyboard: a distance + Enter while dragging, or after letting go

  key(e) {
    if (e.ctrlKey || e.metaKey) return false;
    const dr = this.drag;
    if (dr) {
      if (e.key.length === 1 && TYPABLE.test(e.key)) this.typed += e.key;
      else if (e.key === 'Backspace') this.typed = this.typed.slice(0, -1);
      else if (e.key === 'Enter' && this.typed.trim()) {
        const v = this.typedValue(this.reference(dr), dr.v, Math.sign(dr.v - dr.start));
        if (v != null) {
          this.drag = null;
          this.finish({ ...dr, v, remove: false, moved: true });
        }
      } else if (e.key === 'Escape') this.cancel();
      this.view.render();
      return true; // nothing else reacts to keys mid-drag
    }
    const en = this.entry;
    if (!en || e.altKey) return false;
    // Only a digit starts the entry, so tool keys still work straight after letting go.
    if (e.key.length === 1 && TYPABLE.test(e.key) && (this.typed || /^[0-9.]$/.test(e.key))) {
      this.typed += e.key;
    } else if (e.key === 'Backspace' && this.typed) {
      this.typed = this.typed.slice(0, -1);
    } else if (e.key === 'Enter' && this.typed.trim()) {
      const g = this.find(en.id);
      const v = g ? this.typedValue(en.ref, g.v, en.dir) : null;
      if (!g) this.endEntry();
      if (v != null) {
        this.view.save('Place guide', (list) => {
          const x = list.find((gg) => gg.id === en.id);
          if (x) x.v = v;
        });
      }
    } else if (e.key === 'Escape') {
      this.endEntry();
    } else {
      return false;
    }
    this.view.render();
    return true;
  }

  // -------------------------------------------------------------------------
  // Drawing (screen space)

  /** Ruler marks for every guide. */
  marks() {
    const m = { x: [], y: [] };
    for (const g of this.view.list()) m[g.axis].push(g.v);
    return m;
  }

  /**
   * The guides across the canvas. A dragged guide shows what it snapped to
   * (or how far it is from its reference) and its live dimension, and turns
   * red over its ruler; a just-placed guide shows its distance and a prompt
   * for a typed one; a hovered guide its distance to the guides either side.
   */
  svg() {
    const c = this.canvas;
    const r = c.rect();
    const dr = this.drag;
    const fmt = (v) => formatLength(v, this.units, { precision: 'label' });
    const line = (axis, v, cls) => {
      const x = n(c.X(v));
      const y = n(c.Y(v));
      return axis === 'x' ? `<line class="${cls}" x1="${x}" y1="${RULER}" x2="${x}" y2="${n(r.height)}"/>` : `<line class="${cls}" x1="${RULER}" y1="${y}" x2="${n(r.width)}" y2="${y}"/>`;
    };
    const label = (x, y, text, cls = '') => `<text class="cv-guide-text halo${cls}" x="${n(x)}" y="${n(y)}">${esc(text)}</text>`;
    const typed = this.typed ? `${this.typed}▏` : null;
    const out = this.view.list().filter((g) => g.id !== dr?.id)
      .map((g) => line(g.axis, g.v, `cv-user-guide${this.view.isSelected(g.id) ? ' selected' : g.id === this.hoverId ? ' hover' : ''}`));
    if (dr?.moved) {
      out.push(line(dr.axis, dr.v, `cv-user-guide dragging${dr.remove ? ' remove' : ''}`));
      const ref = dr.remove ? null : this.reference(dr);
      let text = dr.remove ? (dr.id ? 'Release to delete the guide' : 'Drag off the ruler') : dr.label ? `on ${dr.label}` : ref ? `${fmt(Math.abs(dr.v - ref.v))} from the ${ref.label}` : fmt(dr.v);
      if (!dr.remove && !this.typed) text += ' · type a distance + Enter';
      out.push(dr.axis === 'x' ? label(c.X(dr.v) + 6, RULER + 16, text, dr.remove ? ' remove' : '') : label(RULER + 8, c.Y(dr.v) - 6, text, dr.remove ? ' remove' : ''));
      if (ref && dr.at) {
        if (dr.ref != null) out.push(line(dr.axis, ref.v, 'cv-user-guide hover'));
        out.push(this.dim(dr.axis, ref.v, dr.v, dr.at, typed));
      }
    } else if (this.entry) {
      const en = this.entry;
      const g = this.find(en.id);
      if (g && en.ref) {
        const p = en.at ?? { x: (r.width / 2 - c.view.tx) / c.view.scale, y: (r.height / 2 - c.view.ty) / (c.sign * c.view.scale) };
        const at = { sx: c.X(p.x), sy: c.Y(p.y) };
        out.push(this.dim(g.axis, en.ref.v, g.v, at, typed));
        const hint = this.typed ? 'Enter to place · Esc to cancel' : `Type a distance from the ${en.ref.label} (e.g. ${this.view.example}) + Enter`;
        out.push(g.axis === 'x'
          ? label(Math.max(c.X(g.v), c.X(en.ref.v)) + 8, at.sy + 18, hint)
          : label(at.sx + 8, Math.max(c.Y(g.v), c.Y(en.ref.v)) + 16, hint));
      }
    }
    if (!dr?.moved && this.hoverId && this.hoverAt && this.hoverId !== this.entry?.id) {
      const g = this.find(this.hoverId);
      for (const v of g ? this.neighbours(g) : []) if (v != null) out.push(this.dim(g.axis, v, g.v, this.hoverAt));
    }
    return out.join('');
  }

  /** Dimension between two parallel guide positions, drawn across them at a screen point. */
  dim(axis, v0, v1, at, typed = null) {
    const c = this.canvas;
    const text = typed ?? formatLength(Math.abs(v1 - v0), this.units, { precision: 'label' });
    const cls = ` class="halo${typed ? ' typed-value' : ''}"`;
    if (axis === 'x') {
      const x0 = c.X(v0);
      const x1 = c.X(v1);
      const y = at.sy;
      return `<g class="cv-guide-dim"><path d="M${n(x0)} ${n(y)}H${n(x1)}M${n(x0)} ${n(y - 5)}V${n(y + 5)}M${n(x1)} ${n(y - 5)}V${n(y + 5)}"/>` +
        `<text${cls} x="${n((x0 + x1) / 2)}" y="${n(y - 7)}" text-anchor="middle">${esc(text)}</text></g>`;
    }
    const y0 = c.Y(v0);
    const y1 = c.Y(v1);
    const x = at.sx;
    return `<g class="cv-guide-dim"><path d="M${n(x)} ${n(y0)}V${n(y1)}M${n(x - 5)} ${n(y0)}H${n(x + 5)}M${n(x - 5)} ${n(y1)}H${n(x + 5)}"/>` +
      `<text${cls} x="${n(x + 8)}" y="${n((y0 + y1) / 2 + 4)}">${esc(text)}</text></g>`;
  }
}
