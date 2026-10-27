// Trim profile catalog. Profiles are data (public/data/trim-profiles.json),
// loaded once at startup and validated here, so new profiles never need a
// code change. Widths are written with units ("3 1/4\"", "70mm") and stored
// in millimetres like all other geometry.
import { MM_PER_IN, formatLength, parseLength } from './units.js';

/** What each category is for. `kind` decides how the editor places it. */
export const TRIM_CATEGORIES = {
  baseboard: { label: 'Baseboard', kind: 'run' },
  shoe: { label: 'Shoe moulding', kind: 'run' },
  crown: { label: 'Crown', kind: 'run' },
  'chair-rail': { label: 'Chair rail', kind: 'run' },
  'panel-moulding': { label: 'Wall / panel moulding', kind: 'panel' },
  'door-casing': { label: 'Door casing', kind: 'casing' },
  'window-casing': { label: 'Window casing', kind: 'casing' },
  'window-stool': { label: 'Window stool', kind: 'part' },
  'window-apron': { label: 'Window apron', kind: 'part' },
  'window-sill': { label: 'Window sill', kind: 'part' },
};

export const ESTIMATE_UNITS = { lf: 'Linear', sf: 'Area', sheet: 'Sheets' };

/** How wall panelling is drawn: grooves, boards at the width, battens, or plain sheets. */
export const PANEL_PATTERNS = ['beadboard', 'shiplap', 'board-batten', 'panel'];

const EXPLICIT_UNIT = /['"′″’”]|mm$|cm$|\dm$|in\b|ft\b/;

/** A length that must carry its unit, so catalog values never depend on the display system. */
function parseCatalogLength(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!EXPLICIT_UNIT.test(s)) return null;
  const mm = parseLength(s, 'imperial');
  return mm != null && mm > 0 ? Math.round(mm * 1000) / 1000 : null;
}

/**
 * Validates raw catalog JSON. Bad entries are skipped (and reported in
 * `warnings`) rather than failing the whole catalog.
 */
export function parseCatalog(raw) {
  const warnings = [];
  const profiles = [];
  const byId = new Map();
  for (const [i, p] of (Array.isArray(raw?.profiles) ? raw.profiles : []).entries()) {
    const where = `profile ${i + 1}${p?.id ? ` (${p.id})` : ''}`;
    if (!p || typeof p.id !== 'string' || !p.id.trim()) { warnings.push(`${where}: missing id`); continue; }
    if (byId.has(p.id)) { warnings.push(`${where}: duplicate id`); continue; }
    if (typeof p.name !== 'string' || !p.name.trim()) { warnings.push(`${where}: missing name`); continue; }
    if (!TRIM_CATEGORIES[p.category]) { warnings.push(`${where}: unknown category "${p.category}"`); continue; }
    if (!ESTIMATE_UNITS[p.unit]) { warnings.push(`${where}: unit must be lf, sf or sheet`); continue; }
    const widths = (Array.isArray(p.widths) ? p.widths : []).map(parseCatalogLength);
    if (!widths.length || widths.some((w) => w == null)) { warnings.push(`${where}: widths must be lengths with units, e.g. "3 1/4\\"" or "70mm"`); continue; }
    let sheetLength = null;
    if (p.unit === 'sheet') {
      sheetLength = parseCatalogLength(p.sheetLength);
      if (sheetLength == null) { warnings.push(`${where}: sheet goods need a sheetLength with units`); continue; }
    }
    if (p.pattern != null && !PANEL_PATTERNS.includes(p.pattern)) { warnings.push(`${where}: pattern must be one of ${PANEL_PATTERNS.join(', ')}`); continue; }
    const spacing = p.spacing != null ? parseCatalogLength(p.spacing) : null;
    if (p.spacing != null && spacing == null) { warnings.push(`${where}: spacing must be a length with units`); continue; }
    const def = p.defaultWidth != null ? parseCatalogLength(p.defaultWidth) : null;
    const profile = {
      id: p.id,
      name: p.name.trim(),
      category: p.category,
      unit: p.unit,
      widths,
      defaultWidth: widths.find((w) => def != null && Math.abs(w - def) < 0.01) ?? widths[0],
      sheetLength,
      // Panelling without a pattern: sheets show their seams, area goods their boards.
      pattern: p.pattern ?? (p.unit === 'sheet' ? 'panel' : 'shiplap'),
      spacing,
      isDefault: p.default === true,
      description: typeof p.description === 'string' ? p.description : '',
    };
    profiles.push(profile);
    byId.set(profile.id, profile);
  }
  return { profiles, byId, warnings };
}

let catalog = parseCatalog({ profiles: [] });

export function setCatalog(raw) {
  catalog = parseCatalog(raw);
  return catalog;
}

export function getCatalog() {
  return catalog;
}

export function getProfile(id) {
  return id ? catalog.byId.get(id) ?? null : null;
}

/** Profiles in one or more categories, optionally filtered (e.g. by estimate unit). */
export function profilesFor(categories, filter = () => true) {
  const cats = new Set([categories].flat());
  return catalog.profiles.filter((p) => cats.has(p.category) && filter(p));
}

/** The preferred profile of a category: flagged default, else the first listed. */
export function defaultProfile(categories, filter) {
  const list = profilesFor(categories, filter);
  return list.find((p) => p.isDefault) ?? list[0] ?? null;
}

/** Fallback widths when a profile is missing from the catalog. */
export function fallbackSize(category, units) {
  const metric = units === 'metric';
  const sizes = {
    baseboard: metric ? 90 : 5.25 * MM_PER_IN,
    shoe: metric ? 18 : 0.75 * MM_PER_IN,
    crown: metric ? 90 : 3.625 * MM_PER_IN,
    'chair-rail': metric ? 65 : 2.5 * MM_PER_IN,
    'panel-moulding': metric ? 30 : 1.125 * MM_PER_IN,
    'door-casing': metric ? 66 : 3.5 * MM_PER_IN,
    'window-casing': metric ? 66 : 3.5 * MM_PER_IN,
    'window-stool': metric ? 90 : 3.5 * MM_PER_IN,
    'window-apron': metric ? 66 : 3.5 * MM_PER_IN,
    'window-sill': metric ? 40 : 1.25 * MM_PER_IN,
  };
  return sizes[category] ?? (metric ? 50 : 2 * MM_PER_IN);
}

/** Profile size for display: 1/16" on imperial plans, whole millimetres on metric ones. */
export function formatSize(mm, units) {
  if (mm == null || !Number.isFinite(mm)) return '';
  if (units === 'metric') return `${Math.round(mm)} mm`;
  return formatLength(mm, units);
}

/** "Colonial baseboard 5 1/4"" – or the category when the profile is unknown. */
export function profileLabel(profileId, size, units, category) {
  const p = getProfile(profileId);
  const name = p?.name ?? `${TRIM_CATEGORIES[category]?.label ?? 'Trim'}${profileId ? ` (${profileId})` : ''}`;
  if (p?.unit === 'sheet') return `${name} ${formatLength(size, units, { precision: 'label' })} × ${formatLength(p.sheetLength, units, { precision: 'label' })}`;
  return size ? `${name} ${formatSize(size, units)}` : name;
}
