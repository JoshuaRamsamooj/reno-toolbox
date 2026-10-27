// Small standalone SVG preview of a design, stored alongside it in the DB.
import { analyze, designBounds } from './model.js';
import { footprint, resolveItem } from './furniture.js';

const f = (v) => Math.round(v);

export function renderThumbnail(d) {
  const b = designBounds(d);
  if (!b) return null;
  const pad = Math.max(b.width, b.height) * 0.06 + 200;
  const vb = [b.minX - pad, b.minY - pad, b.width + pad * 2, b.height + pad * 2].map(f).join(' ');
  const { rooms, idx } = analyze(d);
  const fills = rooms
    .map((g) => `<polygon points="${g.polygon.map((p) => `${f(p.x)},${f(p.y)}`).join(' ')}" fill="${g.dead ? '#d9dce1' : '#e8eef7'}"/>`)
    .join('');
  // Furniture footprints (not rugs or wall units), under the walls.
  const furniture = (d.furniture ?? [])
    .map((item) => resolveItem(item))
    .filter((r) => r.mount === 'floor' || r.mount === 'counter')
    .map((r) => `<polygon points="${footprint(r).outline.map((p) => `${f(p.x)},${f(p.y)}`).join(' ')}"/>`)
    .join('');
  const walls = d.walls
    .map((w) => {
      const A = idx.nodes.get(w.a);
      const B = idx.nodes.get(w.b);
      return `<line x1="${f(A.x)}" y1="${f(A.y)}" x2="${f(B.x)}" y2="${f(B.y)}" stroke-width="${f(Math.max(w.thickness, pad / 6))}"/>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}"><rect x="${f(b.minX - pad)}" y="${f(b.minY - pad)}" width="${f(b.width + pad * 2)}" height="${f(b.height + pad * 2)}" fill="#fff"/>${fills}<g fill="#cfd5de">${furniture}</g><g stroke="#374151" stroke-linecap="square">${walls}</g></svg>`;
}
