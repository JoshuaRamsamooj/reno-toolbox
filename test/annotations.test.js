import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDesign, migrateDesign } from '../public/js/core/model.js';
import {
  annotationAt, annotationBounds, annotationHit, calloutAnchor, deleteAnnotation, handleAt, makeAnnotation, sanitizeAnnotations, textBlock,
} from '../public/js/core/annotations.js';
import { MM_PER_IN } from '../public/js/core/units.js';

const IN = MM_PER_IN;

test('notes are saved with the plan; malformed ones are dropped on load', () => {
  const d = createDesign('imperial');
  assert.deepEqual(d.annotations, []);
  d.annotations.push(makeAnnotation('text', { x: 0, y: 0 }, null, { text: 'Remove wall' }));
  d.annotations.push(makeAnnotation('arrow', { x: 0, y: 0 }, { x: 1000, y: 0 }, { color: 'blue' }));
  const back = migrateDesign(JSON.parse(JSON.stringify({ ...d, annotations: [...d.annotations, { id: 'x', kind: 'arrow', a: { x: 0, y: 0 } }, { id: 'y', kind: 'star', a: { x: 0, y: 0 } }] })));
  assert.equal(back.annotations.length, 2);
  assert.equal(back.annotations[0].text, 'Remove wall');
  assert.equal(back.annotations[0].box, true);
  assert.equal(back.annotations[1].color, 'blue');
  assert.equal(sanitizeAnnotations([{ id: 'z', kind: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 1 }, color: 'pink' }])[0].color, 'red');
  // Older plans without notes load with none.
  const { annotations, ...old } = d;
  assert.deepEqual(migrateDesign(old).annotations, []);
  deleteAnnotation(back, back.annotations[0].id);
  assert.equal(back.annotations.length, 1);
});

test('text boxes grow with their text; callouts lead from the side nearest their point', () => {
  const an = makeAnnotation('text', { x: 0, y: 0 }, null, { text: 'Two\nlines here', size: 10 * IN });
  const t = textBlock(an);
  assert.deepEqual(t.lines, ['Two', 'lines here']);
  assert.ok(t.w > 10 * 0.6 * 10 * IN);
  assert.ok(Math.abs(t.h - (2 * 12.5 * IN + 2 * t.pad)) < 0.01);
  const b = annotationBounds(an);
  assert.ok(b.maxX > b.minX && b.maxY > b.minY);

  const right = makeAnnotation('callout', { x: 0, y: 0 }, { x: 5000, y: 50 }, { text: 'Note', size: 200 });
  const anchor = calloutAnchor(right);
  assert.ok(Math.abs(anchor.x - (textBlock(right).x + textBlock(right).w)) < 0.01);
  const below = makeAnnotation('callout', { x: 0, y: 0 }, { x: 100, y: 5000 }, { text: 'Note', size: 200 });
  assert.ok(Math.abs(calloutAnchor(below).y - textBlock(below).h) < 0.01);
});

test('picking notes: text blocks, lines and the outlines of boxes and ellipses', () => {
  const tol = 10;
  const text = makeAnnotation('text', { x: 0, y: 0 }, null, { text: 'Hello', size: 200 });
  assert.ok(annotationHit(text, { x: 50, y: 50 }, tol));
  assert.ok(!annotationHit(text, { x: 5000, y: 50 }, tol));
  const line = makeAnnotation('line', { x: 0, y: 0 }, { x: 1000, y: 0 });
  assert.ok(annotationHit(line, { x: 500, y: 5 }, tol));
  assert.ok(!annotationHit(line, { x: 500, y: 50 }, tol));
  const box = makeAnnotation('rect', { x: 0, y: 0 }, { x: 1000, y: 1000 });
  assert.ok(annotationHit(box, { x: 1000, y: 500 }, tol));
  assert.ok(!annotationHit(box, { x: 500, y: 500 }, tol)); // the inside of a box is the drawing underneath
  const ellipse = makeAnnotation('ellipse', { x: 0, y: 0 }, { x: 2000, y: 1000 });
  assert.ok(annotationHit(ellipse, { x: 2000, y: 500 }, tol));
  assert.ok(annotationHit(ellipse, { x: 1000, y: 0 }, tol));
  assert.ok(!annotationHit(ellipse, { x: 1000, y: 500 }, tol));
  // The note drawn last is on top.
  const under = makeAnnotation('rect', { x: 0, y: 0 }, { x: 1000, y: 1000 });
  const over = makeAnnotation('line', { x: 0, y: 0 }, { x: 1000, y: 0 });
  assert.equal(annotationAt([under, over], { x: 500, y: 0 }, tol), over);
  // End handles: arrows and boxes have two, a text box none.
  assert.equal(handleAt(line, { x: 1003, y: 0 }, tol), 'b');
  assert.equal(handleAt(text, { x: 0, y: 0 }, tol), null);
});
