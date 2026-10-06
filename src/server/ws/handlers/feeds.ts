// Feed boards (agent-office.boards.json): what someone arriving on a floor is shown on them.
import type { ViewPieces } from './types.js';

export const feedsView: ViewPieces['feeds'] = (_ctx, floor) => floor?.feeds.state() ?? [];
