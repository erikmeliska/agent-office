// Just enough of an MCP client (Streamable HTTP) for a feed board: initialize once per session, then
// tools/call. Answers come as JSON or as server-sent events; a tool's answer is text holding a JSON list.
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Row } from './columns.js';
import { isPrivateIp } from './config.js';

export interface McpCaller {
  call(tool: string, args: Record<string, unknown>): Promise<{ rows: Row[]; truncated: boolean }>;
}

export class McpError extends Error {}

/** Every address a hostname resolves to; dns by default, swapped out in tests. */
export type Resolver = (hostname: string) => Promise<{ address: string }[]>;
const resolveAll: Resolver = (hostname) => dnsLookup(hostname, { all: true });

export interface McpClientOptions {
  timeoutMs?: number;
  resolve?: Resolver;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const PROTOCOL = '2025-06-18';

/** The JSON-RPC answer with `id`, from a JSON body or from an event stream's `data:` lines. */
export function parseRpcBody(text: string, contentType: string, id: number): { result?: unknown; error?: { code: number; message: string } } {
  const candidates = contentType.includes('text/event-stream')
    ? text.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())
    : [text];
  for (const c of candidates) {
    let m: unknown;
    try {
      m = JSON.parse(c);
    } catch {
      continue;
    }
    if (isObj(m) && m.id === id) return m as { result?: unknown; error?: { code: number; message: string } };
  }
  throw new McpError('invalid response (not JSON-RPC)');
}

/** A tool's answer: text with a JSON list, or an object with the list under rows/items/results/data. */
export function parseToolResult(result: unknown): { rows: Row[]; truncated: boolean } {
  const r = isObj(result) ? result : {};
  const content = Array.isArray(r.content) ? r.content : [];
  const text = content.find((c): c is { type: 'text'; text: string } => isObj(c) && c.type === 'text' && typeof c.text === 'string')?.text;
  if (r.isError === true) throw new McpError(`tool failed: ${(text ?? '').slice(0, 200)}`);
  if (text === undefined) throw new McpError('tool returned no text');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new McpError('tool did not return JSON');
  }
  if (Array.isArray(data)) return { rows: data.filter(isObj), truncated: false };
  if (isObj(data)) {
    for (const k of ['rows', 'items', 'results', 'data']) {
      const list = data[k];
      if (Array.isArray(list)) return { rows: list.filter(isObj), truncated: data.truncated === true };
    }
  }
  throw new McpError('tool did not return a list');
}

export class McpHttpClient implements McpCaller {
  private session?: string;
  private ready?: Promise<void>;
  private nextId = 1;
  private timeoutMs: number;
  private resolve: Resolver;

  constructor(
    private url: string,
    private token: () => string | undefined,
    private tokenEnv: string,
    opts: McpClientOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.resolve = opts.resolve ?? resolveAll;
  }

  async call(tool: string, args: Record<string, unknown>): Promise<{ rows: Row[]; truncated: boolean }> {
    const token = this.token();
    if (!token) throw new McpError(`${this.tokenEnv} is not set in the office's environment`);
    this.ready ??= this.initialize(token).catch((e) => {
      this.ready = undefined;
      throw e;
    });
    await this.ready;
    return parseToolResult(await this.rpc('tools/call', { name: tool, arguments: args }, token));
  }

  private async initialize(token: string) {
    this.session = undefined;
    await this.rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'agent-office', version: '1' } }, token);
    try {
      await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, token);
    } catch {
      // A server that doesn't take the notification still answers tools/call.
    }
  }

  /** config.ts refused private IP literals in the URL; a name has to be resolved before each request. */
  private async checkHost() {
    const host = new URL(this.url).hostname.replace(/^\[|\]$/g, '');
    if (isIP(host)) return;
    const addrs = await this.resolve(host);
    if (addrs.some((a) => isPrivateIp(a.address))) throw new McpError('mcp.url resolves into a private network');
  }

  private async post(body: object, token: string) {
    await this.checkHost();
    const res = await fetch(this.url, {
      method: 'POST',
      // A redirect could lead into the private network, so none is followed.
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
        'mcp-protocol-version': PROTOCOL,
        ...(this.session ? { 'mcp-session-id': this.session } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, text: await res.text() };
  }

  private async rpc(method: string, params: object, token: string): Promise<unknown> {
    const id = this.nextId++;
    let r: Awaited<ReturnType<McpHttpClient['post']>>;
    try {
      r = await this.post({ jsonrpc: '2.0', id, method, params }, token);
    } catch (e) {
      if (e instanceof McpError) throw e;
      const err = e as Error;
      throw new McpError(err.name === 'TimeoutError' || err.name === 'AbortError' ? 'timed out' : `unreachable (${err.message})`);
    }
    if (r.status === 401 || r.status === 403) throw new McpError(`refused the token (HTTP ${r.status})`);
    if (r.status === 404 && this.session) {
      this.session = undefined;
      this.ready = undefined;
      throw new McpError('session expired');
    }
    if (r.status >= 300 && r.status < 400) throw new McpError(`redirected (HTTP ${r.status}), not followed`);
    if (r.status < 200 || r.status >= 300) throw new McpError(`HTTP ${r.status}`);
    const sid = r.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    const msg = parseRpcBody(r.text, r.headers.get('content-type') ?? '', id);
    if (msg.error) throw new McpError(`error ${msg.error.code}: ${msg.error.message}`);
    return msg.result;
  }
}
