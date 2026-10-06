/**
 * Feed boards: a floor whose checkout has agent-office.boards.json shows a feed of its own on the
 * issues or PR board (see src/server/feeds). This draws them; the boards feature puts them up (deps.feeds).
 */
import type * as THREE from 'three';
import type { FeedSlot } from '../../../shared/protocol';
import type { Ctx, Hint } from '../../core/context';
import { boardHint } from '../../core/hint';
import { store } from '../../state';
import { openFeed } from './ui';
import { FeedBoardTexture } from './world';

export interface FeedsPart {
  /** The texture to show on `slot`, while this floor has a feed there. */
  texture(slot: FeedSlot): THREE.Texture | undefined;
  hint(slot: FeedSlot): Hint | undefined;
  /** E at `slot`: opens the feed's window. False when there's no feed there. */
  use(slot: FeedSlot, key: string): boolean;
}

export function installFeeds(_ctx: Ctx): FeedsPart {
  const textures = new Map<FeedSlot, FeedBoardTexture>();
  const feedAt = (slot: FeedSlot) => store.feeds.find((f) => f.slot === slot);
  const render = () => {
    for (const f of store.feeds) {
      let tex = textures.get(f.slot);
      if (!tex) textures.set(f.slot, (tex = new FeedBoardTexture()));
      tex.render(f);
    }
  };
  store.on('feeds', render);
  // "updated 3m ago" moves on by itself.
  setInterval(render, 60_000);
  render();
  return {
    texture: (slot) => (feedAt(slot) ? textures.get(slot)?.texture : undefined),
    hint: (slot) => {
      const f = feedAt(slot);
      return f ? boardHint(f.title) : undefined;
    },
    use: (slot, key) => {
      if (!feedAt(slot)) return false;
      if (key === 'E') openFeed(slot);
      return true;
    },
  };
}
