import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ACTIVITY_MAX, ActivityLog, activityColumns, taskOf, toneOf } from '../src/server/feeds/activity.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

const worker = (over: Partial<WorkerInfo>): WorkerInfo => ({
  id: 'w', kind: 'agent', deskId: 'desk-1', name: 'Ada', color: '#fff', status: 'working', acked: false,
  createdBy: 'erik', createdAt: 0, cols: 80, rows: 24, viewers: [], viewerIds: [], ...over,
});
const dir = () => mkdtempSync(path.join(tmpdir(), 'feeds-activity-'));
const TITLES = { now: 'Teraz', recent: 'Nedávno' };

test('taskOf: the task card, else the prompt cut short, else a dash', () => {
  assert.equal(taskOf(worker({ task: { name: 'Fix login', summary: '…' } })), 'Fix login');
  assert.equal(taskOf(worker({ prompt: `  Pokračuj\n na tasku #145 ${'x'.repeat(100)}` })).length, 80);
  assert.ok(taskOf(worker({ prompt: 'Pokračuj\n na tasku #145' })).startsWith('Pokračuj na tasku #145'));
  assert.equal(taskOf(worker({})), '—');
});

test('toneOf: waiting on someone is hot, working is warn, the rest ok', () => {
  assert.equal(toneOf('needs_input'), 'hot');
  assert.equal(toneOf('working'), 'warn');
  assert.equal(toneOf('starting'), 'warn');
  assert.equal(toneOf('done'), 'ok');
  assert.equal(toneOf('offline'), 'ok');
});

test('columns: desks now (no board agents, no shells), then the log', () => {
  const cols = activityColumns(
    [
      worker({ id: 'a', name: 'Ada', status: 'needs_input', task: { name: 'Support #82', summary: '' } }),
      worker({ id: 'k', name: 'Kiosk', deskId: 'station-issues' }),
      worker({ id: 's', name: 'Shell', kind: 'shell' }),
    ],
    [{ name: 'Bob', task: 'Nástenka', endedAt: 1_000 }],
    TITLES,
    1_000 + 5 * 60_000,
  );
  assert.equal(cols[0].title, 'Teraz');
  assert.deepEqual(cols[0].items.map((i) => [i.id, i.title, i.tone]), [['Ada', 'Support #82', 'hot']]);
  assert.equal(cols[1].title, 'Nedávno');
  assert.deepEqual(cols[1].items, [{ id: 'Bob', title: 'Nástenka', sub: '5m ago', tone: 'ok' }]);
});

test('the log keeps the newest 30 and survives a restart', () => {
  const d = dir();
  const log = new ActivityLog(d);
  for (let i = 0; i < ACTIVITY_MAX + 5; i++) log.add({ name: `w${i}`, task: 't', endedAt: i });
  assert.equal(log.list().length, ACTIVITY_MAX);
  assert.equal(log.list()[0].name, `w${ACTIVITY_MAX + 4}`);
  assert.equal(new ActivityLog(d).list().length, ACTIVITY_MAX);
  assert.ok(JSON.parse(readFileSync(path.join(d, 'activity.json'), 'utf8')).length === ACTIVITY_MAX);
});

test('starts empty from a corrupt file', () => {
  const d = dir();
  writeFileSync(path.join(d, 'activity.json'), '{ not json');
  assert.deepEqual(new ActivityLog(d).list(), []);
  writeFileSync(path.join(d, 'activity.json'), JSON.stringify([{ name: 'ok', task: 't', endedAt: 1 }, { name: 3 }]));
  assert.deepEqual(new ActivityLog(d).list(), [{ name: 'ok', task: 't', endedAt: 1 }]);
});
