// All geometry is stored in millimetres. These helpers convert to and from
// the user's chosen display system ('imperial' or 'metric').

export const MM_PER_IN = 25.4;
export const MM_PER_FT = 304.8;
export const MM2_PER_FT2 = MM_PER_FT * MM_PER_FT;
export const MM2_PER_M2 = 1e6;

function gcd(a, b) {
  return b ? gcd(b, a % b) : a;
}

/** Formats inches as e.g. 12' 6 1/2" (denominator controls fraction precision). */
function formatImperial(mm, denominator = 16) {
  const sign = mm < 0 ? '-' : '';
  const ticks = Math.round((Math.abs(mm) / MM_PER_IN) * denominator);
  const perFoot = 12 * denominator;
  const feet = Math.floor(ticks / perFoot);
  const rem = ticks - feet * perFoot;
  const whole = Math.floor(rem / denominator);
  let num = rem - whole * denominator;
  let den = denominator;
  if (num) {
    const g = gcd(num, den);
    num /= g;
    den /= g;
  }
  const inches = num ? (whole ? `${whole} ${num}/${den}` : `${num}/${den}`) : `${whole}`;
  return feet ? `${sign}${feet}' ${inches}"` : `${sign}${inches}"`;
}

function formatMetric(mm, decimals = 3) {
  const m = mm / 1000;
  let s = m.toFixed(decimals);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (!s.includes('.') || s.split('.')[1].length < 2) s = m.toFixed(2);
  return `${s} m`;
}

/**
 * Formats a length for display. opts.precision: 'fine' (inputs: 1/16", 1 mm)
 * or 'label' (plan annotations: 1/8", 1 cm).
 */
export function formatLength(mm, units, opts = {}) {
  if (mm == null || !Number.isFinite(mm)) return '';
  const fine = opts.precision !== 'label';
  return units === 'metric' ? formatMetric(mm, fine ? 3 : 2) : formatImperial(mm, fine ? 16 : 8);
}

/** Parses "6 1/2", "1/2", "6.5" → number, or NaN. */
function parseMixedNumber(s) {
  s = s.trim();
  if (!s) return NaN;
  let m = s.match(/^(\d+(?:\.\d+)?)\s+(\d+)\/(\d+)$/);
  if (m) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  m = s.match(/^(\d+)\/(\d+)$/);
  if (m) return Number(m[1]) / Number(m[2]);
  m = s.match(/^\d+(?:\.\d+)?$|^\.\d+$/);
  return m ? Number(s) : NaN;
}

function parseImperial(s) {
  s = s
    .replace(/[′’]/g, "'")
    .replace(/[″”]|''/g, '"')
    .replace(/\s*(feet|foot|ft)\.?/gi, "'")
    .replace(/\s*(inches|inch|in)\.?/gi, '"')
    .trim();
  let feet = 0;
  let inches = 0;
  if (s.includes("'")) {
    const [ft, rest = ''] = s.split("'");
    feet = parseMixedNumber(ft);
    const inchPart = rest.replace(/^[\s-]+/, '').replace(/"$/, '').trim();
    inches = inchPart ? parseMixedNumber(inchPart) : 0;
  } else if (s.endsWith('"')) {
    inches = parseMixedNumber(s.slice(0, -1));
  } else {
    // Bare numbers are feet: "12", "12.5", "12 6" (12' 6"), "12-6", "12 6 1/2".
    const m = s.match(/^(\d+(?:\.\d+)?)(?:\s*[-\s]\s*(.+))?$/);
    if (!m) return null;
    if (m[2] && /^\d+$/.test(m[1]) && /^\d+\/\d+$/.test(m[2].trim())) {
      feet = parseMixedNumber(`${m[1]} ${m[2]}`); // "12 1/2" → 12.5 ft
    } else {
      feet = Number(m[1]);
      inches = m[2] ? parseMixedNumber(m[2]) : 0;
    }
  }
  if (!Number.isFinite(feet) || !Number.isFinite(inches)) return null;
  return feet * MM_PER_FT + inches * MM_PER_IN;
}

/**
 * Parses a user-entered length into millimetres. Explicit units always win
 * (3.2m, 450mm, 12'6", 30in); bare numbers use the display system
 * (feet for imperial, metres for metric). Returns null when unparseable.
 */
export function parseLength(input, units) {
  if (input == null) return null;
  let s = String(input).trim().toLowerCase();
  if (!s) return null;
  const neg = s.startsWith('-');
  if (neg) s = s.slice(1).trim();
  let mm = null;
  const metric = s.match(/^(\d+(?:\.\d+)?|\.\d+)\s*(mm|cm|m)$/);
  if (metric) {
    const v = Number(metric[1]);
    mm = metric[2] === 'mm' ? v : metric[2] === 'cm' ? v * 10 : v * 1000;
  } else if (/['"′″’”]|ft|feet|foot|in/.test(s) || units !== 'metric') {
    mm = parseImperial(s);
  } else {
    const v = parseMixedNumber(s);
    mm = Number.isFinite(v) ? v * 1000 : null;
  }
  if (mm == null || !Number.isFinite(mm)) return null;
  return neg ? -mm : mm;
}

/** Parses "12x10", "12' x 10' 6\"", "3.6 x 4m" into [a, b] millimetres. */
export function parseDimensions(input, units) {
  const parts = String(input).split(/\s*[x×*,]\s*/i).filter(Boolean);
  if (parts.length !== 2) return null;
  const a = parseLength(parts[0], units);
  const b = parseLength(parts[1], units);
  return a != null && b != null ? [a, b] : null;
}

/**
 * Parses a signed level deviation such as "+4", "-6mm", "−3/16", "1/4\"",
 * "0.5cm" into millimetres. Explicit units win; bare numbers are read in
 * `readingUnit` ('mm' or 'in'). Returns null when unparseable.
 */
export function parseDeviation(input, readingUnit) {
  if (input == null) return null;
  let s = String(input).trim().toLowerCase().replace(/[−–]/g, '-').replace(/[″”]|''/g, '"');
  if (!s) return null;
  let sign = 1;
  if (s[0] === '+' || s[0] === '-') {
    sign = s[0] === '-' ? -1 : 1;
    s = s.slice(1).trim();
  }
  const m = s.match(/^(.+?)\s*(mm|cm|m|in|inch|inches|")?$/);
  if (!m) return null;
  const v = parseMixedNumber(m[1]);
  if (!Number.isFinite(v)) return null;
  const unit = m[2] ?? (readingUnit === 'in' ? 'in' : 'mm');
  const mm = unit === 'mm' ? v : unit === 'cm' ? v * 10 : unit === 'm' ? v * 1000 : v * MM_PER_IN;
  return sign * mm;
}

/**
 * Formats a deviation in mm ("+4 mm", "−6.5 mm") or 32nds of an inch
 * ("+3/16\"", "−1 1/4\""). opts.sign adds "+" to positive values;
 * opts.compact drops the " mm" suffix for plan labels.
 */
export function formatDeviation(mm, readingUnit, opts = {}) {
  if (mm == null || !Number.isFinite(mm)) return '';
  const neg = mm < 0;
  let body;
  if (readingUnit === 'in') {
    body = formatImperial(Math.abs(mm), 32);
  } else {
    const v = Math.round(Math.abs(mm) * 10) / 10;
    body = `${v.toFixed(v % 1 ? 1 : 0)}${opts.compact ? '' : ' mm'}`;
  }
  const zero = body === '0"' || /^0(\s|$)/.test(body);
  const sign = zero ? (opts.sign ? '±' : '') : neg ? '−' : opts.sign ? '+' : '';
  return `${sign}${body}`;
}

export function areaValue(mm2, units) {
  return units === 'metric' ? mm2 / MM2_PER_M2 : mm2 / MM2_PER_FT2;
}

export function areaUnit(units) {
  return units === 'metric' ? 'm²' : 'sq ft';
}

export function formatArea(mm2, units, decimals) {
  const v = areaValue(mm2, units);
  const d = decimals ?? (units === 'metric' ? 2 : 1);
  return `${v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })} ${areaUnit(units)}`;
}

/** Linear value in feet or metres. */
export function lengthValue(mm, units) {
  return units === 'metric' ? mm / 1000 : mm / MM_PER_FT;
}

export function lengthUnit(units) {
  return units === 'metric' ? 'm' : 'ft';
}

export function formatLinear(mm, units, decimals = 1) {
  const v = lengthValue(mm, units);
  return `${v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })} ${units === 'metric' ? 'm' : 'lf'}`;
}

/** Sensible defaults (mm) for new designs and openings in each system. */
export function unitDefaults(units) {
  if (units === 'metric') {
    return {
      wallThickness: 115,
      ceilingHeight: 2400,
      door: { width: 820, height: 2040, sill: 0 },
      window: { width: 1200, height: 1200, sill: 900 },
      opening: { width: 900, height: 2040, sill: 0 },
      gridSnap: 50,
    };
  }
  return {
    wallThickness: 4.5 * MM_PER_IN,
    ceilingHeight: 8 * MM_PER_FT,
    door: { width: 32 * MM_PER_IN, height: 80 * MM_PER_IN, sill: 0 },
    window: { width: 36 * MM_PER_IN, height: 48 * MM_PER_IN, sill: 36 * MM_PER_IN },
    opening: { width: 36 * MM_PER_IN, height: 80 * MM_PER_IN, sill: 0 },
    gridSnap: 3 * MM_PER_IN,
  };
}
