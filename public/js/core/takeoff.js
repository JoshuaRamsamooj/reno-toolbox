// Quantity takeoff: turns the analysed plan into raw quantities per room and
// a first-pass material list. Everything is computed in mm/mm² and converted
// to the display system at the end.
import { BARN_OVERLAP, DOOR_STYLES, analyze, doorStyle, roomElevations, indexDesign, wallLength } from './model.js';
import { profileArea, profileHeightAt } from './ceiling.js';
import { lerp } from './geometry.js';
import { bandArea, bulkheadSurfaces } from './bulkhead.js';
import { analyzeLeveling, resolveCompound } from './leveling.js';
import { designFaces } from './faces.js';
import { BUY_UNITS, FLOOR_KINDS, FLOOR_PRESETS, layoutRun, runLayer } from './flooring.js';
import { mergeTrimLines, trimTakeoff } from './trim.js';
import { furnitureMaterials } from './furniture.js';
import { TRIM_CATEGORIES, getProfile, profileLabel } from './trimCatalog.js';
import { MM2_PER_FT2, MM2_PER_M2, MM_PER_FT, areaValue, areaUnit, formatLength, lengthValue } from './units.js';

/** Material units counted in whole pieces. */
export const COUNT_UNITS = new Set(['sheets', 'bags', 'boxes', 'panels', 'rolls', 'doors', 'ea']);

export function estimateDefaults(units) {
  return {
    flooringWaste: 10,
    drywallWaste: 12,
    insulationWaste: 5,
    trimWaste: 10,
    insulateCeilings: true,
    drywallSheet: units === 'metric' ? { w: 1200, h: 2400 } : { w: 4 * MM_PER_FT, h: 8 * MM_PER_FT },
    trimLength: units === 'metric' ? 4800 : 16 * MM_PER_FT,
    paintCoats: 2,
    paintCoverage: { imperial: 350, metric: 10 }, // sq ft per gallon, m² per litre
    prices: {}, // unit price per material line, by line key
    taxRate: 0, // %, one rate for every line
    currency: '$',
  };
}

export function resolveEstimate(d) {
  const def = estimateDefaults(d.units);
  const e = d.estimate ?? {};
  return { ...def, ...e, paintCoverage: { ...def.paintCoverage, ...(e.paintCoverage ?? {}) }, prices: { ...(e.prices ?? {}) } };
}

/** A material line's quantity as listed (whole pieces, or one decimal), which is what gets priced. */
export function listedQuantity(m) {
  return COUNT_UNITS.has(m.unit) ? m.quantity : Math.round(m.quantity * 10) / 10;
}

const cents = (v) => Math.round(v * 100) / 100;

/**
 * Prices the material list: each line's listed quantity (waste included)
 * times its unit price (design.estimate.prices, by line key; lines without
 * a price cost nothing), then one tax rate on the subtotal.
 */
export function priceMaterials(d, materials) {
  const e = resolveEstimate(d);
  const lines = materials.map((m) => {
    const unitPrice = Number.isFinite(e.prices[m.key]) ? e.prices[m.key] : null;
    return { key: m.key, unitPrice, cost: unitPrice == null ? null : cents(listedQuantity(m) * unitPrice) };
  });
  const subtotal = cents(lines.reduce((sum, l) => sum + (l.cost ?? 0), 0));
  const taxRate = Number.isFinite(e.taxRate) ? e.taxRate : 0;
  const tax = cents((subtotal * taxRate) / 100);
  return { lines, priced: lines.filter((l) => l.cost != null).length, subtotal, taxRate, tax, total: cents(subtotal + tax), currency: e.currency ?? '$' };
}

/** Money with the plan's currency symbol and two decimals, e.g. $1,234.50. */
export function formatMoney(v, currency = '$') {
  return `${v < 0 ? '−' : ''}${currency}${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function emptyQuantities() {
  return {
    floorArea: 0,
    perimeter: 0,
    wallGross: 0,
    openingArea: 0,
    wallNet: 0,
    exteriorWallNet: 0,
    ceilingArea: 0,
    ceilingInsulation: 0,
    bulkheadArea: 0,
    bulkheadBead: 0,
    baseboard: 0, // potential baseboard and casing on every face (assigned trim is in `trim`)
    doorCasing: 0,
    windowCasing: 0,
    doors: 0,
    windows: 0,
    openings: 0,
  };
}

/**
 * Measures one wall face (a strip of length `length` with a height profile)
 * and its openings. `segments` marks which spans of the face are exterior;
 * `bands` are spans hidden behind bulkheads (no wall finish, still insulated).
 */
function measureFace(q, length, profile, openings, segments, bands = []) {
  const gross = profileArea(profile);
  let openArea = 0;
  let baseGaps = 0;
  const openingSpans = [];
  for (const op of openings) {
    const s0 = Math.max(0, op.s0);
    const s1 = Math.min(length, op.s1);
    if (s1 <= s0) continue;
    const top = Math.min(op.top, profileHeightAt(profile, (s0 + s1) / 2));
    const h = Math.max(0, top - op.bottom);
    openArea += (s1 - s0) * h;
    openingSpans.push({ s0, s1, h, bottom: op.bottom, top });
    const o = op.opening;
    if (o.type === 'window') {
      q.windows++;
      q.windowCasing += 2 * (o.width + o.height);
    } else {
      baseGaps += s1 - s0;
      q[o.type === 'door' ? 'doors' : 'openings']++;
      q.doorCasing += 2 * o.height + o.width;
    }
  }
  const net = Math.max(0, gross - openArea);
  q.wallGross += gross;
  q.openingArea += openArea;
  q.wallNet += net;
  q.baseboard += Math.max(0, length - baseGaps);
  for (const seg of segments.filter((x) => x.exterior)) {
    let a = profileArea(profile, seg.s0, seg.s1);
    for (const sp of openingSpans) a -= Math.max(0, Math.min(seg.s1, sp.s1) - Math.max(seg.s0, sp.s0)) * sp.h;
    q.exteriorWallNet += Math.max(0, a);
  }
  for (const band of bands) {
    let covered = bandArea(profile, band.s0, band.s1, band.bottom);
    for (const sp of openingSpans) {
      const overlap = Math.max(0, Math.min(band.s1, sp.s1) - Math.max(band.s0, sp.s0));
      covered -= overlap * Math.max(0, sp.top - Math.max(sp.bottom, band.bottom));
    }
    q.wallNet -= Math.min(Math.max(0, covered), q.wallNet);
  }
}

export function computeTakeoff(d) {
  const analysis = analyze(d);
  const idx = indexDesign(d);
  const trim = trimTakeoff(d, designFaces(d, analysis));
  // Dead space is drawn but never finished: no floor, walls, ceiling, trim or leveling.
  const rooms = analysis.rooms.filter((g) => !g.dead).map((g) => {
    const q = emptyQuantities();
    const elev = roomElevations(d, g);
    q.floorArea = g.area;
    q.perimeter = g.perimeter;
    q.ceilingArea = elev.model.area;
    q.ceilingInsulation = elev.model.area;
    // Bulkhead soffits replace the ceiling surface above them.
    const slopeFactor = g.area > 0 ? elev.model.area / g.area : 1;
    for (const r of elev.bulkheads) {
      const surf = bulkheadSurfaces(r, elev.model);
      q.ceilingArea = Math.max(0, q.ceilingArea - surf.soffit * slopeFactor);
      q.bulkheadArea += surf.area;
      q.bulkheadBead += surf.bead;
    }
    for (const w of elev.walls) measureFace(q, w.length, w.profile, w.openings, w.segments, w.bands);

    // Partial-height/stub walls inside the room are finished on both sides.
    for (const id of g.spurWallIds) {
      const wall = idx.walls.get(id);
      const A = idx.nodes.get(wall.a);
      const B = idx.nodes.get(wall.b);
      const L = wallLength(d, wall, idx);
      const h = elev.model.heightAt(lerp(A, B, 0.5));
      const profile = [{ s: 0, z: h }, { s: L, z: h }];
      const ops = d.openings
        .filter((o) => o.wallId === id)
        .map((o) => {
          const bottom = o.type === 'window' ? o.sill : 0;
          return { opening: o, s0: o.offset - o.width / 2, s1: o.offset + o.width / 2, bottom, top: bottom + o.height };
        });
      measureFace(q, L, profile, ops, []);
      measureFace(q, L, profile, ops, []);
    }
    // Linked rooms share one analysis; each room takes its own share of it.
    const lv = g.room?.leveling?.readings?.length ? analyzeLeveling(d, g, { analysis }) : null;
    const leveling = lv?.ready ? lv.byRoom.get(g.room.id) ?? null : null;
    const roomTrim = mergeTrimLines(trim.lines.filter((l) => l.faceKind === 'room' && l.roomId === (g.room?.id ?? null)));
    return { id: g.room?.id ?? null, name: g.room?.name ?? 'Unnamed room', flooring: g.room?.flooring !== false, ceilingType: elev.spec.type, q, leveling, trim: roomTrim };
  });

  const totals = emptyQuantities();
  for (const r of rooms) for (const k of Object.keys(totals)) totals[k] += r.q[k];
  // Rooms with a finish-floor layout are counted from it; the rest by area.
  const floorRuns = (d.floorRuns ?? []).map((run) => layoutRun(d, run, { analysis }));
  const laidOut = new Set((d.floorRuns ?? []).filter((run) => runLayer(run) === 'finish').flatMap((run) => run.roomIds));
  const flooredArea = rooms.filter((r) => r.flooring && !laidOut.has(r.id)).reduce((s, r) => s + r.q.floorArea, 0);

  const materials = [...materialList(d, totals, flooredArea, laidOut.size > 0), ...floorMaterials(d, floorRuns), ...trimMaterials(d, trim.totals), ...levelingMaterials(d, rooms), ...doorMaterials(d), ...furnitureMaterials(d, analysis)];
  return {
    rooms,
    totals,
    trim,
    floorRuns,
    materials,
    pricing: priceMaterials(d, materials),
    counts: countOpenings(d),
  };
}

/**
 * One line per flooring run: boxes (or sheets, panels, rolls) from the
 * layout's piece count with offcuts reused, plus the run's waste allowance.
 */
function floorMaterials(d, layouts) {
  const u = d.units;
  const aUnit = areaUnit(u);
  const A = (mm2) => areaValue(mm2, u);
  const L = (mm) => formatLength(mm, u, { precision: 'label' });
  return layouts.filter((l) => l.pieces.length).map((l) => {
    const r = l.run;
    const m = l.material;
    const kind = FLOOR_KINDS[r.kind];
    const product = FLOOR_PRESETS[r.preset]?.name ?? `${kind.label} ${L(r.width)} × ${L(r.length)}`;
    const pieces = `${m.order} ${kind.pieces} (${m.stock} from the layout + ${r.waste}% waste)`;
    return {
      key: `floor:${r.id}`,
      category: r.layer === 'subfloor' ? 'Subfloor' : 'Flooring',
      label: `${product} – ${r.name} (${l.region.geoms.map((g) => g.room.name).join(', ')})`,
      quantity: m.boxes,
      unit: BUY_UNITS[r.unit][1],
      detail: `${r.perBox > 1 ? `${pieces}, ${r.perBox} per ${BUY_UNITS[r.unit][0]}` : pieces} · ${A(m.netArea).toFixed(1)} ${aUnit} covered, ${A(m.coverage).toFixed(1)} ${aUnit} bought`,
      floor: { runId: r.id, pieces: m.order, netArea: m.netArea, coverage: m.coverage },
    };
  });
}

const TRIM_ORDER = Object.keys(TRIM_CATEGORIES);

/**
 * Assigned trim, one line per profile and size: linear profiles in lf/m and
 * stock pieces, area goods in sq ft/m², sheet goods in whole sheets.
 */
function trimMaterials(d, lines) {
  const e = resolveEstimate(d);
  const u = d.units;
  const L = (mm) => lengthValue(mm, u);
  const A = (mm2) => areaValue(mm2, u);
  const withWaste = (v) => v * (1 + e.trimWaste / 100);
  const lUnit = u === 'metric' ? 'm' : 'lf';
  const aUnit = areaUnit(u);
  const pieceLabel = u === 'metric' ? `${(e.trimLength / 1000).toFixed(1)} m` : `${Math.round(e.trimLength / MM_PER_FT)}'`;
  const sorted = [...lines].sort((p, q) => TRIM_ORDER.indexOf(p.category) - TRIM_ORDER.indexOf(q.category) || p.size - q.size);
  return sorted.map((l) => {
    const label = `${TRIM_CATEGORIES[l.category]?.label ?? 'Trim'} – ${profileLabel(l.profileId, l.size, u, l.category)}`;
    const base = { key: `trim:${l.key}`, category: 'Trim', label, trim: l };
    if (l.unit === 'sheet') {
      const sheet = l.size * (getProfile(l.profileId)?.sheetLength ?? 0);
      return {
        ...base, quantity: sheet > 0 ? Math.ceil(withWaste(l.area) / sheet - 1e-9) : 0, unit: 'sheets',
        detail: `${A(l.area).toFixed(1)} ${aUnit} net + ${e.trimWaste}% waste`,
      };
    }
    if (l.unit === 'sf') {
      return { ...base, quantity: A(withWaste(l.area)), unit: aUnit, detail: `${A(l.area).toFixed(1)} ${aUnit} net + ${e.trimWaste}% waste` };
    }
    return {
      ...base, quantity: L(withWaste(l.length)), unit: lUnit,
      detail: `${Math.ceil(withWaste(l.length) / e.trimLength - 1e-9)} × ${pieceLabel} pieces (net ${L(l.length).toFixed(1)} ${lUnit} in ${l.pieces} piece${l.pieces === 1 ? '' : 's'} + ${e.trimWaste}% waste)`,
    };
  });
}

/** Self-leveler bags (contingency applied to the plan total) and grinding, from rooms with a floor survey. */
function levelingMaterials(d, rooms) {
  const surveyed = rooms.filter((r) => r.leveling);
  if (!surveyed.length) return [];
  const u = d.units;
  const aUnit = areaUnit(u);
  const A = (mm2) => areaValue(mm2, u);
  const { product, contingency } = resolveCompound(d);
  const raw = surveyed.reduce((s, r) => s + r.leveling.rawBags, 0);
  const fillArea = surveyed.reduce((s, r) => s + r.leveling.fillArea, 0);
  const grinding = surveyed.filter((r) => r.leveling.grindArea > 0);
  const items = [];
  if (raw > 0) {
    const pouring = surveyed.filter((r) => r.leveling.rawBags > 0).map((r) => r.name).join(', ');
    items.push({
      key: 'self-leveler', category: 'Leveling', label: `Self-leveling compound – ${product.name} (${product.bag})`,
      quantity: Math.ceil(raw * (1 + contingency / 100) - 1e-9), unit: 'bags',
      detail: `${A(fillArea).toFixed(1)} ${aUnit} pour in ${pouring} + ${contingency}% contingency`,
    });
  }
  if (grinding.length) {
    const area = grinding.reduce((s, r) => s + r.leveling.grindArea, 0);
    const spots = grinding.reduce((s, r) => s + r.leveling.zones, 0);
    items.push({
      key: 'grinding', category: 'Leveling', label: 'Grind high spots',
      quantity: A(area), unit: aUnit,
      detail: `${spots} spot${spots === 1 ? '' : 's'} in ${grinding.map((r) => r.name).join(', ')} (see Level tool for locations)`,
    });
  }
  return items;
}

const DOOR_HARDWARE = {
  single: 'prehung or slab + hinges',
  double: 'pair of leaves',
  sliding: 'two bypass panels + track',
  pocket: 'slab + pocket frame kit',
  barn: 'slab + surface track',
};

/** Doors by style and size, with the hardware each style needs (barn track runs twice the slab width). */
function doorMaterials(d) {
  const L = (mm) => formatLength(mm, d.units, { precision: 'label' });
  const groups = new Map();
  for (const o of d.openings) {
    const style = doorStyle(o);
    if (!style) continue;
    const key = `${style}|${Math.round(o.width)}|${Math.round(o.height)}`;
    if (!groups.has(key)) groups.set(key, { style, width: o.width, height: o.height, count: 0 });
    groups.get(key).count++;
  }
  const order = Object.keys(DOOR_STYLES);
  return [...groups.values()]
    .sort((p, q) => order.indexOf(p.style) - order.indexOf(q.style) || p.width - q.width)
    .map((g) => {
      const slab = g.style === 'barn' ? g.width + 2 * BARN_OVERLAP : g.width;
      const extra = g.style === 'barn' ? ` (${L(slab)} slab, ${L(2 * slab)} track)` : g.style === 'double' ? ` (2 × ${L(g.width / 2)} leaves)` : '';
      return {
        key: `door:${g.style}:${Math.round(g.width)}:${Math.round(g.height)}`, category: 'Doors',
        label: `${DOOR_STYLES[g.style]} door – ${L(g.width)} × ${L(g.height)}`,
        quantity: g.count, unit: 'doors', detail: `${DOOR_HARDWARE[g.style]}${extra}`,
      };
    });
}

function countOpenings(d) {
  const c = { door: 0, window: 0, opening: 0 };
  for (const o of d.openings) c[o.type] = (c[o.type] ?? 0) + 1;
  return c;
}

function materialList(d, t, flooredArea, hasLayouts = false) {
  const e = resolveEstimate(d);
  const u = d.units;
  const A = (mm2) => areaValue(mm2, u);
  const L = (mm) => lengthValue(mm, u);
  const withWaste = (v, pct) => v * (1 + pct / 100);
  const aUnit = areaUnit(u);
  const lUnit = u === 'metric' ? 'm' : 'lf';
  const sheetArea = e.drywallSheet.w * e.drywallSheet.h;
  const sheetLabel = u === 'metric'
    ? `${e.drywallSheet.w} × ${e.drywallSheet.h} mm`
    : `${Math.round(e.drywallSheet.w / MM_PER_FT)}' × ${Math.round(e.drywallSheet.h / MM_PER_FT)}'`;
  const finished = t.wallNet + t.ceilingArea + t.bulkheadArea;
  const drywallArea = finished;
  const ceilingInsulation = e.insulateCeilings ? t.ceilingInsulation : 0;
  const paintArea = finished * e.paintCoats;
  const bulkheadNote = t.bulkheadArea > 0 ? ` + ${A(t.bulkheadArea).toFixed(1)} ${aUnit} bulkheads` : '';
  const coverage = e.paintCoverage[u] * (u === 'metric' ? MM2_PER_M2 : MM2_PER_FT2);

  const items = [
    ...(hasLayouts && flooredArea <= 0 ? [] : [{
      key: 'flooring', category: 'Flooring', label: hasLayouts ? 'Flooring – rooms without a layout' : 'Flooring',
      quantity: A(withWaste(flooredArea, e.flooringWaste)), unit: aUnit,
      detail: `${A(flooredArea).toFixed(1)} ${aUnit} net + ${e.flooringWaste}% waste`,
    }]),
    {
      key: 'drywall', category: 'Drywall', label: `Drywall sheets (${sheetLabel})`,
      quantity: Math.ceil(withWaste(drywallArea, e.drywallWaste) / sheetArea - 1e-9), unit: 'sheets',
      detail: `${A(t.wallNet).toFixed(1)} ${aUnit} walls + ${A(t.ceilingArea).toFixed(1)} ${aUnit} ceilings${bulkheadNote} + ${e.drywallWaste}% waste`,
    },
    ...(t.bulkheadBead > 0 ? [{
      key: 'corner-bead', category: 'Drywall', label: 'Corner bead – bulkheads',
      quantity: L(withWaste(t.bulkheadBead, e.trimWaste)), unit: lUnit,
      detail: `${L(t.bulkheadBead).toFixed(1)} ${lUnit} of outside corners + ${e.trimWaste}% waste`,
    }] : []),
    {
      key: 'insulation-walls', category: 'Insulation', label: 'Insulation – exterior walls',
      quantity: A(withWaste(t.exteriorWallNet, e.insulationWaste)), unit: aUnit,
      detail: `${A(t.exteriorWallNet).toFixed(1)} ${aUnit} net exterior wall + ${e.insulationWaste}% waste`,
    },
    {
      key: 'insulation-ceilings', category: 'Insulation', label: 'Insulation – ceilings',
      quantity: A(withWaste(ceilingInsulation, e.insulationWaste)), unit: aUnit,
      detail: e.insulateCeilings ? `${A(t.ceilingInsulation).toFixed(1)} ${aUnit} ceiling + ${e.insulationWaste}% waste` : 'Disabled in estimate settings',
    },
    {
      key: 'paint', category: 'Paint', label: 'Paint – walls & ceilings',
      quantity: paintArea / coverage, unit: u === 'metric' ? 'L' : 'gal',
      detail: `${A(finished).toFixed(1)} ${aUnit} × ${e.paintCoats} coats @ ${e.paintCoverage[u]} ${aUnit}/${u === 'metric' ? 'L' : 'gal'}`,
    },
  ];
  return items;
}

/** CSV export of the takeoff (rooms, materials with prices and totals, trim by face). */
export function takeoffToCsv(d, takeoff) {
  const u = d.units;
  const aU = areaUnit(u);
  const lU = u === 'metric' ? 'm' : 'ft';
  const A = (v) => areaValue(v, u).toFixed(2);
  const L = (v) => lengthValue(v, u).toFixed(2);
  const esc = (s) => (/[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
  const rows = [
    ['Room', 'Ceiling', `Floor (${aU})`, `Perimeter (${lU})`, `Walls gross (${aU})`, `Openings (${aU})`, `Walls net (${aU})`,
      `Exterior walls net (${aU})`, `Ceiling (${aU})`, `Bulkheads (${aU})`, `Baseboard (${lU})`, `Door casing (${lU})`, `Window casing (${lU})`, 'Doors', 'Windows', 'Openings'],
  ];
  const line = (name, ceiling, q) => [name, ceiling, A(q.floorArea), L(q.perimeter), A(q.wallGross), A(q.openingArea), A(q.wallNet),
    A(q.exteriorWallNet), A(q.ceilingArea), A(q.bulkheadArea), L(q.baseboard), L(q.doorCasing), L(q.windowCasing), q.doors, q.windows, q.openings];
  for (const r of takeoff.rooms) rows.push(line(r.name, r.ceilingType, r.q));
  rows.push(line('TOTAL', '', takeoff.totals));
  rows.push([]);
  const pricing = takeoff.pricing ?? priceMaterials(d, takeoff.materials);
  const money = (v) => (v == null ? '' : v.toFixed(2));
  rows.push(['Material', 'Quantity', 'Unit', 'Unit price', 'Total', 'Notes']);
  takeoff.materials.forEach((m, i) => {
    const line = pricing.lines[i];
    rows.push([m.label, m.quantity.toFixed(COUNT_UNITS.has(m.unit) ? 0 : 2), m.unit, money(line.unitPrice), money(line.cost), m.detail]);
  });
  if (pricing.priced) {
    rows.push(['Subtotal', '', '', '', money(pricing.subtotal), `${pricing.priced} of ${pricing.lines.length} lines priced`]);
    rows.push([`Tax (${pricing.taxRate}%)`, '', '', '', money(pricing.tax), '']);
    rows.push(['Total', '', '', '', money(pricing.total), pricing.currency]);
  }
  if (takeoff.trim?.lines.length) {
    rows.push([]);
    rows.push(['Trim by wall face', 'Item', `Length (${lU})`, `Area (${aU})`, 'Estimate unit']);
    for (const l of takeoff.trim.lines) {
      rows.push([l.face, `${TRIM_CATEGORIES[l.category]?.label ?? 'Trim'} – ${profileLabel(l.profileId, l.size, u, l.category)}`, L(l.length), l.unit === 'lf' ? '' : A(l.area), l.unit]);
    }
  }
  return rows.map((r) => r.map(esc).join(',')).join('\n');
}

