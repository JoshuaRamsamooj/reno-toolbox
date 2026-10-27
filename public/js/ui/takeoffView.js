// Takeoff tab: material list, per-room quantities and estimate settings.
import { COUNT_UNITS, computeTakeoff, formatMoney, resolveEstimate, takeoffToCsv } from '../core/takeoff.js';
import { MM_PER_FT, areaUnit, areaValue, formatLength, lengthValue } from '../core/units.js';
import { checkbox, field, h, lengthInput, numberInput, select } from './dom.js';
import { TRIM_CATEGORIES, getProfile, profileLabel } from '../core/trimCatalog.js';

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

    const p = t.pricing;
    const money = (v) => formatMoney(v, p.currency);
    const keys = t.materials.map((m) => m.key);
    const materials = h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Material'), h('th', { class: 'num' }, 'Quantity'), h('th', {}, 'Unit'),
        h('th', { class: 'num' }, 'Unit price'), h('th', { class: 'num' }, 'Total'), h('th', {}, 'Basis'))),
      h('tbody', {}, t.materials.map((m, i) => h('tr', {},
        h('td', {}, h('span', { class: `cat cat-${m.category.toLowerCase()}` }, m.category), ' ', m.label),
        h('td', { class: 'num' }, COUNT_UNITS.has(m.unit) ? String(m.quantity) : m.quantity.toFixed(1)),
        h('td', {}, m.unit),
        h('td', { class: 'num' }, this.priceInput(m, p.lines[i].unitPrice, p.currency, keys)),
        h('td', { class: 'num' }, p.lines[i].cost == null ? h('span', { class: 'muted' }, '–') : money(p.lines[i].cost)),
        h('td', { class: 'muted small' }, m.detail)))),
      h('tfoot', { class: 'price-foot' },
        h('tr', {}, h('td', { colspan: 4 }, 'Subtotal', h('span', { class: 'muted small' }, ` · ${p.priced} of ${p.lines.length} lines priced`)), h('td', { class: 'num' }, money(p.subtotal)), h('td', {})),
        h('tr', {}, h('td', { colspan: 4 }, `Tax (${p.taxRate}%)`, h('span', { class: 'muted small' }, ' · one rate for every line, set in Estimate settings')), h('td', { class: 'num' }, money(p.tax)), h('td', {})),
        h('tr', { class: 'grand' }, h('td', { colspan: 4 }, 'Total'), h('td', { class: 'num' }, money(p.total)), h('td', {}))),
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
      ['Base (potential)', (q) => L(q.baseboard), lU],
      ['Casing (potential)', (q) => L(q.doorCasing + q.windowCasing), lU],
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
            h('h2', {}, 'Material estimate', h('span', { class: 'estimate-total' }, t.pricing.priced ? ` · ${formatMoney(t.pricing.total, t.pricing.currency)} incl. tax` : '')),
            h('button', { onclick: () => this.downloadCsv(t) }, 'Export CSV'),
          ),
          h('div', { class: 'table-wrap' }, materials),
          h('h2', {}, 'Trim by wall face'),
          this.trimSchedule(t),
          h('h2', {}, 'Quantities by room'),
          h('div', { class: 'table-wrap' }, rooms),
          h('p', { class: 'muted small' },
            'Wall areas use interior faces and the room ceiling profile; openings and wall hidden behind bulkheads are deducted (bulkhead soffits, fronts and end caps are counted separately). Doors in shared walls count once per side, so casing covers both faces. ',
            'Exterior walls are detected automatically (override per wall in the inspector). ',
            'Potential base and casing assume every face and opening is trimmed; the material list uses only the trim you assign.'),
        ),
        this.settings(d),
      ),
    );
    this.restoreFocus();
  }

  /**
   * Unit price for one material line (per its own unit: sheet, sq ft, lf,
   * bag, door...). Blank clears it. Enter or Tab moves to the next line's
   * price, Shift+Tab to the previous, as in a spreadsheet.
   */
  priceInput(m, value, currency, keys) {
    const input = h('input', {
      type: 'text', class: 'price-input', inputmode: 'decimal', value: value == null ? '' : value.toFixed(2),
      placeholder: '0.00', 'aria-label': `Unit price per ${m.unit}`, title: `Price per ${m.unit}`, dataset: { priceKey: m.key },
    });
    const commit = () => {
      const raw = input.value.replace(/[^0-9.\-]/g, '');
      const v = raw === '' ? null : Number(raw);
      if (v != null && !(Number.isFinite(v) && v >= 0)) {
        input.classList.add('invalid');
        return;
      }
      if (v === value || (v != null && value != null && Math.abs(v - value) < 0.0001)) return;
      this.app.change(v == null ? 'Clear unit price' : 'Unit price', (x) => {
        x.estimate = { ...(x.estimate ?? {}) };
        const prices = { ...(x.estimate.prices ?? {}) };
        if (v == null) delete prices[m.key];
        else prices[m.key] = Math.round(v * 10000) / 10000;
        x.estimate.prices = prices;
      });
    };
    const next = (step) => keys[keys.indexOf(m.key) + step] ?? null;
    input.addEventListener('change', commit);
    input.addEventListener('focus', () => {
      if (this.pendingFocus === m.key) this.pendingFocus = null;
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') this.pendingFocus = next(e.shiftKey ? -1 : 1);
      if (e.key === 'Enter') {
        this.pendingFocus = next(1);
        input.blur();
        setTimeout(() => this.restoreFocus());
      }
      if (e.key === 'Escape') {
        input.value = value == null ? '' : value.toFixed(2);
        input.blur();
      }
    });
    return h('span', { class: 'price-cell' }, h('span', { class: 'muted' }, currency), input);
  }

  /** After a re-render (or an Enter), put the cursor in the price field the user was moving to. */
  restoreFocus() {
    const key = this.pendingFocus;
    if (!key) return;
    const el = [...this.el.querySelectorAll('input.price-input')].find((x) => x.dataset.priceKey === key);
    if (!el) return;
    this.pendingFocus = null;
    el.focus();
    el.select();
  }

  /** Assigned trim per face: what's on each wall side, in each profile's estimate unit. */
  trimSchedule(t) {
    const d = this.app.design;
    const u = d.units;
    if (!t.trim.lines.length) {
      return h('p', { class: 'muted' }, 'No trim assigned yet, so the material list has no trim lines. Use the Trim tool (T) on the plan, the Trim tab, or the room panel to assign baseboard, casing, crown and panelling — per face, per room or for the whole house.');
    }
    const qty = (l) => {
      if (l.unit === 'lf') return `${lengthValue(l.length, u).toFixed(2)} ${u === 'metric' ? 'm' : 'lf'}`;
      const area = `${areaValue(l.area, u).toFixed(1)} ${areaUnit(u)}`;
      const p = getProfile(l.profileId);
      return l.unit === 'sheet' && p ? `${area} (${Math.ceil(l.area / (l.size * p.sheetLength) - 1e-9)} sheets)` : area;
    };
    return h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Wall face'), h('th', {}, 'Trim'), h('th', { class: 'num' }, 'Pieces'), h('th', { class: 'num' }, 'Net quantity'))),
      h('tbody', {}, t.trim.lines.map((l) => h('tr', {},
        h('td', {}, l.face),
        h('td', {}, `${TRIM_CATEGORIES[l.category]?.label ?? 'Trim'} – ${profileLabel(l.profileId, l.size, u, l.category)}`),
        h('td', { class: 'num' }, String(l.pieces)),
        h('td', { class: 'num' }, qty(l)))))));
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
      field('Flooring waste', numberInput(e.flooringWaste, (v) => set('Flooring waste', (x) => { x.flooringWaste = v; }), { min: 0, max: 100, suffix: '%' }),
        d.floorRuns.length ? 'For rooms without a flooring layout; each layout sets its own in the Flooring panel' : null),
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
      h('h3', {}, 'Pricing'),
      field('Tax rate', numberInput(e.taxRate, (v) => set('Tax rate', (x) => { x.taxRate = Math.min(100, Math.max(0, v)); }), { min: 0, max: 100, step: 0.025, suffix: '%' }),
        'Applied to every line'),
      field('Currency symbol', this.currencyInput(e.currency, (v) => set('Currency', (x) => { x.currency = v; }))),
      h('p', { class: 'muted small' }, 'Enter a unit price on each material line; totals use the quantity as listed, waste included. Prices are saved with the plan.'),
    );
  }

  currencyInput(value, onCommit) {
    const input = h('input', { type: 'text', value, maxlength: 4, class: 'currency-input', 'aria-label': 'Currency symbol' });
    input.addEventListener('change', () => {
      const v = input.value.trim();
      if (v !== value) onCommit(v);
    });
    return input;
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
