// Trim cut plan in the views: the "Trim cuts" and "Fewest joins" toggles,
// joins and stick labels on elevations, the plan legend, the comparison of
// the two plans (amount to buy, joins and price) and the Takeoff section
// with stock lengths and the cut list.
import { CUT_MODES, cutMode, formatStock } from '../core/trimCuts.js';
import { formatMoney } from '../core/takeoff.js';
import { TRIM_CATEGORIES, profileLabel } from '../core/trimCatalog.js';
import { formatArea, formatLength } from '../core/units.js';
import { RULER } from './canvas.js';
import { checkbox, h, lengthInput } from './dom.js';
import { esc, n, uprightAngle } from './svg.js';

const plural = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;
const signed = (v, text) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${text}`;

/**
 * Least material | Fewest joins: the cut plan the estimate uses (saved with
 * the plan, undoable). The same control in every view and the Takeoff.
 */
export function cutModeControl(app) {
  const mode = cutMode(app.design);
  return h('div', {
    class: 'segmented cut-mode', role: 'group', 'aria-label': 'Cut trim for',
    title: 'Least material: buy the fewest lengths, joining runs wherever that saves one. Fewest joins: only join runs longer than the stock, even if that takes more. The Takeoff uses this plan.',
  }, Object.entries(CUT_MODES).map(([key, label]) => h('button', {
    class: key === mode ? 'active' : '', 'aria-pressed': String(key === mode), onclick: () => key !== mode && app.setTrimOptimize(key === 'joins'),
  }, label)));
}

/**
 * Trim layers for a view's bar, as checkboxes like the other layers: Trim
 * (the plan only: trim is always drawn on elevations) and Trim cuts, which
 * needs the trim shown; while the cuts are shown, the cut plan choice.
 */
export function cutToggles(app, { trimLayer = false } = {}) {
  const d = app.design;
  const trimShown = !trimLayer || d.settings.showTrim !== false;
  const cuts = checkbox('Trim cuts', app.showTrimCuts && trimShown, (v) => app.setShowTrimCuts(v));
  if (!trimShown) {
    cuts.querySelector('input').disabled = true;
    cuts.classList.add('disabled');
  }
  return [
    trimLayer ? h('span', { class: 'cv-layer', title: 'Show baseboard, shoe moulding, crown and casing on the plan' },
      checkbox('Trim', trimShown, (v) => app.change(v ? 'Show trim' : 'Hide trim', (x) => { x.settings.showTrim = v; }))) : null,
    h('span', { class: 'cv-layer', title: trimShown ? 'Show where each length of trim stock is cut and where runs have to be joined' : 'Turn on Trim to see where it is cut' }, cuts),
    app.showTrimCuts && trimShown ? cutModeControl(app) : null,
  ].filter(Boolean);
}

/** What a group is: "Colonial baseboard 5 1/4"", plus the panel height for sheet wainscot. */
export function groupLabel(g, units) {
  const name = profileLabel(g.profileId, g.size, units, g.category);
  return g.kind === 'sheet' ? `${name}, ${formatLength(g.panelHeight, units, { precision: 'label' })} panels` : name;
}

/** "4 × 14'", "9 panels (3 sheets)" or "12 × 8' boards" for one plan of a group. */
export function planCount(g, p, units) {
  if (g.kind === 'sheet') return `${plural(p.count, 'panel')} (${plural(p.sheets, 'sheet')})`;
  return `${p.count} × ${formatStock(g.stock, units)}${g.kind === 'boards' ? ' boards' : ''}`;
}

/**
 * The two plans side by side, from trimCutSummary(): per material line the
 * quantity, joins and cost of each, and the totals and differences of
 * fewest joins over least material (amounts per unit, joins, price incl. tax).
 */
export function compareCuts(cuts) {
  const a = cuts.byMode.material;
  const b = cuts.byMode.joins;
  const lines = a.materials.map((m, i) => ({
    key: m.key, label: m.label, unit: m.unit,
    material: { quantity: m.quantity, joins: m.cuts?.joins ?? 0, cost: a.pricing.lines[i].cost, cuts: m.cuts ?? null },
    joins: { quantity: b.materials[i].quantity, joins: b.materials[i].cuts?.joins ?? 0, cost: b.pricing.lines[i].cost, cuts: b.materials[i].cuts ?? null },
  }));
  const amounts = new Map();
  for (const l of lines) {
    const dq = l.joins.quantity - l.material.quantity;
    if (Math.abs(dq) > 0.05) amounts.set(l.unit, (amounts.get(l.unit) ?? 0) + dq);
  }
  const joins = (plan) => cuts.plan.groups.reduce((s, g) => s + g.plans[plan].joins, 0);
  return {
    lines,
    amounts: [...amounts],
    joins: { material: joins('material'), joins: joins('joins') },
    cost: Math.round((b.pricing.total - a.pricing.total) * 100) / 100,
    priced: a.pricing.priced > 0,
    currency: a.pricing.currency,
    same: !amounts.size && joins('material') === joins('joins'),
  };
}

function amountText([unit, v]) {
  const value = Math.abs(v);
  const text = ['sheets', 'ea'].includes(unit) ? plural(Math.round(value), unit === 'sheets' ? 'sheet' : 'piece') : `${value.toFixed(1)} ${unit}`;
  return signed(v, text);
}

/**
 * One line on what "fewest joins" changes: "+14.0 lf · 2 fewer joins · +$21.00".
 * Prices only appear once the trim lines are priced in the Takeoff.
 */
export function differenceText(cmp) {
  if (cmp.same) return 'Both plans are the same: no extra stock and no joins to save';
  const parts = cmp.amounts.length ? cmp.amounts.map(amountText) : ['no extra stock'];
  const saved = cmp.joins.material - cmp.joins.joins;
  parts.push(saved > 0 ? plural(saved, 'fewer join') : saved < 0 ? plural(-saved, 'more join') : 'same joins');
  if (cmp.priced) parts.push(`${cmp.cost >= 0 ? '+' : '−'}${formatMoney(Math.abs(cmp.cost), cmp.currency)}`);
  return parts.join(' · ');
}

/** Joins and stick tags on a wall elevation (marks from faceCutMarks), mapped by X(s), Y(z) at `scale` px/mm. */
export function cutMarksSvg(marks, X, Y, scale) {
  const out = [];
  for (const j of marks.joins) {
    // A little past the band on both sides, so a join reads even on thin trim.
    const dx = X(j.b.s) - X(j.a.s);
    const dy = Y(j.b.z) - Y(j.a.z);
    const len = Math.hypot(dx, dy) || 1;
    const ex = (dx / len) * 3;
    const ey = (dy / len) * 3;
    const d = `M${n(X(j.a.s) - ex)} ${n(Y(j.a.z) - ey)}L${n(X(j.b.s) + ex)} ${n(Y(j.b.z) + ey)}`;
    out.push(`<path class="cut-join-halo" d="${d}"/><path class="cut-join" d="${d}"/>`);
  }
  for (const l of marks.labels) {
    const fs = Math.min(10, Math.max(7, l.width * scale * 0.75));
    if (l.length * scale < l.tag.length * fs * 0.62 + 4) continue;
    const x = X(l.at.s);
    const y = Y(l.at.z);
    const angle = uprightAngle({ x: l.dir.s, y: -l.dir.z });
    out.push(`<text class="cut-label" x="${n(x)}" y="${n(y)}" font-size="${n(fs)}" text-anchor="middle" dominant-baseline="central"${angle ? ` transform="rotate(${n(angle)} ${n(x)} ${n(y)})"` : ''}>${esc(l.tag)}</text>`);
  }
  return `<g class="cut-marks">${out.join('')}</g>`;
}

/** Screen-space box on the plan: each group's stock and joins in the current plan, and what fewest joins changes. */
export function cutLegendSvg(cuts, units, rect) {
  const groups = cuts.plan.groups;
  if (!groups.length) return '';
  const mode = cuts.mode;
  const cmp = compareCuts(cuts);
  const rows = groups.map((g) => {
    const p = g.plans[mode];
    return [g.code, groupLabel(g, units), `${planCount(g, p, units)} · ${plural(p.joins, g.kind === 'sheet' ? 'seam' : 'join')}`];
  });
  const diff = mode === 'joins' ? `vs least material: ${differenceText(cmp)}` : `Fewest joins would be: ${differenceText(cmp)}`;
  const W = 420;
  const H = 40 + rows.length * 15 + 20;
  const fit = (label, count) => {
    const room = Math.floor((W - 46 - count.length * 6.3) / 6.1);
    return label.length > room ? `${label.slice(0, Math.max(8, room - 1))}…` : label;
  };
  const x = Math.max(RULER + 10, rect.width - W - 12);
  const y = Math.max(RULER + 10, rect.height - H - 12);
  return `<g class="cut-legend${mode === 'joins' ? ' joins' : ''}" transform="translate(${n(x)} ${n(y)})">` +
    `<rect class="cut-legend-bg" width="${W}" height="${H}" rx="6"/>` +
    `<text x="10" y="18" class="title">Trim cuts · ${esc(CUT_MODES[mode])}</text>` +
    `<text x="${W - 10}" y="18" class="sub" text-anchor="end">to buy, before waste</text>` +
    rows.map(([code, label, count], i) => `<g transform="translate(10 ${38 + i * 15})"><text class="code">${esc(code)}</text>` +
      `<text x="26" class="name">${esc(fit(label, count))}</text><text x="${W - 20}" text-anchor="end">${esc(count)}</text></g>`).join('') +
    `<text x="10" y="${H - 10}" class="diff">${esc(diff)}</text></g>`;
}

/** Location of a cut for the cut list: "Kitchen – 1. North wall, baseboard (2 of 3)". */
function cutWhere(c, segs) {
  const i = segs.findIndex((s) => Math.abs(s.t0 - c.t0) < 0.01);
  return `${c.piece.faceName}, ${c.piece.part}${segs.length > 1 ? ` (${i + 1} of ${segs.length})` : ''}`;
}

/** The Takeoff section: the plan toggle, stock lengths, the two plans compared, and the cut list. */
export function cutPlanSection(app, cuts, { openGroups }) {
  const d = app.design;
  const u = d.units;
  const groups = cuts.plan.groups;
  const mode = cuts.mode;
  const toggle = cutModeControl(app);
  if (!groups.length) {
    return [h('div', { class: 'section-head cut-head' }, h('h2', {}, 'Trim cut plan'), toggle),
      h('p', { class: 'muted' }, 'Assign trim to see how it is cut from stock lengths.')];
  }
  const cmp = compareCuts(cuts);
  const money = (v) => (v == null ? '' : ` · ${formatMoney(v, cmp.currency)}`);
  const lineFor = (g) => cmp.lines.find((l) => l.key === `trim:${g.lineKey}`);
  const qty = (l, side) => (l ? `${l.unit === 'sheets' ? l[side].quantity : l[side].quantity.toFixed(1)} ${l.unit}${money(l[side].cost)}` : '');
  const stockCell = (g) => {
    if (g.kind === 'sheet') return h('span', { class: 'muted small' }, `${formatLength(g.size, u, { precision: 'label' })} × ${formatLength(g.sheetLength, u, { precision: 'label' })} sheet, ${g.perSheet} per sheet`);
    const custom = g.stockSource === 'plan';
    return h('div', { class: 'stock-cell' },
      lengthInput(g.stock, u, (mm) => setStock(app, g.lineKey, mm), { min: 100 }),
      custom ? h('button', { class: 'link small', title: 'Use the catalog or default length', onclick: () => setStock(app, g.lineKey, null) }, 'reset to default')
        : h('span', { class: 'muted small' }, g.stockSource === 'catalog' ? 'from the catalog' : 'default length'));
  };
  const planCell = (g, key) => {
    const p = g.plans[key];
    const l = lineFor(g);
    const current = key === mode;
    return h('td', { class: current ? 'current' : '' },
      h('div', { class: 'nowrap' }, `${planCount(g, p, u)} · ${plural(p.joins, g.kind === 'sheet' ? 'seam' : 'join')}`),
      h('div', { class: 'muted small nowrap' }, `buy ${qty(l, key)}`),
      h('div', { class: 'muted small' }, leftoverText(g, p, l?.[key].cuts, u)));
  };
  const diffCell = (g) => {
    const l = lineFor(g);
    const dj = g.plans.joins.joins - g.plans.material.joins;
    const parts = [];
    if (l && Math.abs(l.joins.quantity - l.material.quantity) > 0.05) parts.push(amountText([l.unit, l.joins.quantity - l.material.quantity]));
    if (dj) parts.push(signed(dj, plural(Math.abs(dj), g.kind === 'sheet' ? 'seam' : 'join')));
    if (l?.joins.cost != null && l.material.cost != null && Math.abs(l.joins.cost - l.material.cost) > 0.004) {
      const dc = l.joins.cost - l.material.cost;
      parts.push(`${dc > 0 ? '+' : '−'}${formatMoney(Math.abs(dc), cmp.currency)}`);
    }
    return h('td', { class: 'cut-diff-cell' }, parts.length ? parts.map((t) => h('div', {}, t)) : h('span', { class: 'muted' }, 'same'));
  };
  const table = h('table', { class: 'data cut-table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Trim'), h('th', {}, 'Stock length'),
      h('th', { class: mode === 'material' ? 'current' : '' }, CUT_MODES.material), h('th', { class: mode === 'joins' ? 'current' : '' }, CUT_MODES.joins),
      h('th', { class: 'cut-diff-cell' }, 'Difference', h('div', { class: 'unit' }, 'fewest joins − least')))),
    h('tbody', {}, groups.map((g) => h('tr', {},
      h('td', { class: 'cut-name', title: TRIM_CATEGORIES[g.category]?.label ?? 'Trim' }, h('span', { class: 'cut-code' }, g.code), ' ', groupLabel(g, u)),
      h('td', {}, stockCell(g)), planCell(g, 'material'), planCell(g, 'joins'), diffCell(g)))),
    h('tfoot', {}, h('tr', {}, h('td', { colspan: 4 }, 'Total difference', h('span', { class: 'muted small' }, cmp.priced ? ' · incl. tax' : ' · price the trim lines above to compare cost')), h('td', { class: 'cut-diff-cell' }, differenceText(cmp).split(' · ').map((t) => h('div', {}, t))))));

  const cutList = groups.map((g) => {
    const p = g.plans[mode];
    const det = h('details', { class: 'cut-list', open: openGroups.has(g.key) },
      h('summary', {}, h('span', { class: 'cut-code' }, g.code), ` ${groupLabel(g, u)} – ${planCount(g, p, u)}, ${plural(p.joins, g.kind === 'sheet' ? 'seam' : 'join')}`),
      h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, h('th', {}, g.kind === 'sheet' ? 'Panel' : g.kind === 'boards' ? 'Board' : 'Stick'), h('th', {}, 'Cuts'), h('th', { class: 'num' }, 'Offcut'))),
        h('tbody', {}, p.sticks.map((st) => h('tr', {},
          h('td', {}, st.tag),
          h('td', {}, h('ul', { class: 'cut-cuts' }, st.cuts.map((c) => h('li', {},
            h('strong', {}, formatLength(c.length, u, { precision: 'label' })), ' ', h('span', { class: 'muted' }, cutWhere(c, p.segments.get(c.piece.id) ?? [])))))),
          h('td', { class: 'num' }, formatLength(st.offcut, u, { precision: 'label' })))))));
    det.addEventListener('toggle', () => (det.open ? openGroups.add(g.key) : openGroups.delete(g.key)));
    return det;
  });

  return [
    h('div', { class: 'section-head cut-head' }, h('h2', {}, 'Trim cut plan'), toggle),
    h('p', { class: 'muted small' },
      `${CUT_MODES.material}: the fewest lengths of stock, splicing runs wherever that saves one. ${CUT_MODES.joins}: runs are only joined when longer than the stock; offcuts go to shorter runs elsewhere. `,
      'The material list uses the highlighted plan, plus the trim waste allowance. Show the cuts on the plan and elevations with "Trim cuts" in the bar above the drawing.'),
    h('div', { class: 'table-wrap' }, table),
    h('h3', {}, `Cut list (${CUT_MODES[mode].toLowerCase()})`),
    ...cutList,
  ];
}

/**
 * What is left after installing: everything bought less what goes on the
 * walls, so it follows the waste allowance. "4' 9" left over (incl. 1 spare length)".
 */
function leftoverText(g, p, cuts, units) {
  if (!cuts) return `${formatLength(p.offcut, units, { precision: 'label' })} left over`;
  const amount = g.kind === 'sheet' ? formatArea(cuts.leftover, units) : formatLength(cuts.leftover, units, { precision: 'label' });
  const word = g.kind === 'sheet' ? 'sheet' : g.kind === 'boards' ? 'board' : 'length';
  return `${amount} left over${cuts.spare > 0 ? ` (incl. ${plural(cuts.spare, `spare ${word}`)})` : ''}`;
}

function setStock(app, lineKey, mm) {
  app.change(mm == null ? 'Reset stock length' : 'Stock length', (x) => {
    x.estimate = { ...(x.estimate ?? {}) };
    const lengths = { ...(x.estimate.stockLengths ?? {}) };
    if (mm == null) delete lengths[lineKey];
    else lengths[lineKey] = mm;
    x.estimate.stockLengths = lengths;
  });
}
