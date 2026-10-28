// Interior elevations: every wall face of a room, drawn as seen from inside
// the room, at a shared scale, with openings, ceiling profile and dimensions.
import { analyze, doorStyle, roomElevations } from '../core/model.js';
import { CEILING_TYPES, profileArea, profileHeightAt } from '../core/ceiling.js';
import { bandArea } from '../core/bulkhead.js';
import { formatArea, formatLength } from '../core/units.js';
import { doorMarksSvg, esc, n, pts, wainscotMarksSvg } from './svg.js';
import { h, svgEl } from './dom.js';
import { designFaces, faceKey, faceRef, faceTitle, findFace } from '../core/faces.js';
import { drawOrder, resolveFaceTrim } from '../core/trim.js';
import { faceCutMarks } from '../core/trimCuts.js';
import { compareCuts, cutMarksSvg, cutToggles, differenceText } from './cutPlan.js';

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
    return g ?? analysis.rooms.find((x) => !x.dead) ?? analysis.rooms[0] ?? null;
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

    // The room's walls, then the sides and ends of any stub walls in it.
    const faceList = [...elev.walls, ...elev.spurs];
    const maxLen = Math.max(...faceList.map((w) => w.length), 1);
    const maxH = Math.max(elev.model.maxHeight, ...faceList.flatMap((w) => w.profile.map((p) => p.z)));
    const k = Math.min((VW - 130) / maxLen, 300 / maxH);
    const net = elev.walls.reduce((s, w) => s + faceNet(w), 0);
    const faces = designFaces(d, analysis);
    const cuts = this.app.trimCuts();
    const showCuts = this.app.showTrimCuts && cuts.plan.groups.length > 0;

    this.el.replaceChildren(
      h('div', { class: 'elev-header' },
        h('label', {}, 'Room ', roomSelect),
        h('span', { class: 'chip' }, CEILING_TYPES[elev.spec.type]),
        h('span', { class: 'chip' }, `Floor ${formatArea(g.area, u)}`),
        h('span', { class: 'chip' }, `Ceiling ${formatArea(elev.model.area, u)}`),
        h('span', { class: 'chip' }, `Walls net ${formatArea(net, u)}`),
        elev.bulkheads.length ? h('span', { class: 'chip bh' }, `${elev.bulkheads.length} bulkhead${elev.bulkheads.length > 1 ? 's' : ''}`) : null,
        h('span', { class: 'spacer' }),
        cuts.plan.groups.length ? cutToggles(this.app) : null,
        h('button', { onclick: () => window.print() }, 'Print'),
      ),
      ...(showCuts ? [this.cutSummary(g, cuts)] : []),
      h('div', { class: 'elev-grid' }, faceList.map((w, i) => this.card(d, g, elev, w, i, k, maxH, faces, showCuts ? cuts : null))),
    );
  }

  /**
   * The cut plan for this room (sticks and joins in each trim it uses, in the
   * plan the estimate uses) and, for the whole house, what fewest joins changes.
   */
  cutSummary(g, cuts) {
    const mode = cuts.mode;
    const roomId = g.room?.id ?? null;
    const chips = [];
    for (const grp of cuts.plan.groups) {
      const pieces = grp.pieces.filter((p) => p.roomId === roomId);
      if (!pieces.length) continue;
      const segs = grp.plans[mode].segments;
      const sticks = new Set(pieces.flatMap((p) => (segs.get(p.id) ?? []).map((sg) => sg.stick)));
      const joins = pieces.reduce((s, p) => s + Math.max(0, (segs.get(p.id)?.length ?? 1) - 1), 0);
      const word = grp.kind === 'sheet' ? 'seam' : 'join';
      chips.push(h('span', { class: `chip cut-chip${joins ? ' has-joins' : ''}`, title: `Lengths of stock this room's ${grp.code} trim comes from (some are shared with other rooms)` },
        h('strong', {}, grp.code), ` ${sticks.size} ${grp.kind === 'sheet' ? 'panel' : grp.kind === 'boards' ? 'board' : 'stick'}${sticks.size === 1 ? '' : 's'} · ${joins} ${word}${joins === 1 ? '' : 's'}`));
    }
    const diff = differenceText(compareCuts(cuts));
    return h('div', { class: 'elev-cuts' },
      h('span', { class: 'muted small' }, `Cut plan (${mode === 'joins' ? 'fewest joins' : 'least material'}):`),
      chips.length ? chips : h('span', { class: 'muted small' }, 'no trim in this room'),
      h('span', { class: 'spacer' }),
      h('span', { class: `chip cut-diff${mode === 'joins' ? ' on' : ''}` }, mode === 'joins' ? `Whole house vs least material: ${diff}` : `Fewest joins would be: ${diff}`));
  }

  card(d, g, elev, w, i, k, maxH, faces, cuts) {
    const u = d.units;
    const selectWall = () => this.app.select({ type: 'wall', id: w.wallIds[0] });
    const face = findFace(faces, faceRef(w));
    const trim = face ? resolveFaceTrim(d, face) : null;
    const marks = cuts && face ? faceCutMarks(cuts.plan, cuts.mode, faceKey(faceRef(face))) : null;
    return h('figure', { class: 'elev-card' },
      h('figcaption', {},
        h('div', {},
          h('strong', {}, faceTitle(w, i + 1)),
          h('span', { class: 'muted' }, ` · ${formatLength(w.length, u)} · net ${formatArea(faceNet(w), u)}${w.exterior ? ' · exterior' : ''}`),
        ),
        h('div', { class: 'elev-actions' },
          h('button', { onclick: () => this.app.openFace(faceRef(w)) }, trim?.items.length ? 'Edit trim' : 'Add trim'),
          h('button', { class: 'keyplan', title: 'Select this wall', onclick: selectWall }, svgEl(keyPlan(g, w)))),
      ),
      svgEl(drawElevation(w, k, maxH, u, trim, marks)),
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

function drawElevation(w, k, maxH, units, trim, cutMarks) {
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
      // Hinge side: the swing chevron points to the hinged jamb (sliding doors: an arrow to the side they open to).
      const hingeAtStart = op.forward === !o.flipX;
      const style = doorStyle(o);
      out.push(doorMarksSvg(style, x, y, wPx, hPx, hingeAtStart, 'el'));
      if (style === 'single') {
        const lx = hingeAtStart ? x + wPx : x;
        out.push(`<circle class="el-knob" cx="${n(lx + (hingeAtStart ? -6 : 6))}" cy="${n(Y(op.bottom + 36 * 25.4))}" r="2.2"/>`);
      }
    }
    const label = `${fmt(o.width)} × ${fmt(o.height)}`;
    const lx = x + wPx / 2;
    const ly = o.type === 'window' ? y - 6 : y + 14;
    out.push(`<text class="el-op-label" x="${n(lx)}" y="${n(ly)}" text-anchor="middle">${esc(label)}</text>`);
    if (o.type === 'window' && op.bottom > 0) {
      out.push(vDim(x + wPx + 10, Y(0), Y(op.bottom), `sill ${fmt(op.bottom)}`, 'el-dim small', 'start'));
    }
  }

  // Stub walls meeting this face: the wall runs out toward the viewer here, so trim stops either side.
  for (const j of w.junctions ?? []) {
    const ss = [j.s0, ...w.profile.map((p) => p.s).filter((s) => s > j.s0 && s < j.s1), j.s1];
    out.push(`<polygon class="el-junction" points="${pts([{ x: X(j.s0), y: Y(0) }, { x: X(j.s1), y: Y(0) }, ...ss.reverse().map((s) => ({ x: X(s), y: Y(profileHeightAt(w.profile, s)) }))])}"/>`);
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

  // A tray ceiling rises beyond the wall top: dashed outline with its height
  // (before the trim, so crown in the tray draws on top of it).
  if (w.tray) {
    const t = w.tray;
    const [x0, x1, yb, yt] = [X(t.s0), X(t.s1), Y(t.bottom), Y(t.top)];
    out.push(`<polygon class="el-tray" points="${n(x0)},${n(yb)} ${n(x0)},${n(yt)} ${n(x1)},${n(yt)} ${n(x1)},${n(yb)}"/>`);
    out.push(`<text class="el-dim-text" x="${n((x0 + x1) / 2)}" y="${n(yt - 6)}" text-anchor="middle">${esc(`tray ${fmt(t.top)} (+${fmt(t.top - t.bottom)})`)}</text>`);
    out.push(vDim(X(L) + 16, Y(0), yt, fmt(t.top), 'el-dim', 'start'));
  }

  // Cabinets and fixtures against the wall that trim stops at (see trimObstructions).
  for (const ob of trim?.obstructions ?? []) out.push(obstructionSvg(ob, X, Y, w.profile));

  // Trim drawn on this face in the Trim tab, wainscot first so it never hides the baseboard.
  for (const r of drawOrder(trim?.items ?? [])) {
    for (const p of r.pieces) {
      const rings = [p.poly, ...(p.hole ? [p.hole] : p.holes ?? [])];
      const d = rings.map((ring) => `M${ring.map((q) => `${n(X(q.s))} ${n(Y(q.z))}`).join('L')}Z`).join('');
      const pat = p.marks ? ` pat-${p.marks.pattern}` : '';
      out.push(`<path class="el-trim tc-${r.item.kind === 'wainscot' ? 'wainscot' : r.item.category}${pat}" fill-rule="evenodd" d="${d}"/>`);
      // With the cut plan shown, its seams replace the evenly spaced sheet seams.
      if (p.marks) out.push(wainscotMarksSvg(cutMarks ? { ...p.marks, lines: p.marks.lines.filter((l) => l.kind !== 'seam') } : p.marks, X, Y, k));
    }
  }
  if (cutMarks) out.push(cutMarksSvg(cutMarks, X, Y, k));

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

/** A cabinet or fixture against the wall: its outline up to its height (or the ceiling), named. */
export function obstructionSvg(ob, X, Y, profile, cls = 'el') {
  const top = Math.min(ob.top, profileHeightAt(profile, (ob.s0 + ob.s1) / 2));
  const [x0, x1, y0, y1] = [X(ob.s0), X(ob.s1), Y(ob.bottom), Y(top)];
  const label = x1 - x0 > ob.name.length * 5 + 8 && y0 - y1 > 14
    ? `<text class="${cls}-obstruction-label" x="${n((x0 + x1) / 2)}" y="${n((y0 + y1) / 2)}" text-anchor="middle" dominant-baseline="central">${esc(ob.name)}</text>` : '';
  return `<g class="${cls}-obstruction"><rect x="${n(x0)}" y="${n(y1)}" width="${n(x1 - x0)}" height="${n(y0 - y1)}"><title>${esc(ob.name)}: no trim behind it</title></rect>${label}</g>`;
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
