import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpHttpClient, parseRpcBody, parseToolResult } from '../src/server/feeds/mcp-client.js';

type Handler = (body: { id?: number; method: string; params?: { name?: string } }, req: IncomingMessage, res: ServerResponse) => void;

async function fakeMcp(handle: Handler) {
  const seen: { method: string; auth?: string; session?: string }[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      seen.push({ method: body.method, auth: req.headers.authorization, session: req.headers['mcp-session-id'] as string | undefined });
      handle(body, req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const close = () => new Promise<void>((r) => {
    server.closeAllConnections();
    server.close(() => r());
  });
  return { url, seen, close };
}

const json = (res: ServerResponse, id: number | undefined, result: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(200, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
};
const toolText = (data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
/** A server that initializes with a session and answers tools/call with `rows`. */
const standard = (rows: unknown): Handler => (body, _req, res) => {
  if (body.method === 'initialize') return json(res, body.id, { protocolVersion: '2025-06-18', capabilities: {} }, { 'mcp-session-id': 's1' });
  if (body.method === 'notifications/initialized') return void res.writeHead(202).end();
  json(res, body.id, toolText(rows));
};

test('initializes once, sends the token and session, returns the rows', async (t) => {
  const mcp = await fakeMcp(standard([{ id: 1, title: 'a' }]));
  t.after(mcp.close);
  const client = new McpHttpClient(mcp.url, () => 'secret', 'TOKEN');
  assert.deepEqual(await client.call('get_tasks', { priority: 'critical' }), { rows: [{ id: 1, title: 'a' }], truncated: false });
  await client.call('get_tasks', {});
  assert.deepEqual(mcp.seen.map((s) => s.method), ['initialize', 'notifications/initialized', 'tools/call', 'tools/call']);
  assert.ok(mcp.seen.every((s) => s.auth === 'Bearer secret'));
  assert.equal(mcp.seen[2].session, 's1');
});

test('parses an SSE answer', async (t) => {
  const mcp = await fakeMcp((body, _req, res) => {
    if (body.method === 'notifications/initialized') return void res.writeHead(202).end();
    const result = body.method === 'initialize' ? { capabilities: {} } : toolText([{ id: 7 }]);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`);
  });
  t.after(mcp.close);
  assert.deepEqual((await new McpHttpClient(mcp.url, () => 't', 'T').call('x', {})).rows, [{ id: 7 }]);
});

test('a refused token is a clear error', async (t) => {
  const mcp = await fakeMcp((_b, _r, res) => void res.writeHead(401).end());
  t.after(mcp.close);
  await assert.rejects(new McpHttpClient(mcp.url, () => 'bad', 'T').call('x', {}), /refused the token \(HTTP 401\)/);
});

test('fails without a token and does not call the network', async (t) => {
  const mcp = await fakeMcp(standard([]));
  t.after(mcp.close);
  await assert.rejects(new McpHttpClient(mcp.url, () => undefined, 'INTELIMAIL_MCP_TOKEN').call('x', {}), /INTELIMAIL_MCP_TOKEN is not set/);
  assert.equal(mcp.seen.length, 0);
});

test('times out', async (t) => {
  const mcp = await fakeMcp(() => undefined);
  t.after(mcp.close);
  await assert.rejects(new McpHttpClient(mcp.url, () => 't', 'T', { timeoutMs: 200 }).call('x', {}), /timed out/);
});

test('re-initializes after the session expires', async (t) => {
  let expired = false;
  const base = standard([{ id: 1 }]);
  const mcp = await fakeMcp((body, req, res) => {
    if (body.method === 'tools/call' && !expired) {
      expired = true;
      return void res.writeHead(404).end();
    }
    base(body, req, res);
  });
  t.after(mcp.close);
  const client = new McpHttpClient(mcp.url, () => 't', 'T');
  await assert.rejects(client.call('x', {}), /session expired/);
  assert.deepEqual((await client.call('x', {})).rows, [{ id: 1 }]);
  assert.equal(mcp.seen.filter((s) => s.method === 'initialize').length, 2);
});

test('a redirect is not followed', async (t) => {
  const target = await fakeMcp(standard([{ id: 1 }]));
  t.after(target.close);
  const mcp = await fakeMcp((_b, _r, res) => void res.writeHead(302, { location: target.url }).end());
  t.after(mcp.close);
  await assert.rejects(new McpHttpClient(mcp.url, () => 't', 'T').call('x', {}), /redirected \(HTTP 302\), not followed/);
  assert.equal(target.seen.length, 0);
});

test('a name that resolves into a private network is refused before any request', async (t) => {
  const mcp = await fakeMcp(standard([{ id: 1 }]));
  t.after(mcp.close);
  const asked: string[] = [];
  const resolve = async (host: string) => {
    asked.push(host);
    return [{ address: '93.184.216.34' }, { address: '10.1.2.3' }];
  };
  const url = mcp.url.replace('127.0.0.1', 'mcp.example.com');
  await assert.rejects(new McpHttpClient(url, () => 't', 'T', { resolve }).call('x', {}), /mcp\.url resolves into a private network/);
  assert.deepEqual(asked, ['mcp.example.com']);
  assert.equal(mcp.seen.length, 0);
});

test('a name that resolves to loopback is allowed; an IP literal is not looked up', async (t) => {
  const mcp = await fakeMcp(standard([{ id: 1 }]));
  t.after(mcp.close);
  const asked: string[] = [];
  const resolve = async (host: string) => {
    asked.push(host);
    return [{ address: '127.0.0.1' }, { address: '::1' }];
  };
  assert.deepEqual((await new McpHttpClient(mcp.url, () => 't', 'T', { resolve }).call('x', {})).rows, [{ id: 1 }]);
  assert.deepEqual(asked, []);
  const byName = mcp.url.replace('127.0.0.1', 'localhost');
  assert.deepEqual((await new McpHttpClient(byName, () => 't', 'T', { resolve }).call('x', {})).rows, [{ id: 1 }]);
  assert.ok(asked.length > 0 && asked.every((h) => h === 'localhost'));
});

test('the address checked is the one connected to, so re-pointing the name is caught', async (t) => {
  const mcp = await fakeMcp(standard([{ id: 1 }]));
  t.after(mcp.close);
  // A rebinding DNS server: a harmless address at first, a private one afterwards.
  let answer = '127.0.0.1';
  const asked: string[] = [];
  const resolve = async (host: string) => {
    asked.push(host);
    return [{ address: answer }];
  };
  const client = new McpHttpClient(mcp.url.replace('127.0.0.1', 'rebind.example.com'), () => 't', 'T', { resolve });
  // The name reaches the fake server only through the resolver's answer, never through system DNS.
  assert.deepEqual((await client.call('x', {})).rows, [{ id: 1 }]);
  const before = mcp.seen.length;
  assert.equal(asked.length, before, 'every request looks the name up again');
  answer = '10.0.0.1';
  await assert.rejects(client.call('x', {}), /mcp\.url resolves into a private network/);
  assert.equal(mcp.seen.length, before);
});

test('parseRpcBody: JSON, SSE, wrong id, garbage', () => {
  assert.deepEqual(parseRpcBody('{"jsonrpc":"2.0","id":3,"result":1}', 'application/json', 3), { jsonrpc: '2.0', id: 3, result: 1 });
  assert.deepEqual(parseRpcBody('data: {"id":2,"result":0}\n\ndata: {"id":3,"result":5}\n', 'text/event-stream; charset=utf-8', 3), { id: 3, result: 5 });
  assert.throws(() => parseRpcBody('{"id":9,"result":1}', 'application/json', 3), /invalid response/);
  assert.throws(() => parseRpcBody('<html>', 'text/html', 3), /invalid response/);
});

test('parseToolResult: arrays, wrapped lists, tool errors, non-JSON', () => {
  assert.deepEqual(parseToolResult(toolText([{ a: 1 }, 'x', null])), { rows: [{ a: 1 }], truncated: false });
  assert.deepEqual(parseToolResult(toolText({ rows: [{ a: 1 }], truncated: true })), { rows: [{ a: 1 }], truncated: true });
  assert.throws(() => parseToolResult({ isError: true, content: [{ type: 'text', text: 'no such tool' }] }), /tool failed: no such tool/);
  assert.throws(() => parseToolResult({ content: [{ type: 'text', text: 'hello' }] }), /did not return JSON/);
  assert.throws(() => parseToolResult({ content: [{ type: 'text', text: '{"a":1}' }] }), /did not return a list/);
  assert.throws(() => parseToolResult({ content: [] }), /no text/);
});
