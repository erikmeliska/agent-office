// What a worker's screen says about it, for the providers that read it (see ProviderAdapter.screen).
import { providerAdapter } from '../providers/index.js';
import { screenText } from './terminal.js';
import type { Worker, WorkerHandle } from './types.js';

/**
 * An agent can sit at its prompt without being usable: Claude stuck on a first-run screen, or not
 * signed in on this machine. Flag that as needing a human, and clear it once the screen moves on.
 * Past that, a provider that reads its screen for how it's doing (`watch`) is handed it.
 */
export function checkScreen(w: Worker, h: WorkerHandle) {
  const screen = w.info.kind === 'agent' ? providerAdapter(w.info.provider)?.screen : undefined;
  if (!w.term || !screen) return;
  const s = w.info.status;
  if (screen.blocked && (s === 'starting' || s === 'idle' || (w.bootBlocked && s === 'needs_input'))) {
    // Only this run's output counts: a "Not logged in" in the scrollback from before is old news.
    const text = screenText(w.term, w.term.buffer.active.type === 'normal' ? Math.max(0, w.fresh?.line ?? 0) : 0);
    const blocked = screen.blocked(text, s === 'starting' || !!w.bootBlocked);
    if (blocked && s !== 'needs_input') {
      w.bootBlocked = true;
      w.info.activity = blocked;
      h.setStatus('needs_input');
    } else if (!blocked && w.bootBlocked && s === 'needs_input') {
      w.bootBlocked = false;
      w.info.activity = undefined;
      h.setStatus('idle');
    }
  }
  if (screen.watch && w.pty && !w.bootBlocked && w.info.status !== 'starting') screen.watch(h, screenText(w.term));
}
