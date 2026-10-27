// Flooring panel (shown while the plan's flooring layer is on): which run
// each room is in, the product and pattern of the active run, its direction
// and origin helpers, the layout check, the material takeoff and the install
// guidance for its flooring type.
import {
  BUY_UNITS, FLOOR_KINDS, FLOOR_LAYERS, FLOOR_PRESETS, assignRooms, bestFit, centredOrigin, createRun, cutLimits,
  presetFields, presetsFor, resolveRun, roomRun, runLayer,
} from '../core/flooring.js';
import { formatArea, formatLength, parseDeviation, parseLength } from '../core/units.js';
import { checkbox, field, h, lengthInput, numberInput, select } from './dom.js';

/** Piece sizes: bare numbers are inches (imperial) or mm (metric); feet need a ' mark. */
function parseSize(raw, units) {
  const s = String(raw).trim();
  const mm = /['′’]|ft|feet|foot/i.test(s) ? parseLength(s, units) : parseDeviation(s, units === 'metric' ? 'mm' : 'in');
  return mm == null || mm < 0 ? null : mm;
}

const sizeHint = (units) => (units === 'metric' ? 'Try 600, 1.2m or 3' : 'Try 48, 7 1/2, 1/8 or 8\'');

/** Piece sizes in mm on metric plans (grout and gaps are a few mm), feet and inches otherwise. */
function formatSize(mm, units) {
  return units === 'metric' ? `${Math.round(mm * 10) / 10} mm` : formatLength(mm, units);
}

export function floorPanel(app, analysis) {
  const d = app.design;
  const u = d.units;
  const plan = app.plan;
  const layer = plan.floorLayer;
  const sel = app.selection;
  const g = sel?.type === 'room' ? analysis.rooms.find((x) => x.room?.id === sel.id) : null;
  const runs = d.floorRuns.filter((r) => runLayer(r) === layer);
  const active = plan.activeFloorRun();
  const count = (l) => d.floorRuns.filter((r) => runLayer(r) === l).length;

  const layerSwitch = h('div', { class: 'segmented fl-layers', role: 'group', 'aria-label': 'Flooring layer' },
    Object.entries(FLOOR_LAYERS).map(([key, label]) => h('button', {
      class: key === layer ? 'active' : '',
      onclick: () => {
        plan.floorLayer = key;
        plan.render();
        app.inspector.render();
      },
    }, `${label}${count(key) ? ` (${count(key)})` : ''}`)));

  const out = [
    h('div', { class: 'panel-kicker' }, 'Flooring layout'),
    layerSwitch,
  ];
  if (!analysis.rooms.length) {
    out.push(h('p', {}, 'Draw a room first, then lay out its flooring here.'));
    return h('div', { class: 'panel' }, ...out);
  }

  if (g) {
    out.push(h('h2', {}, g.room.name), roomAssignment(app, g, layer));
  } else {
    out.push(h('p', { class: 'muted small' }, 'Click a room to choose its flooring. Rooms can share one run, so the pattern carries through the doorways between them.'));
    if (runs.length) {
      out.push(h('ul', { class: 'wall-list' }, runs.map((r) => h('li', { class: r === active ? 'active' : '' },
        h('button', {
          class: 'link',
          onclick: () => {
            plan.floorRunId = r.id;
            app.select({ type: 'room', id: r.roomIds[0] });
          },
        }, r.name),
        h('span', { class: 'muted small' }, roomNames(d, r.roomIds))))));
    }
  }
  if (active) out.push(...runCard(app, analysis, active));
  out.push(h('div', { class: 'button-row' }, h('button', { onclick: () => plan.setFlooring(false) }, 'Hide flooring layer')));
  return h('div', { class: 'panel' }, ...out);
}

function roomNames(d, ids) {
  return ids.map((id) => d.rooms.find((r) => r.id === id)?.name).filter(Boolean).join(', ');
}

/** Which run on this layer the room belongs to: none, an existing run, or a new one. */
function roomAssignment(app, g, layer) {
  const d = app.design;
  const roomId = g.room.id;
  const current = roomRun(d, roomId, layer);
  const options = { '': 'None' };
  for (const r of d.floorRuns.filter((x) => runLayer(x) === layer)) options[r.id] = `${r.name} · ${roomNames(d, r.roomIds)}`;
  for (const [kind, k] of Object.entries(FLOOR_KINDS)) if (k.layer === layer) options[`new:${kind}`] = `+ New ${k.label.toLowerCase()} run`;
  return field(`${FLOOR_LAYERS[layer]} in this room`, select(current?.id ?? '', options, (v) => {
    if (!v) {
      app.change('Remove flooring', (x) => {
        const r = roomRun(x, roomId, layer);
        if (r) r.roomIds = r.roomIds.filter((id) => id !== roomId);
      });
    } else if (v.startsWith('new:')) {
      app.change('New flooring run', (x) => createRun(x, v.slice(4), [roomId]));
    } else {
      app.change('Assign flooring', (x) => assignRooms(x, v, [roomId]));
    }
  }), current && current.roomIds.length > 1 ? `Shared with ${roomNames(d, current.roomIds.filter((id) => id !== roomId))}` : null);
}

function runCard(app, analysis, run) {
  const d = app.design;
  const u = d.units;
  const plan = app.plan;
  const r = resolveRun(run, u);
  const layout = plan.floorLayout(run, analysis);
  const kind = FLOOR_KINDS[r.kind];
  const editRun = (label, fn) => app.change(label, (x) => {
    const target = x.floorRuns.find((f) => f.id === run.id);
    if (target) fn(target, x);
  });
  const sizeInput = (value, onCommit, opts = {}) => lengthInput(value, u, onCommit, { parse: parseSize, format: formatSize, example: sizeHint(u), ...opts });

  const nameInput = h('input', { type: 'text', value: r.name, maxlength: 80 });
  nameInput.addEventListener('change', () => editRun('Rename flooring run', (x) => { x.name = nameInput.value.trim() || x.name; }));
  nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && nameInput.blur());

  // Rooms: tick to join this run (taking the room out of any other run on the layer).
  const otherRun = (roomId) => d.floorRuns.find((x) => x !== run && runLayer(x) === r.layer && x.roomIds.includes(roomId));
  // Alphabetical, with numbers in order (Room 2 before Room 10).
  const byName = (a, b) => a.room.name.localeCompare(b.room.name, undefined, { numeric: true, sensitivity: 'base' });
  const rooms = analysis.rooms.filter((x) => x.room && !x.dead).sort(byName).map((x) => {
    const id = x.room.id;
    const elsewhere = otherRun(id);
    return checkbox(`${x.room.name}${elsewhere ? ` (in ${elsewhere.name})` : ''}`, r.roomIds.includes(id), (v) => editRun(v ? 'Add room to flooring run' : 'Remove room from flooring run', (target, x2) => {
      if (v) assignRooms(x2, target.id, [id]);
      else target.roomIds = target.roomIds.filter((rid) => rid !== id);
    }));
  });

  const presetOptions = Object.fromEntries(presetsFor(r.kind, u).map(([k, p]) => [k, p.name]));
  presetOptions.custom = 'Custom size';
  const presetKey = FLOOR_PRESETS[r.preset] ? r.preset : 'custom';
  const kindOptions = Object.fromEntries(Object.entries(FLOOR_KINDS).filter(([, k]) => k.layer === r.layer).map(([key, k]) => [key, k.label]));

  const product = [
    h('h3', {}, 'Product'),
    Object.keys(kindOptions).length > 1 ? field('Type', select(r.kind, kindOptions, (v) => editRun('Flooring type', (x) => {
      x.kind = v;
      Object.assign(x, presetFields(presetsFor(v, u)[0][0], u));
    }))) : null,
    field('Product', select(presetKey, presetOptions, (v) => v !== 'custom' && editRun('Flooring product', (x) => Object.assign(x, presetFields(v, u))))),
    h('div', { class: 'field-row' },
      field(r.unit === 'roll' ? 'Roll length' : `${kind.piece[0].toUpperCase()}${kind.piece.slice(1)} length`, sizeInput(r.length, (mm) => editRun('Piece length', (x) => { x.length = mm; x.preset = 'custom'; }), { min: 10 })),
      field(r.unit === 'roll' ? 'Roll width' : 'Width', sizeInput(r.width, (mm) => editRun('Piece width', (x) => { x.width = mm; x.preset = 'custom'; }), { min: 10 }))),
    r.kind !== 'plank' ? field(r.kind === 'tile' ? 'Grout joint' : 'Gap between panels', sizeInput(r.joint, (mm) => editRun('Joint width', (x) => { x.joint = mm; }))) : null,
    ...staggerFields(app, r, editRun, sizeInput),
    h('div', { class: 'field-row' },
      field(r.unit === 'box' ? `${kind.pieces[0].toUpperCase()}${kind.pieces.slice(1)} per box` : 'Pieces per unit', numberInput(r.perBox, (v) => editRun('Pieces per box', (x) => { x.perBox = Math.max(1, Math.round(v)); }), { min: 1 })),
      field('Sold by', select(r.unit, Object.fromEntries(Object.entries(BUY_UNITS).map(([k, [one]]) => [k, one])), (v) => editRun('Sold by', (x) => { x.unit = v; })))),
    h('div', { class: 'field-row' },
      field('Waste allowance', numberInput(r.waste, (v) => editRun('Flooring waste', (x) => { x.waste = Math.min(100, Math.max(0, v)); }), { min: 0, max: 100, suffix: '%' })),
      field(r.kind === 'tile' ? 'Movement joint' : 'Gap at walls', sizeInput(r.gap, (mm) => editRun('Expansion gap', (x) => { x.gap = mm; })))),
    field('Smallest end cut', sizeInput(r.minCut, (mm) => editRun('Smallest cut', (x) => { x.minCut = mm; }), { allowEmpty: true, placeholder: `Auto (${formatSize(cutLimits({ ...r, minCut: null }).end.sliver, u)})` }),
      'Shorter cuts are marked as slivers; Best fit and the random stagger avoid them'),
  ];

  const isGrid = r.stagger.mode === 'fixed';
  const direction = [
    h('h3', {}, 'Direction & start'),
    h('div', { class: 'field-row' },
      field('Run direction', numberInput(Math.round(r.angle * 10) / 10, (v) => editRun('Flooring direction', (x, x2) => {
        x.angle = ((v % 180) + 180) % 180;
        x.origin = bestFit(x2, x);
      }), { step: 15, suffix: '°' }), r.angle % 180 === 0 ? 'East–west' : r.angle % 180 === 90 ? 'North–south' : 'Diagonal'),
      field('Floor joists run', select(d.settings.joists ?? '', { '': 'Unknown / slab', EW: 'East–west', NS: 'North–south' },
        (v) => app.change('Joist direction', (x) => { x.settings.joists = v; })))),
    h('div', { class: 'button-row' },
      h('button', { onclick: () => editRun('Rotate flooring', (x, x2) => { x.angle = (resolveRun(x, u).angle + 90) % 180; x.origin = bestFit(x2, x); }) }, '⟳ Rotate 90°'),
      h('button', { class: 'primary', title: 'Place the pattern to avoid slivers, especially in doorways, and balance the rows', onclick: () => editRun('Best fit', (x, x2) => { x.origin = bestFit(x2, x); }) }, 'Best fit'),
      r.kind === 'tile' ? h('button', { title: 'A tile centred in the largest room', onclick: () => editRun('Center tile', (x, x2) => { x.origin = centredOrigin(x2, x, 'tile'); }) }, 'Center tile') : null,
      r.kind === 'tile' ? h('button', { title: 'Grout lines crossing at the centre of the largest room', onclick: () => editRun('Center joint', (x, x2) => { x.origin = centredOrigin(x2, x, 'joint'); }) }, 'Center joint') : null),
    h('p', { class: 'muted small' }, 'Drag the layout on the plan to move the pattern; it snaps rows and joints to wall corners and room centres (hold Shift for free movement). Arrow keys nudge it (Shift = ', u === 'metric' ? '10 mm' : '1"', ').',
      isGrid || r.kind !== 'plank' ? '' : ' With a random stagger each row picks its own start cut, so rows re-shuffle as you drag along them.'),
  ];

  return [
    h('h3', {}, kind.label === 'Subfloor' ? 'Subfloor run' : `${kind.label} run`),
    field('Name', nameInput),
    h('div', { class: 'field-label' }, 'Rooms in this run'),
    h('div', { class: 'fl-rooms' }, rooms),
    r.roomIds.length > 1 ? h('p', { class: 'muted small' }, 'One continuous pattern: it carries through the doors and cased openings between these rooms without restarting.') : null,
    ...product,
    ...direction,
    ...layoutCheck(layout, u),
    ...takeoffFields(layout, u),
    ...guidanceList(layout),
    h('div', { class: 'button-row' },
      h('button', { class: 'danger', onclick: () => app.change('Delete flooring run', (x) => { x.floorRuns = x.floorRuns.filter((f) => f.id !== run.id); }) }, 'Delete run')),
  ];
}

/** Stagger: random or fixed offset for planks, the bond pattern for tile, the seam offset for subfloor. */
function staggerFields(app, r, editRun, sizeInput) {
  const u = app.design.units;
  const pu = r.length + r.joint;
  const setOffset = (label, mm) => editRun(label, (x) => { x.stagger = { ...resolveRun(x, u).stagger, mode: 'fixed', offset: mm }; });
  const fractionButtons = (fracs) => h('div', { class: 'button-row fl-fracs' }, fracs.map(([f, label]) => h('button', {
    class: Math.abs(((r.stagger.offset % pu) + pu) % pu - pu * f) < 1 && r.stagger.mode === 'fixed' ? 'active' : '',
    onclick: () => setOffset('Stagger offset', pu * f),
  }, label)));
  if (r.kind === 'plank') {
    const random = r.stagger.mode === 'random';
    return [
      field('Stagger', select(r.stagger.mode, { random: 'Random (keeps a minimum joint spacing)', fixed: 'Fixed offset' },
        (v) => editRun('Stagger', (x) => { x.stagger = { ...resolveRun(x, u).stagger, mode: v }; }))),
      random
        ? h('div', { class: 'field-row' },
          field('Min joint spacing', sizeInput(r.stagger.min, (mm) => editRun('Joint spacing', (x) => { x.stagger = { ...resolveRun(x, u).stagger, min: mm }; }))),
          field('Pattern', h('button', { onclick: () => editRun('Reshuffle stagger', (x) => { const st = resolveRun(x, u).stagger; x.stagger = { ...st, seed: st.seed + 1 }; }) }, 'Reshuffle')))
        : field('Offset per row', sizeInput(r.stagger.offset, (mm) => setOffset('Stagger offset', mm))),
      random ? null : fractionButtons([[1 / 2, '½'], [1 / 3, '⅓'], [1 / 4, '¼']]),
    ];
  }
  if (r.kind === 'tile') {
    const frac = (((r.stagger.offset % pu) + pu) % pu) / pu;
    const near = (f) => Math.abs(frac - f) < 1e-3;
    const key = near(0) || near(1) ? 'grid' : near(1 / 2) ? 'half' : near(1 / 3) ? 'third' : 'custom';
    const fracOf = { grid: 0, half: 1 / 2, third: 1 / 3 };
    return [
      field('Pattern', select(key, { grid: 'Grid (stacked)', half: '½ offset (brick)', third: '⅓ offset', custom: 'Custom offset' },
        (v) => v !== 'custom' && setOffset('Tile pattern', pu * fracOf[v]))),
      key === 'custom' ? field('Offset per row', sizeInput(r.stagger.offset, (mm) => setOffset('Tile offset', mm))) : null,
    ];
  }
  return [
    field('Seam offset per row', sizeInput(r.stagger.offset, (mm) => setOffset('Seam offset', mm))),
    fractionButtons([[0, 'None'], [1 / 2, '½ sheet'], [1 / 4, '¼ sheet']]),
  ];
}

/** Row widths at the walls, the shortest end and narrowest rip, and the cut counts. */
function layoutCheck(layout, u) {
  const L = (mm) => formatLength(mm, u, { precision: 'label' });
  const s = layout.stats;
  const e = layout.ends;
  const lim = layout.limits;
  if (!layout.pieces.length) return [h('h3', {}, 'Layout check'), h('p', { class: 'muted small' }, 'The run has no floor to cover yet.')];
  const row = (label, value, bad) => h('tr', { class: bad ? 'bad' : '' }, h('th', {}, label), h('td', {}, value));
  const rows = [];
  if (e) {
    rows.push(row(`First row (${e.vFrom.toLowerCase()} wall)`, L(e.v.first), e.v.first < lim.rip.warn - 0.5));
    rows.push(row(`Last row (${e.vTo.toLowerCase()} wall)`, L(e.v.last), e.v.last < lim.rip.warn - 0.5));
    if (e.u) {
      rows.push(row(`First column (${e.uFrom.toLowerCase()} wall)`, L(e.u.first), e.u.first < lim.end.warn - 0.5));
      rows.push(row(`Last column (${e.uTo.toLowerCase()} wall)`, L(e.u.last), e.u.last < lim.end.warn - 0.5));
    }
  }
  if (s.shortestEnd) rows.push(row('Shortest end piece', L(s.shortestEnd.needL), s.shortestEnd.needL < lim.end.sliver - 0.5));
  if (s.narrowestRip) rows.push(row('Narrowest rip', L(s.narrowestRip.needW), s.narrowestRip.needW < lim.rip.sliver - 0.5));
  rows.push(row('Cut pieces', `${s.cut} of ${s.pieces}`));
  rows.push(row('Slivers', s.slivers ? `${s.slivers}${s.trafficIssues ? ` · ${s.trafficIssues} small cuts in doorways/traffic` : ''}` : 'None', s.slivers > 0));
  return [h('h3', {}, 'Layout check'), h('table', { class: 'lvl-table fl-check' }, h('tbody', {}, rows))];
}

function takeoffFields(layout, u) {
  const r = layout.run;
  const m = layout.material;
  if (!layout.pieces.length) return [];
  const [one, many] = BUY_UNITS[r.unit];
  const pieces = FLOOR_KINDS[r.kind].pieces;
  const area = (mm2) => formatArea(mm2, u);
  const buy = r.perBox > 1
    ? ['Buy ', h('b', {}, `${m.boxes} ${m.boxes === 1 ? one : many}`), ` (${m.buy} ${pieces}).`]
    : ['Buy ', h('b', {}, `${m.boxes} ${m.boxes === 1 ? one : many}`), '.'];
  const row = (label, value, note) => h('tr', {}, h('th', {}, label), h('td', {}, value), h('td', { class: 'muted' }, note ?? ''));
  return [
    h('h3', {}, 'Material takeoff'),
    h('p', { class: 'lvl-result' }, buy),
    h('table', { class: 'lvl-table' }, h('tbody', {},
      row('From the layout', `${m.stock} ${pieces}`, `${layout.stats.full} full + ${m.stock - layout.stats.full} cut${m.reused ? `, ${m.reused} cuts from offcuts` : ''}`),
      row(`+ ${r.waste}% waste`, `${m.order} ${pieces}`, r.perBox > 1 ? `${r.perBox} per ${one}` : ''),
      row('Floor covered', area(m.netArea), `cut waste ${Math.round(m.cutWaste * 100)}%`),
      row('Bought', area(m.coverage), r.perBox > 1 ? `${area(m.boxArea)} per ${one}` : ''))),
    h('p', { class: 'muted small' }, 'Counts come from this layout, reusing offcuts where they fit; the waste allowance covers breakage, defects and mis-cuts. Carton counts are typical, so check the box.'),
  ];
}

function guidanceList(layout) {
  const icon = { ok: '✓', warn: '!', info: 'i' };
  return [
    h('h3', {}, `Install guidance · ${FLOOR_KINDS[layout.run.kind].label.toLowerCase()}`),
    h('ul', { class: 'fl-guide' }, layout.guidance.map((gd) => h('li', { class: gd.status },
      h('span', { class: 'fl-icon', 'aria-label': gd.status }, icon[gd.status]),
      h('div', {}, h('strong', {}, gd.title), ' ', gd.text)))),
    h('p', { class: 'muted small' }, 'Typical published figures (NWFA, ANSI A108 / TCNA, APA). The manufacturer\'s instructions take precedence.'),
  ];
}
