// Interior elevations: every wall face of a room, drawn as seen from inside
// the room, at a shared scale, with openings, ceiling profile and dimensions.
import { analyze, roomElevations } from '../core/model.js';
import { CEILING_TYPES, profileArea, profileHeightAt } from '../core/ceiling.js';
import { bandArea } from '../core/bulkhead.js';
import { formatArea, formatLength } from '../core/units.js';
import { esc, n, pts } from './svg.js';
import { h, svgEl } from './dom.js';

const VW = 640;

export class ElevationView {
  constructor(app, el) {
    this.app = app;
    this.el = el;
    this.roomId = null;
  }

  /** Room implied by the current selection, falling back to the last viewed room. */
  pickRoom(analysis) {
    const sel = this.app.selection;
    const d = this.app.design;
    let g = null;
    if (sel?.type === 'room') g = analysis.rooms.find((x) => x.room?.id === sel.id);
    if (!g && sel?.type === 'wall') g = analysis.rooms.find((x) => x.wallIds.includes(sel.id));
    if (!g && sel?.type === 'opening') {
      const o = d.openings.find((x) => x.id === sel.id);
      g = o && analysis.rooms.find((x) => x.wallIds.includes(o.wallId));
    }
    if (!g && this.roomId) g = analysis.rooms.find((x) => x.room?.id === this.roomId);
    return g ?? analysis.rooms[0] ?? null;
  }

  render() {
    const d = this.app.design;
    const analysis = analyze(d);
    const g = this.pickRoom(analysis);
    if (!g) {
      this.el.replaceChildren(h('div', { class: 'empty' }, h('h2', {}, 'No rooms yet'), h('p', {}, 'Draw a closed set of walls on the Plan tab and each enclosed area becomes a room with its own elevations.')));
      return;
    }
    this.roomId = g.room?.id ?? null;
    const u = d.units;
    const elev = roomElevations(d, g);
    const roomSelect = h('select', { class: 'room-select' }, analysis.rooms.map((r) => h('option', { value: r.room?.id ?? '', selected: r === g }, r.room?.name ?? 'Room')));
    roomSelect.addEventListener('change', () => this.app.select({ type: 'room', id: roomSelect.value }));

    const maxLen = Math.max(...elev.walls.map((w) => w.length), 1);
    const maxH = Math.max(elev.model.maxHeight, ...elev.walls.flatMap((w) => w.profile.map((p) => p.z)));
    const k = Math.min((VW - 130) / maxLen, 300 / maxH);
    const net = elev.walls.reduce((s, w) => s + faceNet(w), 0);

    this.el.replaceChildren(
      h('div', { class: 'elev-header' },
        h('label', {}, 'Room ', roomSelect),
        h('span', { class: 'chip' }, CEILING_TYPES[elev.spec.type]),
        h('span', { class: 'chip' }, `Floor ${formatArea(g.area, u)}`),
        h('span', { class: 'chip' }, `Ceiling ${formatArea(elev.model.area, u)}`),
        h('span', { class: 'chip' }, `Walls net ${formatArea(net, u)}`),
        elev.bulkheads.length ? h('span', { class: 'chip bh' }, `${elev.bulkheads.length} bulkhead${elev.bulkheads.length > 1 ? 's' : ''}`) : null,
        h('span', { class: 'spacer' }),
        h('button', { onclick: () => window.print() }, 'Print'),
      ),
      h('div', { class: 'elev-grid' }, elev.walls.map((w, i) => this.card(d, g, elev, w, i, k, maxH))),
    );
  }

  card(d, g, elev, w, i, k, maxH) {
    const u = d.units;
    const selectWall = () => this.app.select({ type: 'wall', id: w.wallIds[0] });
    return h('figure', { class: 'elev-card' },
      h('figcaption', {},
        h('div', {},
          h('strong', {}, `${i + 1}. ${w.compass} wall`),
          h('span', { class: 'muted' }, ` · ${formatLength(w.length, u)} · net ${formatArea(faceNet(w), u)}${w.exterior ? ' · exterior' : ''}`),
        ),
        h('button', { class: 'keyplan', title: 'Select this wall', onclick: selectWall }, svgEl(keyPlan(g, w))),
      ),
      svgEl(drawElevation(w, k, maxH, u)),
    );
  }
}

/** Finished wall area of a face: gross minus openings and bulkhead-covered bands. */
function faceNet(w) {
  const openings = w.openings.reduce((a, o) => a + Math.max(0, Math.min(o.s1, w.length) - Math.max(o.s0, 0)) * (o.top - o.bottom), 0);
  const bands = w.bands.reduce((a, b) => a + bandArea(w.profile, b.s0, b.s1, b.bottom), 0);
  return Math.max(0, profileArea(w.profile) - openings - bands);
}

function keyPlan(g, w) {
  const xs = g.polygon.map((p) => p.x);
  const ys = g.polygon.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const size = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY) || 1;
  const s = 44 / size;
  const map = (p) => ({ x: 8 + (p.x - minX) * s, y: 8 + (p.y - minY) * s });
  const P = map(w.P);
  const Q = map(w.Q);
  const mid = { x: (P.x + Q.x) / 2, y: (P.y + Q.y) / 2 };
  // Eye looking from inside the room toward the wall.
  const eye = { x: mid.x - w.outward.x * 12, y: mid.y - w.outward.y * 12 };
  return `<svg viewBox="0 0 60 60" width="60" height="60"><polygon points="${pts(g.polygon.map(map))}" class="kp-room"/>` +
    `<line x1="${n(P.x)}" y1="${n(P.y)}" x2="${n(Q.x)}" y2="${n(Q.y)}" class="kp-wall"/>` +
    `<line x1="${n(eye.x)}" y1="${n(eye.y)}" x2="${n(mid.x - w.outward.x * 3)}" y2="${n(mid.y - w.outward.y * 3)}" class="kp-eye"/>` +
    `<circle cx="${n(eye.x)}" cy="${n(eye.y)}" r="2" class="kp-dot"/></svg>`;
}

function drawElevation(w, k, maxH, units) {
  const L = w.length;
  const x0 = 70;
  const top = 34;
  const baseY = top + maxH * k;
  const VH = baseY + 70;
  const X = (s) => x0 + s * k;
  const Y = (z) => baseY - z * k;
  const fmt = (v) => formatLength(v, units, { precision: 'label' });
  const out = [];

  const outline = [{ x: X(0), y: Y(0) }, { x: X(L), y: Y(0) }, ...[...w.profile].reverse().map((p) => ({ x: X(p.s), y: Y(p.z) }))];
  out.push(`<polygon class="el-wall${w.exterior ? ' exterior' : ''}" points="${pts(outline)}"/>`);
  out.push(`<line class="el-floor" x1="${n(X(0) - 10)}" y1="${n(baseY)}" x2="${n(X(L) + 10)}" y2="${n(baseY)}"/>`);

  for (const op of w.openings) {
    const s0 = Math.max(0, op.s0);
    const s1 = Math.min(L, op.s1);
    if (s1 <= s0) continue;
    const o = op.opening;
    const x = X(s0);
    const y = Y(op.top);
    const wPx = (s1 - s0) * k;
    const hPx = (op.top - op.bottom) * k;
    const cls = `el-opening ${o.type}`;
    out.push(`<rect class="${cls}" x="${n(x)}" y="${n(y)}" width="${n(wPx)}" height="${n(hPx)}"/>`);
    if (o.type === 'window') {
      const inset = Math.min(4, wPx / 6, hPx / 6);
      out.push(`<rect class="el-sash" x="${n(x + inset)}" y="${n(y + inset)}" width="${n(wPx - inset * 2)}" height="${n(hPx - inset * 2)}"/>`);
      out.push(`<line class="el-sash" x1="${n(x + inset)}" y1="${n(y + hPx / 2)}" x2="${n(x + wPx - inset)}" y2="${n(y + hPx / 2)}"/>`);
      out.push(`<line class="el-sill" x1="${n(x - 4)}" y1="${n(y + hPx)}" x2="${n(x + wPx + 4)}" y2="${n(y + hPx)}"/>`);
    } else if (o.type === 'door') {
      // Hinge side: the swing chevron points to the hinged jamb.
      const hingeAtStart = op.forward === !o.flipX;
      const hx = hingeAtStart ? x : x + wPx;
      const lx = hingeAtStart ? x + wPx : x;
      out.push(`<polyline class="el-swing" points="${n(lx)},${n(y)} ${n(hx)},${n(y + hPx / 2)} ${n(lx)},${n(y + hPx)}"/>`);
      out.push(`<circle class="el-knob" cx="${n(lx + (hingeAtStart ? -6 : 6))}" cy="${n(Y(op.bottom + 36 * 25.4))}" r="2.2"/>`);
    }
    const label = `${fmt(o.width)} × ${fmt(o.height)}`;
    const lx = x + wPx / 2;
    const ly = o.type === 'window' ? y - 6 : y + 14;
    out.push(`<text class="el-op-label" x="${n(lx)}" y="${n(ly)}" text-anchor="middle">${esc(label)}</text>`);
    if (o.type === 'window' && op.bottom > 0) {
      out.push(vDim(x + wPx + 10, Y(0), Y(op.bottom), `sill ${fmt(op.bottom)}`, 'el-dim small', 'start'));
    }
  }

  // Bulkheads: hatched band from the underside up to the ceiling line.
  for (const b of w.bands) {
    const ss = [b.s0, ...w.profile.map((p) => p.s).filter((s) => s > b.s0 && s < b.s1), b.s1];
    const top = ss.map((s) => ({ x: X(s), y: Y(Math.max(b.bottom, profileHeightAt(w.profile, s))) }));
    const bottom = ss.map((s) => ({ x: X(s), y: Y(Math.min(b.bottom, profileHeightAt(w.profile, s))) })).reverse();
    out.push(`<polygon class="el-bulkhead" points="${pts([...top, ...bottom])}"/>`);
    const wPx = (b.s1 - b.s0) * k;
    const host = b.resolved.face === w || b.resolved.face.wallIds.some((id) => w.wallIds.includes(id));
    const text = host ? `bulkhead @ ${fmt(b.bottom)}` : fmt(b.bottom);
    const mid = (b.s0 + b.s1) / 2;
    const bandPx = (profileHeightAt(w.profile, mid) - b.bottom) * k;
    if (wPx > text.length * 5.6 && bandPx > 11) {
      const y = (Y(b.bottom) + Y(profileHeightAt(w.profile, mid))) / 2;
      out.push(`<text class="el-bh-label" x="${n(X(mid))}" y="${n(y)}" text-anchor="middle" dominant-baseline="central">${esc(text)}</text>`);
    }
  }

  // Heights: at each end and at any peak in the profile.
  const first = w.profile[0];
  const last = w.profile[w.profile.length - 1];
  out.push(vDim(X(0) - 16, Y(0), Y(first.z), fmt(first.z), 'el-dim', 'end'));
  if (Math.abs(last.z - first.z) > 1) out.push(vDim(X(L) + 16, Y(0), Y(last.z), fmt(last.z), 'el-dim', 'start'));
  for (const p of w.profile.slice(1, -1)) {
    out.push(`<line class="el-peak" x1="${n(X(p.s))}" y1="${n(Y(0))}" x2="${n(X(p.s))}" y2="${n(Y(p.z))}"/>`);
    out.push(`<text class="el-dim-text" x="${n(X(p.s))}" y="${n(Y(p.z) - 8)}" text-anchor="middle">${esc(`peak ${fmt(p.z)}`)}</text>`);
  }

  // Chain dimensions across openings, then the overall width.
  const stops = [0, L];
  for (const op of w.openings) stops.push(Math.max(0, Math.min(L, op.s0)), Math.max(0, Math.min(L, op.s1)));
  const uniq = [...new Set(stops.map((s) => Math.round(s)))].sort((a, b) => a - b);
  if (uniq.length > 2) out.push(hChain(uniq, X, baseY + 20, k, fmt));
  out.push(hChain([0, L], X, baseY + (uniq.length > 2 ? 44 : 22), k, () => formatLength(L, units, { precision: 'label' })));

  const defs = '<defs><pattern id="bh-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="7" height="7" fill="#fdf3e4"/><line x1="0" y1="0" x2="0" y2="7" stroke="#e8b26a" stroke-width="1.4"/></pattern></defs>';
  return `<svg class="elevation" viewBox="0 0 ${VW} ${n(VH)}" preserveAspectRatio="xMidYMid meet">${defs}${out.join('')}</svg>`;
}

function hChain(stops, X, y, k, fmt) {
  let s = `<g class="el-dim"><line x1="${n(X(stops[0]))}" y1="${n(y)}" x2="${n(X(stops[stops.length - 1]))}" y2="${n(y)}"/>`;
  for (const v of stops) s += `<line x1="${n(X(v))}" y1="${n(y - 5)}" x2="${n(X(v))}" y2="${n(y + 5)}"/>`;
  for (let i = 0; i + 1 < stops.length; i++) {
    const w = (stops[i + 1] - stops[i]) * k;
    if (w < 30) continue;
    s += `<text class="el-dim-text" x="${n(X((stops[i] + stops[i + 1]) / 2))}" y="${n(y - 4)}" text-anchor="middle">${esc(fmt(stops[i + 1] - stops[i]))}</text>`;
  }
  return `${s}</g>`;
}

function vDim(x, y0, y1, text, cls, anchor) {
  const mid = (y0 + y1) / 2;
  const tx = anchor === 'end' ? x - 4 : x + 4;
  return `<g class="${cls}"><line x1="${n(x)}" y1="${n(y0)}" x2="${n(x)}" y2="${n(y1)}"/>` +
    `<line x1="${n(x - 4)}" y1="${n(y0)}" x2="${n(x + 4)}" y2="${n(y0)}"/><line x1="${n(x - 4)}" y1="${n(y1)}" x2="${n(x + 4)}" y2="${n(y1)}"/>` +
    `<text class="el-dim-text" x="${n(tx)}" y="${n(mid)}" text-anchor="${anchor}" dominant-baseline="central">${esc(text)}</text></g>`;
}
