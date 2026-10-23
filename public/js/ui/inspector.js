// Right-hand properties panel: edits whatever is selected in the plan, or
// the design-wide settings when nothing is selected.
import { addBulkhead, analyze, deleteNode, roomElevations, deleteOpening, deleteRoom, deleteWall, indexDesign, OPENING_TYPES, resolveRoomCeiling, setWallLength, wallLength } from '../core/model.js';
import { CEILING_TYPES } from '../core/ceiling.js';
import { bulkheadDefaults } from '../core/bulkhead.js';
import {
  COMPOUNDS, DEEP_GRIND, FLATNESS_SPECS, SPACING_OPTIONS, bagCoverage, connectedRooms, readingUnit, resolveLeveling, roomDoorways,
} from '../core/leveling.js';
import { MM_PER_IN, formatArea, formatDeviation, formatLength, formatLinear, unitDefaults } from '../core/units.js';
import { checkbox, deviationInput, field, h, lengthInput, numberInput, select } from './dom.js';
import { designFaces, faceRef } from '../core/faces.js';
import { clearScope, faceSummary, packageApplier, packageManager, quickApply, quickRemove } from './trimPanels.js';

const LITRES_PER_CU_FT = 28.3168;

export class Inspector {
  constructor(app, el) {
    this.app = app;
    this.el = el;
  }

  render() {
    const { design, selection } = this.app;
    const analysis = analyze(design);
    let body;
    if (this.app.tab === 'trim') body = this.app.faceEditor.panel();
    else if (this.app.plan.tool === 'level') body = this.levelPanel(analysis);
    else if (selection?.type === 'room') body = this.roomPanel(analysis, selection.id);
    else if (selection?.type === 'wall') body = this.wallPanel(analysis, selection.id);
    else if (selection?.type === 'opening') body = this.openingPanel(analysis, selection.id);
    else if (selection?.type === 'node') body = this.nodePanel(selection.id);
    else if (selection?.type === 'multi') body = this.multiPanel(analysis, selection.items);
    this.el.replaceChildren(body ?? this.designPanel(analysis));
  }

  focus(hit) {
    const target = hit?.type === 'room' ? 'input[name=room-name]' : hit?.type === 'wall' ? 'input[name=wall-length]' : 'input';
    const input = this.el.querySelector(target);
    input?.focus();
    input?.select?.();
  }

  edit(label, fn) {
    this.app.change(label, fn);
  }

  designPanel(analysis) {
    const d = this.app.design;
    const u = d.units;
    const floor = analysis.rooms.reduce((s, g) => s + g.area, 0);
    return h('div', { class: 'panel' },
      h('h2', {}, 'Plan settings'),
      h('div', { class: 'stats' },
        stat('Rooms', analysis.rooms.length),
        stat('Walls', d.walls.length),
        stat('Floor area', formatArea(floor, u)),
      ),
      field('Default wall thickness', lengthInput(d.settings.wallThickness, u, (mm) => this.edit('Wall thickness', (x) => { x.settings.wallThickness = mm; }), { min: 1 }),
        'Used for new walls'),
      h('button', {
        class: 'link', onclick: () => this.edit('Apply thickness', (x) => x.walls.forEach((w) => { w.thickness = x.settings.wallThickness; })),
      }, 'Apply to all existing walls'),
      field('Default ceiling height', lengthInput(d.settings.ceilingHeight, u, (mm) => this.edit('Ceiling height', (x) => { x.settings.ceilingHeight = mm; }), { min: 100 }),
        'Rooms without their own height use this'),
      field('Plan dimensions', select(d.settings.dimensionMode, { interior: 'Interior faces (per room)', centerline: 'Wall centrelines', off: 'Hidden' },
        (v) => this.edit('Dimension mode', (x) => { x.settings.dimensionMode = v; }))),
      checkbox('Show trim on the plan', d.settings.showTrim !== false, (v) => this.edit(v ? 'Show trim' : 'Hide trim', (x) => { x.settings.showTrim = v; })),
      h('h3', {}, 'Trim (whole house)'),
      quickApply(this.app, {}, 'house', { tray: analysis.rooms.some((g) => resolveRoomCeiling(d, g.room).type === 'tray') }),
      quickRemove(this.app, {}, 'house'),
      packageApplier(this.app, {}, ['house']),
      h('div', { class: 'button-row' }, h('button', { onclick: () => this.app.showTab('trim') }, 'Open trim editor')),
      h('details', { class: 'packages' }, h('summary', {}, `Trim packages (${d.trimPackages.length})`), ...packageManager(this.app)),
      h('h3', {}, 'Quick start'),
      h('ol', { class: 'help' },
        h('li', {}, h('b', {}, 'Room tool (R): '), 'drag a rectangle, or click a corner and type the interior size, e.g. ', h('code', {}, u === 'metric' ? '3.6x4.2' : "12x10'6"), ' then Enter.'),
        h('li', {}, 'Start the next room on an existing corner. Shared walls merge automatically.'),
        h('li', {}, h('b', {}, 'Wall tool (W): '), 'click corners; type a length like ', h('code', {}, u === 'metric' ? '2.4' : "8'6"), ' + Enter to set each wall exactly. Ending on a wall or corner joins it.'),
        h('li', {}, h('b', {}, 'Door (D), Window (N), Opening (O): '), 'click on a wall.'),
        h('li', {}, 'Click a room to name it and set its ceiling height and profile.'),
        h('li', {}, h('b', {}, 'Trim tool (T): '), 'click the side of a wall to draw baseboard, casing, chair rail and panels on it.'),
        h('li', {}, 'Switch to ', h('b', {}, 'Elevations'), ', ', h('b', {}, 'Trim'), ' or ', h('b', {}, 'Takeoff'), ' at the top of the canvas.'),
      ),
      h('p', { class: 'muted small' }, 'Select several: drag a box or Shift+click; Ctrl+A selects all; Del deletes. Pan: P, right-drag, middle mouse or hold Space. Zoom: scroll wheel. Undo: Ctrl+Z.'),
    );
  }

  roomPanel(analysis, roomId) {
    const d = this.app.design;
    const u = d.units;
    const g = analysis.rooms.find((x) => x.room?.id === roomId);
    if (!g) return null;
    const room = g.room;
    const spec = resolveRoomCeiling(d, room);
    const c = room.ceiling;
    const editRoom = (label, fn) => this.edit(label, (x) => fn(x.rooms.find((r) => r.id === roomId)));
    const nameInput = h('input', { type: 'text', name: 'room-name', value: room.name, maxlength: 80 });
    nameInput.addEventListener('change', () => editRoom('Rename room', (r) => { r.name = nameInput.value.trim() || r.name; }));
    nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && nameInput.blur());

    const defaultH = formatLength(d.settings.ceilingHeight, u);
    const heightLabel = { flat: 'Ceiling height', tray: 'Ceiling height (perimeter)', shed: 'Low side height', gable: 'Wall (eave) height' }[spec.type];
    const ceilingFields = [
      field('Profile', select(spec.type, CEILING_TYPES, (v) => editRoom('Ceiling profile', (r) => { r.ceiling.type = v; }))),
      field(heightLabel, lengthInput(c.height, u, (mm) => editRoom('Ceiling height', (r) => { r.ceiling.height = mm; }), { placeholder: `Default (${defaultH})`, allowEmpty: true, min: 100 })),
    ];
    if (spec.type === 'shed' || spec.type === 'gable') {
      ceilingFields.push(
        field(spec.type === 'shed' ? 'High side height' : 'Peak height', lengthInput(spec.peak, u, (mm) => editRoom('Peak height', (r) => { r.ceiling.peak = mm; }), { min: 100 })),
        spec.type === 'shed'
          ? field('Rises toward', select(spec.dir, { N: 'North (up)', E: 'East (right)', S: 'South (down)', W: 'West (left)' }, (v) => editRoom('Slope direction', (r) => { r.ceiling.dir = v; })))
          : field('Ridge runs', select(spec.ridge, { EW: 'East – West (left/right)', NS: 'North – South (up/down)' }, (v) => editRoom('Ridge direction', (r) => { r.ceiling.ridge = v; }))),
      );
    }
    if (spec.type === 'tray') {
      ceilingFields.push(
        field('Tray depth (rise)', lengthInput(spec.trayDepth, u, (mm) => editRoom('Tray depth', (r) => { r.ceiling.trayDepth = mm; }), { min: 1 })),
        field('Tray inset from walls', lengthInput(spec.trayInset, u, (mm) => editRoom('Tray inset', (r) => { r.ceiling.trayInset = mm; }), { min: 1 })),
      );
    }

    return h('div', { class: 'panel' },
      h('div', { class: 'panel-kicker' }, 'Room'),
      field('Name', nameInput),
      h('div', { class: 'stats' },
        stat('Floor', formatArea(g.area, u)),
        stat('Perimeter', formatLinear(g.perimeter, u)),
        stat('Walls', g.walls.length),
      ),
      h('h3', {}, 'Ceiling'),
      ...ceilingFields,
      h('h3', {}, 'Bulkheads'),
      ...this.bulkheadFields(g, editRoom),
      h('h3', {}, 'Finishes'),
      checkbox('Include in flooring estimate', room.flooring !== false, (v) => editRoom('Flooring', (r) => { r.flooring = v; })),
      h('h3', {}, 'Trim'),
      ...this.roomTrimFields(g),
      h('h3', {}, 'Walls (interior faces)'),
      h('ul', { class: 'wall-list' }, g.walls.map((w, i) => h('li', {},
        h('button', { class: 'link', onclick: () => this.app.select({ type: 'wall', id: w.wallIds[0] }) },
          `${i + 1}. ${w.compass}`),
        h('span', {}, formatLength(w.length, u)),
        w.openings.length ? h('span', { class: 'muted small' }, ` · ${w.openings.length} opening${w.openings.length > 1 ? 's' : ''}`) : null))),
      h('div', { class: 'button-row' },
        h('button', { onclick: () => this.app.showTab('elevations') }, 'View elevations'),
        h('button', { class: 'danger', onclick: () => { this.edit('Delete room', (x) => deleteRoom(x, roomId)); this.app.select(null); } }, 'Delete room'),
      ),
    );
  }

  /** Room trim: per-face list with editor links, one-click assignments and packages for the room. */
  roomTrimFields(g) {
    const d = this.app.design;
    const roomId = g.room.id;
    const faces = designFaces(d, analyze(d)).filter((f) => f.kind === 'room' && f.roomId === roomId);
    const target = { roomId };
    return [
      h('ul', { class: 'wall-list' }, faces.map((f) => h('li', {},
        h('button', { class: 'link', onclick: () => this.app.openFace(faceRef(f)) }, `${f.number}. ${f.compass}`),
        h('span', { class: 'muted small' }, faceSummary(d, f) || 'no trim'),
        h('button', { class: 'link', onclick: () => this.app.openFace(faceRef(f)) }, 'Edit')))),
      h('p', { class: 'muted small' }, 'Add to every wall of this room (one Undo):'),
      quickApply(this.app, target, 'room', { tray: resolveRoomCeiling(d, g.room).type === 'tray' }),
      quickRemove(this.app, target, 'room'),
      packageApplier(this.app, target, ['room']),
      h('button', { class: 'link danger', onclick: () => clearScope(this.app, 'room', target) }, 'Clear this room\'s trim'),
    ];
  }

  bulkheadFields(g, editRoom) {
    const d = this.app.design;
    const u = d.units;
    const roomId = g.room.id;
    const elev = roomElevations(d, g);
    const def = bulkheadDefaults(u);
    const faceOptions = Object.fromEntries(g.walls.map((f, i) => [f.wallIds[0], `${i + 1}. ${f.compass} (${formatLength(f.length, u, { precision: 'label' })})`]));
    const editBh = (id, label, fn) => editRoom(label, (r) => fn(r.bulkheads.find((b) => b.id === id)));
    const cards = elev.bulkheads.map((r, i) => {
      const bh = r.bulkhead;
      const face = r.face;
      return h('div', { class: 'subcard' },
        h('div', { class: 'subcard-head' },
          h('strong', {}, `Bulkhead ${i + 1}`),
          h('button', { class: 'link danger', onclick: () => editRoom('Remove bulkhead', (rm) => { rm.bulkheads = rm.bulkheads.filter((b) => b.id !== bh.id); }) }, 'Remove')),
        field('Along wall', select(face.wallIds[0], faceOptions, (v) => editBh(bh.id, 'Bulkhead wall', (b) => {
          b.wallId = v;
          b.anchor = null;
          b.start = null;
          b.length = null;
        }))),
        h('div', { class: 'field-row' },
          field('Depth into room', lengthInput(r.depth, u, (mm) => editBh(bh.id, 'Bulkhead depth', (b) => { b.depth = mm; }), { min: 1 })),
          field('Underside height', lengthInput(bh.bottom, u, (mm) => editBh(bh.id, 'Bulkhead height', (b) => { b.bottom = mm; }),
            { allowEmpty: true, min: 1, placeholder: formatLength(r.bottom, u, { precision: 'label' }) })),
        ),
        h('div', { class: 'field-row' },
          field('Start from left', lengthInput(bh.start, u, (mm) => editBh(bh.id, 'Bulkhead start', (b) => { b.start = mm; }),
            { allowEmpty: true, placeholder: 'Corner (0)' })),
          field('Length', lengthInput(bh.length, u, (mm) => editBh(bh.id, 'Bulkhead length', (b) => { b.length = mm; }),
            { allowEmpty: true, min: 1, placeholder: `Full (${formatLength(face.length - r.s0, u, { precision: 'label' })})` })),
        ),
      );
    });
    const longest = [...g.walls].sort((a, b) => b.length - a.length)[0];
    return [
      ...cards,
      cards.length ? h('p', { class: 'muted small' }, `"Left" is as seen from inside the room, facing the wall. Leave the height blank to sit ${formatLength(def.drop, u)} below the ceiling.`) : null,
      h('button', { class: 'add-button', onclick: () => this.edit('Add bulkhead', (x) => addBulkhead(x, roomId, longest.wallIds[0])) }, '+ Add bulkhead'),
    ];
  }

  wallPanel(analysis, wallId) {
    const d = this.app.design;
    const u = d.units;
    const idx = indexDesign(d);
    const w = idx.walls.get(wallId);
    if (!w) return null;
    const L = wallLength(d, w, idx);
    const info = analysis.wallInfo.get(wallId);
    const editWall = (label, fn) => this.edit(label, (x) => fn(x.walls.find((ww) => ww.id === wallId)));

    const sides = info.roomSides
      .filter(Boolean)
      .filter((g, i, arr) => arr.indexOf(g) === i)
      .map((g) => {
        const face = g.walls.find((f) => f.wallIds.includes(wallId));
        if (!face) return null;
        return field(`${g.room?.name ?? 'Room'} side (${face.compass.toLowerCase()} wall)`, lengthInput(face.length, u, (mm) => {
          this.edit('Wall length', (x) => setWallLength(x, wallId, L + (mm - face.length)));
        }, { min: 1 }), face.wallIds.length > 1 ? 'Interior face spans several wall segments' : null);
      });

    const openings = d.openings.filter((o) => o.wallId === wallId);
    const wallFaces = designFaces(d, analysis).filter((f) => f.wallIds.includes(wallId));
    return h('div', { class: 'panel' },
      h('div', { class: 'panel-kicker' }, 'Wall'),
      field('Centreline length', lengthInput(L, u, (mm) => this.edit('Wall length', (x) => setWallLength(x, wallId, mm)), { min: 1, name: 'wall-length' }),
        'Changing a length moves end B and stretches everything beyond it'),
      sides.length ? h('h3', {}, 'Interior face lengths') : null,
      ...sides,
      h('h3', {}, 'Construction'),
      field('Thickness', lengthInput(w.thickness, u, (mm) => editWall('Wall thickness', (ww) => { ww.thickness = mm; }), { min: 1 })),
      field('Type', select(w.exterior ?? 'auto', {
        auto: `Auto (${info.exterior ? 'exterior' : 'interior'})`,
        yes: 'Exterior – insulate',
        no: 'Interior – no insulation',
      }, (v) => editWall('Wall type', (ww) => { ww.exterior = v; }))),
      wallFaces.length ? h('h3', {}, 'Trim') : null,
      wallFaces.length ? h('div', { class: 'button-row' }, wallFaces.map((f) => h('button', { onclick: () => this.app.openFace(faceRef(f)), title: faceSummary(d, f) || 'No trim yet' },
        `Edit trim · ${f.kind === 'room' ? `${f.room.room?.name ?? 'Room'} side` : 'exterior side'}`))) : null,
      openings.length ? h('h3', {}, 'Openings in this wall') : null,
      openings.length ? h('ul', { class: 'wall-list' }, openings.map((o) => h('li', {},
        h('button', { class: 'link', onclick: () => this.app.select({ type: 'opening', id: o.id }) }, OPENING_TYPES[o.type]),
        h('span', {}, `${formatLength(o.width, u, { precision: 'label' })} × ${formatLength(o.height, u, { precision: 'label' })}`)))) : null,
      h('div', { class: 'button-row' },
        h('button', { class: 'danger', onclick: () => { this.edit('Delete wall', (x) => deleteWall(x, wallId)); this.app.select(null); } }, 'Delete wall'),
      ),
    );
  }

  openingPanel(analysis, openingId) {
    const d = this.app.design;
    const u = d.units;
    const o = d.openings.find((x) => x.id === openingId);
    if (!o) return null;
    const idx = indexDesign(d);
    const L = wallLength(d, idx.walls.get(o.wallId), idx);
    const editO = (label, fn) => this.edit(label, (x) => fn(x.openings.find((oo) => oo.id === openingId)));
    const fromA = o.offset - o.width / 2;
    const fromB = L - o.offset - o.width / 2;
    return h('div', { class: 'panel' },
      h('div', { class: 'panel-kicker' }, OPENING_TYPES[o.type]),
      field('Type', select(o.type, OPENING_TYPES, (v) => editO('Opening type', (oo) => {
        const def = unitDefaults(u)[v];
        oo.type = v;
        oo.height = def.height;
        oo.sill = def.sill;
      }))),
      field('Width', lengthInput(o.width, u, (mm) => editO('Opening width', (oo) => { oo.width = mm; }), { min: 1 })),
      field('Height', lengthInput(o.height, u, (mm) => editO('Opening height', (oo) => { oo.height = mm; }), { min: 1 })),
      o.type === 'window' ? field('Sill height (floor to bottom)', lengthInput(o.sill, u, (mm) => editO('Sill height', (oo) => { oo.sill = mm; }))) : null,
      h('h3', {}, 'Position'),
      field('Gap from wall end A', lengthInput(fromA, u, (mm) => editO('Move opening', (oo) => { oo.offset = mm + oo.width / 2; }))),
      field('Gap from wall end B', lengthInput(fromB, u, (mm) => editO('Move opening', (oo) => { oo.offset = L - mm - oo.width / 2; }))),
      h('p', { class: 'muted small' }, 'Measured along the wall centreline. Ends A and B are labelled on the plan when the wall is selected.'),
      o.type === 'door' ? h('div', { class: 'button-row' },
        h('button', { onclick: () => editO('Flip hinge', (oo) => { oo.flipX = !oo.flipX; }) }, '⇆ Flip hinge side'),
        h('button', { onclick: () => editO('Flip swing', (oo) => { oo.flipY = !oo.flipY; }) }, '⇅ Flip swing'),
      ) : null,
      h('div', { class: 'button-row' },
        h('button', { onclick: () => this.app.select({ type: 'wall', id: o.wallId }) }, 'Select wall'),
        h('button', { class: 'danger', onclick: () => { this.edit('Delete opening', (x) => deleteOpening(x, openingId)); this.app.select(null); } }, 'Delete'),
      ),
    );
  }

  multiPanel(analysis, items) {
    const d = this.app.design;
    const u = d.units;
    const count = (type) => items.filter((i) => i.type === type).length;
    const wallIds = new Set(items.filter((i) => i.type === 'wall').map((i) => i.id));
    const walls = d.walls.filter((w) => wallIds.has(w.id));
    const common = (vals) => (vals.every((v) => v === vals[0]) ? vals[0] : null);
    const thickness = walls.length ? common(walls.map((w) => Math.round(w.thickness * 100) / 100)) : null;
    const type = walls.length ? common(walls.map((w) => w.exterior ?? 'auto')) : null;
    const editWalls = (label, fn) => this.edit(label, (x) => x.walls.filter((w) => wallIds.has(w.id)).forEach(fn));
    const typeOptions = { auto: 'Auto-detect', yes: 'Exterior – insulate', no: 'Interior – no insulation' };
    if (type == null) typeOptions[''] = 'Mixed';
    const parts = [['wall', 'Walls'], ['opening', 'Openings'], ['room', 'Rooms'], ['node', 'Corners']].filter(([t]) => count(t));
    return h('div', { class: 'panel' },
      h('div', { class: 'panel-kicker' }, 'Multiple selection'),
      h('h2', {}, `${items.length} items selected`),
      h('div', { class: 'stats' }, parts.map(([t, label]) => stat(label, count(t)))),
      walls.length ? h('h3', {}, `Selected walls (${walls.length})`) : null,
      walls.length ? field('Thickness', lengthInput(thickness, u, (mm) => editWalls('Wall thickness', (w) => { w.thickness = mm; }), { min: 1, placeholder: 'Mixed' })) : null,
      walls.length ? field('Type', select(type ?? '', typeOptions, (v) => v && editWalls('Wall type', (w) => { w.exterior = v; }))) : null,
      h('div', { class: 'button-row' },
        h('button', { class: 'danger', onclick: () => this.app.deleteSelection() }, `Delete ${items.length} items`),
        h('button', { onclick: () => this.app.select(null) }, 'Clear selection'),
      ),
      h('p', { class: 'muted small' }, 'Shift+click adds or removes items. Drag left→right to select what is fully inside the box, right→left to select anything it touches. Ctrl+A selects everything.'),
    );
  }

  /** Level tool: survey grid, target and clearance, then the cut/fill plan and compound estimate. */
  levelPanel(analysis) {
    const d = this.app.design;
    const u = d.units;
    const plan = this.app.plan;
    const g = plan.levelRoom(analysis);
    if (!g) {
      return h('div', { class: 'panel' },
        h('div', { class: 'panel-kicker' }, 'Floor leveling'),
        h('p', {}, analysis.rooms.length ? 'Click a room on the plan to survey its floor.' : 'Draw a room first, then survey its floor here.'));
    }
    const roomId = g.room.id;
    const la = plan.levelAnalysis(g, analysis);
    const unit = readingUnit(d);
    const dev = (v, sign = true) => formatDeviation(v, unit, { sign });
    const area = (mm2) => formatArea(mm2, u);
    // Edits this room's survey; pass la.group.ids for settings linked rooms share (target, tolerance).
    const editLv = (label, fn, ids = [roomId]) => this.edit(label, (x) => {
      for (const id of ids) {
        const room = x.rooms.find((r) => r.id === id);
        if (!room) continue;
        const lv = resolveLeveling(room, x.units);
        fn(lv);
        room.leveling = lv;
      }
    });
    const measured = la.nodes.filter((nd) => nd.z != null).length;
    const zs = la.members.find((m) => m.geom.room.id === roomId).readings.map((r) => r.z);
    const firstEmpty = la.nodes.find((nd) => nd.z == null) ?? la.nodes[0];

    // Keys keep a decimal so integer-like ones (762) don't jump ahead in the option order.
    const spacingKey = (mm) => mm.toFixed(1);
    const spacingOptions = Object.fromEntries(SPACING_OPTIONS[u].map((mm) => [spacingKey(mm), formatLength(mm, u, { precision: 'label' })]));
    spacingOptions[spacingKey(la.lv.spacing)] ??= formatLength(la.lv.spacing, u, { precision: 'label' });
    const specKey = Object.entries(FLATNESS_SPECS).find(([, sp]) => Math.abs(sp.tolerance - la.band * 2) < 0.01)?.[0] ?? 'standard';

    const survey = [
      h('h3', {}, 'Survey grid'),
      h('div', { class: 'field-row' },
        field('Grid spacing', select(spacingKey(la.lv.spacing), spacingOptions, (v) => editLv('Grid spacing', (lv) => { lv.spacing = Number(v); }))),
        field('Bare numbers are', select(unit, { mm: 'mm', in: 'inches' }, (v) => this.edit('Reading unit', (x) => { x.settings.readingUnit = v; })))),
      checkbox('Quick entry: Enter jumps to the next node', plan.levelQuick, (v) => { plan.levelQuick = v; }),
      checkbox('Show numbers on the plan', plan.levelNumbers, (v) => {
        plan.levelNumbers = v;
        plan.render();
      }),
      la.nodes.length ? h('div', { class: 'button-row' },
        h('button', {
          class: 'primary',
          onclick: (e) => {
            e.currentTarget.blur();
            plan.startLevelEntry(g, firstEmpty);
          },
        }, measured ? `Continue at ${firstEmpty.label}` : `Start at ${firstEmpty.label}`),
      ) : h('p', { class: 'error small' }, 'The room is too small for this grid spacing.'),
      h('p', { class: 'muted small' },
        'Readings are relative to your benchmark (+ high, − low). Tap a preset in the bar under the plan, or type any other value, e.g. ', h('code', {}, unit === 'in' ? '3/8' : '4'), ' or ', h('code', {}, unit === 'in' ? '-5/16' : '-7.5'),
        ', then Enter. Tab skips, arrows move, Del clears, Esc stops. Nodes run in walking order: row 1 west → east, row 2 back.'),
      la.offGrid.length ? h('p', { class: 'muted small' }, `${la.offGrid.length} reading${la.offGrid.length > 1 ? 's sit' : ' sits'} off this grid (shown as ◆, still used). `,
        h('button', { class: 'link', onclick: () => editLv('Remove off-grid readings', (lv) => { lv.readings = lv.readings.filter((r) => !la.offGrid.some((o) => o.x === r.x && o.y === r.y)); }) }, 'Remove them')) : null,
    ];

    const target = [
      h('h3', {}, 'Target & tolerance'),
      field('Flatness spec', select(specKey, Object.fromEntries(Object.entries(FLATNESS_SPECS).map(([k, sp]) => [k, `${sp[u]} · ${sp.use}`])),
        (v) => editLv('Flatness spec', (lv) => { lv.tolerance = FLATNESS_SPECS[v].tolerance; }, la.group.ids)),
      `Level band ±${dev(la.band, false)} around the target keeps every straightedge gap within spec`),
    ];
    if (!la.ready) {
      target.push(h('p', { class: 'lvl-callout' }, `Enter at least 3 readings to see the heatmap and the action plan (${measured} of ${la.nodes.length} so far).`));
    } else {
      target.push(...this.levelTargetFields(g, la, editLv, dev));
    }

    return h('div', { class: 'panel' },
      h('div', { class: 'panel-kicker' }, 'Floor leveling'),
      h('h2', {}, g.room.name),
      h('div', { class: 'stats' },
        stat('Readings', `${measured} / ${la.nodes.length}`),
        stat('Highest', zs.length ? dev(Math.max(...zs)) : '–'),
        stat('Lowest', zs.length ? dev(Math.min(...zs)) : '–'),
      ),
      ...survey,
      ...this.levelLinkFields(g, la, analysis, editLv),
      ...target,
      ...this.levelLockFields(g, la, editLv, dev),
      ...(la.ready ? this.levelActionPlan(la, dev, area) : []),
      la.readings.length ? h('div', { class: 'button-row' },
        h('button', { class: 'danger', onclick: () => confirm(`Clear all ${la.readings.length} readings in ${g.room.name}?`) && editLv('Clear readings', (lv) => { lv.readings = []; }) }, 'Clear readings'),
      ) : null,
    );
  }

  levelTargetFields(g, la, editLv, dev) {
    const plan = this.app.plan;
    const roomId = g.room.id;
    const lo = Math.floor(Math.min(la.min - 2 * la.band, la.target, la.recommended));
    const hi = Math.ceil(Math.max(la.max + la.band, la.target));
    const readout = h('strong', { class: 'lvl-readout' }, dev(la.target));
    const slider = h('input', { type: 'range', min: lo, max: hi, step: 0.5, value: la.target, 'aria-label': 'Target height' });
    slider.addEventListener('input', () => {
      plan.levelPreview = { roomId, target: Number(slider.value) };
      readout.textContent = dev(Number(slider.value));
      plan.render();
    });
    slider.addEventListener('change', () => {
      plan.levelPreview = null;
      editLv('Target height', (lv) => { lv.target = Number(slider.value); }, la.group.ids);
      plan.render();
    });
    const unit = readingUnit(this.app.design);
    const area = (mm2) => formatArea(mm2, this.app.design.units);
    // Both optimised plans, already capped by the clearance locks; choosing one makes it the recommendation.
    const option = (key, title) => {
      const o = la.options[key];
      const active = la.minimize === key;
      return h('button', {
        class: `lvl-option${active ? ' active' : ''}`, 'aria-pressed': String(active),
        onclick: () => editLv(title, (lv) => { lv.minimize = key; lv.target = null; }, la.group.ids),
      },
      h('strong', {}, title),
      h('span', {}, `Target ${dev(o.target)}${o.capped ? ' (lock)' : ''}`),
      h('span', {}, o.grindArea ? `Grind ${area(o.grindArea)}, cut ≤ ${dev(o.maxCut, false)}` : 'No grinding'),
      h('span', {}, o.bags ? `Pour ${area(o.fillArea)}, ${o.bags} bag${o.bags === 1 ? '' : 's'}` : 'No compound'));
    };
    const out = [
      field('Optimize for', h('div', { class: 'lvl-options' }, option('grind', 'Minimize grinding'), option('pour', 'Minimize pour')),
        la.locks.length ? 'Both plans stay within the clearance locks' : null),
      field('Target height (vs benchmark)', h('div', { class: 'lvl-target' }, slider, readout)),
      field('Exact target', deviationInput(la.auto ? null : la.target, unit, (mm) => editLv('Target height', (lv) => { lv.target = mm; }, la.group.ids),
        { allowEmpty: true, placeholder: `Auto: ${dev(la.recommended)}` })),
    ];
    const capName = la.capLock ? lockName(la.capLock, la.linked).replace(/^./, (c) => c.toUpperCase()) : '';
    const rec = la.strategy === 'none'
      ? h('p', { class: `lvl-callout${la.auto ? ' ok' : ''}` }, `The floor is already within tolerance: at the recommended ${dev(la.recommended)} no pour or grinding is needed.`)
      : la.strategy === 'grind-only'
        ? h('p', { class: 'lvl-callout' },
          la.options.pour.capped ? `${capName} limits the floor to ${dev(la.cap)}, below the lowest spot. ` : '',
          `Recommended: grind the floor down to ${dev(la.recommended)} so no compound is needed`,
          la.options.pour.grindArea ? ` (${la.zones.length && la.auto ? `${la.zones.length} spot${la.zones.length === 1 ? '' : 's'}, ` : ''}cuts up to ${dev(la.options.pour.maxCut, false)}).` : '.')
      : la.strategy === 'fill'
        ? h('p', { class: 'lvl-callout' }, `Recommended: pour to ${dev(la.recommended)}, filling only (no grinding).`)
        : h('p', { class: 'lvl-callout warn' }, `${capName} limits the floor to ${dev(la.cap)}, below the ${dev(la.fillOnly)} a fill-only pour needs. `,
          h('b', {}, `Recommended: target ${dev(la.recommended)} and grind the high spots`), ' below rather than raising the whole floor.');
    out.push(rec);
    for (const b of la.breaches) {
      out.push(h('p', { class: 'lvl-callout danger' },
        h('b', {}, `Target breaches ${lockName(b, la.linked)} by ${dev(b.by, false)}. `),
        b.kind === 'doorway' ? `The floor would rise ${dev(la.target - b.z, false)} there (max ${dev(b.lock.maxBuild, false)}). ` : `The limit is ${dev(b.lock.maxBuild)} above the benchmark. `,
        'Lower the target, or use the recommendation to shift work to grinding.'));
    }
    if (!la.auto) {
      out.push(h('button', { class: 'link', onclick: () => editLv('Recommended target', (lv) => { lv.target = null; }, la.group.ids) }, `Use recommended (${dev(la.recommended)})`));
    }
    return out;
  }

  /** Locks of every room in the group (each edited on the room it belongs to); new ones go on this room. */
  levelLockFields(g, la, editLv, dev) {
    const unit = readingUnit(this.app.design);
    const locationOptions = (geom) => {
      const options = { '': 'Anywhere in the room (above benchmark)' };
      for (const dw of roomDoorways(geom)) {
        const label = `${OPENING_TYPES[dw.opening.type]} – ${dw.compass.toLowerCase()} wall`;
        const same = Object.values(options).filter((v) => v.startsWith(label)).length;
        options[dw.opening.id] = same ? `${label} (${same + 1})` : label;
      }
      return options;
    };
    const doorways = roomDoorways(g);
    const cards = la.locks.map((l, i) => {
      const lock = l.lock;
      const owner = la.members.find((m) => m.geom.room.id === l.room.id)?.geom ?? g;
      const editLock = (label, fn) => editLv(label, (lv) => fn(lv.locks.find((x) => x.id === lock.id)), [l.room.id]);
      const opts = locationOptions(owner);
      if (lock.openingId && !opts[lock.openingId]) opts[lock.openingId] = 'Removed opening';
      const status = l.kind === 'missing' ? 'That opening no longer exists, so this lock is ignored.'
        : l.kind === 'room' ? `Finished floor may reach ${dev(lock.maxBuild)} above the benchmark.`
          : l.z == null ? 'Needs readings to locate the existing floor height here.'
            : `Existing floor here reads ${dev(l.z)}, so the finished floor may reach ${dev(l.maxTarget)}.`;
      const breached = la.breaches?.some((b) => b.lock.id === lock.id);
      return h('div', { class: `subcard${breached ? ' breach' : ''}` },
        h('div', { class: 'subcard-head' },
          h('strong', {}, `Clearance lock ${i + 1}`, la.linked ? h('span', { class: 'muted' }, ` · ${l.room.name}`) : null),
          h('button', { class: 'link danger', onclick: () => editLv('Remove clearance lock', (lv) => { lv.locks = lv.locks.filter((x) => x.id !== lock.id); }, [l.room.id]) }, 'Remove')),
        field('Location', select(lock.openingId ?? '', opts, (v) => editLock('Lock location', (x) => { x.openingId = v || null; }))),
        field('Max build-up', deviationInput(lock.maxBuild, unit, (mm) => editLock('Max build-up', (x) => { x.maxBuild = mm; }), { min: 0, sign: false })),
        h('p', { class: `small ${breached ? 'error' : 'muted'}` }, status),
      );
    });
    const firstDoor = doorways.find((dw) => dw.opening.type === 'door') ?? doorways[0];
    return [
      h('h3', {}, 'Clearance locks'),
      ...cards,
      cards.length ? null : h('p', { class: 'muted small' }, 'Cap how far the floor may rise, e.g. 8 mm at a patio door threshold or under a door that can\'t be trimmed.'),
      h('button', {
        class: 'add-button',
        onclick: () => editLv('Add clearance lock', (lv) => {
          lv.locks = [...lv.locks, { id: `lk${Date.now().toString(36)}${lv.locks.length}`, openingId: firstDoor?.opening.id ?? null, maxBuild: 8 }];
        }),
      }, la.linked ? `+ Add clearance lock in ${g.room.name}` : '+ Add clearance lock'),
    ];
  }

  /** "Level with connected rooms" toggle, shown when the room shares a door or opening with another room. */
  levelLinkFields(g, la, analysis, editLv) {
    const d = this.app.design;
    const neighbours = connectedRooms(d, g, analysis);
    if (!neighbours.length) return [];
    const on = la.lv.linked !== false;
    const others = la.members.filter((m) => m.geom.room.id !== g.room.id).map((m) => m.geom.room.name);
    const waiting = neighbours.filter((n) => !la.group.ids.includes(n.room.id)).map((n) => n.room.name);
    let note;
    if (!on) note = 'This room is leveled on its own, with its own target and heatmap.';
    else if (others.length) {
      note = `Leveled with ${others.join(', ')} as one floor: one continuous heatmap, shared target, tolerance and clearance locks. ` +
        'All readings must be taken from the same benchmark.';
    } else note = `Connected to ${neighbours.map((n) => n.room.name).join(', ')}. Rooms join once both have readings and linking on.`;
    if (on && others.length && waiting.length) note += ` ${waiting.join(', ')} will join once surveyed (with linking on).`;
    return [
      h('h3', {}, 'Connected rooms'),
      checkbox('Level with rooms connected by doors or openings', on, (v) => editLv(v ? 'Link rooms' : 'Unlink room', (lv) => { lv.linked = v; })),
      h('p', { class: 'muted small' }, note),
    ];
  }

  levelActionPlan(la, dev, area) {
    const d = this.app.design;
    const u = d.units;
    const p = la.product;
    const editEstimate = (label, fn) => this.edit(label, (x) => {
      x.estimate = { ...(x.estimate ?? {}) };
      fn(x.estimate);
    });
    const zones = la.zones.map((z) => {
      const shown = z.nodes.slice(0, 5).map((nd) => `${nd.name} (${dev(nd.cut)})`).join(', ');
      const more = z.nodes.length > 5 ? ` +${z.nodes.length - 5} more` : '';
      return h('li', {},
        h('div', {}, h('strong', {}, z.label), ' ', shown + more),
        h('div', { class: 'muted small' },
          `${area(z.area)} · cut up to ${dev(z.maxCut, false)} · centre ${formatLength(z.fromWest, u, { precision: 'label' })} from ${la.linked ? `${z.room}'s ` : ''}west wall, ${formatLength(z.fromNorth, u, { precision: 'label' })} from north wall`));
    });

    const isMetric = u === 'metric';
    const volume = isMetric ? `${p.bagLitres.toFixed(1)} L` : `${(p.bagLitres / LITRES_PER_CU_FT).toFixed(2)} cu ft`;
    const samples = isMetric ? [3, 6, 12] : [1 / 8, 1 / 4, 1 / 2].map((i) => i * MM_PER_IN);
    const curve = samples.map((t) => `${area(bagCoverage(p, t))} at ${formatDeviation(t, isMetric ? 'mm' : 'in')}`).join(', ');
    const range = `${p.minThickness > 0 ? formatDeviation(p.minThickness, isMetric ? 'mm' : 'in') : 'featheredge'} to ${formatDeviation(p.maxNeat, isMetric ? 'mm' : 'in')} neat` +
      (p.extendedYield > 1 ? `, ${formatDeviation(p.maxExtended, isMetric ? 'mm' : 'in')} extended with aggregate (${p.extendedYield}× yield)` : '');
    const custom = la.productKey === 'custom' ? h('div', { class: 'field-row' },
      field(`Bag yield (${isMetric ? 'L' : 'cu ft'})`, numberInput(isMetric ? p.bagLitres : Math.round((p.bagLitres / LITRES_PER_CU_FT) * 100) / 100, (v) => editEstimate('Compound yield', (e) => {
        e.levelCustom = { ...(e.levelCustom ?? {}), bagLitres: Math.max(0.1, isMetric ? v : v * LITRES_PER_CU_FT) };
      }), { min: 0.1, step: isMetric ? 0.5 : 0.05 })),
      field('Max thickness', deviationInput(p.maxNeat, readingUnit(d), (mm) => editEstimate('Compound max thickness', (e) => {
        e.levelCustom = { ...(e.levelCustom ?? {}), maxNeat: mm, maxExtended: mm };
      }), { min: 1, sign: false })),
    ) : null;

    const warnings = [];
    if (la.overMaxArea > 0) warnings.push(`${area(la.overMaxArea)} is deeper than this product's ${dev(p.maxExtended, false)} limit: build those spots up first or pour in lifts.`);
    else if (la.extendedArea > 0) warnings.push(`${area(la.extendedArea)} is deeper than ${dev(p.maxNeat, false)}: extend with aggregate there (counted at ${p.extendedYield}× yield).`);
    if (la.maxCut > DEEP_GRIND) warnings.push(`Cuts deeper than ${dev(DEEP_GRIND, false)} are slow to grind in concrete; on wood subfloors plane or sister the joists instead.`);
    if (la.missing) warnings.push(`${la.missing} grid node${la.missing > 1 ? 's have' : ' has'} no reading yet; the heatmap interpolates there.`);

    return [
      h('h3', {}, la.linked ? `Action plan · ${la.group.names.join(' + ')}` : 'Action plan'),
      h('table', { class: 'lvl-table' }, h('tbody', {},
        h('tr', {}, h('th', {}, h('span', { class: 'swatch grind' }), 'Total grind area'), h('td', {}, area(la.grindArea)), h('td', { class: 'muted' }, la.grindArea ? `max cut ${dev(la.maxCut, false)}` : '')),
        h('tr', {}, h('th', {}, h('span', { class: 'swatch fill' }), 'Total fill area'), h('td', {}, area(la.fillArea)), h('td', { class: 'muted' }, la.fillArea ? `avg fill ${dev(la.avgFill, false)}` : '')),
      )),
      la.zones.length ? h('div', { class: 'field-label' }, `Grind these spots (${la.zones.length}, marked on the plan)`) : h('p', { class: 'muted small' }, 'No grinding needed at this target.'),
      la.zones.length ? h('ol', { class: 'lvl-zones' }, zones) : null,
      h('h3', {}, 'Compound estimate'),
      field('Product', select(la.productKey, Object.fromEntries(Object.entries(COMPOUNDS).map(([k, c]) => [k, k === 'custom' ? 'Custom product…' : `${c.name} (${c.bag})`])),
        (v) => editEstimate('Leveling compound', (e) => { e.levelProduct = v; }))),
      custom,
      h('p', { class: 'muted small' }, `Yield ${volume} per bag: about ${curve}. Pours from ${range}. Nominal data-sheet figures; check the bag.`),
      field('Contingency', numberInput(la.contingency, (v) => editEstimate('Contingency', (e) => { e.levelContingency = Math.min(100, Math.max(0, v)); }), { min: 0, max: 100, suffix: '%' })),
      h('p', { class: 'lvl-result' }, la.bags
        ? ['You need ', h('b', {}, `${la.bags} bag${la.bags === 1 ? '' : 's'}`), ` of compound (includes ${la.contingency}% contingency).`]
        : 'No compound needed at this target.'),
      ...warnings.map((w) => h('p', { class: 'lvl-callout warn small' }, w)),
    ];
  }

  nodePanel(nodeId) {
    const d = this.app.design;
    const count = d.walls.filter((w) => w.a === nodeId || w.b === nodeId).length;
    return h('div', { class: 'panel' },
      h('div', { class: 'panel-kicker' }, 'Corner'),
      h('p', {}, `${count} wall${count === 1 ? '' : 's'} meet here. Drag the corner to reshape; drop it on another corner to join them.`),
      h('div', { class: 'button-row' },
        h('button', { class: 'danger', onclick: () => { this.edit('Delete corner', (x) => deleteNode(x, nodeId)); this.app.select(null); } }, 'Delete corner & its walls'),
      ),
    );
  }
}

function lockName(l, linked = false) {
  const where = linked ? ` of ${l.room.name}` : '';
  if (l.kind === 'room') return linked ? `the room-wide clearance limit in ${l.room.name}` : 'the room-wide clearance limit';
  if (l.kind === 'doorway') return `the ${OPENING_TYPES[l.doorway.opening.type].toLowerCase()} on the ${l.doorway.compass.toLowerCase()} wall${where}`;
  return 'a removed opening';
}

function stat(label, value) {
  return h('div', { class: 'stat' }, h('span', {}, label), h('strong', {}, String(value)));
}
