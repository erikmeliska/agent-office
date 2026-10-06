import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Feeds } from '../src/server/feeds/index.js';
import type { McpCaller } from '../src/server/feeds/mcp-client.js';
import type { BoardFeed, WorkerInfo } from '../src/shared/protocol.js';

const CONFIG = {
  boards: {
    issues: {
      type: 'mcp', title: 'Hot', refreshSec: 60, mcp: { url: 'https://example.com/mcp', tokenEnv: 'AGENT_OFFICE_MCP_T' },
      columns: [
        { title: 'Critical', tool: 'get_tasks', item: { id: '#{id}', title: '{title}' } },
        { title: 'Tickets', tool: 'search_tickets', item: { id: 'T{id}', title: '{subject}' } },
      ],
    },
    pulls: { type: 'activity', title: 'Agents', now: 'Teraz', recent: 'Nedávno' },
  },
};

/** `null` config: the checkout has no agent-office.boards.json. */
function floor(config: unknown = CONFIG, caller?: McpCaller) {
  const dir = mkdtempSync(path.join(tmpdir(), 'feeds-floor-'));
  const dataDir = path.join(dir, '.agent-office');
  mkdirSync(dataDir);
  if (config !== null) writeFileSync(path.join(dir, 'agent-office.boards.json'), typeof config === 'string' ? config : JSON.stringify(config));
  const sent: BoardFeed[][] = [];
  const workers: WorkerInfo[] = [];
  const feeds = new Feeds(dir, dataDir, { send: (f) => sent.push(f), workers: () => workers, watched: () => true }, {
    caller: () => caller ?? { call: async (tool) => ({ rows: tool === 'get_tasks' ? [{ id: 1, title: 'Fix' }] : [{ id: 9, subject: 'Help' }], truncated: false }) },
  });
  return { feeds, sent, workers };
}

test('no config: no feeds, nothing sent', async (t) => {
  const { feeds, sent } = floor(null);
  t.after(() => feeds.stop());
  await feeds.settled();
  assert.deepEqual(feeds.state(), []);
  assert.equal(sent.length, 0);
});

test('an MCP board loads its columns and publishes them', async (t) => {
  const { feeds, sent } = floor();
  t.after(() => feeds.stop());
  await feeds.settled();
  const hot = feeds.state().find((f) => f.slot === 'issues')!;
  assert.deepEqual(hot.columns, [
    { title: 'Critical', items: [{ id: '#1', title: 'Fix' }] },
    { title: 'Tickets', items: [{ id: 'T9', title: 'Help' }] },
  ]);
  assert.ok(hot.updatedAt > 0);
  assert.equal(hot.error, undefined);
  assert.ok(sent.length >= 1);
});

test('a failing column keeps its last items and reports the error; the others still load', async (t) => {
  let fail = false;
  const caller: McpCaller = {
    call: async (tool) => {
      if (fail && tool === 'search_tickets') throw new Error('refused the token (HTTP 401)');
      return { rows: tool === 'get_tasks' ? [{ id: fail ? 2 : 1, title: 'Fix' }] : [{ id: 9, subject: 'Help' }], truncated: false };
    },
  };
  const { feeds } = floor(CONFIG, caller);
  t.after(() => feeds.stop());
  await feeds.settled();
  fail = true;
  await feeds.refreshAll();
  const hot = feeds.state().find((f) => f.slot === 'issues')!;
  assert.equal(hot.columns[0].items[0].id, '#2');
  assert.deepEqual(hot.columns[1].items, [{ id: 'T9', title: 'Help' }]);
  assert.match(hot.error ?? '', /Tickets: refused the token/);
});

test('when every column fails, updatedAt stays at the last success', async (t) => {
  let fail = false;
  const caller: McpCaller = { call: async () => { if (fail) throw new Error('timed out'); return { rows: [], truncated: false }; } };
  const { feeds } = floor(CONFIG, caller);
  t.after(() => feeds.stop());
  await feeds.settled();
  const before = feeds.state().find((f) => f.slot === 'issues')!.updatedAt;
  fail = true;
  await feeds.refreshAll();
  const hot = feeds.state().find((f) => f.slot === 'issues')!;
  assert.equal(hot.updatedAt, before);
  assert.match(hot.error ?? '', /timed out/);
});

test('a broken config shows as an error on its slot', async (t) => {
  const { feeds } = floor({ boards: { issues: { type: 'mcp', title: 'x' } } });
  t.after(() => feeds.stop());
  const [f] = feeds.state();
  assert.equal(f.slot, 'issues');
  assert.match(f.error ?? '', /agent-office.boards.json › issues/);
});

test('activity: desks now, and a worker that goes home lands in the log', async (t) => {
  const { feeds, workers, sent } = floor();
  t.after(() => feeds.stop());
  const ada: WorkerInfo = { id: 'a', kind: 'agent', deskId: 'desk-1', name: 'Ada', color: '#fff', status: 'working', acked: false, createdBy: 'e', createdAt: 0, cols: 80, rows: 24, viewers: [], viewerIds: [], task: { name: 'Support #82', summary: '' } };
  workers.push(ada);
  feeds.onWorker();
  let act = feeds.state().find((f) => f.slot === 'pulls')!;
  assert.deepEqual(act.columns[0].items.map((i) => i.title), ['Support #82']);
  const before = sent.length;
  feeds.onWorker();
  assert.equal(sent.length, before, 'nothing changed, nothing sent');
  workers.pop();
  feeds.onWorkerGone(ada);
  act = feeds.state().find((f) => f.slot === 'pulls')!;
  assert.deepEqual(act.columns[0].items, []);
  assert.deepEqual(act.columns[1].items.map((i) => [i.id, i.title]), [['Ada', 'Support #82']]);
});

test('does not publish after stop', async () => {
  // One call per column, each held until released.
  const held: (() => void)[] = [];
  const slow: McpCaller = { call: () => new Promise((r) => { held.push(() => r({ rows: [{ id: 1, title: 'x' }], truncated: false })); }) };
  const { feeds, sent } = floor(CONFIG, slow);
  const count = sent.length;
  feeds.stop();
  for (const release of held) release();
  await feeds.settled();
  assert.equal(sent.length, count);
});
