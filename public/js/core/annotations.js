// Annotations: notes and mark-up drawn over the plan (text boxes, callouts,
// arrows, lines, boxes and ellipses). They are not part of the wall graph,
// so wall edits leave them where they are. Stored in design.annotations as
//   { id, kind, a: {x, y}, b: {x, y} | null, text, size, color, box }
// in plan millimetres, so they print at the drawing's scale:
//   text     a = top-left of the text (b is null)
//   callout  a = top-left of the text, b = the point its leader arrow points at
//   arrow    a → b, head at b          line  a → b
//   rect     a and b are opposite corners          ellipse  inscribed in that box
// size is the text height (mm on the plan); color a key of ANNOTATION_COLORS;
// box draws a border round the text of a text or callout.
import { closestPointOnSegment, dist } from './geometry.js';
import { MM_PER_IN } from './units.js';
import { uid } from './model.js';

export const ANNOTATION_KINDS = {
  text: 'Text box',
  callout: 'Callout',
  arrow: 'Arrow',
  line: 'Line',
  rect: 'Box',
  ellipse: 'Ellipse',
};
export const ANNOTATION_COLORS = { red: '#dc2626', blue: '#2563eb', green: '#15803d', orange: '#ea580c', black: '#1f2933' };
const TEXT_KINDS = new Set(['text', 'callout']);
export const hasText = (an) => TEXT_KINDS.has(an.kind);

/** Text heights to pick from, mm on the plan. */
export function annotationSizes(units) {
  return units === 'metric'
    ? { small: 75, medium: 100, large: 150, huge: 230 }
    : { small: 3 * MM_PER_IN, medium: 4 * MM_PER_IN, large: 6 * MM_PER_IN, huge: 9 * MM_PER_IN };
}

export function makeAnnotation(kind, a, b, { text, size, color, box } = {}, units = 'imperial') {
  const an = {
    id: uid('n'), kind, a: { x: a.x, y: a.y }, b: b ? { x: b.x, y: b.y } : null,
    size: size > 0 ? size : annotationSizes(units).medium,
    color: ANNOTATION_COLORS[color] ? color : 'red',
  };
  if (hasText(an)) {
    an.text = text ?? (kind === 'callout' ? 'Note' : 'Text');
    an.box = box ?? true;
  }
  return an;
}

const finitePoint = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y);

/** Drops malformed annotations from stored designs. */
export function sanitizeAnnotations(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((an) => an && typeof an.id === 'string' && ANNOTATION_KINDS[an.kind] && finitePoint(an.a) && (an.kind === 'text' || finitePoint(an.b)))
    .map((an) => {
      const out = { ...an, size: an.size > 0 ? an.size : 4 * MM_PER_IN, color: ANNOTATION_COLORS[an.color] ? an.color : 'red' };
      if (hasText(out)) {
        out.text = typeof out.text === 'string' ? out.text : '';
        out.box = out.box !== false;
      }
      if (out.kind === 'text') out.b = null;
      return out;
    });
}

export function deleteAnnotation(d, id) {
  d.annotations = (d.annotations ?? []).filter((an) => an.id !== id);
}

/** The text's lines and the block they take up, from a (an estimate: about 0.6 em per character). */
export function textBlock(an) {
  const lines = String(an.text ?? '').split('\n');
  const lineHeight = an.size * 1.25;
  const pad = an.box ? an.size * 0.4 : 0;
  const width = Math.max(an.size, ...lines.map((l) => l.length * an.size * 0.6)) + 2 * pad;
  return { lines, lineHeight, pad, x: an.a.x, y: an.a.y, w: width, h: lines.length * lineHeight + 2 * pad };
}

/** Where a callout's leader leaves its text: the middle of the block's nearest side. */
export function calloutAnchor(an) {
  const t = textBlock(an);
  const c = { x: t.x + t.w / 2, y: t.y + t.h / 2 };
  const dx = an.b.x - c.x;
  const dy = an.b.y - c.y;
  if (Math.abs(dx) * t.h > Math.abs(dy) * t.w) return { x: dx > 0 ? t.x + t.w : t.x, y: c.y };
  return { x: c.x, y: dy > 0 ? t.y + t.h : t.y };
}

/** Bounding box { minX, minY, maxX, maxY } of an annotation. */
export function annotationBounds(an) {
  const pts = [an.a];
  if (an.b) pts.push(an.b);
  if (hasText(an)) {
    const t = textBlock(an);
    pts.push({ x: t.x + t.w, y: t.y + t.h });
  }
  return {
    minX: Math.min(...pts.map((p) => p.x)), maxX: Math.max(...pts.map((p) => p.x)),
    minY: Math.min(...pts.map((p) => p.y)), maxY: Math.max(...pts.map((p) => p.y)),
  };
}

/** Whether point p (plan mm) picks an annotation, within tol: its text block, line, or a box's or ellipse's outline. */
export function annotationHit(an, p, tol) {
  if (hasText(an)) {
    const t = textBlock(an);
    if (p.x >= t.x - tol && p.x <= t.x + t.w + tol && p.y >= t.y - tol && p.y <= t.y + t.h + tol) return true;
    return an.kind === 'callout' && closestPointOnSegment(p, calloutAnchor(an), an.b).dist <= tol;
  }
  if (an.kind === 'arrow' || an.kind === 'line') return closestPointOnSegment(p, an.a, an.b).dist <= tol;
  const minX = Math.min(an.a.x, an.b.x);
  const maxX = Math.max(an.a.x, an.b.x);
  const minY = Math.min(an.a.y, an.b.y);
  const maxY = Math.max(an.a.y, an.b.y);
  if (an.kind === 'rect') {
    const corners = [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }];
    return corners.some((c, i) => closestPointOnSegment(p, c, corners[(i + 1) % 4]).dist <= tol);
  }
  // Ellipse: near its outline.
  const rx = Math.max((maxX - minX) / 2, 1);
  const ry = Math.max((maxY - minY) / 2, 1);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const r = Math.hypot((p.x - cx) / rx, (p.y - cy) / ry);
  return Math.abs(r - 1) * Math.min(rx, ry) <= tol;
}

/** The topmost annotation at p (drawn last = on top), or null. */
export function annotationAt(list, p, tol) {
  for (let i = list.length - 1; i >= 0; i--) if (annotationHit(list[i], p, tol)) return list[i];
  return null;
}

/** The handles of an annotation that can be dragged: its end points (a text box has none). */
export function annotationHandles(an) {
  if (an.kind === 'text') return [];
  return [{ key: 'a', p: an.a }, { key: 'b', p: an.b }];
}

/** The handle of `an` within tol of p, or null. */
export function handleAt(an, p, tol) {
  return annotationHandles(an).find((hd) => dist(hd.p, p) <= tol)?.key ?? null;
}
