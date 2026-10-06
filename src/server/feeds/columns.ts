// What a feed column shows: the rows a tool returned, kept (where), ordered (sort), cut (limit) and
// written out through the column's templates. Only the fields the templates name leave the server.
import type { FeedColumn, FeedItem, FeedTone } from '../../shared/protocol.js';

export type Row = Record<string, unknown>;

export interface ColumnSpec {
  title: string;
  tool: string;
  args: Record<string, unknown>;
  item: { id: string; title: string; sub?: string };
  where?: Record<string, string | number | boolean | null>;
  sort?: string;
  limit: number;
  tone?: FeedTone;
}

const DATE = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/;

/** `YYYY-MM-DD` or `YYYY-MM-DD HH:MM[:SS]`, read as local time; anything else isn't a date. */
export function parseDate(v: unknown): number | undefined {
  if (typeof v !== 'string' || !DATE.test(v)) return undefined;
  const t = Date.parse(v.length === 10 ? `${v}T00:00:00` : v.replace(' ', 'T'));
  return Number.isNaN(t) ? undefined : t;
}

/** Every condition holds: an exact value, or a date before (`<now`) or after (`>now`) now. */
export function matches(row: Row, where: ColumnSpec['where'], now: number): boolean {
  if (!where) return true;
  for (const [field, cond] of Object.entries(where)) {
    const v = row[field];
    if (cond === '<now' || cond === '>now') {
      const t = parseDate(v);
      if (t === undefined || (cond === '<now' ? t >= now : t <= now)) return false;
    } else if (v !== cond) return false;
  }
  return true;
}

function sortKey(v: unknown): number | string | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const t = parseDate(v);
  if (t !== undefined) return t;
  return typeof v === 'number' ? v : String(v);
}

/** By `sort` (a field; `-field` for descending), with empty values last either way. */
export function sortRows(rows: Row[], sort: string | undefined): Row[] {
  if (!sort) return rows;
  const desc = sort.startsWith('-');
  const field = desc ? sort.slice(1) : sort;
  return [...rows].sort((a, b) => {
    const x = sortKey(a[field]);
    const y = sortKey(b[field]);
    if (x === undefined) return y === undefined ? 0 : 1;
    if (y === undefined) return -1;
    const c = x < y ? -1 : x > y ? 1 : 0;
    return desc ? -c : c;
  });
}

/** `{field}` replaced by the row's value; missing or null fields are empty. */
export function fill(template: string, row: Row): string {
  return template
    .replace(/\{([A-Za-z0-9_]+)\}/g, (_, f: string) => {
      const v = row[f];
      return v === null || v === undefined ? '' : String(v);
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function toItem(spec: ColumnSpec, row: Row): FeedItem {
  const item: FeedItem = { id: fill(spec.item.id, row), title: fill(spec.item.title, row) };
  const sub = spec.item.sub ? fill(spec.item.sub, row) : '';
  if (sub) item.sub = sub;
  if (spec.tone) item.tone = spec.tone;
  return item;
}

export function buildColumn(spec: ColumnSpec, rows: Row[], now = Date.now(), truncated = false): FeedColumn {
  const kept = sortRows(rows.filter((r) => matches(r, spec.where, now)), spec.sort);
  const col: FeedColumn = { title: spec.title, items: kept.slice(0, spec.limit).map((r) => toItem(spec, r)) };
  if (truncated || kept.length > spec.limit) col.truncated = true;
  return col;
}
