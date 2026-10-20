// Leveling layer for the plan: the cut/fill heatmap (a canvas raster clipped
// to the room), the survey grid with readings, grind-zone call-outs,
// clearance-lock badges and a screen-space legend.
import { levelColor, legendStops } from '../core/leveling.js';
import { formatDeviation } from '../core/units.js';
import { esc, n, pts, tag } from './svg.js';

const images = new WeakMap(); // surface → { key, href }

/** PNG data URL with one pixel per raster cell, coloured by deviation from the target. */
function heatmapHref(la) {
  const key = `${la.target}|${la.band}|${la.scaleMax}`;
  const cached = images.get(la.surface);
  if (cached?.key === key) return cached.href;
  const { cols, rows } = la.surface;
  const { delta } = la;
  const canvas = document.createElement('canvas');
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(cols, rows);
  for (let k = 0; k < delta.length; k++) {
    const [r, g, b] = levelColor(delta[k], la.band, la.scaleMax);
    img.data.set([r, g, b, 255], k * 4);
  }
  ctx.putImageData(img, 0, 0);
  const href = canvas.toDataURL();
  images.set(la.surface, { key, href });
  return href;
}

/** One heatmap image per linked group, clipped to its rooms. */
export function renderHeatmap(view, la) {
  if (!la.ready) return '';
  const s = la.surface;
  const id = `lvl-clip-${la.group.leaderId}`;
  return `<clipPath id="${esc(id)}">${la.members.map((m) => tag('polygon', { points: pts(m.geom.polygon) }, null)).join('')}</clipPath>` +
    tag('image', {
      class: 'lvl-heat', href: heatmapHref(la), x: s.x0, y: s.y0, width: s.cols * s.cell, height: s.rows * s.cell,
      preserveAspectRatio: 'none', 'clip-path': `url(#${id})`,
    }, null);
}

/**
 * Grid nodes for every room in the group (coloured by deviation when the
 * surface is ready), optional numbers, column/row labels, grind zones and
 * clearance locks. `entry`/`hover` are {roomId, key} of the node being typed
 * into and the node under the mouse.
 */
export function renderSurvey(view, la, { unit, numbers, entry, hover }) {
  const out = [];
  const px = (v) => view.px(v);
  const r = px(4.5);
  for (const m of la.members) {
    const grid = m.grid;
    const roomId = m.geom.room?.id;
    const spacingPx = grid.spacing * view.view.scale;
    const showNumbers = numbers && spacingPx >= 30;

    // Column letters above, row numbers to the left.
    if (spacingPx >= 18) {
      const top = grid.ys[0] - Math.min(grid.spacing / 2, px(16));
      const left = grid.xs[0] - Math.min(grid.spacing / 2, px(16));
      for (const c of new Set(m.nodes.map((nd) => nd.col))) out.push(view.label({ x: grid.xs[c], y: top }, m.nodes.find((nd) => nd.col === c).label.replace(/\d+$/, ''), 0, 'lvl-axis', 10));
      for (const row of new Set(m.nodes.map((nd) => nd.row))) out.push(view.label({ x: left, y: grid.ys[row] }, String(row + 1), 0, 'lvl-axis', 10));
    }

    for (const nd of m.nodes) {
      const has = nd.z != null;
      const delta = has && la.ready ? nd.z - la.target : null;
      const fill = delta != null ? `rgb(${levelColor(delta, la.band, la.scaleMax).join(',')})` : has ? '#6b7480' : '#fff';
      const is = (ref) => ref?.roomId === roomId && ref.key === nd.key;
      if (is(entry)) out.push(tag('circle', { class: 'lvl-current', cx: nd.x, cy: nd.y, r: r * 2.1, 'stroke-width': px(2.2) }, null));
      else if (is(hover)) out.push(tag('circle', { class: 'lvl-hover', cx: nd.x, cy: nd.y, r: r * 1.9, 'stroke-width': px(1.5) }, null));
      out.push(tag('circle', { class: `lvl-node${has ? ' has' : ''}`, cx: nd.x, cy: nd.y, r, fill, 'stroke-width': px(has ? 1.8 : 1.2) }, null));
      if (showNumbers && has) {
        const text = formatDeviation(delta ?? nd.z, unit, { sign: true, compact: true });
        out.push(view.label({ x: nd.x, y: nd.y + px(13) }, text, 0, 'lvl-num', 10.5));
      }
    }
    for (const rd of m.offGrid) {
      const s = px(3);
      out.push(tag('rect', { class: 'lvl-offgrid', x: rd.x - s, y: rd.y - s, width: 2 * s, height: 2 * s, transform: `rotate(45 ${n(rd.x)} ${n(rd.y)})` }, null));
    }
  }

  for (const z of la.ready ? la.zones : []) {
    const e = z.extent;
    out.push(tag('rect', {
      class: 'lvl-zone', x: e.minX, y: e.minY, width: e.maxX - e.minX, height: e.maxY - e.minY,
      'stroke-width': px(1.4), 'stroke-dasharray': `${n(px(5))} ${n(px(3))}`,
    }, null));
    // Label beside the zone's highest surveyed node, clear of its number.
    const top = z.nodes[0];
    const peak = la.members.find((m) => m.geom.room?.id === top?.roomId)?.nodes.find((nd) => nd.label === top.label) ?? z.centroid;
    out.push(view.label({ x: peak.x + px(19), y: peak.y }, z.label, 0, 'lvl-zone-label', 12));
  }

  for (const l of la.locks) {
    if (!l.point) continue;
    const breached = la.breaches?.some((b) => b.lock.id === l.lock.id);
    const text = `≤ ${formatDeviation(l.lock.maxBuild, unit)}`;
    const w = px(text.length * 6.2 + 14);
    const hgt = px(16);
    out.push(`<g class="lvl-lock${breached ? ' breach' : ''}">${
      tag('rect', { x: l.point.x - w / 2, y: l.point.y - hgt / 2, width: w, height: hgt, rx: px(4), 'stroke-width': px(1.2) }, null)}${
      view.label(l.point, text, 0, 'lvl-lock-text', 10)}</g>`);
  }
  return `<g class="lvl-survey">${out.join('')}</g>`;
}

/** Colour key in screen space (top-left of the canvas; the entry bar owns the bottom). */
export function renderLegend(la, unit) {
  const W = 300;
  const x = 14;
  const y = 12;
  const stops = legendStops(la.band, la.scaleMax)
    .map((s) => `<stop offset="${s.offset}" stop-color="rgb(${s.color.join(',')})"/>`).join('');
  const fmt = (v, sign) => formatDeviation(v, unit, { sign });
  return `<g class="lvl-legend" transform="translate(${x} ${y})">` +
    `<defs><linearGradient id="lvl-legend-grad">${stops}</linearGradient></defs>` +
    `<rect class="lvl-legend-bg" width="${W}" height="56" rx="6"/>` +
    `<rect x="10" y="10" width="${W - 20}" height="10" rx="2" fill="url(#lvl-legend-grad)"/>` +
    `<text x="10" y="34">Pour ${esc(fmt(la.scaleMax, false))}</text>` +
    `<text x="${W / 2}" y="34" text-anchor="middle">Level ±${esc(formatDeviation(la.band, unit))}</text>` +
    `<text x="${W - 10}" y="34" text-anchor="end">Grind ${esc(fmt(la.scaleMax, false))}</text>` +
    `<text x="10" y="48" class="sub">vs target ${esc(fmt(la.target, true))} · numbers: + grind, − pour</text>` +
    '</g>';
}
