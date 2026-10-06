// Just enough of an MCP client (Streamable HTTP) for a feed board: initialize once per session, then
// tools/call. Answers come as JSON or as server-sent events; a tool's answer is text holding a JSON list.
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import type { LookupAddress } from 'node:dns';
import type { Row } from './columns.js';
import { isLoopbackIp, isPrivateIp, LOOPBACK } from './config.js';

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
  /** URL host names allowed to resolve to loopback; LOOPBACK by default, widened in tests. */
  loopbackHosts?: ReadonlySet<string>;
  /** The most an answer may hold, in bytes. */
  maxBytes?: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const PROTOCOL = '2025-06-18';
const MAX_BYTES = 4 * 1024 * 1024;

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
  private loopbackOk: boolean;
  private maxBytes: number;

  constructor(
    private url: string,
    private token: () => string | undefined,
    private tokenEnv: string,
    opts: McpClientOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.resolve = opts.resolve ?? resolveAll;
    this.loopbackOk = (opts.loopbackHosts ?? LOOPBACK).has(new URL(url).hostname);
    this.maxBytes = opts.maxBytes ?? MAX_BYTES;
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

  /**
   * The connection's own DNS lookup, refusing a name with any address in a private network, or on
   * loopback unless the URL literally names localhost. The address checked is the one connected to,
   * so a name can't be re-pointed between check and request.
   * (config.ts already refused IP literals in the URL, and those never come through here.)
   */
  private lookup: LookupFunction = (hostname, options, cb) => {
    this.resolve(hostname).then(
      (addrs) => {
        const refused = (ip: string) => isPrivateIp(ip) || (!this.loopbackOk && isLoopbackIp(ip));
        if (addrs.some((a) => refused(a.address))) return cb(new McpError('mcp.url resolves into a private network'), '', 0);
        const all = addrs.map((a) => ({ address: a.address, family: isIP(a.address) }));
        if (!all.length) return cb(Object.assign(new Error(`no address for ${hostname}`), { code: 'ENOTFOUND' }), '', 0);
        if (options.all) return (cb as unknown as (e: null, a: LookupAddress[]) => void)(null, all);
        cb(null, all[0].address, all[0].family);
      },
      (e: NodeJS.ErrnoException) => cb(e, '', 0),
    );
  };

  private post(body: object, token: string): Promise<{ status: number; header: (name: string) => string | undefined; text: string }> {
    const data = JSON.stringify(body);
    const send = new URL(this.url).protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      // node:http follows no redirects, and agent: false gives each request a fresh connection, looked up anew.
      const req = send(this.url, {
        method: 'POST',
        agent: false,
        lookup: this.lookup,
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
          'mcp-protocol-version': PROTOCOL,
          ...(this.session ? { 'mcp-session-id': this.session } : {}),
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > this.maxBytes) {
            req.destroy();
            return reject(new McpError('answer too large'));
          }
          chunks.push(c);
        });
        res.on('error', reject);
        res.on('end', () => {
          const header = (name: string) => {
            const v = res.headers[name.toLowerCase()];
            return Array.isArray(v) ? v.join(', ') : v;
          };
          resolve({ status: res.statusCode ?? 0, header, text: Buffer.concat(chunks).toString('utf8') });
        });
      });
      req.on('error', reject);
      req.end(data);
    });
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
    const sid = r.header('mcp-session-id');
    if (sid) this.session = sid;
    const msg = parseRpcBody(r.text, r.header('content-type') ?? '', id);
    if (msg.error) throw new McpError(`error ${msg.error.code}: ${msg.error.message}`);
    return msg.result;
  }
}
