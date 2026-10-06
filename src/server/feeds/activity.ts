// The activity board: the floor's workers at their desks now, and the last ones who went home with
// what they were on, kept in .agent-office/activity.json so a restart doesn't forget them.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FeedColumn, FeedTone, WorkerInfo, WorkerStatus } from '../../shared/protocol.js';
import { DESK_BY_ID } from '../../shared/layout.js';

export interface ActivityEntry {
  name: string;
  task: string;
  endedAt: number;
}

export const ACTIVITY_MAX = 30;
const RECENT_SHOWN = 8;

export function taskOf(w: WorkerInfo): string {
  if (w.task?.name) return w.task.name;
  const prompt = w.prompt?.replace(/\s+/g, ' ').trim();
  return prompt ? prompt.slice(0, 80) : '—';
}

export function toneOf(s: WorkerStatus): FeedTone {
  if (s === 'needs_input') return 'hot';
  if (s === 'working' || s === 'starting') return 'warn';
  return 'ok';
}

/** An agent at a desk: not a shell, not a board agent at its kiosk. */
export function onDesk(w: WorkerInfo): boolean {
  return w.kind === 'agent' && !DESK_BY_ID.get(w.deskId)?.station;
}

function ago(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

export function activityColumns(workers: WorkerInfo[], log: readonly ActivityEntry[], titles: { now: string; recent: string }, now = Date.now()): FeedColumn[] {
  const atDesks = workers.filter(onDesk).map((w) => ({ id: w.name, title: taskOf(w), sub: DESK_BY_ID.get(w.deskId)?.label ?? w.deskId, tone: toneOf(w.status) }));
  const recent = log.slice(0, RECENT_SHOWN).map((e) => ({ id: e.name, title: e.task, sub: ago(now - e.endedAt), tone: 'ok' as const }));
  return [
    { title: titles.now, items: atDesks },
    { title: titles.recent, items: recent, ...(log.length > RECENT_SHOWN ? { truncated: true } : {}) },
  ];
}

const valid = (e: unknown): e is ActivityEntry =>
  !!e && typeof e === 'object' && typeof (e as ActivityEntry).name === 'string' && typeof (e as ActivityEntry).task === 'string' && typeof (e as ActivityEntry).endedAt === 'number';

export class ActivityLog {
  private entries: ActivityEntry[] = [];
  private file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'activity.json');
    try {
      const saved: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (Array.isArray(saved)) this.entries = saved.filter(valid).slice(0, ACTIVITY_MAX);
    } catch {
      // no log yet, or a broken one: start empty
    }
  }

  list(): readonly ActivityEntry[] {
    return this.entries;
  }

  add(e: ActivityEntry) {
    this.entries = [e, ...this.entries].slice(0, ACTIVITY_MAX);
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.entries));
    renameSync(tmp, this.file);
  }
}
