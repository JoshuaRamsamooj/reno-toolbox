// Side-panel controls for trim: profile and size pickers, bulk assignment
// (face / room / house) and trim packages. Shared by the wall face editor
// and the room, wall and plan panels. Every bulk action is one app.change,
// so a single Undo reverses it.
import { designFaces, faceRef, findFace } from '../core/faces.js';
import {
  PACKAGE_CATEGORIES, applySpecs, clearTrim, describeSpec, itemLabel, makePackage, parseTrimLength, recordForFace, scopeFaces, specKey, trimDefaults,
  trimKindsOn,
} from '../core/trim.js';
import { TRIM_CATEGORIES, defaultProfile, formatSize, getProfile, profilesFor } from '../core/trimCatalog.js';
import { formatLength } from '../core/units.js';
import { checkbox, field, h, lengthInput, select } from './dom.js';

export const SCOPE_LABELS = { face: 'This face', room: 'Whole room', house: 'Whole house' };

/** lengthInput options for trim: bare numbers are inches (imperial) or mm (metric). */
export function trimLengthOpts(units, extra = {}) {
  return {
    parse: parseTrimLength,
    example: units === 'metric' ? 'Bare numbers are mm: 900, or 90cm, 0.9m' : `Bare numbers are inches: 36, 36 1/2, or 3'`,
    ...extra,
  };
}

const isSheetGood = (p) => p.unit !== 'lf';

/** Profiles an item of this category (and kind) may use. */
export function profileChoices(category, kind) {
  if (category === 'door-casing' || category === 'window-casing') {
    const other = category === 'door-casing' ? 'window-casing' : 'door-casing';
    return [...profilesFor(category), ...profilesFor(other)];
  }
  if (category === 'panel-moulding') return profilesFor('panel-moulding', kind === 'box' ? (p) => !isSheetGood(p) : isSheetGood);
  if (category === 'window-apron') return [...profilesFor('window-apron'), ...profilesFor(['window-casing', 'door-casing'])];
  return profilesFor(category);
}

function sizeText(profile, mm, units) {
  if (profile?.unit === 'sheet') return `${formatLength(mm, units, { precision: 'label' })} × ${formatLength(profile.sheetLength, units, { precision: 'label' })}`;
  return formatSize(mm, units);
}

/** Profile + width selects. onChange({profileId, size}) keeps the width when the new profile offers it. */
export function profilePicker(units, category, kind, profileId, size, onChange, labels = {}) {
  const profiles = profileChoices(category, kind);
  const options = profiles.map((p) => h('option', { value: p.id, selected: p.id === profileId }, p.name));
  if (!profiles.some((p) => p.id === profileId)) options.unshift(h('option', { value: profileId ?? '', selected: true }, profileId ? `${profileId} (not in catalog)` : 'Choose a profile…'));
  const profileSel = h('select', {}, options);
  profileSel.addEventListener('change', () => {
    const p = getProfile(profileSel.value);
    if (!p) return;
    onChange({ profileId: p.id, size: p.widths.some((w) => Math.abs(w - size) < 0.01) ? size : p.defaultWidth });
  });
  const p = getProfile(profileId);
  const widths = p?.widths ?? [];
  const sizes = widths.map((w) => h('option', { value: String(w), selected: Math.abs(w - size) < 0.01 }, sizeText(p, w, units)));
  if (!widths.some((w) => Math.abs(w - size) < 0.01)) sizes.unshift(h('option', { value: String(size), selected: true }, sizeText(p, size, units)));
  const sizeSel = h('select', {}, sizes);
  sizeSel.addEventListener('change', () => onChange({ profileId, size: Number(sizeSel.value) }));
  return h('div', { class: 'field-row' },
    field(labels.profile ?? 'Profile', profileSel),
    field(labels.size ?? (p?.unit === 'sheet' ? 'Sheet' : 'Width'), sizeSel));
}

/** Faces for a scope inside a change, re-found in the design being edited. */
function facesIn(d, scope, target) {
  const faces = designFaces(d);
  const face = target.face ? findFace(faces, faceRef(target.face)) : null;
  return scopeFaces(faces, scope, { face, roomId: target.roomId ?? face?.roomId ?? null });
}

/** Applies specs to every face in a scope as one undoable step. */
export function applyToScope(app, label, specs, scope, target) {
  let n = 0;
  app.change(label, (d) => {
    n = applySpecs(d, facesIn(d, scope, target), specs);
  });
  if (n) app.toast(`${label}: ${n} wall face${n === 1 ? '' : 's'} (one Undo reverts it)`);
  else app.toast('No wall faces to apply it to', 'error');
}

/** Kinds of trim that can be taken off a whole room or house, by specKey. */
export const TRIM_KINDS = {
  baseboard: { label: 'Baseboard', spec: { category: 'baseboard' } },
  shoe: { label: 'Shoe moulding', spec: { category: 'shoe' } },
  crown: { label: 'Crown', spec: { category: 'crown' } },
  'crown-tray': { label: 'Tray crown', spec: { category: 'crown', placement: 'tray' } },
  'chair-rail': { label: 'Chair rail', spec: { category: 'chair-rail' } },
  'door-casing': { label: 'Door casing', spec: { category: 'door-casing' } },
  'window-casing': { label: 'Window casing', spec: { category: 'window-casing' } },
  'panel-moulding': { label: 'Wainscot', spec: { category: 'panel-moulding' } },
};

const itemCount = (d) => d.faceTrim.reduce((n, r) => n + r.items.length, 0);

/** Takes one kind of trim off every face in a scope, as one undoable step. */
export function removeFromScope(app, key, scope, target) {
  const kind = TRIM_KINDS[key];
  const where = scope === 'house' ? 'the whole house' : scope === 'room' ? 'this room' : 'this face';
  let removed = 0;
  app.change(`Remove ${kind.label.toLowerCase()} from ${where}`, (d) => {
    const before = itemCount(d);
    applySpecs(d, facesIn(d, scope, target), [{ ...kind.spec, remove: true }]);
    removed = before - itemCount(d);
  });
  if (removed) app.toast(`Removed ${kind.label.toLowerCase()} from ${where}: ${removed} piece${removed === 1 ? '' : 's'} of trim (one Undo restores ${removed === 1 ? 'it' : 'them'})`);
  else app.toast(`There's no ${kind.label.toLowerCase()} in ${where}`, 'error');
}

/** "Remove from …" buttons for each kind of trim present in a scope (null when there's none). */
export function quickRemove(app, target, scope) {
  const kinds = trimKindsOn(app.design, facesIn(app.design, scope, target));
  const keys = Object.keys(TRIM_KINDS).filter((k) => kinds.has(k));
  if (!keys.length) return null;
  return h('div', { class: 'quick-remove' },
    h('span', { class: 'muted small' }, `Remove from ${scope === 'house' ? 'the whole house' : 'this room'}:`),
    h('div', { class: 'quick-apply' }, keys.map((k) => h('button', {
      class: 'danger', title: `Delete all ${TRIM_KINDS[k].label.toLowerCase()} from ${scope === 'house' ? 'every room' : 'every wall of this room'} (one Undo)`,
      onclick: () => removeFromScope(app, k, scope, target),
    }, `− ${TRIM_KINDS[k].label}`))));
}

export function clearScope(app, scope, target) {
  app.change(`Clear trim (${SCOPE_LABELS[scope].toLowerCase()})`, (d) => clearTrim(d, facesIn(d, scope, target)));
}

/** Package select with one apply button per scope. */
export function packageApplier(app, target, scopes) {
  const d = app.design;
  if (!d.trimPackages.length) return h('p', { class: 'muted small' }, 'No trim packages yet. Save a face\'s trim as a package in the Trim tab, or create one under Packages.');
  const sel = h('select', {}, d.trimPackages.map((p) => h('option', { value: p.id, selected: p.id === app.lastPackageId }, p.name)));
  sel.addEventListener('change', () => { app.lastPackageId = sel.value; });
  const apply = (scope) => {
    const pkg = app.design.trimPackages.find((p) => p.id === sel.value);
    if (!pkg) return;
    app.lastPackageId = pkg.id;
    applyToScope(app, `Apply “${pkg.name}”`, pkg.items, scope, target);
  };
  return h('div', { class: 'pkg-apply' },
    field('Package', sel),
    h('div', { class: 'button-row' }, scopes.map((scope) => h('button', { onclick: () => apply(scope), disabled: scope === 'room' && !target.roomId && !target.face?.roomId }, `Apply to ${SCOPE_LABELS[scope].toLowerCase()}`))));
}

/** One-click assignments of the default profiles to a scope. opts.tray offers crown in tray ceilings. */
export function quickApply(app, target, scope, { tray = false } = {}) {
  const run = (label, specs) => () => applyToScope(app, label, specs, scope, target);
  return h('div', { class: 'quick-apply' },
    h('button', { onclick: run('Baseboard', [{ category: 'baseboard' }]) }, '+ Baseboard'),
    h('button', { onclick: run('Shoe moulding', [{ category: 'shoe' }]), title: 'Shoe moulding (or quarter round) at the foot of the baseboard' }, '+ Shoe'),
    h('button', { onclick: run('Crown', [{ category: 'crown' }]) }, '+ Crown'),
    tray ? h('button', { onclick: run('Tray crown', [{ category: 'crown', placement: 'tray' }]), title: 'Crown along the sides of tray ceilings' }, '+ Tray crown') : null,
    h('button', { onclick: run('Chair rail', [{ category: 'chair-rail' }]) }, '+ Chair rail'),
    h('button', { onclick: run('Casing', [{ category: 'door-casing' }, { category: 'window-casing' }]) }, '+ Case doors & windows'),
  );
}

// ---------------------------------------------------------------------------
// Package manager

// Package items, one per kind; tray crown is a kind of its own.
const CATEGORY_OPTIONS = Object.fromEntries(PACKAGE_CATEGORIES.flatMap((c) => [
  [c, c === 'panel-moulding' ? 'Wainscot' : TRIM_CATEGORIES[c].label],
  ...(c === 'crown' ? [['crown-tray', 'Tray crown']] : []),
]));

/** A spec with the default profile and width for its kind ('crown-tray' = crown in a tray ceiling). */
export function defaultSpec(key, units) {
  const category = key === 'crown-tray' ? 'crown' : key;
  const kind = category === 'panel-moulding' ? 'wainscot' : null;
  const p = defaultProfile(category, kind ? isSheetGood : undefined) ?? profileChoices(category, kind)[0];
  const spec = { category, profileId: p?.id ?? null, size: p?.defaultWidth ?? 0 };
  const def = trimDefaults(units);
  if (category === 'chair-rail') spec.height = def.chairRail;
  if (category === 'panel-moulding') spec.height = def.wainscot;
  if (key === 'crown-tray') spec.placement = 'tray';
  return spec;
}

/** Window stool / apron / sill toggles for a casing spec or item. part(key) returns the current part or null. */
export function windowParts(units, current, onToggle, onPart) {
  const parts = [['stool', 'Stool', 'window-stool'], ['apron', 'Apron', 'window-apron'], ['sill', 'Sill', 'window-sill']];
  return parts.map(([key, label, category]) => {
    const part = current[key];
    return h('div', { class: 'part-row' },
      checkbox(label, !!part, (v) => onToggle(key, v)),
      part ? profilePicker(units, category, null, part.profileId, part.size, (pick) => onPart(key, pick), { profile: `${label} profile`, size: 'Width' }) : null,
      part && key !== 'apron' ? field(`${label} horn (past casing)`, lengthInput(part.horn, units, (mm) => onPart(key, { horn: mm }), trimLengthOpts(units))) : null,
    );
  });
}

let openPackageId = null;

export function packageManager(app) {
  const d = app.design;
  const u = d.units;
  const editPkg = (id, label, fn) => app.change(label, (x) => fn(x.trimPackages.find((p) => p.id === id)));
  const cards = d.trimPackages.map((pkg) => {
    const open = openPackageId === pkg.id;
    const head = h('div', { class: 'subcard-head' },
      h('button', { class: 'link', onclick: () => { openPackageId = open ? null : pkg.id; app.inspector.render(); } }, `${open ? '▾' : '▸'} ${pkg.name}`),
      h('button', { class: 'link danger', onclick: () => { app.change('Delete package', (x) => { x.trimPackages = x.trimPackages.filter((p) => p.id !== pkg.id); }); } }, 'Delete'));
    if (!open) return h('div', { class: 'subcard' }, head, h('div', { class: 'muted small' }, pkg.items.map((s) => describeSpec(s, u)).join(' · ') || 'Empty'));
    const nameInput = h('input', { type: 'text', value: pkg.name, maxlength: 80 });
    nameInput.addEventListener('change', () => editPkg(pkg.id, 'Rename package', (p) => { p.name = nameInput.value.trim() || p.name; }));
    const items = pkg.items.map((spec, i) => {
      const editSpec = (label, fn) => editPkg(pkg.id, label, (p) => fn(p.items[i]));
      return h('div', { class: 'pkg-item' },
        h('div', { class: 'subcard-head' },
          h('strong', {}, CATEGORY_OPTIONS[specKey(spec)]),
          h('button', { class: 'link danger', onclick: () => editPkg(pkg.id, 'Remove package item', (p) => { p.items.splice(i, 1); }) }, 'Remove')),
        profilePicker(u, spec.category, spec.category === 'panel-moulding' ? 'wainscot' : null, spec.profileId, spec.size, (pick) => editSpec('Package profile', (s) => Object.assign(s, pick))),
        spec.height != null ? field(spec.category === 'chair-rail' ? 'Height AFF (top of rail)' : 'Height', lengthInput(spec.height, u, (mm) => editSpec('Package height', (s) => { s.height = mm; }), trimLengthOpts(u, { min: 1 }))) : null,
        spec.category === 'window-casing' ? windowParts(u, spec,
          (key, on) => editSpec('Package window option', (s) => { s[key] = on ? {} : null; }),
          (key, pick) => editSpec('Package window option', (s) => { s[key] = { ...(s[key] ?? {}), ...pick }; })) : null,
      );
    });
    const addSel = select('', { '': 'Add an item…', ...CATEGORY_OPTIONS }, (cat) => {
      if (!cat) return;
      editPkg(pkg.id, 'Add package item', (p) => {
        p.items = p.items.filter((s) => specKey(s) !== cat);
        p.items.push(defaultSpec(cat, u));
      });
    });
    return h('div', { class: 'subcard open' }, head, field('Name', nameInput), ...items, addSel,
      h('p', { class: 'muted small' }, 'One item per kind of trim. Applying a package replaces those kinds of trim on each face.'));
  });
  const add = () => {
    const name = prompt('Package name:', `Package ${d.trimPackages.length + 1}`);
    if (!name?.trim()) return;
    const pkg = makePackage(name.trim(), [defaultSpec('baseboard', u), defaultSpec('door-casing', u), defaultSpec('window-casing', u)]);
    openPackageId = pkg.id;
    app.change('New package', (x) => { x.trimPackages.push(pkg); });
  };
  return [...cards, h('button', { class: 'add-button', onclick: add }, '+ New package')];
}

/** Save a face's trim (one item per kind) as a new package. */
export function saveFaceAsPackage(app, specs) {
  if (!specs.length) {
    app.toast('Add some trim to this face first', 'error');
    return;
  }
  const name = prompt('Save this face\'s trim as a package named:', 'Standard trim');
  if (!name?.trim()) return;
  const pkg = makePackage(name.trim(), specs);
  app.lastPackageId = pkg.id;
  app.change('Save package', (x) => { x.trimPackages.push(pkg); });
  app.toast(`Saved package “${pkg.name}”`);
}

/** Short summary of a face's trim for lists, e.g. "Baseboard, Crown, 2 casings". */
export function faceSummary(d, face) {
  const items = recordForFace(d, face)?.items ?? [];
  if (!items.length) return '';
  const counts = new Map();
  for (const i of items) counts.set(itemLabel(i), (counts.get(itemLabel(i)) ?? 0) + 1);
  return [...counts].map(([label, n]) => (n > 1 ? `${n}× ${label.toLowerCase()}` : label)).join(', ');
}
