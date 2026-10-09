import type { AppScreenState } from '../../../shared/protocol';
import type { Slice } from '../store';

declare module '../store' {
  interface Store {
    /** The meeting room's screen: its pages and the one that's up, the same on every floor. */
    appScreen: AppScreenState;
  }
  interface Topics {
    appScreen: true;
  }
}

/** No pages: before the office says, or from an office that has no screen (one older than this page). */
const NO_SCREEN: AppScreenState = { pages: [], rotate: 0 };

export const appScreen: Slice = {
  init(s) {
    s.appScreen = NO_SCREEN;
  },
  on: {
    appScreen(s, m) {
      s.appScreen = m.state ?? NO_SCREEN;
      return ['appScreen'];
    },
  },
  enter(s, v) {
    s.appScreen = v.appScreen ?? NO_SCREEN;
    return ['appScreen'];
  },
};
