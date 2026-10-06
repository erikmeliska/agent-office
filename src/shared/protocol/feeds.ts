// A board whose content a floor brings itself (agent-office.boards.json in its checkout): a feed from
// an MCP server, or what the floor's workers are doing. It takes the place of the issues or PR board.

/** The board a feed takes the place of. */
export type FeedSlot = 'issues' | 'pulls';
export type FeedTone = 'hot' | 'warn' | 'ok';

export interface FeedItem {
  id: string;
  title: string;
  sub?: string;
  tone?: FeedTone;
}

export interface FeedColumn {
  title: string;
  items: FeedItem[];
  /** There was more than the column shows. */
  truncated?: boolean;
}

export interface BoardFeed {
  slot: FeedSlot;
  title: string;
  columns: FeedColumn[];
  /** When it last loaded (ms); 0 before the first time. */
  updatedAt: number;
  /** Why it couldn't load (all of it, or some of its columns). */
  error?: string;
}

export type FeedsServerMsg = { t: 'feeds'; feeds: BoardFeed[] };
