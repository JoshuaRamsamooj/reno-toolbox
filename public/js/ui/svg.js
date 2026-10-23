// Tiny helpers for building SVG markup strings.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** Compact number for attributes. */
export const n = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : 0);

export const pts = (list) => list.map((p) => `${n(p.x)},${n(p.y)}`).join(' ');

export function attrs(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== false)
    .map(([k, v]) => `${k}="${typeof v === 'number' ? n(v) : esc(v)}"`)
    .join(' ');
}

export const tag = (name, a = {}, body = '') => (body === null ? `<${name} ${attrs(a)}/>` : `<${name} ${attrs(a)}>${body}</${name}>`);

/** Angle in degrees for text along a direction, flipped to stay upright. */
export function uprightAngle(dir) {
  let a = (Math.atan2(dir.y, dir.x) * 180) / Math.PI;
  if (a > 90.01) a -= 180;
  if (a < -89.99) a += 180;
  return a;
}

/**
 * Wainscot marks (from core/trim.js wainscotMarks) as SVG, mapped by X(s) and
 * Y(z) at `scale` px/mm. Grooves are dropped once closer than 3 px.
 */
export function wainscotMarksSvg(marks, X, Y, scale) {
  const byKind = new Map();
  for (const l of marks.lines) {
    if (l.kind === 'groove' && marks.spacing * scale < 3) continue;
    byKind.set(l.kind, (byKind.get(l.kind) ?? '') + `M${n(X(l.s0))} ${n(Y(l.z0))}L${n(X(l.s1))} ${n(Y(l.z1))}`);
  }
  const strips = marks.strips.map((ring) => `M${ring.map((q) => `${n(X(q.s))} ${n(Y(q.z))}`).join('L')}Z`).join('');
  return `<g class="fe-wmarks pat-${marks.pattern}">${strips ? `<path class="fe-wstrip" d="${strips}"/>` : ''}${
    [...byKind].map(([kind, d]) => `<path class="fe-wline ${kind}" d="${d}"/>`).join('')}</g>`;
}
