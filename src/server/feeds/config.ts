// agent-office.boards.json in a floor's checkout: which board a feed takes the place of, and where it
// comes from. Written by people and committed with the project; the office only reads it.
import { readFileSync } from 'node:fs';
import { BlockList, isIP } from 'node:net';
import path from 'node:path';
import type { FeedSlot, FeedTone } from '../../shared/protocol.js';
import type { ColumnSpec } from './columns.js';

export const CONFIG_FILE = 'agent-office.boards.json';
export const FEED_SLOTS: readonly FeedSlot[] = ['issues', 'pulls'];

export interface McpBoard {
  type: 'mcp';
  slot: FeedSlot;
  title: string;
  url: string;
  /** The office's environment variable holding the bearer token. */
  tokenEnv: string;
  refreshSec: number;
  columns: ColumnSpec[];
}

export interface ActivityBoard {
  type: 'activity';
  slot: FeedSlot;
  title: string;
  /** The two columns' titles. */
  now: string;
  recent: string;
}

export type BoardSpec = McpBoard | ActivityBoard;

export interface LoadedConfig {
  boards: BoardSpec[];
  errors: { slot?: FeedSlot; error: string }[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const TONES = new Set<string>(['hot', 'warn', 'ok']);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
/** The file is committed with the project, so it may only name tokens the office set aside for boards. */
export const TOKEN_ENV_PREFIX = 'AGENT_OFFICE_MCP_';
const TOKEN_ENV = new RegExp(`^${TOKEN_ENV_PREFIX}[A-Z0-9_]+$`);
// Private-network addresses written straight into the URL; loopback stays allowed for a local MCP server.
// (A name that resolves to one is the MCP client's to catch, not the config's.)
const PRIVATE = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16]] as const) {
  PRIVATE.addSubnet(net, bits, 'ipv4');
}
// BlockList already holds IPv4-mapped IPv6 (::ffff:10.0.0.1) to the IPv4 rules.
for (const [net, bits] of [['fc00::', 7], ['fe80::', 10], ['::', 128]] as const) PRIVATE.addSubnet(net, bits, 'ipv6');
const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

function isPrivateIp(hostname: string): boolean {
  const ip = hostname.replace(/^\[|\]$/g, '');
  const family = isIP(ip);
  return family !== 0 && PRIVATE.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

export function urlProblem(raw: string): string | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'mcp.url is not a URL';
  }
  if (isPrivateIp(u.hostname)) return 'mcp.url must not point into a private network';
  if (u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname))) return undefined;
  return 'mcp.url must be https (or http on localhost)';
}

function parseColumn(c: unknown, i: number): ColumnSpec | string {
  const at = `columns[${i}]`;
  if (!isObj(c)) return `${at}: expected an object`;
  const title = text(c.title, 40);
  if (!title) return `${at}: needs a "title"`;
  if (typeof c.tool !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(c.tool)) return `${at}: needs a "tool"`;
  if (c.args !== undefined && !isObj(c.args)) return `${at}: "args" must be an object`;
  const item = c.item;
  if (!isObj(item) || typeof item.id !== 'string' || typeof item.title !== 'string' || (item.sub !== undefined && typeof item.sub !== 'string')) {
    return `${at}: "item" needs "id" and "title" templates`;
  }
  let where: ColumnSpec['where'];
  if (c.where !== undefined) {
    if (!isObj(c.where) || !Object.values(c.where).every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v))) {
      return `${at}: "where" maps fields to a value, "<now" or ">now"`;
    }
    where = c.where as ColumnSpec['where'];
  }
  if (c.sort !== undefined && (typeof c.sort !== 'string' || !/^-?[A-Za-z0-9_]+$/.test(c.sort))) return `${at}: "sort" is a field name`;
  const limit = c.limit === undefined ? 8 : c.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 20) return `${at}: "limit" is 1 to 20`;
  if (c.tone !== undefined && (typeof c.tone !== 'string' || !TONES.has(c.tone))) return `${at}: "tone" is hot, warn or ok`;
  return {
    title,
    tool: c.tool,
    args: (c.args as Record<string, unknown>) ?? {},
    item: { id: item.id, title: item.title, ...(item.sub !== undefined ? { sub: item.sub as string } : {}) },
    ...(where ? { where } : {}),
    ...(c.sort !== undefined ? { sort: c.sort as string } : {}),
    limit,
    ...(c.tone !== undefined ? { tone: c.tone as FeedTone } : {}),
  };
}

function parseBoard(slot: FeedSlot, b: unknown): BoardSpec | string {
  if (!isObj(b)) return 'expected an object';
  const title = text(b.title, 60);
  if (!title) return 'needs a "title"';
  if (b.type === 'activity') return { type: 'activity', slot, title, now: text(b.now, 30) ?? 'Now', recent: text(b.recent, 30) ?? 'Recent' };
  if (b.type !== 'mcp') return 'type must be "mcp" or "activity"';
  const m = b.mcp;
  if (!isObj(m) || typeof m.url !== 'string') return 'needs "mcp": {"url", "tokenEnv"}';
  const bad = urlProblem(m.url);
  if (bad) return bad;
  if (typeof m.tokenEnv !== 'string' || !TOKEN_ENV.test(m.tokenEnv)) {
    return `mcp.tokenEnv is the name of an environment variable starting with ${TOKEN_ENV_PREFIX}`;
  }
  const refreshSec = b.refreshSec === undefined ? 120 : b.refreshSec;
  if (typeof refreshSec !== 'number' || !Number.isInteger(refreshSec) || refreshSec < 30) return '"refreshSec" is a whole number of seconds, 30 or more';
  if (!Array.isArray(b.columns) || b.columns.length < 1 || b.columns.length > 4) return 'needs 1 to 4 columns';
  const columns: ColumnSpec[] = [];
  for (const [i, c] of b.columns.entries()) {
    const col = parseColumn(c, i);
    if (typeof col === 'string') return col;
    columns.push(col);
  }
  return { type: 'mcp', slot, title, url: m.url, tokenEnv: m.tokenEnv, refreshSec, columns };
}

export function parseConfig(json: unknown): LoadedConfig {
  const out: LoadedConfig = { boards: [], errors: [] };
  if (!isObj(json) || !isObj(json.boards)) {
    out.errors.push({ error: `${CONFIG_FILE}: expected {"boards": {...}}` });
    return out;
  }
  for (const [key, b] of Object.entries(json.boards)) {
    if (!(FEED_SLOTS as readonly string[]).includes(key)) {
      out.errors.push({ error: `${CONFIG_FILE}: unknown board "${key}" (use ${FEED_SLOTS.join(' or ')})` });
      continue;
    }
    const slot = key as FeedSlot;
    const r = parseBoard(slot, b);
    if (typeof r === 'string') out.errors.push({ slot, error: `${CONFIG_FILE} › ${slot}: ${r}` });
    else out.boards.push(r);
  }
  return out;
}

export function loadConfig(dir: string): LoadedConfig {
  let raw: string;
  try {
    raw = readFileSync(path.join(dir, CONFIG_FILE), 'utf8');
  } catch {
    return { boards: [], errors: [] };
  }
  try {
    return parseConfig(JSON.parse(raw));
  } catch (e) {
    return { boards: [], errors: [{ error: `${CONFIG_FILE}: invalid JSON (${(e as Error).message})` }] };
  }
}
