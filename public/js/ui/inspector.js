// Right-hand properties panel: edits whatever is selected in the plan, or
// the design-wide settings when nothing is selected.
import { addBulkhead, analyze, deleteNode, roomElevations, deleteOpening, deleteRoom, deleteWall, indexDesign, OPENING_TYPES, resolveRoomCeiling, setWallLength, wallLength } from '../core/model.js';
import { CEILING_TYPES } from '../core/ceiling.js';
import { bulkheadDefaults } from '../core/bulkhead.js';
import { formatArea, formatLength, formatLinear, unitDefaults } from '../core/units.js';
import { checkbox, field, h, lengthInput, select } from './dom.js';

export class Inspector {
  constructor(app, el) {
    this.app = app;
    this.el = el;
  }

  render() {
    const { design, selection } = this.app;
    const analysis = analyze(design);
    let body;
    if (selection?.type === 'room') body = this.roomPanel(analysis, selection.id);
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
      h('h3', {}, 'Quick start'),
      h('ol', { class: 'help' },
        h('li', {}, h('b', {}, 'Room tool (R): '), 'drag a rectangle, or click a corner and type the interior size, e.g. ', h('code', {}, u === 'metric' ? '3.6x4.2' : "12x10'6"), ' then Enter.'),
        h('li', {}, 'Start the next room on an existing corner. Shared walls merge automatically.'),
        h('li', {}, h('b', {}, 'Wall tool (W): '), 'click corners; type a length like ', h('code', {}, u === 'metric' ? '2.4' : "8'6"), ' + Enter to set each wall exactly. Ending on a wall or corner joins it.'),
        h('li', {}, h('b', {}, 'Door (D), Window (N), Opening (O): '), 'click on a wall.'),
        h('li', {}, 'Click a room to name it and set its ceiling height and profile.'),
        h('li', {}, 'Switch to ', h('b', {}, 'Elevations'), ' or ', h('b', {}, 'Takeoff'), ' at the top of the canvas.'),
      ),
      h('p', { class: 'muted small' }, 'Select several: drag a box or Shift+click; Ctrl+A selects all; Del deletes. Pan: right-drag, middle mouse or hold Space. Zoom: scroll wheel. Undo: Ctrl+Z.'),
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
      checkbox('Crown moulding', !!room.crown, (v) => editRoom('Crown', (r) => { r.crown = v; })),
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

function stat(label, value) {
  return h('div', { class: 'stat' }, h('span', {}, label), h('strong', {}, String(value)));
}
