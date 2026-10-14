import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLength, parseDimensions, parseLength, MM_PER_FT, MM_PER_IN } from '../public/js/core/units.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `expected ${a} ≈ ${b}`);

test('parses imperial lengths in common notations', () => {
  const cases = {
    "12'": 12 * MM_PER_FT,
    "12' 6\"": 12 * MM_PER_FT + 6 * MM_PER_IN,
    "12'6": 12 * MM_PER_FT + 6 * MM_PER_IN,
    "12'-6 1/2\"": 12 * MM_PER_FT + 6.5 * MM_PER_IN,
    '12 6': 12 * MM_PER_FT + 6 * MM_PER_IN,
    '12-6': 12 * MM_PER_FT + 6 * MM_PER_IN,
    '12': 12 * MM_PER_FT,
    '12.5': 12.5 * MM_PER_FT,
    '12 1/2': 12.5 * MM_PER_FT,
    '30"': 30 * MM_PER_IN,
    '30 in': 30 * MM_PER_IN,
    '3/4"': 0.75 * MM_PER_IN,
    '10 ft': 10 * MM_PER_FT,
    '2.4m': 2400,
  };
  for (const [input, mm] of Object.entries(cases)) near(parseLength(input, 'imperial'), mm);
});

test('parses metric lengths', () => {
  near(parseLength('3.6', 'metric'), 3600);
  near(parseLength('3600mm', 'metric'), 3600);
  near(parseLength('360 cm', 'metric'), 3600);
  near(parseLength("12'", 'metric'), 12 * MM_PER_FT);
  assert.equal(parseLength('abc', 'metric'), null);
  assert.equal(parseLength('', 'imperial'), null);
});

test('formats lengths', () => {
  assert.equal(formatLength(12 * MM_PER_FT + 6.5 * MM_PER_IN, 'imperial'), `12' 6 1/2"`);
  assert.equal(formatLength(8 * MM_PER_IN, 'imperial'), '8"');
  assert.equal(formatLength(10 * MM_PER_FT, 'imperial'), `10' 0"`);
  assert.equal(formatLength(3658, 'metric'), '3.658 m');
  assert.equal(formatLength(3500, 'metric'), '3.50 m');
  assert.equal(formatLength(3658, 'metric', { precision: 'label' }), '3.66 m');
  const mm = 7 * MM_PER_FT + 3.25 * MM_PER_IN;
  near(parseLength(formatLength(mm, 'imperial'), 'imperial'), mm);
});

test('parses dimension pairs', () => {
  const [a, b] = parseDimensions("12x10'6\"", 'imperial');
  near(a, 12 * MM_PER_FT);
  near(b, 10.5 * MM_PER_FT);
  assert.deepEqual(parseDimensions('3.6 x 4', 'metric'), [3600, 4000]);
  assert.equal(parseDimensions('12', 'imperial'), null);
});
