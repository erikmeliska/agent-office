// A floor's feed boards (see agent-office.boards.json): each one loads, keeps itself fresh and tells
// the people on the floor. A floor without the file has none, and its boards are GitHub's as before.
import type { BoardFeed, FeedColumn, FeedSlot, WorkerInfo } from '../../shared/protocol.js';
import { buildColumn } from './columns.js';
import { loadConfig, type ActivityBoard, type BoardSpec, type McpBoard } from './config.js';
import { McpHttpClient, type McpCaller } from './mcp-client.js';
import { ActivityLog, activityColumns, onDesk, taskOf } from './activity.js';

export interface FeedsHooks {
  send(feeds: BoardFeed[]): void;
  workers(): WorkerInfo[];
  /** Someone is on the floor: keep the boards fresh. */
  watched(): boolean;
}

/** A floor nobody is on asks this many times less often. */
const IDLE_FACTOR = 5;

export class Feeds {
  private feeds = new Map<FeedSlot, BoardFeed>();
  private boards: BoardSpec[];
  private callers = new Map<FeedSlot, McpCaller>();
  private timers: NodeJS.Timeout[] = [];
  private pending = new Set<Promise<void>>();
  private log: ActivityLog;
  private activityKey = '';
  private stopped = false;

  constructor(
    dir: string,
    dataDir: string,
    private hooks: FeedsHooks,
    opts: { caller?: (b: McpBoard) => McpCaller; env?: NodeJS.ProcessEnv } = {},
  ) {
    this.log = new ActivityLog(dataDir);
    const cfg = loadConfig(dir);
    for (const e of cfg.errors) {
      console.warn(`[feeds] ${e.error}`);
      if (e.slot) this.feeds.set(e.slot, { slot: e.slot, title: '⚠️ Board config', columns: [], updatedAt: 0, error: e.error });
    }
    this.boards = cfg.boards;
    const env = opts.env ?? process.env;
    for (const b of this.boards) {
      if (b.type === 'activity') {
        this.feeds.set(b.slot, this.activityFeed(b));
        continue;
      }
      this.callers.set(b.slot, opts.caller?.(b) ?? new McpHttpClient(b.url, () => env[b.tokenEnv], b.tokenEnv));
      this.feeds.set(b.slot, { slot: b.slot, title: b.title, columns: b.columns.map((c) => ({ title: c.title, items: [] })), updatedAt: 0 });
      this.track(this.refresh(b));
      let tick = 0;
      this.timers.push(
        setInterval(() => {
          tick++;
          if (this.hooks.watched() || tick % IDLE_FACTOR === 0) this.track(this.refresh(b));
        }, b.refreshSec * 1000),
      );
    }
    for (const t of this.timers) t.unref?.();
  }

  state(): BoardFeed[] {
    return [...this.feeds.values()];
  }

  /** Every load under way has finished. */
  async settled(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  /** Loads every MCP board now. */
  refreshAll(): Promise<void> {
    for (const b of this.boards) if (b.type === 'mcp') this.track(this.refresh(b));
    return this.settled();
  }

  /** A worker on the floor changed: the activity board follows. */
  onWorker() {
    this.publishActivity();
  }

  /** A worker went home: what it was on goes into the log. */
  onWorkerGone(info?: WorkerInfo) {
    if (info && onDesk(info) && this.boards.some((b) => b.type === 'activity')) this.log.add({ name: info.name, task: taskOf(info), endedAt: Date.now() });
    this.publishActivity();
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
  }

  private track(p: Promise<void>) {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  private activityFeed(b: ActivityBoard): BoardFeed {
    return { slot: b.slot, title: b.title, columns: activityColumns(this.hooks.workers(), this.log.list(), b), updatedAt: Date.now() };
  }

  private publishActivity() {
    if (this.stopped) return;
    let changed = false;
    for (const b of this.boards) {
      if (b.type !== 'activity') continue;
      const feed = this.activityFeed(b);
      this.feeds.set(b.slot, feed);
      const key = JSON.stringify(feed.columns);
      if (key !== this.activityKey) {
        this.activityKey = key;
        changed = true;
      }
    }
    if (changed) this.hooks.send(this.state());
  }

  private async refresh(b: McpBoard): Promise<void> {
    const caller = this.callers.get(b.slot)!;
    const results = await Promise.all(
      b.columns.map(async (c): Promise<{ col?: FeedColumn; error?: string }> => {
        try {
          const r = await caller.call(c.tool, c.args);
          return { col: buildColumn(c, r.rows, Date.now(), r.truncated) };
        } catch (e) {
          return { error: `${c.title}: ${(e as Error).message}` };
        }
      }),
    );
    if (this.stopped) return;
    const prev = this.feeds.get(b.slot)!;
    const errors = results.flatMap((r) => (r.error ? [r.error] : []));
    this.feeds.set(b.slot, {
      slot: b.slot,
      title: b.title,
      columns: results.map((r, i) => r.col ?? prev.columns[i] ?? { title: b.columns[i].title, items: [] }),
      updatedAt: errors.length < results.length ? Date.now() : prev.updatedAt,
      ...(errors.length ? { error: errors.join(' · ') } : {}),
    });
    this.hooks.send(this.state());
  }
}
