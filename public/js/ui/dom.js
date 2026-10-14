// Minimal DOM builder and form controls shared by the side panels.
import { formatLength, parseLength } from '../core/units.js';

/** h('div', {class: 'x', onclick}, child, 'text', [more]) */
export function h(tagName, props = {}, ...children) {
  const el = document.createElement(tagName);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function field(label, control, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hint ? h('span', { class: 'field-hint' }, hint) : null);
}

/**
 * Text input that accepts any length notation and commits millimetres.
 * `value` may be null (shows placeholder, e.g. an inherited default).
 */
export function lengthInput(value, units, onCommit, { placeholder, allowEmpty = false, min = 0, name } = {}) {
  const input = h('input', {
    type: 'text', class: 'length-input', value: value == null ? '' : formatLength(value, units),
    placeholder: placeholder ?? '', spellcheck: false, autocomplete: 'off', name,
  });
  const commit = () => {
    const raw = input.value.trim();
    if (!raw && allowEmpty) {
      input.classList.remove('invalid');
      if (value != null) onCommit(null);
      return;
    }
    const mm = parseLength(raw, units);
    if (mm == null || mm < min) {
      input.classList.add('invalid');
      input.title = units === 'metric' ? 'Try 2.4, 2400mm or 240cm' : `Try 8', 8' 6", 96" or 8 6`;
      return;
    }
    input.classList.remove('invalid');
    if (value == null || Math.abs(mm - value) > 0.01) onCommit(mm);
    else input.value = formatLength(value, units);
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') {
      input.value = value == null ? '' : formatLength(value, units);
      input.classList.remove('invalid');
      input.blur();
    }
  });
  return input;
}

export function numberInput(value, onCommit, { min, max, step = 1, suffix } = {}) {
  const input = h('input', { type: 'number', value, min, max, step });
  input.addEventListener('change', () => {
    const v = Number(input.value);
    if (Number.isFinite(v)) onCommit(v);
  });
  return suffix ? h('span', { class: 'with-suffix' }, input, h('span', {}, suffix)) : input;
}

export function select(value, options, onChange) {
  const el = h('select', {}, Object.entries(options).map(([k, label]) => h('option', { value: k, selected: k === value }, label)));
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

export function checkbox(label, checked, onChange) {
  const input = h('input', { type: 'checkbox', checked });
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'check' }, input, h('span', {}, label));
}

export function svgEl(markup) {
  const tpl = document.createElement('template');
  tpl.innerHTML = markup.trim();
  return tpl.content.firstElementChild;
}
