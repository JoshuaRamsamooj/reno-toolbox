// Application shell: owns the design, undo history, selection and
// persistence, and wires the views together.
import { createDesign, migrateDesign, newOpeningProblem, normalize, openingProblems, deleteGuide, deleteNode, deleteOpening, deleteRoom, deleteWall } from './core/model.js';
import { deleteFurniture } from './core/furniture.js';
import { renderThumbnail } from './core/thumbnail.js';
import { formatLength } from './core/units.js';
import { api } from './api.js';
import { PlanView, TOOLS } from './ui/planView.js';
import { Inspector } from './ui/inspector.js';
import { ElevationView } from './ui/elevationView.js';
import { TakeoffView } from './ui/takeoffView.js';
import { FaceEditor } from './ui/faceEditor.js';
import { setCatalog } from './core/trimCatalog.js';
import { h } from './ui/dom.js';

const DRAFT_KEY = 'reno-toolbox:draft';
const HISTORY_LIMIT = 200;
const $ = (sel) => document.querySelector(sel);

class App {
  constructor() {
    this.listeners = new Map();
    this.design = createDesign('imperial');
    this.name = 'Untitled plan';
    this.savedId = null;
    this.dirty = false;
    this.selection = null;
    this.undoStack = [];
    this.redoStack = [];
    this.tab = 'plan';
    this.spaceDown = false;
    this.trimFace = null; // wall face open in the Trim tab: { wallId, dir }
    this.lastPackageId = null;

    this.plan = new PlanView(this, $('#plan'));
    this.inspector = new Inspector(this, $('#inspector'));
    this.elevations = new ElevationView(this, $('#view-elevations'));
    this.takeoff = new TakeoffView(this, $('#view-takeoff'));
    this.faceEditor = new FaceEditor(this, $('#view-trim'));

    this.on('change', () => this.refresh());
    this.on('selection', () => this.refresh());
    this.on('tool', (tool) => {
      this.updateToolbar(tool);
      this.inspector.render();
    });
    this.on('focus-inspector', (hit) => this.inspector.focus(hit));
    this.on('cursor', (p) => {
      $('#coords').textContent = p ? `${formatLength(p.x, this.design.units, { precision: 'label' })}, ${formatLength(p.y, this.design.units, { precision: 'label' })}` : '';
    });

    this.buildToolbar();
    this.bindChrome();
    this.restoreDraft();
    this.refresh();
    requestAnimationFrame(() => this.plan.fit());
  }

  on(evt, fn) {
    if (!this.listeners.has(evt)) this.listeners.set(evt, []);
    this.listeners.get(evt).push(fn);
  }

  emit(evt, payload) {
    for (const fn of this.listeners.get(evt) ?? []) fn(payload);
  }

  // -------------------------------------------------------------------------
  // Mutations and history

  snapshot() {
    return JSON.stringify(this.design);
  }

  pushUndo(snap) {
    this.undoStack.push(snap);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  /**
   * Applies a mutation as one undoable step, then normalises the plan.
   * Refused if it leaves an opening that doesn't fit (overlapping another,
   * or above a bulkhead or the ceiling).
   */
  change(label, fn) {
    const before = this.snapshot();
    const problems = openingProblems(this.design);
    try {
      fn(this.design);
      normalize(this.design);
      const problem = newOpeningProblem(problems, this.design);
      if (problem) throw new Error(problem);
    } catch (err) {
      console.error(err);
      this.design = migrateDesign(JSON.parse(before));
      this.toast(`Couldn't ${label.toLowerCase()}: ${err.message}`, 'error');
      this.refresh(); // put inputs back to the unchanged values
      return;
    }
    if (this.snapshot() === before) return;
    this.pushUndo(before);
    this.markDirty();
    this.validateSelection();
    this.emit('change', label);
  }

  /** Live edits (dragging) mutate in place and are committed by endLive(). */
  beginLive() {
    this.liveBefore = this.snapshot();
    this.liveProblems = openingProblems(this.design);
  }

  live() {
    this.plan.render();
    if (this.tab === 'trim') this.faceEditor.renderCanvas();
  }

  endLive(label) {
    const before = this.liveBefore;
    this.liveBefore = null;
    normalize(this.design);
    const problem = before && newOpeningProblem(this.liveProblems, this.design);
    if (problem) {
      // e.g. a wall shortened until its openings collide: snap back.
      this.design = migrateDesign(JSON.parse(before));
      this.toast(`Couldn't ${label.toLowerCase()}: ${problem}`, 'error');
      this.refresh();
      return;
    }
    if (before && this.snapshot() !== before) {
      this.pushUndo(before);
      this.markDirty();
    }
    this.validateSelection();
    this.emit('change', label);
  }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(this.snapshot());
    this.design = migrateDesign(JSON.parse(this.undoStack.pop()));
    this.afterHistoryJump();
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this.snapshot());
    this.design = migrateDesign(JSON.parse(this.redoStack.pop()));
    this.afterHistoryJump();
  }

  afterHistoryJump() {
    this.markDirty();
    this.validateSelection();
    this.syncUnitsButtons();
    this.emit('change', 'history');
  }

  validateSelection() {
    const lists = { wall: this.design.walls, node: this.design.nodes, opening: this.design.openings, room: this.design.rooms, guide: this.design.guides, furniture: this.design.furniture };
    const alive = this.selectedItems().filter((i) => lists[i.type]?.some((x) => x.id === i.id));
    this.selection = alive.length > 1 ? { type: 'multi', items: alive } : alive[0] ?? null;
  }

  /** Selection is null, a single {type, id}, or {type: 'multi', items: [{type, id}, ...]}. */
  select(sel) {
    const same = JSON.stringify(sel ?? null) === JSON.stringify(this.selection ?? null);
    this.selection = sel ?? null;
    if (!same) this.emit('selection', sel);
  }

  selectedItems() {
    const s = this.selection;
    if (!s) return [];
    return s.type === 'multi' ? s.items : [s];
  }

  isSelected(type, id) {
    return this.selectedItems().some((i) => i.type === type && i.id === id);
  }

  selectMany(items) {
    const seen = new Set();
    const unique = items.filter((i) => {
      const key = `${i.type}:${i.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    this.select(unique.length > 1 ? { type: 'multi', items: unique } : unique[0] ?? null);
  }

  /** Shift+click: add the item to the selection, or remove it if already there. */
  toggleSelect(item) {
    const items = this.selectedItems();
    const rest = items.filter((i) => !(i.type === item.type && i.id === item.id));
    this.selectMany(rest.length === items.length ? [...items, item] : rest);
  }

  selectAll() {
    this.selectMany([
      ...this.design.walls.map((w) => ({ type: 'wall', id: w.id })),
      ...this.design.openings.map((o) => ({ type: 'opening', id: o.id })),
      ...(this.plan.furnitureVisible() ? this.design.furniture.map((f) => ({ type: 'furniture', id: f.id })) : []),
    ]);
  }

  deleteSelection() {
    const items = this.selectedItems();
    if (!items.length) return;
    // Rooms first (they look at the walls), then openings, walls and corners.
    const order = { room: 0, opening: 1, wall: 2, node: 3, guide: 4, furniture: 5 };
    const ops = { wall: deleteWall, node: deleteNode, opening: deleteOpening, room: deleteRoom, guide: deleteGuide, furniture: deleteFurniture };
    const sorted = [...items].sort((a, b) => order[a.type] - order[b.type]);
    const label = items.length > 1 ? `Delete ${items.length} items` : `Delete ${items[0].type}`;
    this.change(label, (d) => sorted.forEach((i) => ops[i.type](d, i.id)));
    this.select(null);
    if (items.length > 1) this.toast(`Deleted ${items.length} items`);
  }

  // -------------------------------------------------------------------------
  // Rendering

  refresh() {
    this.plan.render();
    this.inspector.render();
    if (this.tab === 'elevations') this.elevations.render();
    if (this.tab === 'takeoff') this.takeoff.render();
    if (this.tab === 'trim') this.faceEditor.render();
    $('#btn-undo').disabled = !this.undoStack.length;
    $('#btn-redo').disabled = !this.redoStack.length;
  }

  showTab(tab) {
    this.tab = tab;
    for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === tab);
    for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== `view-${tab}`;
    $('.toolbar').classList.toggle('disabled', tab !== 'plan');
    if (tab === 'plan') this.updateToolbar(this.plan.tool);
    this.refresh();
    if (tab === 'plan') this.plan.render();
  }

  /** Opens a wall face ({wallId, dir}) in the Trim tab's elevation editor. */
  openFace(ref) {
    if (JSON.stringify(ref) !== JSON.stringify(this.trimFace)) {
      this.faceEditor.sel = null;
      this.faceEditor.selGuide = null;
      this.faceEditor.rulers.cancel();
    }
    this.trimFace = ref;
    this.showTab('trim');
  }

  buildToolbar() {
    const icons = {
      select: '<path d="M5 3l14 8-6 1.5L10 19z"/>',
      pan: '<path d="M12 2v20M2 12h20M12 2l-3 3M12 2l3 3M12 22l-3-3M12 22l3-3M2 12l3-3M2 12l3 3M22 12l-3-3M22 12l-3 3" stroke-width="2" fill="none"/>',
      wall: '<path d="M3 17V7h6v6h12" stroke-width="3" fill="none"/>',
      rect: '<rect x="4" y="5" width="16" height="14" stroke-width="2.5" fill="none"/>',
      door: '<path d="M4 20h4V6M8 6a12 12 0 0 1 12 12" fill="none" stroke-width="2"/><path d="M3 20h18" stroke-width="2"/>',
      window: '<rect x="3" y="9" width="18" height="6" fill="none" stroke-width="2"/><path d="M3 12h18" stroke-width="1.5"/>',
      opening: '<path d="M3 12h5M16 12h5M8 8v8M16 8v8" stroke-width="2.5" fill="none"/>',
      layout: '<rect x="3" y="4" width="10" height="13" rx="1.5" fill="none" stroke-width="2"/><path d="M3 8h10" stroke-width="1.5"/><rect x="15" y="12" width="6" height="8" rx="1" fill="none" stroke-width="1.8"/><path d="M15 15h6" stroke-width="1.4"/>',
      measure: '<rect x="2" y="8" width="20" height="8" rx="1" fill="none" stroke-width="2"/><path d="M6 8v4M10 8v3M14 8v4M18 8v3" stroke-width="1.6" fill="none"/>',
      level: '<rect x="2" y="8" width="20" height="8" rx="2" fill="none" stroke-width="2"/><rect x="9.5" y="10" width="5" height="4" rx="1" stroke="none"/><path d="M7 8v3M17 8v3" stroke-width="1.5"/>',
      trim: '<path d="M3 4h18M3 20h18" stroke-width="2.5" fill="none"/><path d="M3 4v16" stroke-width="2" fill="none"/><rect x="8" y="8" width="9" height="8" fill="none" stroke-width="1.8"/>',
    };
    const bar = $('#tools');
    for (const [key, tool] of Object.entries(TOOLS)) {
      bar.append(h('button', {
        class: 'tool', dataset: { tool: key }, title: `${tool.label} (${tool.key})`,
        onclick: () => {
          this.showTab('plan');
          this.plan.setTool(key);
        },
      }, iconSvg(icons[key]), h('span', {}, tool.label)));
    }
    this.updateToolbar('select');
  }

  updateToolbar(tool) {
    for (const b of document.querySelectorAll('.tool')) b.classList.toggle('active', b.dataset.tool === tool);
    $('#hint').textContent = TOOLS[tool].hint;
  }

  // -------------------------------------------------------------------------
  // Chrome: header buttons, tabs, keyboard

  bindChrome() {
    for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => this.showTab(b.dataset.tab));
    $('#btn-undo').addEventListener('click', () => this.undo());
    $('#btn-redo').addEventListener('click', () => this.redo());
    $('#btn-new').addEventListener('click', () => this.newDesign());
    $('#btn-open').addEventListener('click', () => this.openDialog());
    $('#btn-save').addEventListener('click', () => this.save());
    $('#btn-save-as').addEventListener('click', () => this.save({ asNew: true }));
    $('#btn-export').addEventListener('click', () => this.exportJson());
    $('#btn-import').addEventListener('click', () => $('#import-file').click());
    $('#import-file').addEventListener('change', (e) => this.importJson(e.target.files[0]));

    const nameInput = $('#design-name');
    nameInput.addEventListener('input', () => {
      this.name = nameInput.value;
      this.markDirty();
    });
    nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && nameInput.blur());

    for (const b of document.querySelectorAll('#units button')) {
      b.addEventListener('click', () => {
        if (this.design.units === b.dataset.units) return;
        this.change('Change units', (d) => {
          d.units = b.dataset.units;
        });
        this.syncUnitsButtons();
        this.refresh();
      });
    }

    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') this.spaceDown = false;
    });
    window.addEventListener('beforeunload', (e) => {
      if (this.dirty && this.design.walls.length) e.preventDefault();
    });
  }

  onKey(e) {
    const t = e.target;
    const typing = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      this.save({ asNew: e.shiftKey });
      return;
    }
    if (typing || $('#open-dialog').open) return;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      this.redo();
      return;
    }
    if (this.tab === 'trim') {
      if (e.code === 'Space' && !this.faceEditor.typed) {
        this.spaceDown = true;
        e.preventDefault();
        return;
      }
      if (this.faceEditor.onKey(e)) e.preventDefault();
      return;
    }
    if (this.tab !== 'plan') return;
    if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      this.plan.setTool('select');
      this.selectAll();
      return;
    }
    if (this.plan.onKey(e)) {
      e.preventDefault();
      return;
    }
    if (e.code === 'Space') {
      this.spaceDown = true;
      e.preventDefault();
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selection) {
      e.preventDefault();
      this.deleteSelection();
      return;
    }
    if (mod || e.altKey) return;
    const key = e.key.toUpperCase();
    if (key === 'F') return this.plan.fit();
    for (const [name, tool] of Object.entries(TOOLS)) {
      if (tool.key === key) {
        this.plan.setTool(name);
        return;
      }
    }
  }

  syncUnitsButtons() {
    for (const b of document.querySelectorAll('#units button')) b.classList.toggle('active', b.dataset.units === this.design.units);
  }

  markDirty() {
    this.dirty = true;
    this.updateTitle();
    clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => this.saveDraft(), 400);
  }

  updateTitle() {
    $('#design-name').value = this.name;
    $('#dirty').textContent = this.dirty ? (this.savedId ? 'Unsaved changes' : 'Not saved') : 'Saved';
    $('#dirty').className = this.dirty ? 'status dirty' : 'status';
    document.title = `${this.dirty ? '• ' : ''}${this.name} – Reno Toolbox`;
  }

  // -------------------------------------------------------------------------
  // Persistence

  saveDraft() {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ design: this.design, name: this.name, savedId: this.savedId, dirty: this.dirty }));
    } catch {
      // Storage full or unavailable: the draft is a convenience only.
    }
  }

  restoreDraft() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) {
        const draft = JSON.parse(raw);
        this.loadDesign(draft.design, { name: draft.name, id: draft.savedId, dirty: draft.dirty });
        return;
      }
    } catch {
      localStorage.removeItem(DRAFT_KEY);
    }
    this.loadDesign(createDesign('imperial'), { name: 'Untitled plan' });
  }

  loadDesign(data, { name, id = null, dirty = false }) {
    this.design = migrateDesign(data);
    normalize(this.design);
    this.name = name || 'Untitled plan';
    this.savedId = id;
    this.dirty = dirty;
    this.selection = null;
    this.trimFace = null;
    this.undoStack = [];
    this.redoStack = [];
    this.syncUnitsButtons();
    this.updateTitle();
    this.saveDraft();
    this.refresh();
  }

  confirmDiscard() {
    return !this.dirty || !this.design.walls.length || confirm('Discard unsaved changes to the current plan?');
  }

  newDesign() {
    if (!this.confirmDiscard()) return;
    this.loadDesign(createDesign(this.design.units), { name: 'Untitled plan' });
    this.plan.setTool('rect');
    this.plan.fit();
  }

  async save({ asNew = false } = {}) {
    let name = this.name.trim() || 'Untitled plan';
    if (asNew) {
      const answer = prompt('Save a copy as:', this.savedId ? `${name} (copy)` : name);
      if (answer == null) return;
      name = answer.trim() || name;
    }
    const payload = { name, data: this.design, thumbnail: renderThumbnail(this.design) };
    try {
      const rec = this.savedId && !asNew ? await api.update(this.savedId, payload) : await api.create(payload);
      this.savedId = rec.id;
      this.name = rec.name;
      this.dirty = false;
      this.updateTitle();
      this.saveDraft();
      this.toast(`Saved “${rec.name}”`);
    } catch (err) {
      this.toast(`Save failed: ${err.message}`, 'error');
    }
  }

  async openDialog() {
    const dialog = $('#open-dialog');
    const list = $('#design-list');
    list.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
    dialog.showModal();
    try {
      const designs = await api.list();
      if (!designs.length) {
        list.replaceChildren(h('p', { class: 'muted' }, 'No saved plans yet. Use Save to store the current plan in the local database.'));
        return;
      }
      list.replaceChildren(...designs.map((rec) => h('div', { class: `design-item${rec.id === this.savedId ? ' current' : ''}` },
        h('button', { class: 'design-open', onclick: () => this.openDesign(rec.id) },
          rec.thumbnail ? h('img', { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(rec.thumbnail)}`, alt: '' }) : h('div', { class: 'no-thumb' }),
          h('div', {}, h('strong', {}, rec.name), h('span', { class: 'muted small' }, new Date(rec.updatedAt).toLocaleString())),
        ),
        h('button', { class: 'icon danger', title: 'Delete', onclick: () => this.deleteDesign(rec) }, '✕'),
      )));
    } catch (err) {
      list.replaceChildren(h('p', { class: 'error' }, `Couldn't load plans: ${err.message}`));
    }
  }

  async openDesign(id) {
    if (!this.confirmDiscard()) return;
    try {
      const rec = await api.get(id);
      $('#open-dialog').close();
      this.loadDesign(rec.data, { name: rec.name, id: rec.id });
      this.plan.setTool('select');
      this.plan.fit();
      this.toast(`Opened “${rec.name}”`);
    } catch (err) {
      this.toast(`Open failed: ${err.message}`, 'error');
    }
  }

  async deleteDesign(rec) {
    if (!confirm(`Delete “${rec.name}” from the database? This can't be undone.`)) return;
    try {
      await api.remove(rec.id);
      if (rec.id === this.savedId) {
        this.savedId = null;
        this.dirty = true;
        this.updateTitle();
      }
      this.openDialog();
    } catch (err) {
      this.toast(`Delete failed: ${err.message}`, 'error');
    }
  }

  exportJson() {
    const blob = new Blob([JSON.stringify({ name: this.name, data: this.design }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${this.name.replace(/[^\w.-]+/g, '_') || 'plan'}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async importJson(file) {
    if (!file) return;
    $('#import-file').value = '';
    if (!this.confirmDiscard()) return;
    try {
      const parsed = JSON.parse(await file.text());
      const data = parsed.data ?? parsed;
      if (!Array.isArray(data.walls) || !Array.isArray(data.nodes)) throw new Error('not a Reno Toolbox plan');
      this.loadDesign(data, { name: parsed.name ?? file.name.replace(/\.json$/i, ''), dirty: true });
      this.plan.fit();
    } catch (err) {
      this.toast(`Import failed: ${err.message}`, 'error');
    }
  }

  toast(msg, kind = 'info') {
    const el = $('#toast');
    el.textContent = msg;
    el.className = `toast show ${kind}`;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (el.className = 'toast'), 2600);
  }
}

function iconSvg(body) {
  const tpl = document.createElement('template');
  tpl.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" fill="currentColor" stroke-linejoin="round">${body}</svg>`;
  return tpl.content.firstElementChild;
}

/** Loads the trim profile catalog (public/data/trim-profiles.json) before the app starts. */
async function loadCatalog() {
  try {
    const res = await fetch('data/trim-profiles.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const catalog = setCatalog(await res.json());
    for (const w of catalog.warnings) console.warn(`Trim catalog: ${w}`);
    return null;
  } catch (err) {
    console.error(err);
    return `Couldn't load the trim catalog (${err.message}); trim will use generic sizes`;
  }
}

const catalogProblem = await loadCatalog();
window.app = new App();
if (catalogProblem) window.app.toast(catalogProblem, 'error');
