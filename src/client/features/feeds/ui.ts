import './ui.css';
import type { BoardFeed, FeedSlot } from '../../../shared/protocol';
import { store } from '../../state';
import { h, openModal, timeAgo } from '../../ui/dom';

/** E at a feed board: every item of every column, kept up to date while it's open. */
export function openFeed(slot: FeedSlot) {
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const title = h('h2', {});
  const body = h('div.body.feed');
  const foot = h('span.grow', {});
  const el = h('div.modal', { role: 'dialog', 'aria-label': 'Board', style: 'width:min(960px,100%)' }, h('header', {}, title, close), body, h('footer', {}, foot));
  const render = () => {
    const feed: BoardFeed | undefined = store.feeds.find((f) => f.slot === slot);
    title.textContent = feed?.title ?? 'Board';
    body.replaceChildren(
      ...(feed?.columns ?? []).map((c) =>
        h(
          'section.feed-col',
          {},
          h('h3', {}, `${c.title} · ${c.items.length}${c.truncated ? '+' : ''}`),
          ...(c.items.length
            ? c.items.map((it) => h(`div.feed-item.${it.tone ?? 'none'}`, {}, h('b', {}, it.id), ' ', h('span', {}, it.title), ...(it.sub ? [h('small', {}, it.sub)] : [])))
            : [h('p.feed-empty', {}, '—')]),
        ),
      ),
    );
    foot.textContent = feed?.error ? `⚠️ ${feed.error}` : feed?.updatedAt ? `Updated ${timeAgo(feed.updatedAt)}` : '';
  };
  const off = store.on('feeds', render);
  const modal = openModal(el, { doing: '📋 at a board', onClose: () => off() });
  close.addEventListener('click', () => modal.close());
  render();
}
