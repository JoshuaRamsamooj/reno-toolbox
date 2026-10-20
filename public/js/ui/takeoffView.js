// Takeoff tab: material list, per-room quantities and estimate settings.
import { COUNT_UNITS, computeTakeoff, resolveEstimate, takeoffToCsv } from '../core/takeoff.js';
import { MM_PER_FT, areaUnit, areaValue, formatLength, lengthValue } from '../core/units.js';
import { checkbox, field, h, lengthInput, numberInput, select } from './dom.js';

const SHEETS = {
  imperial: { '4x8': [4, 8], '4x10': [4, 10], '4x12': [4, 12] },
  metric: { '1200x2400': [1200, 2400], '1200x2700': [1200, 2700], '1200x3000': [1200, 3000] },
};

export class TakeoffView {
  constructor(app, el) {
    this.app = app;
    this.el = el;
  }

  render() {
    const d = this.app.design;
    const u = d.units;
    const t = computeTakeoff(d);
    if (!t.rooms.length) {
      this.el.replaceChildren(h('div', { class: 'empty' }, h('h2', {}, 'Nothing to measure yet'), h('p', {}, 'Draw some rooms on the Plan tab; quantities update live as you edit.')));
      return;
    }
    const A = (v) => areaValue(v, u).toFixed(1);
    const L = (v) => lengthValue(v, u).toFixed(1);
    const aU = areaUnit(u);
    const lU = u === 'metric' ? 'm' : 'ft';

    const materials = h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Material'), h('th', { class: 'num' }, 'Quantity'), h('th', {}, 'Unit'), h('th', {}, 'Basis'))),
      h('tbody', {}, t.materials.map((m) => h('tr', {},
        h('td', {}, h('span', { class: `cat cat-${m.category.toLowerCase()}` }, m.category), ' ', m.label),
        h('td', { class: 'num' }, COUNT_UNITS.has(m.unit) ? String(m.quantity) : m.quantity.toFixed(1)),
        h('td', {}, m.unit),
        h('td', { class: 'muted small' }, m.detail)))),
    );

    const cols = [
      ['Floor', (q) => A(q.floorArea), aU],
      ['Perimeter', (q) => L(q.perimeter), lU],
      ['Walls gross', (q) => A(q.wallGross), aU],
      ['Openings', (q) => A(q.openingArea), aU],
      ['Walls net', (q) => A(q.wallNet), aU],
      ['Ext. walls net', (q) => A(q.exteriorWallNet), aU],
      ['Ceiling', (q) => A(q.ceilingArea), aU],
      ['Bulkheads', (q) => A(q.bulkheadArea), aU],
      ['Baseboard', (q) => L(q.baseboard), lU],
      ['Casing', (q) => L(q.doorCasing + q.windowCasing), lU],
      ['D / W / O', (q) => `${q.doors} / ${q.windows} / ${q.openings}`, ''],
    ];
    const rooms = h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Room'), cols.map(([label, , unit]) => h('th', { class: 'num' }, label, unit ? h('div', { class: 'unit' }, unit) : null)))),
      h('tbody', {}, t.rooms.map((r) => h('tr', { class: 'clickable', onclick: () => r.id && this.app.select({ type: 'room', id: r.id }) },
        h('td', {}, r.name, r.flooring ? null : h('span', { class: 'muted small' }, ' (no flooring)')),
        cols.map(([, fn]) => h('td', { class: 'num' }, fn(r.q)))))),
      h('tfoot', {}, h('tr', {}, h('td', {}, 'Total'), cols.map(([, fn]) => h('td', { class: 'num' }, fn(t.totals))))),
    );

    this.el.replaceChildren(
      h('div', { class: 'takeoff' },
        h('div', { class: 'takeoff-main' },
          h('div', { class: 'section-head' },
            h('h2', {}, 'Material estimate'),
            h('button', { onclick: () => this.downloadCsv(t) }, 'Export CSV'),
          ),
          h('div', { class: 'table-wrap' }, materials),
          h('h2', {}, 'Quantities by room'),
          h('div', { class: 'table-wrap' }, rooms),
          h('p', { class: 'muted small' },
            'Wall areas use interior faces and the room ceiling profile; openings and wall hidden behind bulkheads are deducted (bulkhead soffits, fronts and end caps are counted separately). Doors in shared walls count once per side, so casing covers both faces. ',
            'Exterior walls are detected automatically (override per wall in the inspector).'),
        ),
        this.settings(d),
      ),
    );
  }

  settings(d) {
    const u = d.units;
    const e = resolveEstimate(d);
    const set = (label, fn) => this.app.change(label, (x) => {
      x.estimate = { ...resolveEstimate(x), ...(x.estimate ?? {}) };
      fn(x.estimate);
    });
    const sheetKey = Object.entries(SHEETS[u]).find(([, [w, hh]]) => {
      const mm = u === 'metric' ? [w, hh] : [w * MM_PER_FT, hh * MM_PER_FT];
      return Math.abs(mm[0] - e.drywallSheet.w) < 1 && Math.abs(mm[1] - e.drywallSheet.h) < 1;
    })?.[0] ?? 'custom';
    const sheetOptions = Object.fromEntries(Object.keys(SHEETS[u]).map((k) => [k, u === 'metric' ? `${k.replace('x', ' × ')} mm` : `${k.replace('x', "' × ")}'`]));
    if (sheetKey === 'custom') sheetOptions.custom = 'Custom';
    return h('aside', { class: 'takeoff-settings' },
      h('h3', {}, 'Estimate settings'),
      field('Flooring waste', numberInput(e.flooringWaste, (v) => set('Flooring waste', (x) => { x.flooringWaste = v; }), { min: 0, max: 100, suffix: '%' })),
      field('Drywall sheet', select(sheetKey, sheetOptions, (k) => set('Drywall sheet', (x) => {
        const [w, hh] = SHEETS[u][k];
        x.drywallSheet = u === 'metric' ? { w, h: hh } : { w: w * MM_PER_FT, h: hh * MM_PER_FT };
      }))),
      field('Drywall waste', numberInput(e.drywallWaste, (v) => set('Drywall waste', (x) => { x.drywallWaste = v; }), { min: 0, max: 100, suffix: '%' })),
      field('Insulation waste', numberInput(e.insulationWaste, (v) => set('Insulation waste', (x) => { x.insulationWaste = v; }), { min: 0, max: 100, suffix: '%' })),
      checkbox('Insulate ceilings (top floor / attic)', e.insulateCeilings, (v) => set('Ceiling insulation', (x) => { x.insulateCeilings = v; })),
      field('Trim piece length', lengthInput(e.trimLength, u, (mm) => set('Trim length', (x) => { x.trimLength = mm; }), { min: 100 }),
        `Currently ${formatLength(e.trimLength, u)}`),
      field('Trim waste', numberInput(e.trimWaste, (v) => set('Trim waste', (x) => { x.trimWaste = v; }), { min: 0, max: 100, suffix: '%' })),
      field('Paint coats', numberInput(e.paintCoats, (v) => set('Paint coats', (x) => { x.paintCoats = Math.max(1, Math.round(v)); }), { min: 1, max: 5 })),
      field(`Paint coverage (${areaUnit(u)} per ${u === 'metric' ? 'litre' : 'gallon'})`, numberInput(e.paintCoverage[u], (v) => set('Paint coverage', (x) => {
        x.paintCoverage = { ...x.paintCoverage, [u]: Math.max(0.1, v) };
      }), { min: 0.1, step: u === 'metric' ? 0.5 : 10 })),
    );
  }

  downloadCsv(t) {
    const d = this.app.design;
    const blob = new Blob([takeoffToCsv(d, t)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(this.app.name || 'plan').replace(/[^\w.-]+/g, '_')}-takeoff.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}
