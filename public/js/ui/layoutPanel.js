// Layout planning panels: the catalog of furniture, cabinets, fixtures and
// appliances with the layout checks (Layout tool), and a selected piece's
// size, rotation, options and clearances.
import { FURNITURE, FURNITURE_CATEGORIES, applySize, defaultSizeId, deleteFurniture, duplicateFurniture, resolveItem, wrapAngle } from '../core/furniture.js';
import { MM_PER_IN, formatLength } from '../core/units.js';
import { checkbox, field, h, lengthInput, numberInput, select } from './dom.js';

const SIDE_LABELS = { front: 'In front', back: 'Behind', left: 'Left side', right: 'Right side' };
const MOUNTS = { floor: 'On the floor', overhead: 'On the wall, above the floor', counter: 'On the counter', rug: 'Under the furniture' };
const SCREENS = { 43: '43" TV', 50: '50" TV', 55: '55" TV', 65: '65" TV', 75: '75" TV', 85: '85" TV' };

/** Catalog, placing state and layout checks (the Layout tool's panel). */
export function layoutPanel(app, analysis) {
  const plan = app.plan;
  const d = app.design;
  const u = d.units;
  const fmt = (v) => formatLength(v, u, { precision: 'label' });
  const layout = plan.layoutAnalysis(analysis);
  plan.layoutSizes ??= {};
  const placing = plan.placing;
  const placed = new Map();
  for (const f of d.furniture) placed.set(FURNITURE[f.type].category, (placed.get(FURNITURE[f.type].category) ?? 0) + 1);

  // Catalog rows, filtered in place as you type so the search box keeps focus.
  const sections = [];
  const rows = [];
  for (const [cat, label] of Object.entries(FURNITURE_CATEGORIES)) {
    const types = Object.entries(FURNITURE).filter(([, def]) => def.category === cat);
    const catRows = types.map(([type, def]) => {
      const size = plan.layoutSizes[type] ?? defaultSizeId(type);
      const sizeSel = def.sizes.length > 1
        ? select(size, Object.fromEntries(def.sizes.map((s) => [s.id, sizeText(s, u)])), (v) => { plan.layoutSizes[type] = v; })
        : h('span', { class: 'muted small fu-one-size' }, sizeText(def.sizes[0], u));
      const place = () => plan.startPlacing(type, plan.layoutSizes[type] ?? defaultSizeId(type));
      const active = placing?.type === type;
      const row = h('div', { class: `fu-row${active ? ' active' : ''}`, dataset: { search: `${def.name} ${label} ${def.sizes.map((s) => s.label).join(' ')}`.toLowerCase() } },
        h('button', { class: 'link fu-name-btn', title: `Place a ${def.name.toLowerCase()}`, onclick: place }, def.name),
        sizeSel,
        h('button', { class: 'fu-place', onclick: place }, active ? 'Placing…' : 'Place'));
      rows.push(row);
      return row;
    });
    const details = h('details', { class: 'fu-cat', open: plan.layoutOpen.has(cat) || !!plan.layoutSearch },
      h('summary', {}, label, placed.get(cat) ? h('span', { class: 'fu-count' }, String(placed.get(cat))) : null),
      ...catRows);
    details.addEventListener('toggle', () => {
      if (plan.layoutSearch) return;
      if (details.open) plan.layoutOpen.add(cat);
      else plan.layoutOpen.delete(cat);
    });
    sections.push(details);
  }
  const filter = (q) => {
    plan.layoutSearch = q.trim().toLowerCase();
    for (const r of rows) r.hidden = !!plan.layoutSearch && !plan.layoutSearch.split(/\s+/).every((w) => r.dataset.search.includes(w));
    for (const s of sections) {
      const any = [...s.querySelectorAll('.fu-row')].some((r) => !r.hidden);
      s.hidden = !any;
      if (plan.layoutSearch) s.open = true;
      else s.open = plan.layoutOpen.has(Object.keys(FURNITURE_CATEGORIES)[sections.indexOf(s)]);
    }
  };
  const search = h('input', { type: 'search', class: 'fu-search', placeholder: 'Search: queen bed, vanity, 36" range…', value: plan.layoutSearch, oninput: (e) => filter(e.target.value) });
  if (plan.layoutSearch) queueMicrotask(() => filter(plan.layoutSearch));

  const errors = layout.issues.filter((i) => i.severity === 'error').length;
  const names = new Map(layout.items.map((x) => [x.r.item.id, x.r.name]));
  return h('div', { class: 'panel fu-panel' },
    h('div', { class: 'panel-kicker' }, 'Layout planning'),
    h('h2', {}, 'Furniture, cabinets & fixtures'),
    placing ? h('div', { class: 'lvl-callout fu-placing' },
      h('strong', {}, `Placing: ${FURNITURE[placing.type].name}`),
      h('div', { class: 'small' }, `${sizeText(FURNITURE[placing.type].sizes.find((s) => s.id === placing.size), u)} · click on the plan to place it, Shift+click to keep placing · Q / E rotate · Esc stops`),
      h('button', { class: 'link', onclick: () => { plan.placing = null; plan.render(); app.inspector.render(); } }, 'Stop placing')) : null,
    h('div', { class: 'stats' },
      stat('Pieces', d.furniture.length),
      stat('Problems', layout.issues.length ? `${layout.issues.length}${errors ? ` (${errors} serious)` : ''}` : 'none'),
      stat('Seats', layout.items.reduce((s, x) => s + (x.r.def.symbol === 'dining' || x.r.def.symbol === 'sofa' ? x.r.seats : 0), 0) || '–')),
    search,
    ...sections,
    h('h3', {}, 'Layout checks'),
    d.furniture.length ? null : h('p', { class: 'muted small' }, 'Nothing placed yet. Pick a piece above; wall pieces snap to the nearest wall and turn to face the room.'),
    layout.issues.length ? h('ul', { class: 'fu-issues' }, layout.issues.map((i) => h('li', { class: i.severity },
      h('button', { class: 'link', onclick: () => app.select({ type: 'furniture', id: i.itemId }), title: `Select the ${names.get(i.itemId)?.toLowerCase() ?? 'piece'}` }, i.message)))) : d.furniture.length ? h('p', { class: 'fu-ok small' }, '✓ No clashes: everything has its clearances, clear of the walls, doors and windows.') : null,
    ...layout.triangles.map((t) => h('div', { class: `fu-check ${t.ok ? 'ok' : 'warn'}` },
      h('strong', {}, `Work triangle – ${t.room}: ${fmt(t.total)}`),
      h('div', { class: 'small' }, t.legs.map((l) => `${l.name} ${fmt(l.len)}`).join(' · ')),
      h('div', { class: 'small' }, t.ok ? 'Within the usual 4\'–9\' legs and 13\'–26\' total.' : `Outside the usual range: ${t.problems.join('; ')}.`))),
    ...layout.tvs.map((v) => h('div', { class: `fu-check ${v.ok ? 'ok' : 'warn'}` }, h('strong', {}, `TV viewing – ${v.screen}"`), h('div', { class: 'small' }, v.message))),
    h('h3', {}, 'Show'),
    checkbox('Every clearance zone (not just the selected piece)', plan.showClearances === 'all', (v) => { plan.showClearances = v ? 'all' : 'selected'; plan.render(); }),
    checkbox('Furniture with the other tools', plan.showFurniture, (v) => { plan.showFurniture = v; plan.renderBar(); plan.render(); }),
    h('details', { class: 'fu-guide' }, h('summary', {}, 'Planning clearances'),
      h('ul', { class: 'help' },
        h('li', {}, h('b', {}, 'Walkways: '), '36" for a main path through a room, 24" minimum for a secondary one.'),
        h('li', {}, h('b', {}, 'Bedrooms: '), '24"–30" beside the bed and 30"–36" at its foot; 36" in front of a dresser or wardrobe to open drawers and doors.'),
        h('li', {}, h('b', {}, 'Living: '), '14"–18" between a sofa and the coffee table; TV viewing about 1.2–2 × the screen diagonal.'),
        h('li', {}, h('b', {}, 'Dining: '), '36" from the table edge to a wall or furniture to pull out a chair, 42"–48" where people walk behind; 24" of table per seat.'),
        h('li', {}, h('b', {}, 'Kitchens: '), '42" work aisles (48" for two cooks), 36" walkways; work triangle legs 4\'–9\', 13\'–26\' total; counter stools need 24" behind them.'),
        h('li', {}, h('b', {}, 'Bathrooms: '), 'toilet and bidet 15" from their centreline to a wall or fixture (18" recommended), 21" clear in front (30" recommended); 21" in front of a vanity or tub.'),
        h('li', {}, h('b', {}, 'Laundry & utility: '), '42" in front of a washer and dryer; 30" in front of a water heater or furnace for service.'),
        h('li', {}, 'Kitchen and bath figures follow the NKBA planning guidelines; local codes and the maker\'s instructions take precedence.'))),
  );
}

/** Size, rotation, options, clearances and problems of one piece. */
export function furniturePanel(app, analysis, id) {
  const plan = app.plan;
  const d = app.design;
  const u = d.units;
  const fmt = (v) => formatLength(v, u, { precision: 'label' });
  const f = d.furniture.find((x) => x.id === id);
  if (!f) return null;
  const r = resolveItem(f);
  const def = r.def;
  const sz = r.sizeDef;
  const layout = plan.layoutAnalysis(analysis);
  const x = layout.items.find((y) => y.r.item.id === id);
  const editF = (label, fn) => app.change(label, (dd) => {
    const it = dd.furniture.find((y) => y.id === id);
    if (it) fn(it);
  });
  const sizes = Object.fromEntries(def.sizes.map((s) => [s.id, sizeText(s, u)]));
  if (!sizes[f.size]) sizes[f.size] = 'Custom size';
  const standard = resolveItem({ ...f, opts: { ...f.opts, clear: {} } }).clear;
  const sided = (def.options ?? []).includes('side') || ['L', 'corner', 'diag'].includes(r.shape);
  const sideNames = r.shape === 'L' ? { left: 'Return on the left', right: 'Return on the right' } : { left: 'Corner at the back left', right: 'Corner at the back right' };
  const rotate = (by) => editF('Rotate furniture', (it) => { it.angle = wrapAngle((it.angle ?? 0) + by); });
  const setDim = (key, label) => (mm) => editF(label, (it) => {
    it[key] = mm;
    const s = def.sizes.find((q) => Math.abs(q.w * MM_PER_IN - it.w) < 1 && Math.abs(q.d * MM_PER_IN - it.d) < 1);
    it.size = s ? s.id : 'custom';
  });
  const clearFields = ['front', 'back', 'left', 'right'].map((side) => {
    const s = x?.sides[side];
    const have = s ? (s.have >= 119 * MM_PER_IN ? '10\'+ clear' : `${fmt(s.have)} clear`) : null;
    return field(`${SIDE_LABELS[side]}${have ? ` · ${have}` : ''}`,
      lengthInput(f.opts?.clear?.[side] ?? null, u, (mm) => editF('Clearance', (it) => {
        it.opts = { ...it.opts, clear: { ...(it.opts?.clear ?? {}) } };
        if (mm == null) delete it.opts.clear[side];
        else it.opts.clear[side] = mm;
      }), { allowEmpty: true, placeholder: standard[side] > 0 ? `${fmt(standard[side])} (standard)` : 'none' }));
  });
  return h('div', { class: 'panel fu-panel' },
    h('div', { class: 'panel-kicker' }, FURNITURE_CATEGORIES[def.category]),
    h('h2', {}, r.name),
    plan.tool === 'layout' ? h('button', { class: 'link', onclick: () => app.select(null) }, '← Catalog & layout checks') : null,
    field('Size', select(f.size, sizes, (v) => editF('Furniture size', (it) => applySize(it, v)))),
    h('div', { class: 'field-row' },
      field(r.shape === 'round' ? 'Width (across)' : 'Width', lengthInput(f.w, u, setDim('w', 'Furniture width'), { min: 1 })),
      field('Depth', lengthInput(f.d, u, setDim('d', 'Furniture depth'), { min: 1 }))),
    sz?.ext ? checkbox(`Extended: ${fmt(sz.ext * MM_PER_IN)} long, seats ${sz.extSeats}`, !!f.opts?.extended, (v) => editF(v ? 'Extend table' : 'Fold table', (it) => { it.opts = { ...it.opts, extended: v }; })) : null,
    sided ? field('Orientation', select(r.side, sideNames, (v) => editF('Flip furniture', (it) => { it.opts = { ...it.opts, side: v }; }))) : null,
    f.type === 'tv-stand' ? field('TV on it', select(String(f.opts?.screen ?? 55), SCREENS, (v) => editF('TV size', (it) => { it.opts = { ...it.opts, screen: Number(v) }; })), 'For the viewing distance check') : null,
    h('div', { class: 'field-row' },
      field('Rotation', numberInput(Math.round((f.angle ?? 0) * 10) / 10, (v) => editF('Rotate furniture', (it) => { it.angle = wrapAngle(v); }), { step: 15, suffix: '°' })),
      h('div', { class: 'button-row fu-rotate' },
        h('button', { title: 'Rotate 90° anticlockwise (Q)', onclick: () => rotate(-90) }, '⟲ 90°'),
        h('button', { title: 'Rotate 90° clockwise (E)', onclick: () => rotate(90) }, '⟳ 90°'))),
    field('Label', labelInput(f.label ?? '', def.name, (v) => editF('Rename furniture', (it) => {
      if (v) it.label = v;
      else delete it.label;
    }))),
    h('div', { class: 'stats' },
      stat('Height', r.mount === 'rug' ? '–' : r.mount === 'overhead' ? `${fmt(r.z0)}–${fmt(r.h)}` : fmt(r.h)),
      stat('Takeoff', r.takeoff),
      r.seats ? stat('Seats', r.seats) : stat('Where', MOUNTS[r.mount])),
    r.mount === 'rug' || r.mount === 'counter' ? null : h('div', { class: 'fu-trim' },
      checkbox('No trim on the wall behind it', r.cutsTrim, (v) => editF(v ? 'Leave trim off behind' : 'Run trim behind', (it) => {
        const catalog = !!(r.sizeDef?.cutsTrim ?? def.cutsTrim);
        it.opts = { ...it.opts };
        // Store only a choice that differs from the catalog, so catalog changes still reach the piece.
        if (v === catalog) delete it.opts.cutsTrim;
        else it.opts.cutsTrim = v;
      })),
      h('p', { class: 'muted small' }, `Baseboard, chair rail, crown and wainscot stop either side of it where it stands against a wall and is as high as them. ${(r.sizeDef?.cutsTrim ?? def.cutsTrim) ? 'Standard for built-in pieces like this one.' : 'Off as standard: trim usually runs behind a piece like this.'}`)),
    x?.issues.length ? h('ul', { class: 'fu-issues' }, x.issues.map((i) => h('li', { class: i.severity }, i.message))) : x && r.mount !== 'rug' ? h('p', { class: 'fu-ok small' }, '✓ Clear of walls, doors, windows and other pieces, with its clearances.') : null,
    h('h3', {}, 'Clear floor needed'),
    ...clearFields,
    h('p', { class: 'muted small' }, r.oneSide ? 'Only one side of this needs to be clear. ' : '', def.centerline ? `Side clearances keep ${def.centerline}" from the centreline to anything beside it. ` : '', 'Leave a box empty for the standard figure; the zones are drawn on the plan, red where they are short.'),
    h('div', { class: 'button-row' },
      h('button', { onclick: () => {
        let copy = null;
        app.change(`Duplicate ${r.name.toLowerCase()}`, (dd) => { copy = duplicateFurniture(dd, id); });
        if (copy) app.select({ type: 'furniture', id: copy.id });
      } }, 'Duplicate beside (Ctrl+D)'),
      h('button', { class: 'danger', onclick: () => { app.change(`Delete ${r.name.toLowerCase()}`, (dd) => deleteFurniture(dd, id)); app.select(null); } }, 'Delete')),
    h('p', { class: 'muted small' }, 'Drag to move: wall pieces sit flush on the nearest wall facing into the room and slide to corners, door and window jambs and their neighbours; others line up with walls and other pieces. Shift locks the axis, Alt places freely. Arrows nudge (Shift: a foot / 10 cm).'),
  );
}

function sizeText(s, u) {
  if (!s) return '';
  const L = (inches) => formatLength(inches * MM_PER_IN, u, { precision: 'label' });
  const dims = s.shape === 'round' && s.w === s.d ? `${L(s.w)} ⌀` : `${L(s.w)} × ${L(s.d)}`;
  return `${s.label} – ${dims}`;
}

function labelInput(value, placeholder, onCommit) {
  const input = h('input', { type: 'text', value, placeholder, spellcheck: false, autocomplete: 'off' });
  input.addEventListener('change', () => onCommit(input.value.trim()));
  input.addEventListener('keydown', (e) => e.key === 'Enter' && input.blur());
  return input;
}

function stat(label, value) {
  return h('div', { class: 'stat' }, h('span', {}, label), h('strong', {}, String(value)));
}
