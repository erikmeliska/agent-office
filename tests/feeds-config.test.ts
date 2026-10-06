import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CONFIG_FILE, loadConfig, parseConfig, urlProblem } from '../src/server/feeds/config.js';

const column = { title: 'Critical', tool: 'get_tasks', args: { priority: 'critical' }, item: { id: '#{id}', title: '{title}' } };
const mcp = (over: object = {}) => ({ type: 'mcp', title: '🔥 Hot', mcp: { url: 'https://example.com/api/mcp', tokenEnv: 'AGENT_OFFICE_MCP_EXAMPLE' }, columns: [column], ...over });

test('a valid config: defaults filled in', () => {
  const r = parseConfig({ boards: { issues: mcp(), pulls: { type: 'activity', title: '🤖 Agents' } } });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.boards, [
    { type: 'mcp', slot: 'issues', title: '🔥 Hot', url: 'https://example.com/api/mcp', tokenEnv: 'AGENT_OFFICE_MCP_EXAMPLE', refreshSec: 120,
      columns: [{ title: 'Critical', tool: 'get_tasks', args: { priority: 'critical' }, item: { id: '#{id}', title: '{title}' }, limit: 8 }] },
    { type: 'activity', slot: 'pulls', title: '🤖 Agents', now: 'Now', recent: 'Recent' },
  ]);
});

test('activity board column titles can be renamed', () => {
  const r = parseConfig({ boards: { pulls: { type: 'activity', title: 'A', now: 'Teraz', recent: 'Nedávno' } } });
  assert.deepEqual(r.boards[0], { type: 'activity', slot: 'pulls', title: 'A', now: 'Teraz', recent: 'Nedávno' });
});

test('no file means no boards and no errors', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'feeds-config-'));
  assert.deepEqual(loadConfig(dir), { boards: [], errors: [] });
});

test('broken JSON is one error without a slot', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'feeds-config-'));
  writeFileSync(path.join(dir, CONFIG_FILE), '{ nope');
  const r = loadConfig(dir);
  assert.equal(r.boards.length, 0);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].slot, undefined);
  assert.match(r.errors[0].error, /invalid JSON/);
});

test('each bad board is an error for its slot; good boards still load', () => {
  const r = parseConfig({
    boards: {
      issues: mcp({ refreshSec: 10 }),
      pulls: { type: 'activity', title: 'ok' },
      queue: { type: 'activity', title: 'no' },
    },
  });
  assert.deepEqual(r.boards.map((b) => b.slot), ['pulls']);
  assert.deepEqual(r.errors.map((e) => e.slot), ['issues', undefined]);
  assert.match(r.errors[0].error, /refreshSec/);
  assert.match(r.errors[1].error, /unknown board "queue"/);
});

test('rejects a wrong type, a missing title, bad columns and items', () => {
  const bad = (b: object) => parseConfig({ boards: { issues: b } }).errors[0]?.error ?? '';
  assert.match(bad({ type: 'rss', title: 'x' }), /type must be/);
  assert.match(bad(mcp({ title: '' })), /title/);
  assert.match(bad(mcp({ columns: [] })), /1 to 4 columns/);
  assert.match(bad(mcp({ columns: [column, column, column, column, column] })), /1 to 4 columns/);
  assert.match(bad(mcp({ columns: [{ ...column, item: { id: '#{id}' } }] })), /"item" needs/);
  assert.match(bad(mcp({ columns: [{ ...column, limit: 50 }] })), /limit/);
  assert.match(bad(mcp({ columns: [{ ...column, tone: 'red' }] })), /tone/);
  assert.match(bad(mcp({ columns: [{ ...column, where: { deadline: ['<now'] } }] })), /where/);
  assert.match(bad(mcp({ mcp: { url: 'https://example.com', tokenEnv: 'not a name' } })), /tokenEnv/);
});

test('tokenEnv may only name a token set aside for boards', () => {
  const bad = (tokenEnv: string) => parseConfig({ boards: { issues: mcp({ mcp: { url: 'https://example.com', tokenEnv } }) } }).errors[0]?.error ?? '';
  assert.equal(bad('AGENT_OFFICE_MCP_INTELIMAIL'), '');
  assert.match(bad('GITHUB_TOKEN'), /AGENT_OFFICE_MCP_/);
  assert.match(bad('ANTHROPIC_API_KEY'), /AGENT_OFFICE_MCP_/);
  assert.match(bad('AGENT_OFFICE_MCP_'), /AGENT_OFFICE_MCP_/);
  assert.match(bad('agent_office_mcp_x'), /AGENT_OFFICE_MCP_/);
});

test('urlProblem: no private-network addresses, loopback still fine', () => {
  for (const url of ['https://10.0.0.5/mcp', 'https://172.16.1.1/mcp', 'https://192.168.1.10/mcp', 'https://169.254.169.254/latest',
    'https://100.64.0.1/', 'https://0.0.0.0/', 'https://[fd00::1]/mcp', 'https://[fe80::1]/', 'https://[::ffff:10.0.0.1]/', 'https://0x0a000001/']) {
    assert.match(urlProblem(url) ?? '', /private network/, url);
  }
  assert.equal(urlProblem('https://127.0.0.1:8443/mcp'), undefined);
  assert.equal(urlProblem('https://[::1]/mcp'), undefined);
  assert.equal(urlProblem('https://8.8.8.8/mcp'), undefined);
});

test('urlProblem: https anywhere, http only on loopback', () => {
  assert.equal(urlProblem('https://admin.inteli.services/api/mcp'), undefined);
  assert.equal(urlProblem('http://localhost:3000/mcp'), undefined);
  assert.equal(urlProblem('http://127.0.0.1:3000/mcp'), undefined);
  assert.match(urlProblem('http://example.com/mcp') ?? '', /https/);
  assert.match(urlProblem('ftp://example.com') ?? '', /https/);
  assert.match(urlProblem('nope') ?? '', /not a URL/);
});
