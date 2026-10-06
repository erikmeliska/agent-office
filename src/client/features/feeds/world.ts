import * as THREE from 'three';
import type { BoardFeed, FeedTone } from '../../../shared/protocol';

const TONE: Record<FeedTone, string> = { hot: '#ef476f', warn: '#ffd166', ok: '#06d6a0' };
const FONT = 'Nunito, ui-rounded, system-ui, sans-serif';

function clip(g: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (g.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && g.measureText(`${s}…`).width > maxW) s = s.slice(0, -1);
  return `${s}…`;
}

function since(ms: number): string {
  if (!ms) return 'not loaded yet';
  const m = Math.floor((Date.now() - ms) / 60_000);
  return m < 1 ? 'updated just now' : m < 60 ? `updated ${m}m ago` : `updated ${Math.floor(m / 60)}h ago`;
}

/** A feed board: a dark board with the feed's columns side by side, one line per item. */
export class FeedBoardTexture {
  readonly texture: THREE.CanvasTexture;
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private drawn = '';

  constructor() {
    this.canvas.width = 1200;
    this.canvas.height = 600;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
  }

  render(feed: BoardFeed) {
    // The minute in "updated 3m ago" counts as a change, so the footer keeps up.
    const key = JSON.stringify([feed, since(feed.updatedAt)]);
    if (key === this.drawn) return;
    this.drawn = key;
    const g = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    g.fillStyle = '#1f2933';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#f8f9fa';
    g.font = `900 46px ${FONT}`;
    g.textAlign = 'left';
    g.fillText(clip(g, feed.title, W - 60), 30, 58);
    const cols = feed.columns.length ? feed.columns : [{ title: '', items: [] }];
    const colW = (W - 40) / cols.length;
    const top = 90;
    const footer = 44;
    const rowH = 54;
    cols.forEach((c, i) => {
      const x = 20 + i * colW;
      g.fillStyle = 'rgba(255,255,255,.06)';
      g.fillRect(x + 6, top, colW - 12, H - top - footer - 6);
      g.fillStyle = 'rgba(248,249,250,.8)';
      g.font = `800 28px ${FONT}`;
      g.fillText(clip(g, `${c.title}${c.items.length ? ` · ${c.items.length}${c.truncated ? '+' : ''}` : ''}`, colW - 36), x + 18, top + 38);
      const fit = Math.floor((H - top - footer - 60) / rowH);
      c.items.slice(0, fit).forEach((it, j) => {
        const y = top + 56 + j * rowH;
        g.fillStyle = it.tone ? TONE[it.tone] : '#8d99ae';
        g.fillRect(x + 18, y + 6, 8, rowH - 14);
        g.fillStyle = '#ffd166';
        g.font = `900 22px ui-monospace, Menlo, monospace`;
        const id = clip(g, it.id, colW * 0.3);
        g.fillText(id, x + 36, y + 30);
        const idW = g.measureText(id).width + 12;
        g.fillStyle = '#f8f9fa';
        g.font = `800 24px ${FONT}`;
        g.fillText(clip(g, it.title, colW - 70 - idW), x + 36 + idW, y + 30);
        if (it.sub) {
          g.fillStyle = 'rgba(233,236,239,.6)';
          g.font = `700 18px ${FONT}`;
          g.fillText(clip(g, it.sub, colW - 70), x + 36, y + 50);
        }
      });
      if (!c.items.length) {
        g.fillStyle = 'rgba(233,236,239,.45)';
        g.font = `700 24px ${FONT}`;
        g.fillText('—', x + 18, top + 90);
      }
    });
    g.font = `700 22px ${FONT}`;
    g.fillStyle = feed.error ? '#ef476f' : 'rgba(233,236,239,.6)';
    g.fillText(clip(g, feed.error ? `⚠️ ${feed.error}` : '', W * 0.7), 24, H - 14);
    g.fillStyle = 'rgba(233,236,239,.6)';
    g.textAlign = 'right';
    g.fillText(since(feed.updatedAt), W - 24, H - 14);
    g.textAlign = 'left';
    this.texture.needsUpdate = true;
  }
}
