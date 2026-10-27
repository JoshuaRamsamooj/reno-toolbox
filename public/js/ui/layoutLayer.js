// Plan symbols for furniture, cabinets, fixtures and appliances (see
// core/furniture.js), drawn in each item's own frame: x across its width,
// y from its back (-d/2) to its front (+d/2). The caller wraps them in a
// group translated to the item's centre and rotated to its angle.
import { MM_PER_IN } from '../core/units.js';
import { localShape } from '../core/furniture.js';
import { esc, n, pts, tag } from './svg.js';

const IN = MM_PER_IN;

const rect = (x0, y0, x1, y1, cls, extra = {}) => tag('rect', { class: cls, x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0), ...extra }, null);
const line = (x1, y1, x2, y2, cls, extra = {}) => tag('line', { class: cls, x1, y1, x2, y2, ...extra }, null);
const circle = (cx, cy, r, cls, extra = {}) => tag('circle', { class: cls, cx, cy, r: Math.max(0, r), ...extra }, null);
const ellipse = (cx, cy, rx, ry, cls) => tag('ellipse', { class: cls, cx, cy, rx: Math.max(0, rx), ry: Math.max(0, ry) }, null);
const poly = (list, cls) => tag('polygon', { class: cls, points: pts(list) }, null);

/** Short text drawn inside appliances ("REF", "DW"); the caller rotates it upright. */
export function applianceTag(r) {
  const sz = r.sizeDef ?? {};
  switch (r.def.symbol) {
    case 'fridge': return 'REF';
    case 'dw': return 'DW';
    case 'micro': return 'MW';
    case 'oven': return sz.ovens === 2 ? 'OVEN ×2' : 'OVEN';
    case 'heater': return r.mount === 'overhead' ? 'TWH' : 'WH';
    case 'furnace': return r.sizeDef?.id === 'air-handler' ? 'AH' : 'FURN';
    case 'laundry': return sz.stacked ? 'W/D' : r.type === 'dryer' ? 'D' : 'W';
    case 'tv': return 'TV';
    default: return null;
  }
}

/**
 * The symbol's markup in local coordinates. `sw` is a 1 px stroke in plan
 * units, for the few details drawn thinner or dashed.
 */
export function furnitureSymbol(r, sw) {
  const { w, d } = r;
  const x0 = -w / 2;
  const x1 = w / 2;
  const y0 = -d / 2;
  const y1 = d / 2;
  const shape = localShape(r);
  const body = r.shape === 'round' ? ellipse(0, 0, w / 2, d / 2, 'fu-body') : poly(shape.outline, 'fu-body');
  const dash = `${n(sw * 5)} ${n(sw * 3)}`;
  const sz = r.sizeDef ?? {};
  const out = [body];
  const inset = (k) => Math.min(k, w / 4, d / 4);
  const cross = () => out.push(line(x0, y0, x1, y1, 'fu-line thin'), line(x1, y0, x0, y1, 'fu-line thin'));
  switch (r.def.symbol) {
    case 'bed': {
      const k = inset(2 * IN);
      const pw = w > 45 * IN ? (w - 3 * k) / 2 : w - 2 * k;
      const ph = Math.min(10 * IN, d * 0.16);
      out.push(rect(x0 + k, y0 + k, x0 + k + pw, y0 + k + ph, 'fu-detail', { rx: n(ph / 3) }));
      if (w > 45 * IN) out.push(rect(x1 - k - pw, y0 + k, x1 - k, y0 + k + ph, 'fu-detail', { rx: n(ph / 3) }));
      const fold = y0 + d * 0.32;
      out.push(line(x0, fold, x1, fold, 'fu-line'), line(x0, fold + 3 * IN, x1, fold + 3 * IN, 'fu-line thin'));
      if (r.type === 'bed' && sz.id === 'crib') for (let x = x0 + 4 * IN; x < x1 - 2 * IN; x += 4 * IN) out.push(line(x, y0, x, y0 + 2 * IN, 'fu-line thin'));
      break;
    }
    case 'bunk': {
      const k = inset(2 * IN);
      out.push(rect(x0 + k, y0 + k, x1 - k, y0 + k + Math.min(10 * IN, d * 0.14), 'fu-detail'));
      out.push(line(x0, y0, x1, y1, 'fu-line thin', { 'stroke-dasharray': dash }), line(x1, y0, x0, y1, 'fu-line thin', { 'stroke-dasharray': dash }));
      break;
    }
    case 'nightstand':
      out.push(circle(0, 0, Math.min(w, d) * 0.25, 'fu-detail'));
      break;
    case 'dresser': {
      out.push(line(x0, y1 - inset(1.5 * IN), x1, y1 - inset(1.5 * IN), 'fu-line'));
      const parts = Math.max(1, Math.round(w / (20 * IN)));
      for (let i = 1; i < parts; i++) out.push(line(x0 + (w * i) / parts, y0, x0 + (w * i) / parts, y1, 'fu-line thin'));
      break;
    }
    case 'wardrobe':
      out.push(line(0, y0, 0, y1, 'fu-line thin'), line(x0 + inset(2 * IN), 0, x1 - inset(2 * IN), 0, 'fu-line thin', { 'stroke-dasharray': dash }));
      break;
    case 'bench': {
      const k = inset(1.5 * IN);
      out.push(rect(x0 + k, y0 + k, x1 - k, y1 - k, 'fu-line thin'));
      if (r.type === 'mudroom-bench') {
        const hooks = Math.max(2, Math.round(w / (12 * IN)));
        for (let i = 0; i < hooks; i++) out.push(circle(x0 + (w * (i + 0.5)) / hooks, y0 + 2 * IN, IN, 'fu-detail'));
      }
      break;
    }
    case 'desk':
      if (r.shape === 'rect') out.push(line(x0 + inset(2 * IN), y0 + inset(2 * IN), x1 - inset(2 * IN), y0 + inset(2 * IN), 'fu-line thin'));
      break;
    case 'chair': {
      const back = d * 0.24;
      const arm = w * 0.16;
      out.push(rect(x0, y0, x1, y0 + back, 'fu-detail'), rect(x0, y0 + back, x0 + arm, y1, 'fu-detail'), rect(x1 - arm, y0 + back, x1, y1, 'fu-detail'));
      if (r.type === 'recliner') out.push(rect(x0 + arm, y1, x1 - arm, y1 + 18 * IN, 'fu-line thin', { 'stroke-dasharray': dash }));
      break;
    }
    case 'sofa': {
      const back = Math.min(9 * IN, d * 0.26);
      const arm = Math.min(7 * IN, w * 0.1);
      out.push(rect(x0, y0, x1, y0 + back, 'fu-detail'), rect(x0, y0 + back, x0 + arm, y1, 'fu-detail'), rect(x1 - arm, y0 + back, x1, y1, 'fu-detail'));
      const seats = r.seats || 3;
      const sw0 = (w - 2 * arm) / seats;
      for (let i = 1; i < seats; i++) out.push(line(x0 + arm + sw0 * i, y0 + back, x0 + arm + sw0 * i, y1, 'fu-line thin'));
      break;
    }
    case 'sectional': {
      const back = Math.min(9 * IN, r.leg * 0.25);
      out.push(rect(x0, y0, x1, y0 + back, 'fu-detail'));
      const leftLeg = r.shape === 'U' || (r.shape === 'L' && r.side === 'left');
      const rightLeg = r.shape === 'U' || (r.shape === 'L' && r.side !== 'left');
      if (leftLeg) out.push(rect(x0, y0 + back, x0 + back, y1, 'fu-detail'));
      if (rightLeg) out.push(rect(x1 - back, y0 + back, x1, y1, 'fu-detail'));
      // Seat cushions along the back.
      const from = x0 + (leftLeg ? Math.min(r.leg, w / 2) : 0);
      const to = x1 - (rightLeg ? Math.min(r.leg, w / 2) : 0);
      const seats = Math.max(1, Math.round((to - from) / (26 * IN)));
      for (let i = 0; i <= seats; i++) out.push(line(from + ((to - from) * i) / seats, y0 + back, from + ((to - from) * i) / seats, y0 + Math.min(r.leg, d), 'fu-line thin'));
      break;
    }
    case 'ottoman':
      out.push(r.shape === 'round' ? ellipse(0, 0, w / 2 - inset(2 * IN), d / 2 - inset(2 * IN), 'fu-line thin') : rect(x0 + inset(2 * IN), y0 + inset(2 * IN), x1 - inset(2 * IN), y1 - inset(2 * IN), 'fu-line thin', { rx: n(2 * IN) }));
      break;
    case 'table':
      out.push(r.shape === 'round' ? ellipse(0, 0, w / 2 - inset(1.5 * IN), d / 2 - inset(1.5 * IN), 'fu-line thin') : rect(x0 + inset(1.5 * IN), y0 + inset(1.5 * IN), x1 - inset(1.5 * IN), y1 - inset(1.5 * IN), 'fu-line thin'));
      break;
    case 'media': {
      out.push(line(x0, y1 - inset(1.5 * IN), x1, y1 - inset(1.5 * IN), 'fu-line thin'));
      const tvw = (r.screen ?? 55) * 0.872 * IN;
      out.push(rect(-tvw / 2, -1.5 * IN, tvw / 2, 1.5 * IN, 'fu-screen'));
      break;
    }
    case 'tv':
      out.push(line(x0, y1, x1, y1, 'fu-screen-line'));
      break;
    case 'shelves': {
      const parts = Math.max(1, Math.round(w / (12 * IN)));
      for (let i = 1; i < parts; i++) out.push(line(x0 + (w * i) / parts, y0, x0 + (w * i) / parts, y1, 'fu-line thin'));
      break;
    }
    case 'dining':
      out.push(...diningChairs(r));
      break;
    case 'dchair': {
      const back = Math.min(3 * IN, d * 0.18);
      out.push(rect(x0, y0, x1, y0 + back, 'fu-detail'));
      break;
    }
    case 'stool':
      out.push(ellipse(0, 0, w * 0.3, d * 0.3, 'fu-line thin'));
      break;
    case 'swivel': {
      out.push(rect(-10 * IN, -9 * IN, 10 * IN, 10 * IN, 'fu-detail', { rx: n(3 * IN) }));
      out.push(rect(-9 * IN, -11 * IN, 9 * IN, -7 * IN, 'fu-detail', { rx: n(2 * IN) }));
      break;
    }
    case 'file': {
      const drawers = r.sizeDef?.id === 'vertical' ? 4 : 3;
      for (let i = 1; i < drawers; i++) out.push(line(x0 + (w * i) / drawers, y0, x0 + (w * i) / drawers, y1, 'fu-line thin'));
      break;
    }
    case 'base': {
      // Door line just behind the front; corner units follow their outline.
      if (r.shape === 'rect') {
        out.push(line(x0, y1 - IN, x1, y1 - IN, 'fu-line thin'));
        if (r.sizeDef?.id === 'blind') out.push(rect(r.side === 'left' ? x0 : x1 - 18 * IN, y0, r.side === 'left' ? x0 + 18 * IN : x1, y1, 'fu-line thin', { 'stroke-dasharray': dash }));
      } else if (r.shape === 'corner') {
        // Lazy Susan in the corner square (back left, or back right when mirrored).
        const leg = Math.min(r.leg, w, d);
        const cx = r.side === 'right' ? x1 - leg / 2 : x0 + leg / 2;
        out.push(circle(cx, y0 + leg / 2, leg * 0.4, 'fu-line thin', { 'stroke-dasharray': dash }));
      }
      break;
    }
    case 'upper':
      out.push(line(x0, y0, x1, y1, 'fu-line thin'));
      break;
    case 'tall':
      cross();
      break;
    case 'island':
      out.push(line(x0, y1 - Math.min(12 * IN, d * 0.3), x1, y1 - Math.min(12 * IN, d * 0.3), 'fu-line thin', { 'stroke-dasharray': dash }));
      break;
    case 'sink':
      out.push(...sinkBowls(r));
      break;
    case 'range':
      out.push(...burners(r));
      if (r.mount !== 'counter') out.push(line(x0, y1 - 2 * IN, x1, y1 - 2 * IN, 'fu-line thin'));
      break;
    case 'oven':
      cross();
      out.push(rect(x0 + inset(3 * IN), y1 - 4 * IN, x1 - inset(3 * IN), y1 - IN, 'fu-line thin'));
      break;
    case 'dw':
      out.push(line(x0, y1 - IN, x1, y1 - IN, 'fu-line thin'));
      break;
    case 'micro':
      out.push(line(x0, y1 - IN, x1, y1 - IN, 'fu-line thin'));
      break;
    case 'hood': {
      const k = Math.min(w, d) * 0.22;
      out.push(rect(-k, -k, k, k, 'fu-line thin'));
      out.push(line(x0, y0, -k, -k, 'fu-line thin'), line(x1, y0, k, -k, 'fu-line thin'), line(x0, y1, -k, k, 'fu-line thin'), line(x1, y1, k, k, 'fu-line thin'));
      break;
    }
    case 'fridge': {
      out.push(line(x0, y1 - 2 * IN, x1, y1 - 2 * IN, 'fu-line thin'));
      const id = r.sizeDef?.id;
      if (id === 'french') out.push(line(0, y1 - 2 * IN, 0, y1 - Math.min(d * 0.5, 14 * IN), 'fu-line thin'));
      if (id === 'side-by-side') out.push(line(0, y1 - 2 * IN, 0, y0 + 2 * IN, 'fu-line thin'));
      break;
    }
    case 'toilet': {
      const tank = sz.tank === false ? 0 : Math.min(9 * IN, d * 0.32);
      if (tank) out.push(rect(x0, y0, x1, y0 + tank, 'fu-detail', { rx: n(IN) }));
      else out.push(rect(x0 + w * 0.15, y0, x1 - w * 0.15, y0 + 2 * IN, 'fu-detail'));
      const bowlLen = d - tank - (tank ? IN : 2 * IN);
      const ry = sz.bowl === 'round' ? bowlLen * 0.45 : bowlLen * 0.5;
      out.push(ellipse(0, y1 - ry, w * 0.42, ry, 'fu-detail'), ellipse(0, y1 - ry + IN, w * 0.26, ry * 0.62, 'fu-line thin'));
      break;
    }
    case 'bidet':
      out.push(ellipse(0, IN, w * 0.42, d * 0.42, 'fu-detail'), ellipse(0, 2 * IN, w * 0.25, d * 0.26, 'fu-line thin'), circle(0, y0 + 3 * IN, IN, 'fu-line thin'));
      break;
    case 'vanity': {
      const bowls = sz.bowls ?? 1;
      for (let i = 0; i < bowls; i++) {
        const cx = bowls === 1 ? 0 : (i === 0 ? -1 : 1) * w * 0.25;
        out.push(ellipse(cx, IN, Math.min(8 * IN, w * 0.18 * (bowls === 1 ? 2 : 1)), Math.min(6.5 * IN, d * 0.32), 'fu-detail'), circle(cx, y0 + 2.5 * IN, IN * 0.75, 'fu-line thin'));
      }
      break;
    }
    case 'pedestal':
      if (r.type === 'utility-sink') out.push(rect(x0 + 2 * IN, y0 + 3 * IN, x1 - 2 * IN, y1 - 2 * IN, 'fu-detail', { rx: n(2 * IN) }));
      else out.push(ellipse(0, IN, w * 0.36, d * 0.34, 'fu-detail'), circle(0, y0 + 2.5 * IN, IN * 0.75, 'fu-line thin'));
      break;
    case 'tub': {
      if (r.shape === 'round') {
        out.push(ellipse(0, 0, w / 2 - 3 * IN, d / 2 - 3 * IN, 'fu-detail'), circle(w / 2 - 9 * IN, 0, IN, 'fu-line thin'));
      } else {
        const k = inset(3 * IN);
        out.push(rect(x0 + k, y0 + k, x1 - k, y1 - k, 'fu-detail', { rx: n(Math.min(8 * IN, d / 4)) }), circle(x0 + k + 4 * IN, 0, IN, 'fu-line thin'));
      }
      break;
    }
    case 'shower': {
      if (r.shape === 'diag') {
        out.push(poly(shape.outline.map((p) => ({ x: p.x * 0.88, y: p.y * 0.88 })), 'fu-line thin'));
      } else {
        out.push(line(x0, y0, x1, y1, 'fu-line thin'), line(x1, y0, x0, y1, 'fu-line thin'));
        if (sz.glass) out.push(line(x0, y1, x0 + w * 0.55, y1, 'fu-glass'));
      }
      out.push(circle(0, 0, 1.5 * IN, 'fu-detail'));
      break;
    }
    case 'laundry-pair': {
      out.push(line(0, y0, 0, y1, 'fu-line'));
      for (const cx of [-w / 4, w / 4]) out.push(circle(cx, IN, Math.min(w / 4, d / 2) * 0.62, 'fu-line thin'));
      out.push(line(x0, y1 - 2 * IN, x1, y1 - 2 * IN, 'fu-line thin'));
      break;
    }
    case 'laundry':
      out.push(circle(0, IN, Math.min(w, d) * 0.3, 'fu-line thin'), line(x0, y1 - 2 * IN, x1, y1 - 2 * IN, 'fu-line thin'));
      if (sz.stacked) out.push(line(x0, y0, x1, y1 - 2 * IN, 'fu-line thin'));
      break;
    case 'heater':
      if (r.shape === 'round') out.push(ellipse(0, 0, w * 0.32, d * 0.32, 'fu-line thin'));
      break;
    case 'furnace':
      out.push(rect(x0 + inset(2 * IN), y0 + inset(2 * IN), x1 - inset(2 * IN), y1 - inset(2 * IN), 'fu-line thin'));
      break;
    case 'rug': {
      const k = Math.min(4 * IN, w / 6, d / 6);
      out.push(r.shape === 'round' ? ellipse(0, 0, w / 2 - k, d / 2 - k, 'fu-line thin') : rect(x0 + k, y0 + k, x1 - k, y1 - k, 'fu-line thin'));
      break;
    }
    default:
      out.push(line(x0, y0, x1, y1, 'fu-line faint'), line(x1, y0, x0, y1, 'fu-line faint'));
  }
  return out.join('');
}

/** Chairs around a dining table (drawn tucked halfway in; the clearance is measured from the table edge). */
function diningChairs(r) {
  const { w, d } = r;
  const seats = r.seats || 4;
  const cw = 18 * IN;
  const cd = 18 * IN;
  const out = [];
  const chair = (x, y, angle) => out.push(`<g transform="translate(${n(x)} ${n(y)}) rotate(${n(angle)})">${rect(-cw / 2, -cd / 2, cw / 2, cd / 2, 'fu-chair', { rx: n(2 * IN) })}${rect(-cw / 2, -cd / 2, cw / 2, -cd / 2 + 3 * IN, 'fu-chair-back')}</g>`);
  if (r.shape === 'round') {
    for (let i = 0; i < seats; i++) {
      const t = (i / seats) * 2 * Math.PI - Math.PI / 2;
      const rx = w / 2 + cd * 0.3;
      const ry = d / 2 + cd * 0.3;
      chair(Math.cos(t) * rx, Math.sin(t) * ry, (t * 180) / Math.PI + 90);
    }
    return out;
  }
  // Rectangles: one at each end once there are six or more seats (or a square table seats one a side).
  const square = Math.abs(w - d) < 4 * IN;
  const ends = square ? (seats >= 4 ? 2 : 0) : seats >= 6 ? 2 : 0;
  const sides = seats - ends;
  const perSide = Math.ceil(sides / 2);
  const out0 = cd * 0.35;
  for (let s = 0; s < 2; s++) {
    const count = s === 0 ? perSide : sides - perSide;
    for (let i = 0; i < count; i++) {
      const x = -w / 2 + (w * (i + 0.5)) / count;
      if (s === 0) chair(x, -d / 2 - out0, 0);
      else chair(x, d / 2 + out0, 180);
    }
  }
  if (ends) {
    chair(-w / 2 - out0, 0, -90);
    chair(w / 2 + out0, 0, 90);
  }
  return out;
}

function sinkBowls(r) {
  const { w, d } = r;
  const bowls = r.sizeDef?.bowls ?? 1;
  const out = [];
  if (r.shape === 'diag') {
    // Bowls along the cut-off front, faucet toward the corner.
    const o = localShape(r).outline;
    const k = r.side === 'right' ? 1 : 0;
    const corner = k ? { x: w / 2, y: -d / 2 } : { x: -w / 2, y: -d / 2 };
    const cut = k ? [o[1], o[2]] : [o[2], o[3]];
    const mid = { x: (cut[0].x + cut[1].x) / 2, y: (cut[0].y + cut[1].y) / 2 };
    const tx = cut[1].x - cut[0].x;
    const ty = cut[1].y - cut[0].y;
    const tl = Math.hypot(tx, ty) || 1;
    const c = { x: mid.x + (corner.x - mid.x) * 0.35, y: mid.y + (corner.y - mid.y) * 0.35 };
    for (const s of [-1, 1]) out.push(circle(c.x + (s * tx * 0.28 * w) / tl, c.y + (s * ty * 0.28 * w) / tl, Math.min(w, d) * 0.17, 'fu-detail'));
    out.push(circle(c.x + (corner.x - c.x) * 0.45, c.y + (corner.y - c.y) * 0.45, IN, 'fu-line thin'));
    return out;
  }
  const bw = (w - 3 * IN - (bowls - 1) * 1.5 * IN) / bowls;
  for (let i = 0; i < bowls; i++) {
    const x = -w / 2 + 1.5 * IN + i * (bw + 1.5 * IN);
    out.push(rect(x, -d / 2 + 4 * IN, x + bw, d / 2 - 1.5 * IN, 'fu-detail', { rx: n(2 * IN) }));
    out.push(circle(x + bw / 2, (d / 2 - 1.5 * IN + -d / 2 + 4 * IN) / 2, IN * 0.8, 'fu-line thin'));
  }
  out.push(circle(0, -d / 2 + 2 * IN, IN, 'fu-line thin'));
  return out;
}

function burners(r) {
  const { w, d } = r;
  const count = r.sizeDef?.burners ?? 4;
  const cols = count >= 6 ? 3 : count === 5 ? 3 : 2;
  const rows = 2;
  const usable = { x0: -w / 2 + 2 * IN, x1: w / 2 - 2 * IN, y0: -d / 2 + 2 * IN, y1: d / 2 - (r.mount === 'counter' ? 2 : 5) * IN };
  const out = [];
  const cw = (usable.x1 - usable.x0) / cols;
  const ch = (usable.y1 - usable.y0) / rows;
  const rad = Math.min(cw, ch) * 0.36;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      if (count === 5 && i === 1 && j === 1) continue;
      const big = count === 5 && i === 1;
      out.push(circle(usable.x0 + cw * (i + 0.5), big ? (usable.y0 + usable.y1) / 2 : usable.y0 + ch * (j + 0.5), big ? rad * 1.25 : rad, 'fu-detail'));
    }
  }
  return out;
}

/** A group for one item: translated and rotated into place, with a hover title. */
export function furnitureGroup(r, sw, cls) {
  const title = `${r.name}${r.sizeLabel ? ` – ${r.sizeLabel}` : ''}`;
  return `<g class="${cls}" transform="translate(${n(r.c.x)} ${n(r.c.y)}) rotate(${n(r.item.angle ?? 0)})" stroke-width="${n(sw)}"${
    r.mount === 'overhead' ? ` stroke-dasharray="${n(sw * 6)} ${n(sw * 3)}"` : ''}><title>${esc(title)}</title>${furnitureSymbol(r, sw)}</g>`;
}
