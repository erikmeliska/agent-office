import type { BoardFeed } from '../../../shared/protocol';
import type { Slice } from '../store';

declare module '../store' {
  interface Store {
    /** Boards this floor shows a feed of its own on, in place of the issues or PR board (agent-office.boards.json). */
    feeds: BoardFeed[];
  }
  interface Topics {
    feeds: true;
  }
}

export const feeds: Slice = {
  init(s) {
    s.feeds = [];
  },
  on: {
    feeds(s, m) {
      s.feeds = m.feeds;
      return ['feeds'];
    },
  },
  enter(s, v) {
    s.feeds = v.feeds ?? [];
    return ['feeds'];
  },
};
