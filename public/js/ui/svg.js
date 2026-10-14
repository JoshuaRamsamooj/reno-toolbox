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
