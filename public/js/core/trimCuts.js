// Trim cut planning: the pieces assigned trim has to be cut into, laid out
// on the stock lengths it is sold in. Two plans are made for every profile
// and size:
//
//   material  Least material: the fewest sticks. Pieces are packed whole
//             where they fit and spliced into the leftover space where they
//             don't, so runs get joins wherever that saves a stick.
//   joins     Fewest joins: a run is only joined when it is longer than the
//             stock (and then into full lengths, never a short tail), and the
//             pieces are packed best-fit so offcuts go to shorter runs elsewhere.
//
// A cut piece is one straight length: a run between corners and openings
// (crown is cut again where a sloped ceiling changes pitch), a casing leg,
// head or bottom, a stool, apron or sill, a side of a picture-frame box, a
// stretch of sheet wainscot between doors (stock = one panel, a sheet width
// wide; seams are its joins) or one course of shiplap boards. Board and
// batten stays an area estimate. Each piece carries its geometry in face
// coordinates: centreline a → b ({ s, z }), the band `width` across it, and
// for runs the face span s0..s1, so the plan and elevations can draw joins.
import { faceKey, faceRef } from './faces.js';
import { profileHeightAt } from './ceiling.js';
import { intervalsBelowCeiling, recordForFace, resolveFaceTrim, subtractIntervals, trimLineKey } from './trim.js';
import { TRIM_CATEGORIES, getProfile } from './trimCatalog.js';
import { MM_PER_FT, MM_PER_IN, formatLength } from './units.js';

export const CUT_MODES = { material: 'Least material', joins: 'Fewest joins' };

const EPS = 0.5; // mm
const TRIM_ORDER = Object.keys(TRIM_CATEGORIES);
/** Stick tags: a letter per category (B-3 = baseboard stick 3). */
const CODES = { baseboard: 'B', shoe: 'S', crown: 'C', 'chair-rail': 'R', 'door-casing': 'D', 'window-casing': 'W', 'window-stool': 'T', 'window-apron': 'A', 'window-sill': 'L', 'panel-moulding': 'P' };

/** The plan the estimate uses: 'joins' when "fewest joins" is on, else 'material'. */
export function cutMode(d) {
  return d.estimate?.trimOptimize === true ? 'joins' : 'material';
}

/** Shortest piece spliced into a run: no join leaves a scrap shorter than this. */
export function minSplice(units) {
  return units === 'metric' ? 300 : 12 * MM_PER_IN;
}

/** A stock length for labels: 14' (whole feet) or 4.80 m. */
export function formatStock(mm, units) {
  const ft = mm / MM_PER_FT;
  if (units !== 'metric' && Math.abs(ft - Math.round(ft)) < 0.01) return `${Math.round(ft)}'`;
  return formatLength(mm, units, { precision: 'label' });
}

/** Interior points of a ceiling profile between s0 and s1 where the pitch changes. */
function pitchBreaks(profile, s0, s1) {
  const out = [];
  for (let i = 1; i < profile.length - 1; i++) {
    const p = profile[i];
    if (p.s <= s0 + EPS || p.s >= s1 - EPS) continue;
    const a = profile[i - 1];
    const b = profile[i + 1];
    const before = (p.z - a.z) / Math.max(p.s - a.s, 1e-9);
    const after = (b.z - p.z) / Math.max(b.s - p.s, 1e-9);
    if (Math.abs(before - after) > 1e-6) out.push(p.s);
  }
  return out;
}

function bounds(poly) {
  const ss = poly.map((q) => q.s);
  const zs = poly.map((q) => q.z);
  return { s0: Math.min(...ss), s1: Math.max(...ss), z0: Math.min(...zs), z1: Math.max(...zs) };
}

/** Every straight piece of assigned trim on the faces, in face order. */
export function cutPieces(d, faces) {
  const pieces = [];
  for (const face of faces) {
    const rec = recordForFace(d, face);
    if (!rec?.items.length) continue;
    const key = faceKey(faceRef(face));
    for (const r of resolveFaceTrim(d, face, rec).items) {
      const it = r.item;
      for (const p of r.pieces) {
        const add = (part, length, a, b, width, extra = {}) => {
          if (!(length >= 1)) return;
          pieces.push({
            id: `c${pieces.length}`, order: pieces.length, face: key, faceName: face.name, roomId: face.roomId, itemId: it.id, kind: it.kind,
            category: p.category, profileId: p.profileId, size: p.size, part, length, a, b, width, ...extra,
          });
        };
        if (it.kind === 'run') {
          const part = p.part === 'tray crown' ? 'tray crown' : it.category === 'chair-rail' ? 'chair rail' : it.category;
          if (p.part === 'run' && it.category === 'crown') {
            // Along the ceiling line, one length per pitch.
            const ss = [p.s0, ...pitchBreaks(face.profile, p.s0, p.s1), p.s1];
            for (let i = 1; i < ss.length; i++) {
              const a = { s: ss[i - 1], z: profileHeightAt(face.profile, ss[i - 1]) - p.size / 2 };
              const b = { s: ss[i], z: profileHeightAt(face.profile, ss[i]) - p.size / 2 };
              add(part, Math.hypot(b.s - a.s, b.z - a.z), a, b, p.size, { s0: a.s, s1: b.s });
            }
          } else {
            const bb = bounds(p.poly);
            const z = (bb.z0 + bb.z1) / 2;
            add(part, p.s1 - p.s0, { s: p.s0, z }, { s: p.s1, z }, bb.z1 - bb.z0, { s0: p.s0, s1: p.s1 });
          }
        } else if (it.kind === 'casing') {
          // Measured at the long point; drawn along the piece's centreline.
          const bb = bounds(p.poly);
          if (p.part.endsWith('leg')) {
            const s = (bb.s0 + bb.s1) / 2;
            add(p.part, p.length, { s, z: bb.z0 }, { s, z: bb.z1 }, bb.s1 - bb.s0);
          } else {
            const z = (bb.z0 + bb.z1) / 2;
            add(p.part, p.length, { s: bb.s0, z }, { s: bb.s1, z }, bb.z1 - bb.z0);
          }
        } else if (it.kind === 'box') {
          const { s, z, w, h } = it;
          const t = Math.min(p.size, w / 2, h / 2);
          add('box top', w, { s, z: z + h - t / 2 }, { s: s + w, z: z + h - t / 2 }, t);
          add('box bottom', w, { s, z: z + t / 2 }, { s: s + w, z: z + t / 2 }, t);
          add('box left', h, { s: s + t / 2, z }, { s: s + t / 2, z: z + h }, t);
          add('box right', h, { s: s + w - t / 2, z }, { s: s + w - t / 2, z: z + h }, t);
        } else if (it.kind === 'wainscot') {
          const profile = getProfile(p.profileId);
          const holes = (p.holes ?? []).map((q) => ({ s0: q[0].s, s1: q[1].s, z0: q[0].z, z1: q[2].z }));
          if (profile?.unit === 'sheet') {
            // Panels run unbroken under windows; only doors (holes down to the floor) end a stretch.
            const panelHeight = Math.min(it.height, profile.sheetLength);
            const doors = holes.filter((q) => q.z0 <= 1);
            for (const [s0, s1] of subtractIntervals(r.a, r.b, doors)) {
              add('panel', s1 - s0, { s: s0, z: it.height / 2 }, { s: s1, z: it.height / 2 }, it.height, { s0, s1, panelHeight });
            }
          } else if (profile?.unit === 'sf' && profile.pattern === 'shiplap') {
            // One course of boards per board width, broken by openings and a sloped ceiling.
            for (let z0 = 0; z0 < it.height - 1; z0 += p.size) {
              const z1 = Math.min(it.height, z0 + p.size);
              const gaps = holes.filter((q) => q.z0 < z1 - EPS && q.z1 > z0 + EPS);
              for (const [x0, x1] of intervalsBelowCeiling(face.profile, r.a, r.b, z0 + EPS)) {
                for (const [s0, s1] of subtractIntervals(x0, x1, gaps)) {
                  add('board', s1 - s0, { s: s0, z: (z0 + z1) / 2 }, { s: s1, z: (z0 + z1) / 2 }, z1 - z0, { s0, s1, board: true });
                }
              }
            }
          }
        }
      }
    }
  }
  return pieces;
}

// ---------------------------------------------------------------------------
// Laying pieces out on stock. Internally a stick is { cuts: [{ piece, t0, t1, len }], used },
// where t0..t1 is the part of the piece (0 = its start a) cut from that stick.

/** Fewest joins: lengths a piece is cut into (full sticks, rebalancing a short tail). */
function joinSplit(L, S, splice) {
  if (L <= S + EPS) return [L];
  const k = Math.floor(L / S + 1e-9);
  const tail = L - k * S;
  if (tail < EPS) return [...Array(k - 1).fill(S), L - (k - 1) * S];
  if (tail < 2 * splice) return [...Array(k - 1).fill(S), (S + tail) / 2, (S + tail) / 2];
  return [...Array(k).fill(S), tail];
}

const roomIn = (st, S) => S - st.used;

/** The stick with the least room that still takes `len` (best fit), or null. */
function bestFit(sticks, S, len) {
  let best = null;
  for (const st of sticks) if (roomIn(st, S) >= len - EPS && (!best || st.used > best.used)) best = st;
  return best;
}

function layoutJoins(pieces, S, splice) {
  const segs = [];
  for (const p of pieces) {
    let t = 0;
    for (const len of joinSplit(p.length, S, splice)) {
      segs.push({ piece: p, t0: t, t1: t + len, len });
      t += len;
    }
  }
  segs.sort((x, y) => y.len - x.len || x.piece.order - y.piece.order || x.t0 - y.t0);
  const sticks = [];
  for (const sg of segs) {
    let st = bestFit(sticks, S, sg.len);
    if (!st) sticks.push((st = { cuts: [], used: 0 }));
    st.cuts.push(sg);
    st.used += sg.len;
  }
  return sticks;
}

function layoutMaterial(pieces, S, splice) {
  const minSeg = Math.min(splice, S / 2);
  const total = pieces.reduce((s, p) => s + p.length, 0);
  const sticks = Array.from({ length: Math.max(1, Math.ceil(total / S - 1e-6)) }, () => ({ cuts: [], used: 0 }));
  const sorted = [...pieces].sort((x, y) => y.length - x.length || x.order - y.order);
  for (const p of sorted) {
    let t = 0;
    while (p.length - t > EPS) {
      const rem = p.length - t;
      const fit = bestFit(sticks, S, rem);
      if (fit) {
        fit.cuts.push({ piece: p, t0: t, t1: p.length, len: rem });
        fit.used += rem;
        break;
      }
      // Splice into the biggest space, leaving at least minSeg either side of the join.
      const big = sticks.reduce((a, b) => (b.used < a.used ? b : a));
      let c = roomIn(big, S);
      if (rem - c < minSeg) c = rem - minSeg;
      if (c < minSeg - EPS) {
        sticks.push({ cuts: [], used: 0 });
        continue;
      }
      big.cuts.push({ piece: p, t0: t, t1: t + c, len: c });
      big.used += c;
      t += c;
    }
  }
  return sticks.filter((st) => st.cuts.length);
}

/** Numbers the sticks in the order their first cut comes around the house, with tags and per-piece segments. */
function finishLayout(group, sticks) {
  const S = group.stock;
  const first = (st) => st.cuts.reduce((m, c) => (c.piece.order < m.piece.order || (c.piece.order === m.piece.order && c.t0 < m.t0) ? c : m));
  const ordered = [...sticks].sort((a, b) => first(a).piece.order - first(b).piece.order || first(a).t0 - first(b).t0);
  const segments = new Map();
  const out = ordered.map((st, i) => {
    const n = i + 1;
    const tag = `${group.code}-${n}`;
    const cuts = [...st.cuts].sort((a, b) => b.len - a.len).map((c) => ({ piece: c.piece, t0: c.t0, t1: c.t1, length: c.len }));
    for (const c of cuts) {
      if (!segments.has(c.piece.id)) segments.set(c.piece.id, []);
      segments.get(c.piece.id).push({ t0: c.t0, t1: c.t1, stick: n, tag });
    }
    return { n, tag, cuts, used: st.used, offcut: Math.max(0, S - st.used) };
  });
  let joins = 0;
  for (const segs of segments.values()) {
    segs.sort((a, b) => a.t0 - b.t0);
    joins += segs.length - 1;
  }
  return {
    count: out.length,
    joins,
    sticks: out,
    segments,
    offcut: out.reduce((s, st) => s + st.offcut, 0),
    sheets: group.kind === 'sheet' ? Math.ceil(out.length / group.perSheet) : null,
  };
}

/**
 * The cut plan for trim on `faces`: one group per profile and size (sheet
 * wainscot also per panel height), each with its pieces and both layouts in
 * `plans.material` / `plans.joins`: { count (sticks, panels or boards),
 * joins, sticks: [{ n, tag, cuts, offcut }], segments: Map(piece id →
 * [{ t0, t1, stick, tag }]), offcut, sheets }. `byFace` maps a face key to
 * its pieces with their group.
 *
 * opts.trimLength is the default stock length; opts.stockLengths overrides
 * it per trim line key; a catalog stockLength comes in between.
 */
export function trimCutPlan(d, faces, opts = {}) {
  const trimLength = opts.trimLength > 0 ? opts.trimLength : d.units === 'metric' ? 4800 : 16 * MM_PER_FT;
  const stockLengths = opts.stockLengths ?? {};
  const splice = minSplice(d.units);
  const map = new Map();
  for (const p of cutPieces(d, faces)) {
    const lineKey = trimLineKey(p.category, p.profileId, p.size);
    const key = p.panelHeight != null ? `${lineKey}|h${Math.round(p.panelHeight)}` : lineKey;
    let g = map.get(key);
    if (!g) {
      const profile = getProfile(p.profileId);
      const kind = p.panelHeight != null ? 'sheet' : p.board ? 'boards' : 'lf';
      const custom = Number.isFinite(stockLengths[lineKey]) && stockLengths[lineKey] > 0 ? stockLengths[lineKey] : null;
      g = {
        key, lineKey, kind, category: p.category, profileId: p.profileId, size: p.size, pieces: [],
        stock: kind === 'sheet' ? p.size : custom ?? profile?.stockLength ?? trimLength,
        stockSource: kind === 'sheet' ? 'sheet' : custom ? 'plan' : profile?.stockLength ? 'catalog' : 'default',
      };
      if (kind === 'sheet') {
        g.panelHeight = p.panelHeight;
        g.sheetLength = profile.sheetLength;
        g.perSheet = Math.max(1, Math.floor(profile.sheetLength / p.panelHeight + 1e-6));
      }
      map.set(key, g);
    }
    g.pieces.push(p);
  }
  const groups = [...map.values()].sort((a, b) => TRIM_ORDER.indexOf(a.category) - TRIM_ORDER.indexOf(b.category)
    || (a.kind === 'lf' ? 0 : 1) - (b.kind === 'lf' ? 0 : 1) || a.size - b.size || (a.panelHeight ?? 0) - (b.panelHeight ?? 0));
  const seen = new Map();
  for (const g of groups) {
    const letter = g.category === 'panel-moulding' && g.kind !== 'lf' ? 'K' : CODES[g.category] ?? 'X';
    const k = (seen.get(letter) ?? 0) + 1;
    seen.set(letter, k);
    g.code = k > 1 ? `${letter}${k}` : letter;
    g.net = g.pieces.reduce((s, p) => s + p.length, 0);
    const joins = layoutJoins(g.pieces, g.stock, splice);
    const material = layoutMaterial(g.pieces, g.stock, splice);
    // Least material never takes more stock (or more joins for the same stock) than fewest joins.
    const jp = finishLayout(g, joins);
    let mp = finishLayout(g, material);
    if (mp.count > jp.count || (mp.count === jp.count && mp.joins > jp.joins)) mp = jp;
    g.plans = { joins: jp, material: mp };
  }
  const byFace = new Map();
  for (const g of groups) {
    for (const p of g.pieces) {
      if (!byFace.has(p.face)) byFace.set(p.face, []);
      byFace.get(p.face).push({ piece: p, group: g });
    }
  }
  return { groups, byFace };
}

/**
 * Joins and stick labels on one face for a plan mode, in face coordinates:
 * joins as lines across the piece ({ category, a, b }), labels at the middle
 * of each length of stock ({ category, tag, at, dir, length, width }).
 */
export function faceCutMarks(plan, mode, key) {
  const joins = [];
  const labels = [];
  for (const { piece: p, group: g } of plan.byFace.get(key) ?? []) {
    const segs = g.plans[mode].segments.get(p.id) ?? [];
    const ds = p.b.s - p.a.s;
    const dz = p.b.z - p.a.z;
    const len = Math.hypot(ds, dz) || 1;
    const dir = { s: ds / len, z: dz / len };
    const half = p.width / 2;
    const at = (t) => ({ s: p.a.s + (ds * t) / p.length, z: p.a.z + (dz * t) / p.length });
    segs.forEach((sg, i) => {
      if (i > 0) {
        const c = at(sg.t0);
        joins.push({ category: p.category, a: { s: c.s + dir.z * half, z: c.z - dir.s * half }, b: { s: c.s - dir.z * half, z: c.z + dir.s * half } });
      }
      labels.push({ category: p.category, tag: sg.tag, at: at((sg.t0 + sg.t1) / 2), dir, length: (len * (sg.t1 - sg.t0)) / p.length, width: p.width });
    });
  }
  return { joins, labels };
}

/**
 * Cut marks for the plan view's runs, for planTrimCutMarks: (face, item) →
 * [{ s0, s1, joins: [s], segments: [{ s0, s1, tag }] }] in face coordinates.
 */
export function planCutLookup(plan, mode) {
  const map = new Map();
  for (const g of plan.groups) {
    if (g.kind !== 'lf') continue;
    for (const p of g.pieces) {
      if (p.kind !== 'run') continue;
      const segs = g.plans[mode].segments.get(p.id) ?? [];
      const sAt = (t) => p.s0 + ((p.s1 - p.s0) * t) / p.length;
      const key = `${p.face}|${p.itemId}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push({ s0: p.s0, s1: p.s1, joins: segs.slice(1).map((sg) => sAt(sg.t0)), segments: segs.map((sg) => ({ s0: sAt(sg.t0), s1: sAt(sg.t1), tag: sg.tag })) });
    }
  }
  return (face, item) => map.get(`${faceKey(faceRef(face))}|${item.id}`) ?? null;
}
