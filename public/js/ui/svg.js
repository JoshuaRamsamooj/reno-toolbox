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

/**
 * Door marks on an elevation, for a door drawn at x, y (top left, px), w × h:
 * a swing chevron pointing to the hinge (two for a pair, meeting in the
 * middle), or for sliding styles an arrow toward the side the door opens to,
 * the meeting line of bypass panels, and a barn door's track above the
 * opening. `hingeAtStart`: the hinge (or slide side) is on the left. Classes
 * are `${prefix}-swing`, -meet, -slide and -track.
 */
export function doorMarksSvg(style, x, y, w, h, hingeAtStart, prefix) {
  const chevron = (hx, lx) => `<polyline class="${prefix}-swing" points="${n(lx)},${n(y)} ${n(hx)},${n(y + h / 2)} ${n(lx)},${n(y + h)}"/>`;
  const meet = (mx) => `<line class="${prefix}-meet" x1="${n(mx)}" y1="${n(y)}" x2="${n(mx)}" y2="${n(y + h)}"/>`;
  if (style === 'single') return chevron(hingeAtStart ? x : x + w, hingeAtStart ? x + w : x);
  if (style === 'double') return chevron(x, x + w / 2) + chevron(x + w, x + w / 2) + meet(x + w / 2);
  const out = [];
  const ay = y + h * 0.45;
  const len = Math.min(w * 0.3, 36);
  const head = Math.min(6, len / 3);
  const arrow = (from, dir) => {
    const tip = from + dir * len;
    return `<path class="${prefix}-slide" d="M${n(from)} ${n(ay)}H${n(tip)}M${n(tip - dir * head)} ${n(ay - head)}L${n(tip)} ${n(ay)}L${n(tip - dir * head)} ${n(ay + head)}"/>`;
  };
  if (style === 'sliding') {
    out.push(meet(x + w / 2), arrow(x + w / 2 - 4, -1), arrow(x + w / 2 + 4, 1));
  } else {
    const dir = hingeAtStart ? -1 : 1;
    out.push(arrow(x + w / 2 - (dir * len) / 2, dir));
  }
  if (style === 'barn') {
    const t0 = hingeAtStart ? x - w : x;
    out.push(`<line class="${prefix}-track" x1="${n(t0)}" y1="${n(y - 5)}" x2="${n(t0 + 2 * w)}" y2="${n(y - 5)}"/>`);
  }
  return out.join('');
}
