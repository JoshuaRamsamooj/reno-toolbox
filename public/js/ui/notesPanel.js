// Side panel for notes (annotations): the kind, colour and size the Notes
// tool draws next, and the selected note's text, size, colour and border.
// Every edit is one app.change, so it is undoable.
import { ANNOTATION_COLORS, ANNOTATION_KINDS, annotationSizes, hasText } from '../core/annotations.js';
import { formatLength } from '../core/units.js';
import { checkbox, field, h, select } from './dom.js';

const SIZE_LABELS = { small: 'Small', medium: 'Medium', large: 'Large', huge: 'Huge' };
const COLOR_LABELS = { red: 'Red', blue: 'Blue', green: 'Green', orange: 'Orange', black: 'Black' };

/** Text size select: the standard sizes (with their height on the plan), plus the current one if it is another. */
function sizeSelect(units, value, onChange) {
  const sizes = annotationSizes(units);
  const options = Object.fromEntries(Object.entries(sizes).map(([k, mm]) => [String(mm), `${SIZE_LABELS[k]} (${formatLength(mm, units, { precision: 'label' })})`]));
  if (!options[String(value)]) options[String(value)] = formatLength(value, units, { precision: 'label' });
  return select(String(value), options, (v) => onChange(Number(v)));
}

function swatches(value, onPick) {
  return h('div', { class: 'note-swatches', role: 'group', 'aria-label': 'Colour' }, Object.entries(ANNOTATION_COLORS).map(([key, color]) => h('button', {
    class: `note-swatch${key === value ? ' active' : ''}`, style: `background:${color}`, title: COLOR_LABELS[key], 'aria-label': COLOR_LABELS[key], 'aria-pressed': String(key === value),
    onclick: () => key !== value && onPick(key),
  })));
}

/**
 * What the Notes tool draws next: the kind, and (with no note selected) the
 * colour and text size. A selected note's colour and size carry over to the next one.
 */
function drawPalette(app, withStyle) {
  const plan = app.plan;
  const u = app.design.units;
  const rerender = () => app.inspector.render();
  return [
    h('h3', {}, 'Draw'),
    h('div', { class: 'segmented note-kinds' }, Object.entries(ANNOTATION_KINDS).map(([key, label]) => h('button', {
      class: key === plan.noteKind ? 'active' : '', dataset: { kind: key }, onclick: () => { plan.noteKind = key; rerender(); },
    }, label))),
    withStyle ? field('Colour', swatches(plan.noteStyle.color, (c) => { plan.noteStyle.color = c; rerender(); })) : null,
    withStyle ? field('Text size', sizeSelect(u, plan.noteStyle.size ?? annotationSizes(u).medium, (mm) => { plan.noteStyle.size = mm; rerender(); })) : null,
    h('p', { class: 'muted small' },
      plan.noteKind === 'text' ? 'Click where the text goes, then type it here.'
        : plan.noteKind === 'callout' ? 'Press on the point to call out and drag to where the text goes (or just click), then type the text here.'
          : `Drag to draw ${{ arrow: 'an arrow (the head is where you let go)', line: 'a line', rect: 'a box', ellipse: 'an ellipse' }[plan.noteKind]}. Shift keeps it at 45° or square; Alt places it without snapping.`),
  ];
}

export function notesPanel(app, selection) {
  const d = app.design;
  const u = d.units;
  const drawing = app.plan.tool === 'annotate';
  const an = selection?.type === 'annotation' ? d.annotations.find((x) => x.id === selection.id) : null;
  if (!an) {
    return h('div', { class: 'panel' },
      h('h2', {}, 'Notes'),
      h('p', { class: 'muted small' }, 'Mark up the plan with text boxes, callouts, arrows, lines, boxes and ellipses. They are saved with the plan, sized to print at its scale, and stay put when walls move.'),
      ...drawPalette(app, true),
      d.annotations.length ? h('p', { class: 'muted small' }, `${d.annotations.length} note${d.annotations.length === 1 ? '' : 's'} on the plan · "Notes" in the bar above the plan shows or hides them.`) : null);
  }
  const edit = (label, fn) => app.change(label, (x) => {
    const n = x.annotations.find((y) => y.id === an.id);
    if (n) fn(n);
  });
  // The next note takes the colour and size last given to one.
  const style = (key, v) => { app.plan.noteStyle[key] = v; };
  const fields = [];
  if (hasText(an)) {
    const text = h('textarea', { class: 'note-input', rows: Math.max(2, an.text.split('\n').length + 1), 'aria-label': 'Note text' });
    text.value = an.text;
    text.addEventListener('change', () => {
      if (text.value !== an.text) edit('Note text', (n) => { n.text = text.value; });
    });
    // Ctrl+Enter (or leaving the box) saves; Enter alone starts a new line.
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) text.blur();
      if (e.key === 'Escape') {
        text.value = an.text;
        text.blur();
      }
    });
    fields.push(field('Text', text, 'Enter starts a new line; Ctrl+Enter or clicking away saves'));
    fields.push(field('Text size', sizeSelect(u, an.size, (mm) => {
      style('size', mm);
      edit('Note size', (n) => { n.size = mm; });
    })));
    fields.push(checkbox('Border round the text', an.box, (v) => edit(v ? 'Note border' : 'No note border', (n) => { n.box = v; })));
  }
  fields.push(field('Colour', swatches(an.color, (c) => {
    style('color', c);
    edit('Note colour', (n) => { n.color = c; });
  })));
  return h('div', { class: 'panel' },
    h('div', { class: 'panel-kicker' }, 'Note'),
    h('h2', {}, ANNOTATION_KINDS[an.kind]),
    ...fields,
    h('p', { class: 'muted small' }, an.kind === 'text' ? 'Drag the note to move it.' : 'Drag the note to move it, or its round handles to move an end.'),
    h('div', { class: 'button-row' },
      h('button', { onclick: () => app.select(null) }, 'Done'),
      h('button', { class: 'danger', onclick: () => app.deleteSelection() }, 'Delete')),
    drawing ? drawPalette(app, false) : null);
}
