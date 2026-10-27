// Flooring layer for the plan: each run's pieces clipped to its floor (the
// grout or seams showing between them), cuts tinted by how small they are,
// and for the active run its origin handle, the row widths at the walls and
// a screen-space summary of the layout and what to buy.
import { BUY_UNITS, FLOOR_KINDS } from '../core/flooring.js';
import { formatLength } from '../core/units.js';
import { RULER } from './canvas.js';
import { esc, n, pts, tag } from './svg.js';

const GRADES = ['full', 'cut', 'warn', 'sliver'];

/**
 * Pieces of a run as one path per grade, clipped to the run's floor. With
 * `thresholds`, only the doorway strips (drawn again over the walls, which
 * run solid through openings on the plan).
 */
export function renderFloorRun(view, layout, { active, thresholds = false }) {
  const r = layout.run;
  const f = layout.frame;
  const id = `fl-clip-${r.id}${thresholds ? '-th' : ''}`;
  const parts = thresholds ? layout.region.parts.filter((p) => p.kind === 'threshold') : layout.region.parts;
  if (!parts.length) return '';
  const polys = parts.map((p) => tag('polygon', { points: pts(p.polygon) }, null)).join('');
  // Below a few pixels per piece only the problem cuts are drawn individually.
  const piecePx = Math.min(r.length, r.width) * view.view.scale;
  const detailed = piecePx >= 3;
  const paths = Object.fromEntries(GRADES.map((g) => [g, []]));
  for (const p of layout.pieces) {
    if (thresholds && !p.threshold) continue;
    if (!detailed && (p.grade === 'full' || p.grade === 'cut')) continue;
    const a = f.toXY(p.u0, p.v0);
    const b = f.toXY(p.u1, p.v0);
    const c = f.toXY(p.u1, p.v1);
    const d = f.toXY(p.u0, p.v1);
    paths[p.grade].push(`M${n(a.x)} ${n(a.y)}L${n(b.x)} ${n(b.y)}L${n(c.x)} ${n(c.y)}L${n(d.x)} ${n(d.y)}Z`);
  }
  const sw = view.px(piecePx > 12 ? 1 : 0.6);
  const body = GRADES.filter((g) => paths[g].length)
    .map((g) => `<path class="fl-piece ${g}" d="${paths[g].join('')}" stroke-width="${n(sw)}"/>`).join('');
  return `<clipPath id="${esc(id)}">${polys}</clipPath>` +
    `<g class="fl-run fl-${r.kind}${active ? ' active' : ''}" clip-path="url(#${esc(id)})">` +
    `<g class="fl-ground">${polys}</g>${body}</g>`;
}

/**
 * Marks for the active run: the origin handle with the run direction, the
 * first and last row widths at the walls (and columns for a straight grid),
 * and the corners or centres the origin snapped to while dragging.
 */
export function renderFloorMarks(view, layout, { snap }) {
  const r = layout.run;
  const f = layout.frame;
  const u = view.units;
  const px = (v) => view.px(v);
  const out = [];
  const e = layout.extent;
  const ends = layout.ends;
  const fmt = (mm) => formatLength(mm, u, { precision: 'label' });
  if (e && ends) {
    // A third of the way along, clear of the wall dimensions at the midpoints.
    const mid = e.u0 + (e.u1 - e.u0) / 3;
    const rows = [[e.v0 + ends.v.first / 2, ends.v.first], [e.v1 - ends.v.last / 2, ends.v.last]];
    if (ends.v.courses > 1 && Math.min(ends.v.first, ends.v.last) * view.view.scale >= 9) {
      for (const [v, w] of rows) out.push(view.label(f.toXY(mid, v), fmt(w), 0, `fl-dim${w < layout.limits.rip.warn - 0.5 ? ' bad' : ''}`, 10.5));
    }
    if (ends.u && ends.u.courses > 1 && Math.min(ends.u.first, ends.u.last) * view.view.scale >= 24) {
      const vm = e.v0 + (e.v1 - e.v0) / 3;
      for (const [uu, w] of [[e.u0 + ends.u.first / 2, ends.u.first], [e.u1 - ends.u.last / 2, ends.u.last]]) {
        out.push(view.label(f.toXY(uu, vm), fmt(w), 0, `fl-dim${w < layout.limits.end.warn - 0.5 ? ' bad' : ''}`, 10.5));
      }
    }
  }
  // Origin handle: a ring on the corner of course 0 and an arrow along the run.
  const o = f.origin;
  const tip = { x: o.x + f.dir.x * px(34), y: o.y + f.dir.y * px(34) };
  const head = [
    tip,
    { x: tip.x - f.dir.x * px(8) + f.nrm.x * px(4.5), y: tip.y - f.dir.y * px(8) + f.nrm.y * px(4.5) },
    { x: tip.x - f.dir.x * px(8) - f.nrm.x * px(4.5), y: tip.y - f.dir.y * px(8) - f.nrm.y * px(4.5) },
  ];
  out.push(`<g class="fl-origin">${
    tag('line', { x1: o.x, y1: o.y, x2: tip.x, y2: tip.y, 'stroke-width': px(2) }, null)}${
    tag('polygon', { points: pts(head) }, null)}${
    tag('circle', { cx: o.x, cy: o.y, r: px(6), 'stroke-width': px(2) }, null)}</g>`);
  for (const p of snap ?? []) out.push(tag('circle', { class: 'fl-snap', cx: p.x, cy: p.y, r: px(5), 'stroke-width': px(1.5) }, null));
  return `<g class="fl-marks">${out.join('')}</g>`;
}

/** Summary box in screen space (bottom left): the run, its row widths and cut check, and what to buy. */
export function renderFloorLegend(layout, units, dragging, canvasHeight) {
  const r = layout.run;
  const s = layout.stats;
  const m = layout.material;
  const fmt = (mm) => formatLength(mm, units, { precision: 'label' });
  const [, many] = BUY_UNITS[r.unit];
  const pieces = FLOOR_KINDS[r.kind].pieces;
  const lines = [];
  if (layout.ends) lines.push(`Rows: ${fmt(layout.ends.v.first)} at ${layout.ends.vFrom.toLowerCase()} wall · ${fmt(layout.ends.v.last)} at ${layout.ends.vTo.toLowerCase()}`);
  const parts = [];
  if (s.shortestEnd) parts.push(`shortest end ${fmt(s.shortestEnd.needL)}`);
  if (s.narrowestRip) parts.push(`narrowest rip ${fmt(s.narrowestRip.needW)}`);
  if (parts.length) lines.push(parts.join(' · ').replace(/^./, (c) => c.toUpperCase()));
  const problems = s.slivers ? `${s.slivers} sliver${s.slivers === 1 ? '' : 's'}${s.trafficIssues ? ` (${s.trafficIssues} in traffic)` : ''}` : 'no slivers';
  lines.push(`${s.cut} cut of ${s.pieces} ${pieces} · ${problems}`);
  const buy = r.perBox > 1 ? `${m.boxes} ${many} (${m.buy} ${pieces})` : `${m.boxes} ${many}`;
  lines.push(`Buy ${buy} incl. ${r.waste}% waste`);
  const W = 320;
  const H = 34 + lines.length * 15 + 22;
  const x = RULER + 10;
  const y = Math.max(RULER + 10, canvasHeight - H - 12);
  const key = [['full', 'Full'], ['cut', 'Cut'], ['warn', 'Under ½'], ['sliver', 'Sliver']];
  return `<g class="fl-legend${s.slivers ? ' has-slivers' : ''}" transform="translate(${x} ${y})">` +
    `<rect class="fl-legend-bg" width="${W}" height="${H}" rx="6"/>` +
    `<text x="10" y="18" class="title">${esc(r.name)}${dragging ? ' · moving' : ''}</text>` +
    lines.map((t, i) => `<text x="10" y="${36 + i * 15}">${esc(t)}</text>`).join('') +
    `<g transform="translate(10 ${H - 16})">${key.map(([g, label], i) => `<g transform="translate(${i * 74} 0)" class="fl-${r.kind}"><rect class="fl-piece ${g}" width="12" height="9" y="-8"/><text x="16" y="0" class="sub">${label}</text></g>`).join('')}</g>` +
    '</g>';
}
