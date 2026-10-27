// Trim and panelling on wall faces: baseboard, shoe moulding, crown and chair rail runs,
// door and window casing, picture-frame boxes and wainscot panels.
//
// Trim is stored per wall face in design.faceTrim as
//   { id, wallIds, outward, p0, p1, items: [...] }
// where wallIds / outward (viewer → wall) / p0–p1 (the face's ends) record
// the face at the last sync, so syncFaceTrim() can find it again after the
// wall graph is re-normalised. Item positions are in face coordinates:
// s = distance from the face's left end as seen facing the wall, z = height
// above the finished floor (AFF), both in mm.
//
// Items:
//   run      { kind, category: baseboard|shoe|crown|chair-rail, profileId, size,
//              height (chair rail: top edge AFF), start, end (null = face end),
//              cuts: [{s0, s1}], placement (crown only: 'tray' = along the side
//              of a tray ceiling above this wall) }   gaps at openings are derived
//   casing   { kind, category: door-casing|window-casing, openingId, profileId,
//              size, reveal, stool, apron, sill }   (parts: {profileId, size, horn?} | null)
//   box      { kind, category: panel-moulding, profileId, size, s, z, w, h }
//   wainscot { kind, category: panel-moulding, profileId, size, start, end, height }
import { dot, sub } from './geometry.js';
import { analyze, uid } from './model.js';
import { profileHeightAt } from './ceiling.js';
import { MM_PER_IN, formatLength, parseLength } from './units.js';
import { defaultProfile, fallbackSize, getProfile, profileLabel } from './trimCatalog.js';

export const RUN_CATEGORIES = ['baseboard', 'shoe', 'crown', 'chair-rail'];
export const PACKAGE_CATEGORIES = ['baseboard', 'shoe', 'crown', 'chair-rail', 'door-casing', 'window-casing', 'panel-moulding'];
/** Runs on the floor: baseboard, and shoe moulding at its foot (`size` is the height on the wall). */
const FLOOR_RUNS = new Set(['baseboard', 'shoe']);
const MIN_PIECE = 1; // mm: shorter pieces are dropped
const ITEM_KINDS = new Set(['run', 'casing', 'box', 'wainscot']);

export function trimDefaults(units) {
  const metric = units === 'metric';
  return {
    reveal: metric ? 5 : (3 / 16) * MM_PER_IN, // casing set back from the jamb edge
    horn: metric ? 20 : 0.75 * MM_PER_IN, // stool/sill extension past the casing
    stoolThickness: metric ? 25 : MM_PER_IN, // drawing only
    sillThickness: metric ? 40 : 1.5 * MM_PER_IN, // drawing only
    chairRail: metric ? 900 : 36 * MM_PER_IN,
    wainscot: metric ? 800 : 32 * MM_PER_IN,
    boxGap: metric ? 100 : 4 * MM_PER_IN,
    boxWidth: metric ? 600 : 24 * MM_PER_IN,
  };
}

// ---------------------------------------------------------------------------
// Typed input. Trim dimensions are small, so bare numbers are inches on
// imperial plans and millimetres on metric ones (as for floor readings).

const BARE_NUMBER = /^(\d+(\.\d+)?(\s+\d+\/\d+)?|\d+\/\d+|\.\d+)$/;

export function parseTrimLength(text, units) {
  const s = String(text ?? '').trim();
  if (BARE_NUMBER.test(s)) return parseLength(units === 'metric' ? `${s}mm` : `${s}"`, units);
  return parseLength(s, units);
}

/** "24x18", "2' x 18\"" → [w, h] in mm, or null. */
export function parseTrimDimensions(text, units) {
  const parts = String(text ?? '').split(/\s*[x×*]\s*/i).filter(Boolean);
  if (parts.length !== 2) return null;
  const a = parseTrimLength(parts[0], units);
  const b = parseTrimLength(parts[1], units);
  return a > 0 && b > 0 ? [a, b] : null;
}

// ---------------------------------------------------------------------------
// Items

const isPanelSheet = (p) => p.unit !== 'lf';
const isPanelMoulding = (p) => p.unit === 'lf';

function pickProfile(categories, profileId, filter) {
  return getProfile(profileId) ?? defaultProfile(categories, filter);
}

function pickSize(profile, size, category, units) {
  if (size > 0) return size;
  return profile?.defaultWidth ?? fallbackSize(category, units);
}

export function makeRun(d, category, opts = {}) {
  const p = pickProfile(category, opts.profileId);
  const item = {
    id: uid('t'), kind: 'run', category,
    profileId: p?.id ?? opts.profileId ?? null,
    size: pickSize(p, opts.size, category, d.units),
    start: opts.start ?? null,
    end: opts.end ?? null,
    cuts: [],
  };
  if (category === 'chair-rail') item.height = opts.height ?? trimDefaults(d.units).chairRail;
  if (category === 'crown' && opts.placement === 'tray') item.placement = 'tray';
  return item;
}

export const isTrayCrown = (item) => item.kind === 'run' && item.placement === 'tray';

/** Identifies a kind of trim for replacing and packages: tray crown is separate from wall crown. */
export function specKey(spec) {
  return spec.category === 'crown' && spec.placement === 'tray' ? 'crown-tray' : spec.category;
}

export function makePart(d, category, opts = {}, fallback = null) {
  const p = getProfile(opts?.profileId) ?? defaultProfile(category) ?? fallback;
  const part = { profileId: p?.id ?? opts?.profileId ?? null, size: pickSize(p, opts?.size, category, d.units) };
  if (category !== 'window-apron') part.horn = opts?.horn ?? trimDefaults(d.units).horn;
  return part;
}

export function makeCasing(d, opening, opts = {}) {
  const window = opening.type === 'window';
  const category = window ? 'window-casing' : 'door-casing';
  // Window casing can use door casing stock and vice versa.
  const p = getProfile(opts.profileId) ?? defaultProfile(category) ?? defaultProfile(window ? 'door-casing' : 'window-casing');
  const item = {
    id: uid('t'), kind: 'casing', category, openingId: opening.id,
    profileId: p?.id ?? opts.profileId ?? null,
    size: pickSize(p, opts.size, category, d.units),
    reveal: opts.reveal ?? trimDefaults(d.units).reveal,
    stool: null,
    apron: null,
    sill: null,
  };
  if (window) {
    if (opts.stool) item.stool = makePart(d, 'window-stool', opts.stool);
    if (opts.apron) item.apron = makePart(d, 'window-apron', opts.apron, p);
    if (opts.sill) item.sill = makePart(d, 'window-sill', opts.sill);
  }
  return item;
}

export function makeBox(d, { s, z, w, h, profileId, size }) {
  const p = pickProfile('panel-moulding', profileId, isPanelMoulding);
  return { id: uid('t'), kind: 'box', category: 'panel-moulding', profileId: p?.id ?? profileId ?? null, size: pickSize(p, size, 'panel-moulding', d.units), s, z, w, h };
}

export function makeWainscot(d, opts = {}) {
  const p = pickProfile('panel-moulding', opts.profileId, isPanelSheet);
  return {
    id: uid('t'), kind: 'wainscot', category: 'panel-moulding',
    profileId: p?.id ?? opts.profileId ?? null,
    size: pickSize(p, opts.size, 'panel-moulding', d.units),
    start: opts.start ?? null,
    end: opts.end ?? null,
    height: opts.height ?? trimDefaults(d.units).wainscot,
  };
}

export function itemLabel(item) {
  if (isTrayCrown(item)) return 'Tray crown';
  if (item.kind === 'run') return { baseboard: 'Baseboard', shoe: 'Shoe moulding', crown: 'Crown', 'chair-rail': 'Chair rail' }[item.category];
  if (item.kind === 'casing') return item.category === 'window-casing' ? 'Window casing' : 'Door casing';
  if (item.kind === 'box') return 'Panel box';
  return 'Wainscot';
}

// ---------------------------------------------------------------------------
// Face records

const pt = (p) => ({ x: p.x, y: p.y });
const finitePoint = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y);

export function recordForFace(d, face) {
  if (!face) return null;
  return (d.faceTrim ?? []).find((r) => dot(r.outward, face.outward) > 0.5 && r.wallIds.some((id) => face.wallIds.includes(id))) ?? null;
}

export function ensureRecord(d, face) {
  let r = recordForFace(d, face);
  if (!r) {
    r = { id: uid('f'), wallIds: [...face.wallIds], outward: pt(face.outward), p0: pt(face.P), p1: pt(face.Q), items: [] };
    d.faceTrim ??= [];
    d.faceTrim.push(r);
  }
  return r;
}

function validItem(it) {
  if (!it || typeof it.id !== 'string' || !ITEM_KINDS.has(it.kind)) return false;
  if (!(it.size > 0)) return false;
  if (it.kind === 'box') return [it.s, it.z, it.w, it.h].every(Number.isFinite) && it.w > 0 && it.h > 0;
  if (it.kind === 'casing') return typeof it.openingId === 'string' && Number.isFinite(it.reveal);
  if (it.kind === 'run' && it.category === 'chair-rail' && !Number.isFinite(it.height)) return false;
  if (it.kind === 'wainscot' && !(it.height > 0)) return false;
  return true;
}

/** Drops malformed records and items from stored designs. */
export function sanitizeFaceTrim(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((r) => r && Array.isArray(r.wallIds) && finitePoint(r.outward) && finitePoint(r.p0) && finitePoint(r.p1) && Array.isArray(r.items))
    .map((r) => {
      r.items = r.items.filter(validItem);
      // Ruler guides on the face (face coordinates: x = from the left corner, y = height).
      if (Array.isArray(r.guides)) r.guides = r.guides.filter((g) => g && typeof g.id === 'string' && (g.axis === 'x' || g.axis === 'y') && Number.isFinite(g.v));
      if (!r.guides?.length) delete r.guides;
      for (const it of r.items) if (it.kind === 'run') it.cuts = Array.isArray(it.cuts) ? it.cuts.filter((c) => Number.isFinite(c?.s0) && Number.isFinite(c?.s1)) : [];
      return r;
    });
}

export function sanitizePackages(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string' && Array.isArray(p.items))
    .map((p) => ({ ...p, items: p.items.filter((s) => PACKAGE_CATEGORIES.includes(s?.category)) }));
}

// ---------------------------------------------------------------------------
// Resolving items into pieces (face coordinates)

const rect = (s, z, w, h) => [{ s, z }, { s: s + w, z }, { s: s + w, z: z + h }, { s, z: z + h }];
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/** Length of the ceiling line between s0 and s1 (crown follows slopes). */
export function profileLength(profile, s0, s1) {
  const ss = [s0, ...profile.map((p) => p.s).filter((s) => s > s0 && s < s1), s1];
  let l = 0;
  for (let i = 1; i < ss.length; i++) l += Math.hypot(ss[i] - ss[i - 1], profileHeightAt(profile, ss[i]) - profileHeightAt(profile, ss[i - 1]));
  return l;
}

function minProfile(profile, s0, s1) {
  let z = Math.min(profileHeightAt(profile, s0), profileHeightAt(profile, s1));
  for (const p of profile) if (p.s > s0 && p.s < s1) z = Math.min(z, p.z);
  return z;
}

/** ∫ min(cap, ceiling(s)) ds over [s0, s1]: wall area below a height. */
function cappedArea(profile, s0, s1, cap) {
  const ss = [s0, ...profile.map((p) => p.s).filter((s) => s > s0 && s < s1), s1];
  let a = 0;
  for (let i = 1; i < ss.length; i++) {
    const x0 = ss[i - 1];
    const x1 = ss[i];
    const z0 = profileHeightAt(profile, x0);
    const z1 = profileHeightAt(profile, x1);
    if (z0 >= cap && z1 >= cap) a += cap * (x1 - x0);
    else if (z0 <= cap && z1 <= cap) a += ((z0 + z1) / 2) * (x1 - x0);
    else {
      const xc = x0 + ((cap - z0) * (x1 - x0)) / (z1 - z0);
      const [lo, hi] = z0 < cap ? [[x0, z0], [x1, z1]] : [[x1, z1], [x0, z0]];
      a += ((lo[1] + cap) / 2) * Math.abs(xc - lo[0]) + cap * Math.abs(hi[0] - xc);
    }
  }
  return a;
}

function subtractIntervals(a, b, gaps) {
  let segs = b - a >= MIN_PIECE ? [[a, b]] : [];
  for (const g of gaps) {
    segs = segs.flatMap(([x, y]) => {
      if (g.s1 <= x || g.s0 >= y) return [[x, y]];
      return [[x, Math.min(g.s0, y)], [Math.max(g.s1, x), y]].filter(([p, q]) => q - p >= MIN_PIECE);
    });
  }
  return segs;
}

/**
 * Where trim around each opening on the face ends: the opening grown by its
 * casing (and stool, apron, sill) on this face. Runs gap at these.
 */
export function openingEnvelopes(face, items, def) {
  const casing = new Map(items.filter((i) => i.kind === 'casing').map((i) => [i.openingId, i]));
  return face.openings.map((op) => {
    const c = casing.get(op.opening.id) ?? null;
    const env = { op, casing: c, s0: op.s0, s1: op.s1, bottom: op.bottom, top: op.top };
    if (!c) return env;
    const ext = c.reveal + c.size;
    env.s0 -= ext;
    env.s1 += ext;
    env.top += ext;
    if (op.opening.type === 'window') {
      if (c.stool) {
        env.bottom = op.bottom - def.stoolThickness - (c.apron ? c.apron.size : 0);
        env.s0 = Math.min(env.s0, op.s0 - ext - c.stool.horn);
        env.s1 = Math.max(env.s1, op.s1 + ext + c.stool.horn);
      } else {
        env.bottom = op.bottom - ext;
      }
      if (c.sill) {
        env.bottom -= def.sillThickness;
        env.s0 = Math.min(env.s0, op.s0 - ext - c.sill.horn);
        env.s1 = Math.max(env.s1, op.s1 + ext + c.sill.horn);
      }
      env.bottom = Math.max(0, env.bottom);
    }
    return env;
  });
}

function runBand(face, item, s0, s1) {
  if (FLOOR_RUNS.has(item.category)) return [0, item.size];
  if (item.category === 'chair-rail') return [item.height - item.size, item.height];
  const c = minProfile(face.profile, s0, s1);
  return [c - item.size, c];
}

/** Gaps a run must leave: openings (with their casing) and bulkheads it would run into. */
export function runGaps(face, item, envelopes) {
  const gaps = [];
  for (const env of envelopes) {
    const [z0, z1] = runBand(face, item, env.s0, env.s1);
    if (env.bottom < z1 - 0.5 && env.top > z0 + 0.5) gaps.push({ s0: env.s0, s1: env.s1, reason: env.op.opening.type, openingId: env.op.opening.id });
  }
  for (const b of face.bands ?? []) {
    const [, z1] = runBand(face, item, b.s0, b.s1);
    if (item.category === 'crown' || b.bottom < z1) gaps.push({ s0: b.s0, s1: b.s1, reason: 'bulkhead' });
  }
  return gaps.sort((p, q) => p.s0 - q.s0);
}

function runPiece(face, item, s0, s1) {
  let poly;
  let length = s1 - s0;
  if (item.category === 'crown') {
    const ss = [s0, ...face.profile.map((p) => p.s).filter((s) => s > s0 && s < s1), s1];
    const top = ss.map((s) => ({ s, z: profileHeightAt(face.profile, s) }));
    poly = [...top, ...top.slice().reverse().map((p) => ({ s: p.s, z: p.z - item.size }))];
    length = profileLength(face.profile, s0, s1);
  } else {
    const [z0] = runBand(face, item, s0, s1);
    poly = rect(s0, z0, s1 - s0, item.size);
  }
  return { part: 'run', category: item.category, profileId: item.profileId, size: item.size, s0, s1, length, poly };
}

/**
 * Tray crown: along the tray side above this wall, at the tray height. No
 * openings reach up there, so only the user's start/end and cuts apply.
 */
function resolveTrayCrown(face, item) {
  const edge = face.tray?.edge;
  if (!edge) return { item, a: 0, b: 0, gaps: [], autoSegments: [], pieces: [], noTray: true };
  const lo = Math.min(edge.s0, edge.s1);
  const hi = Math.max(edge.s0, edge.s1);
  const a = clamp(item.start ?? lo, lo, hi);
  const b = clamp(item.end ?? hi, lo, hi);
  const top = face.tray.top;
  const pieces = subtractIntervals(a, b, item.cuts ?? []).map(([s0, s1]) => ({
    part: 'tray crown', category: 'crown', profileId: item.profileId, size: item.size, s0, s1, length: s1 - s0,
    poly: rect(s0, top - item.size, s1 - s0, item.size),
  }));
  return { item, a, b, lo, hi, gaps: [], autoSegments: subtractIntervals(a, b, []), pieces };
}

function resolveRun(face, item, envelopes) {
  if (isTrayCrown(item)) return resolveTrayCrown(face, item);
  const L = face.length;
  const a = clamp(item.start ?? 0, 0, L);
  const b = clamp(item.end ?? L, 0, L);
  const gaps = runGaps(face, item, envelopes);
  const auto = subtractIntervals(a, b, gaps);
  const kept = subtractIntervals(a, b, [...gaps, ...(item.cuts ?? [])]);
  return { item, a, b, gaps, autoSegments: auto, pieces: kept.map(([s0, s1]) => runPiece(face, item, s0, s1)) };
}

function resolveCasing(face, item, def) {
  const op = face.openings.find((o) => o.opening.id === item.openingId);
  if (!op) return null;
  const o = op.opening;
  const r = item.reveal;
  const w = item.size;
  const outerL = op.s0 - r - w;
  const outerR = op.s1 + r + w;
  const span = outerR - outerL;
  const headTop = op.top + r + w;
  const piece = (part, category, profileId, size, length, poly) => ({ part, category, profileId, size, length, poly });
  const pieces = [];
  const casing = (part, length, poly) => pieces.push(piece(part, item.category, item.profileId, w, length, poly));
  // Casing meets at 45° mitres: each corner is split on the diagonal from the
  // outer corner to the inner one, so the pieces never overlap. Lengths are
  // the long points (outer edges), which is how casing is cut.
  const inL = op.s0 - r;
  const inR = op.s1 + r;
  const inTop = op.top + r;
  const head = () => casing('head', span, [{ s: outerL, z: headTop }, { s: inL, z: inTop }, { s: inR, z: inTop }, { s: outerR, z: headTop }]);
  // A leg from z0 up to the head mitre; mitred at the bottom too when it meets a bottom casing.
  const legs = (z0, mitredBottom) => {
    const inZ0 = mitredBottom ? z0 + w : z0;
    casing('left leg', headTop - z0, [{ s: outerL, z: z0 }, { s: inL, z: inZ0 }, { s: inL, z: inTop }, { s: outerL, z: headTop }]);
    casing('right leg', headTop - z0, [{ s: inR, z: inZ0 }, { s: outerR, z: z0 }, { s: outerR, z: headTop }, { s: inR, z: inTop }]);
  };
  if (o.type !== 'window') {
    // Legs stand square on the floor.
    legs(0, false);
    head();
  } else {
    let below = op.bottom;
    if (item.stool) {
      // Legs stand square on the stool.
      legs(op.bottom, false);
      head();
      const st = item.stool;
      below = op.bottom - def.stoolThickness;
      pieces.push(piece('stool', 'window-stool', st.profileId, st.size, span + 2 * st.horn, rect(outerL - st.horn, below, span + 2 * st.horn, def.stoolThickness)));
      if (item.apron) {
        const ap = item.apron;
        pieces.push(piece('apron', 'window-apron', ap.profileId, ap.size, span, rect(outerL, below - ap.size, span, ap.size)));
        below -= ap.size;
      }
    } else {
      // Picture frame: mitred at all four corners.
      const bottom = op.bottom - r - w;
      legs(bottom, true);
      head();
      casing('bottom', span, [{ s: outerL, z: bottom }, { s: outerR, z: bottom }, { s: inR, z: bottom + w }, { s: inL, z: bottom + w }]);
      below = bottom;
    }
    if (item.sill) {
      const si = item.sill;
      pieces.push(piece('sill', 'window-sill', si.profileId, si.size, span + 2 * si.horn, rect(outerL - si.horn, below - def.sillThickness, span + 2 * si.horn, def.sillThickness)));
    }
  }
  return { item, op, outer: { s0: outerL, s1: outerR, top: headTop }, pieces };
}

function resolveBox(item) {
  const { s, z, w, h, size } = item;
  const t = Math.min(size, w / 2, h / 2);
  return {
    item,
    pieces: [{
      part: 'frame', category: 'panel-moulding', profileId: item.profileId, size, length: 2 * (w + h),
      poly: rect(s, z, w, h), hole: rect(s + t, z + t, w - 2 * t, h - 2 * t),
    }],
  };
}

/** Stretches of [a, b] where the ceiling is at or above z (sloped ceilings cut boards short). */
function intervalsBelowCeiling(profile, a, b, z) {
  const ss = [a, ...profile.map((p) => p.s).filter((s) => s > a && s < b), b];
  const out = [];
  for (let i = 1; i < ss.length; i++) {
    const x0 = ss[i - 1];
    const x1 = ss[i];
    const z0 = profileHeightAt(profile, x0) - z;
    const z1 = profileHeightAt(profile, x1) - z;
    if (z0 < 0 && z1 < 0) continue;
    let lo = x0;
    let hi = x1;
    if (z0 < 0) lo = x0 + ((x1 - x0) * -z0) / (z1 - z0);
    if (z1 < 0) hi = x0 + ((x1 - x0) * z0) / (z0 - z1);
    const last = out[out.length - 1];
    if (last && Math.abs(last[1] - lo) < 1e-6) last[1] = hi;
    else out.push([lo, hi]);
  }
  return out;
}

/**
 * Drawing of a wainscot field for its profile, in face coordinates: sheet
 * seams every sheet width, beadboard grooves, shiplap boards at the board
 * width, or battens of the batten width. Openings and the ceiling cut them.
 */
export function wainscotMarks(face, item, a, b, holes, units) {
  const p = getProfile(item.profileId);
  const pattern = p?.pattern ?? 'panel';
  const metric = units === 'metric';
  const spacing = p?.spacing ?? (pattern === 'board-batten' ? (metric ? 400 : 16 * MM_PER_IN) : metric ? 40 : 1.625 * MM_PER_IN);
  const size = item.size;
  const cap = (s) => Math.min(item.height, profileHeightAt(face.profile, s));
  const holeSpans = holes.map((h) => ({ s0: h[0].s, s1: h[1].s, z0: h[0].z, z1: h[2].z }));
  const lines = [];
  const strips = [];
  const vertical = (s, kind) => {
    const gaps = holeSpans.filter((h) => s > h.s0 && s < h.s1).map((h) => ({ s0: h.z0, s1: h.z1 }));
    for (const [z0, z1] of subtractIntervals(0, cap(s), gaps)) lines.push({ kind, s0: s, z0, s1: s, z1 });
  };
  const horizontal = (z, kind) => {
    const gaps = holeSpans.filter((h) => z > h.z0 && z < h.z1);
    for (const [x0, x1] of intervalsBelowCeiling(face.profile, a, b, z)) {
      for (const [s0, s1] of subtractIntervals(x0, x1, gaps)) lines.push({ kind, s0, z0: z, s1, z1: z });
    }
  };
  const seams = new Set();
  if (p?.unit === 'sheet') {
    for (let s = a + size; s < b - MIN_PIECE; s += size) {
      vertical(s, 'seam');
      seams.add(Math.round(s));
    }
  }
  if (pattern === 'beadboard') {
    for (let s = a + spacing; s < b - MIN_PIECE; s += spacing) if (!seams.has(Math.round(s))) vertical(s, 'groove');
  } else if (pattern === 'shiplap') {
    for (let z = size; z < item.height - MIN_PIECE; z += size) horizontal(z, 'board');
  } else if (pattern === 'board-batten') {
    const n = Math.max(1, Math.round((b - a - size) / spacing));
    const step = (b - a - size) / n;
    for (let i = 0; i <= n; i++) {
      const s0 = a + i * step;
      const gaps = holeSpans.filter((h) => s0 < h.s1 && s0 + size > h.s0).map((h) => ({ s0: h.z0, s1: h.z1 }));
      for (const [z0, z1] of subtractIntervals(0, Math.min(cap(s0), cap(s0 + size)), gaps)) strips.push(rect(s0, z0, size, z1 - z0));
    }
  }
  return { pattern, spacing, lines, strips };
}

function resolveWainscot(face, item, envelopes, units) {
  const L = face.length;
  const a = clamp(item.start ?? 0, 0, L);
  const b = clamp(item.end ?? L, 0, L);
  if (b - a < MIN_PIECE) return { item, a, b, pieces: [] };
  let area = cappedArea(face.profile, a, b, item.height);
  const holes = [];
  for (const env of envelopes) {
    const s0 = Math.max(a, env.s0);
    const s1 = Math.min(b, env.s1);
    const z0 = Math.max(0, env.bottom);
    const z1 = Math.min(item.height, env.top);
    if (s1 - s0 < MIN_PIECE || z1 <= z0) continue;
    area -= (s1 - s0) * (z1 - z0);
    holes.push(rect(s0, z0, s1 - s0, z1 - z0));
  }
  const p = getProfile(item.profileId);
  return {
    item, a, b,
    pieces: [{
      part: 'panel', category: 'panel-moulding', profileId: item.profileId, size: item.size,
      length: b - a, area: Math.max(0, area), poly: rect(a, 0, b - a, item.height), holes,
      sheets: p?.unit === 'sheet' ? Math.ceil(Math.max(0, area) / (item.size * p.sheetLength) - 1e-9) : null,
      marks: wainscotMarks(face, item, a, b, holes, units),
    }],
  };
}

const DRAW_ORDER = { wainscot: 0, run: 1, box: 2, casing: 3 };

/** Resolved items in paint order: wainscot panelling underneath, then runs (shoe moulding over the baseboard), boxes and casing on top. */
export function drawOrder(items) {
  const rank = (r) => DRAW_ORDER[r.item.kind] + (r.item.category === 'shoe' ? 0.5 : 0);
  return [...items].sort((a, b) => rank(a) - rank(b));
}

/** Every item on a face resolved into drawable, measurable pieces. */
export function resolveFaceTrim(d, face, record = recordForFace(d, face)) {
  const items = record?.items ?? [];
  const def = trimDefaults(d.units);
  const envelopes = openingEnvelopes(face, items, def);
  const resolved = [];
  for (const item of items) {
    let r = null;
    if (item.kind === 'run') r = resolveRun(face, item, envelopes);
    else if (item.kind === 'casing') r = resolveCasing(face, item, def);
    else if (item.kind === 'box') r = resolveBox(item);
    else if (item.kind === 'wainscot') r = resolveWainscot(face, item, envelopes, d.units);
    if (r) {
      r.length = r.pieces.reduce((s, p) => s + p.length, 0);
      r.area = r.pieces.reduce((s, p) => s + (p.area ?? 0), 0);
      resolved.push(r);
    }
  }
  return { face, record, items: resolved, envelopes };
}

// ---------------------------------------------------------------------------
// Quantities

function unitOf(piece) {
  return getProfile(piece.profileId)?.unit ?? (piece.part === 'panel' ? 'sf' : 'lf');
}

/** Merges quantity lines with the same category, profile and size. */
export function mergeTrimLines(lines) {
  const map = new Map();
  for (const l of lines) {
    const key = `${l.category}|${l.profileId ?? ''}|${Math.round(l.size * 100)}`;
    const m = map.get(key);
    if (m) {
      m.length += l.length;
      m.area += l.area;
      m.pieces += l.pieces;
    } else {
      map.set(key, { key, category: l.category, profileId: l.profileId, size: l.size, unit: l.unit, length: l.length, area: l.area, pieces: l.pieces });
    }
  }
  return [...map.values()];
}

/** Quantity lines for one resolved face: linear length and area per profile and size. */
export function faceTrimLines(resolved) {
  const lines = [];
  for (const r of resolved.items) {
    for (const p of r.pieces) {
      lines.push({ category: p.category, profileId: p.profileId, size: p.size, unit: unitOf(p), length: p.length, area: p.area ?? p.length * p.size, pieces: 1 });
    }
  }
  return mergeTrimLines(lines);
}

/** Trim across a set of faces: per-face lines (with location) and merged totals. */
export function trimTakeoff(d, faces) {
  const lines = [];
  for (const face of faces) {
    const rec = recordForFace(d, face);
    if (!rec?.items.length) continue;
    for (const l of faceTrimLines(resolveFaceTrim(d, face, rec))) {
      lines.push({ ...l, face: face.name, faceKind: face.kind, roomId: face.roomId });
    }
  }
  return { lines, totals: mergeTrimLines(lines) };
}

// ---------------------------------------------------------------------------
// Keeping trim attached through wall edits

/** Current faces a record maps to: same walls on the same side, else the same line overlapping it. */
function matchFaces(faces, rec) {
  const byWall = faces.filter((f) => f.wallIds.some((id) => rec.wallIds.includes(id)) && dot(f.outward, rec.outward) > 0.3);
  const dir = { x: -rec.outward.y, y: rec.outward.x }; // P→Q, since outward = -perp(dir)
  const recLen = dot(sub(rec.p1, rec.p0), dir);
  if (recLen <= MIN_PIECE) return byWall;
  const byLine = faces.filter((f) => {
    if (byWall.includes(f) || dot(f.outward, rec.outward) < 0.9999) return false;
    if (Math.abs(dot(sub(f.P, rec.p0), rec.outward)) > 2) return false;
    const a = dot(sub(f.P, rec.p0), dir);
    const b = dot(sub(f.Q, rec.p0), dir);
    return Math.min(Math.max(a, b), recLen) - Math.max(Math.min(a, b), 0) > MIN_PIECE;
  });
  return [...byWall, ...byLine];
}

function moveItem(item, shift, face, split, openingIds) {
  const L = face.length;
  const it = JSON.parse(JSON.stringify(item));
  if (item.kind === 'run' || item.kind === 'wainscot') {
    const start = item.start == null ? null : item.start + shift;
    const end = item.end == null ? null : item.end + shift;
    it.start = start == null || start <= 0.5 ? null : start;
    it.end = end == null || end >= L - 0.5 ? null : end;
    if ((it.end ?? L) - (it.start ?? 0) < MIN_PIECE) return null;
    if (item.cuts) it.cuts = item.cuts.map((c) => ({ s0: c.s0 + shift, s1: c.s1 + shift })).filter((c) => c.s1 > 0 && c.s0 < L);
    return it;
  }
  if (item.kind === 'casing') return openingIds.has(item.openingId) ? it : null;
  if (item.kind === 'box') {
    it.s = item.s + shift;
    const c = it.s + it.w / 2;
    return split && (c < 0 || c > L) ? null : it;
  }
  return null;
}

function dedupeItems(items) {
  const keys = new Set();
  const ids = new Set();
  const out = [];
  for (const it of items) {
    let key = null;
    if (it.kind === 'casing') key = `casing:${it.openingId}`;
    else if ((it.kind === 'run' || it.kind === 'wainscot') && it.start == null && it.end == null) {
      key = `${it.kind}:${it.category}:${it.placement ?? ''}:${it.profileId}:${Math.round(it.size)}:${Math.round(it.height ?? 0)}`;
    }
    if (key && keys.has(key)) continue;
    if (key) keys.add(key);
    if (ids.has(it.id)) it.id = uid('t');
    ids.add(it.id);
    out.push(it);
  }
  return out;
}

/**
 * Re-attaches face trim after the wall graph changed (called by normalize).
 * Moved walls keep their trim; a face split by a new wall gives each piece
 * a copy clipped to it; faces merged by deleting a wall combine their trim;
 * casing goes when its opening does. Positions are shifted so trim stays put
 * in the real world when a face's left end moves. The face's ruler guides
 * travel the same way (height guides go to every piece of a split face).
 */
export function syncFaceTrim(d, analysis = analyze(d)) {
  const faces = [...analysis.rooms.flatMap((g) => g.walls), ...analysis.exteriorFaces];
  const perFace = new Map();
  for (const rec of d.faceTrim ?? []) {
    if (!rec.items?.length && !rec.guides?.length) continue;
    const matches = matchFaces(faces, rec);
    matches.forEach((f, k) => {
      const shift = dot(sub(rec.p0, f.P), f.dir);
      const openingIds = new Set(d.openings.filter((o) => f.wallIds.includes(o.wallId)).map((o) => o.id));
      const items = rec.items.map((it) => moveItem(it, shift, f, matches.length > 1, openingIds)).filter(Boolean);
      const guides = (rec.guides ?? [])
        .map((g) => (g.axis === 'x' ? { ...g, v: g.v + shift } : { ...g }))
        .filter((g) => g.axis === 'y' || matches.length === 1 || (g.v >= 0 && g.v <= f.length));
      if (k > 0) [...items, ...guides].forEach((it) => { it.id = uid(it.axis ? 'g' : 't'); });
      if (!perFace.has(f)) perFace.set(f, { id: null, items: [], guides: [] });
      const entry = perFace.get(f);
      if (k === 0) entry.id ??= rec.id;
      entry.items.push(...items);
      entry.guides.push(...guides);
    });
  }
  const used = new Set();
  d.faceTrim = [];
  for (const [f, e] of perFace) {
    const items = dedupeItems(e.items);
    const guides = e.guides.filter((g, i) => !e.guides.slice(0, i).some((o) => o.axis === g.axis && Math.abs(o.v - g.v) < 0.5));
    if (!items.length && !guides.length) continue;
    const id = e.id && !used.has(e.id) ? e.id : uid('f');
    used.add(id);
    const rec = { id, wallIds: [...f.wallIds], outward: pt(f.outward), p0: pt(f.P), p1: pt(f.Q), items };
    if (guides.length) rec.guides = guides;
    d.faceTrim.push(rec);
  }
}

/** Version 1 designs: a room's crown flag becomes a crown run on each of its faces. */
export function migrateRoomCrown(d) {
  const ids = new Set(d.rooms.filter((r) => r.crown === true).map((r) => r.id));
  d.rooms.forEach((r) => delete r.crown);
  if (!ids.size) return;
  for (const g of analyze(d).rooms) {
    if (g.room && ids.has(g.room.id)) for (const face of g.walls) applySpecToFace(d, face, { category: 'crown' });
  }
}

// ---------------------------------------------------------------------------
// Bulk assignment and packages. A spec is { category, profileId, size,
// height?, reveal?, stool?, apron?, sill? }; panel-moulding specs are
// wainscot fields (boxes are positional, so they're placed per face).

export function specFromItem(item) {
  const base = { category: item.category, profileId: item.profileId, size: item.size };
  if (isTrayCrown(item)) return { ...base, placement: 'tray' };
  if (item.kind === 'run') return item.category === 'chair-rail' ? { ...base, height: item.height } : base;
  if (item.kind === 'casing') {
    const spec = { ...base, reveal: item.reveal };
    if (item.category === 'window-casing') {
      spec.stool = item.stool ? { ...item.stool } : null;
      spec.apron = item.apron ? { ...item.apron } : null;
      spec.sill = item.sill ? { ...item.sill } : null;
    }
    return spec;
  }
  if (item.kind === 'wainscot') return { ...base, height: item.height };
  return null;
}

/**
 * Applies one spec to a face, replacing what's there for that kind: runs
 * and wainscot become one full-width item; casing goes on every matching
 * opening. With `remove: true` it just takes that kind off the face (tray
 * crown and wall crown are separate kinds).
 */
export function applySpecToFace(d, face, spec, record = ensureRecord(d, face)) {
  const rec = record;
  if (RUN_CATEGORIES.includes(spec.category)) {
    const key = specKey(spec);
    rec.items = rec.items.filter((i) => !(i.kind === 'run' && specKey(specFromItem(i)) === key));
    // Tray crown only goes on walls with a tray ceiling above them.
    if (!spec.remove && (key !== 'crown-tray' || face.tray?.edge)) rec.items.push(makeRun(d, spec.category, spec));
  } else if (spec.category === 'door-casing' || spec.category === 'window-casing') {
    const windows = spec.category === 'window-casing';
    for (const op of face.openings) {
      if ((op.opening.type === 'window') !== windows) continue;
      rec.items = rec.items.filter((i) => !(i.kind === 'casing' && i.openingId === op.opening.id));
      if (!spec.remove) rec.items.push(makeCasing(d, op.opening, spec));
    }
  } else if (spec.category === 'panel-moulding') {
    rec.items = rec.items.filter((i) => i.kind !== 'wainscot'); // boxes are placed one by one, so they stay
    if (!spec.remove) rec.items.push(makeWainscot(d, spec));
  }
}

/** The kinds of trim on some faces (specKey values: 'baseboard', 'crown-tray', …), boxes aside. */
export function trimKindsOn(d, faces) {
  const kinds = new Set();
  for (const face of faces) {
    for (const item of recordForFace(d, face)?.items ?? []) {
      const spec = specFromItem(item);
      if (spec) kinds.add(specKey(spec));
    }
  }
  return kinds;
}

/** Applies specs to every face (one undo step when called inside app.change). Returns the face count. */
export function applySpecs(d, faces, specs) {
  for (const face of faces) {
    const rec = ensureRecord(d, face);
    for (const spec of specs) applySpecToFace(d, face, spec, rec);
  }
  return faces.length;
}

export function clearTrim(d, faces) {
  for (const face of faces) {
    const rec = recordForFace(d, face);
    if (rec) rec.items = [];
  }
}

/** Faces for a scope: 'face', 'room' (all interior faces of the room) or 'house' (every room face). */
export function scopeFaces(faces, scope, { face = null, roomId = face?.roomId ?? null } = {}) {
  if (scope === 'face') return face ? [face] : [];
  if (scope === 'room') return roomId ? faces.filter((f) => f.kind === 'room' && f.roomId === roomId) : [];
  if (scope === 'house') return faces.filter((f) => f.kind === 'room');
  return [];
}

export function makePackage(name, items) {
  return { id: uid('k'), name, items: items.map((s) => JSON.parse(JSON.stringify(s))) };
}

/** A package capturing a face's trim: one spec per kind (tray crown is its own kind). */
export function specsFromRecord(rec) {
  const specs = [];
  const seen = new Set();
  for (const item of rec?.items ?? []) {
    const spec = specFromItem(item);
    if (!spec || seen.has(specKey(spec))) continue;
    seen.add(specKey(spec));
    specs.push(spec);
  }
  return specs;
}

export function describeSpec(spec, units) {
  const label = profileLabel(spec.profileId, spec.size, units, spec.category);
  const extras = [];
  if (spec.height != null) extras.push(`@ ${formatLength(spec.height, units, { precision: 'label' })}${spec.category === 'chair-rail' ? ' AFF' : ' high'}`);
  if (spec.stool) extras.push('stool');
  if (spec.apron) extras.push('apron');
  if (spec.sill) extras.push('sill');
  if (spec.placement === 'tray') extras.push('in tray');
  return `${label}${extras.length ? ` ${extras.join(' + ')}` : ''}`;
}

// ---------------------------------------------------------------------------
// Plan view

const PLAN_CATEGORIES = new Set(['baseboard', 'shoe', 'crown']);

/**
 * Trim as seen on the plan, in plan coordinates.
 *
 * Baseboard, shoe moulding and crown: one band per piece, along the wall
 * face (tray crown: along the tray edge) and `depthOf(item)` mm deep into
 * the room; shoe moulding sits in front of the face's baseboard, if any. Where
 * pieces of the same kind meet at a corner, both ends are cut on the corner
 * bisector, so they meet in a mitre instead of overlapping or running into
 * the wall; ends at door gaps stay square.
 *
 * Casing: the two legs beside each cased opening, on the side of the wall
 * the casing is on, plus a window's stool or sill where it has one (heads
 * and aprons can't be seen from above). Depths come from
 * depthOf({ category, size, part }).
 *
 * Returns [{ category, part, tray, item, poly: [4 points] }]; stools and
 * sills come before the legs that stand on them.
 */
export function planTrimBands(d, faces, depthOf) {
  const lines = [];
  const casingParts = [];
  for (const face of faces) {
    const rec = recordForFace(d, face);
    if (!rec?.items.length) continue;
    const inward = { x: -face.outward.x, y: -face.outward.y };
    // Rectangle on the face from s0 to s1, `depth` out from the wall surface.
    const box = (s0, s1, depth) => {
      const a = { x: face.P.x + face.dir.x * s0, y: face.P.y + face.dir.y * s0 };
      const b = { x: face.P.x + face.dir.x * s1, y: face.P.y + face.dir.y * s1 };
      return [a, b, { x: b.x + inward.x * depth, y: b.y + inward.y * depth }, { x: a.x + inward.x * depth, y: a.y + inward.y * depth }];
    };
    const resolved = resolveFaceTrim(d, face, rec).items;
    const base = resolved.find((r) => r.item.kind === 'run' && r.item.category === 'baseboard' && r.pieces.length);
    for (const r of resolved) {
      if (r.item.kind === 'casing') {
        const it = r.item;
        const { s0: outerL, s1: outerR } = r.outer;
        const legDepth = depthOf({ category: it.category, size: it.size, part: 'leg' });
        for (const [key, category] of [['stool', 'window-stool'], ['sill', 'window-sill']]) {
          const part = it[key];
          if (!part) continue;
          casingParts.unshift({ category, part: key, tray: false, item: it, poly: box(outerL - part.horn, outerR + part.horn, depthOf({ category, size: part.size, part: key })) });
        }
        casingParts.push({ category: it.category, part: 'leg', tray: false, item: it, poly: box(outerL, outerL + it.size, legDepth) });
        casingParts.push({ category: it.category, part: 'leg', tray: false, item: it, poly: box(outerR - it.size, outerR, legDepth) });
        continue;
      }
      if (r.item.kind !== 'run' || !PLAN_CATEGORIES.has(r.item.category) || !r.pieces.length) continue;
      const tray = isTrayCrown(r.item);
      const edge = tray ? face.tray?.edge : null;
      if (tray && !edge) continue;
      // The line the run follows, parametrised by face s (distance from the face's P).
      const origin = tray ? { x: edge.a.x - face.dir.x * edge.s0, y: edge.a.y - face.dir.y * edge.s0 } : face.P;
      const lo = tray ? Math.min(edge.s0, edge.s1) : 0;
      const hi = tray ? Math.max(edge.s0, edge.s1) : face.length;
      const at = (s) => ({ x: origin.x + face.dir.x * s, y: origin.y + face.dir.y * s });
      lines.push({
        group: `${r.item.category}:${tray ? 'tray' : face.kind}`, item: r.item, tray, dir: face.dir, inward: { x: -face.outward.x, y: -face.outward.y },
        start: at(lo), end: at(hi), lo, hi, at, depth: depthOf(r.item), pieces: r.pieces,
        offset: r.item.category === 'shoe' && base ? depthOf(base.item) : 0,
      });
    }
  }
  const near = (p, q) => Math.hypot(p.x - q.x, p.y - q.y) < 1;
  const reaches = (l, s) => l.pieces.some((p) => Math.abs(p.s0 - s) < 1 || Math.abs(p.s1 - s) < 1);
  // The piece of the same kind that continues round the corner at point `corner`.
  const neighbour = (l, corner, atStart) => lines.find((o) => o !== l && o.group === l.group
    && (atStart ? near(o.end, corner) && reaches(o, o.hi) : near(o.start, corner) && reaches(o, o.lo)));
  // The band's edge `outer` (its offset from the wall) or inner (offset + depth), as a line.
  const edgeLine = (l, outer) => {
    const k = outer ? l.offset : l.offset + l.depth;
    return { p: { x: l.start.x + l.inward.x * k, y: l.start.y + l.inward.y * k }, d: l.dir };
  };
  const mitre = (l, o, outer = false) => {
    const a = edgeLine(l, outer);
    const b = edgeLine(o, outer);
    const den = a.d.x * b.d.y - a.d.y * b.d.x;
    if (Math.abs(den) < 1e-9) return null; // collinear: nothing to mitre
    const t = ((b.p.x - a.p.x) * b.d.y - (b.p.y - a.p.y) * b.d.x) / den;
    return { x: a.p.x + a.d.x * t, y: a.p.y + a.d.y * t };
  };
  const out = [];
  for (const l of lines) {
    const off = (p, k) => ({ x: p.x + l.inward.x * k, y: p.y + l.inward.y * k });
    for (const piece of l.pieces) {
      let a = off(l.at(piece.s0), l.offset);
      let b = off(l.at(piece.s1), l.offset);
      let ia = off(l.at(piece.s0), l.offset + l.depth);
      let ib = off(l.at(piece.s1), l.offset + l.depth);
      if (Math.abs(piece.s0 - l.lo) < 1) {
        const o = neighbour(l, l.start, true);
        ia = (o && mitre(l, o)) ?? ia;
        if (l.offset) a = (o && mitre(l, o, true)) ?? a;
      }
      if (Math.abs(piece.s1 - l.hi) < 1) {
        const o = neighbour(l, l.end, false);
        ib = (o && mitre(l, o)) ?? ib;
        if (l.offset) b = (o && mitre(l, o, true)) ?? b;
      }
      out.push({ category: l.item.category, part: 'run', tray: l.tray, item: l.item, poly: [a, b, ib, ia] });
    }
  }
  return [...out, ...casingParts];
}

// ---------------------------------------------------------------------------
// Picture-frame layout

/**
 * Evenly spaced picture-frame boxes between `bottom` and `top`, filling each
 * stretch of the face between openings (and their casing) with boxes close
 * to `width` wide, `gap` apart and `gap` from the ends.
 */
export function layoutBoxes(d, resolved, { bottom, top, gap, width, profileId, size }) {
  const face = resolved.face;
  const blocks = resolved.envelopes.filter((e) => e.bottom < top && e.top > bottom).map((e) => ({ s0: e.s0, s1: e.s1 }));
  for (const b of face.bands ?? []) if (b.bottom < top) blocks.push({ s0: b.s0, s1: b.s1 });
  const spans = subtractIntervals(0, face.length, blocks.sort((p, q) => p.s0 - q.s0));
  const boxes = [];
  for (const [s0, s1] of spans) {
    const span = s1 - s0;
    const n = Math.max(1, Math.round((span - gap) / (width + gap)));
    const w = (span - (n + 1) * gap) / n;
    if (w < Math.max(2 * (size ?? 0), 50)) continue;
    for (let i = 0; i < n; i++) boxes.push(makeBox(d, { s: s0 + gap + i * (w + gap), z: bottom, w, h: top - bottom, profileId, size }));
  }
  return boxes;
}

