import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildColumn, fill, matches, parseDate, sortRows, type ColumnSpec } from '../src/server/feeds/columns.js';

const NOW = Date.parse('2026-10-06T12:00:00');
const spec = (over: Partial<ColumnSpec> = {}): ColumnSpec => ({
  title: 'Tasks', tool: 'get_tasks', args: {}, item: { id: '#{id}', title: '{title}', sub: '{assigned_to_name}' }, limit: 8, ...over,
});
const rows = [
  { id: 1, title: 'Late', deadline: '2026-07-31', priority: 'high', assigned_to_name: 'Tomáš', email: 'x@y.sk' },
  { id: 2, title: 'Soon', deadline: '2026-10-20', priority: 'critical', assigned_to_name: null },
  { id: 3, title: 'No date', deadline: null, priority: 'critical', assigned_to_name: 'Dano' },
  { id: 4, title: 'Older', deadline: '2026-05-29 10:00:00', priority: 'medium', assigned_to_name: 'Erik' },
];

test('parseDate reads dates and date-times, nothing else', () => {
  assert.equal(parseDate('2026-07-31'), Date.parse('2026-07-31T00:00:00'));
  assert.equal(parseDate('2026-05-29 10:00:00'), Date.parse('2026-05-29T10:00:00'));
  assert.equal(parseDate(null), undefined);
  assert.equal(parseDate('soon'), undefined);
  assert.equal(parseDate(20261006), undefined);
});

test('where: exact values, <now, >now, null never matches a date condition', () => {
  assert.equal(matches(rows[0], { priority: 'high' }, NOW), true);
  assert.equal(matches(rows[0], { priority: 'critical' }, NOW), false);
  assert.equal(matches(rows[0], { deadline: '<now' }, NOW), true);
  assert.equal(matches(rows[1], { deadline: '<now' }, NOW), false);
  assert.equal(matches(rows[1], { deadline: '>now' }, NOW), true);
  assert.equal(matches(rows[2], { deadline: '<now' }, NOW), false);
  assert.equal(matches(rows[2], { deadline: null }, NOW), true);
  assert.equal(matches(rows[0], { priority: 'high', deadline: '>now' }, NOW), false);
  assert.equal(matches(rows[0], undefined, NOW), true);
});

test('sort: ascending, descending with -, empty values last both ways', () => {
  assert.deepEqual(sortRows(rows, 'deadline').map((r) => r.id), [4, 1, 2, 3]);
  assert.deepEqual(sortRows(rows, '-deadline').map((r) => r.id), [2, 1, 4, 3]);
  assert.deepEqual(sortRows(rows, 'id').map((r) => r.id), [1, 2, 3, 4]);
  assert.deepEqual(sortRows(rows, undefined).map((r) => r.id), [1, 2, 3, 4]);
});

test('fill: templates, missing and null fields become empty', () => {
  assert.equal(fill('#{id} {title}', rows[0]), '#1 Late');
  assert.equal(fill('{assigned_to_name}', rows[1]), '');
  assert.equal(fill('{nope} x', rows[0]), 'x');
});

test('buildColumn filters, sorts, limits, maps only template fields', () => {
  const col = buildColumn(spec({ where: { deadline: '<now' }, sort: 'deadline', tone: 'warn' }), rows, NOW);
  assert.deepEqual(col, {
    title: 'Tasks',
    items: [
      { id: '#4', title: 'Older', sub: 'Erik', tone: 'warn' },
      { id: '#1', title: 'Late', sub: 'Tomáš', tone: 'warn' },
    ],
  });
  assert.ok(!JSON.stringify(col).includes('x@y.sk'));
});

test('buildColumn marks truncated past the limit or when the source says so', () => {
  assert.equal(buildColumn(spec({ limit: 2 }), rows, NOW).truncated, true);
  assert.equal(buildColumn(spec({ limit: 2 }), rows, NOW).items.length, 2);
  assert.equal(buildColumn(spec(), rows, NOW).truncated, undefined);
  assert.equal(buildColumn(spec(), rows, NOW, true).truncated, true);
  assert.equal(buildColumn(spec(), [{ id: 9, title: 'x' }], NOW).items[0].sub, undefined);
});
