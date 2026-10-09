// Antigravity CLI (agy): its hooks go in the .agents/hooks.json of the folder each worker runs in
// (see ../agy.ts), since that and ~/.gemini/config, which the office never touches, are where it
// reads them from, and report on /hooks/agy. It runs on the machine's own Antigravity login. Its
// spend isn't metered by the office.
//
// What its hooks can't say is read off its screen (see agyScreen):
// - It has no hook for a permission prompt or a question, so a worker waiting on one is caught by
//   its screen showing a picker mid-turn, a moment after it comes up.
// - It only loads a folder's hooks when the folder was trusted as it started. The first run in a
//   new worktree asks to trust it, and once that's answered it runs with no hooks at all: its
//   working, done and needs-you are all read off its screen, and its conversation id off its own
//   log (--log-file), so R still resumes it. A conversation started over inside the terminal
//   (/clear) isn't followed on such a run.
import { mkdirSync, openSync, readSync, closeSync, rmSync } from 'node:fs';
import path from 'node:path';
import { toolAction } from '../../shared/actions.js';
import { addAgyHooks, agyArgs, agyBlocked, agyLogConversation, agyScreen, normalizeAgyHook, removeAgyHooks, writeAgyHook } from '../agy.js';
import { reduceLifecycle } from '../workers/lifecycle.js';
import type { WorkerHandle } from '../workers/types.js';
import { truncate } from '../workers/util.js';
import type { ProviderAdapter } from './types.js';

interface AgyState {
  /** Its hooks have reported on this run: they say when a turn starts and ends, and the screen only what they can't. */
  hooked: boolean;
  /** This run's own log, where its conversation id is read from when no hook says it. */
  logFile?: string;
  logReadAt?: number;
}

interface AgySetup {
  /** The helper its hooks run. */
  hook: string;
  /** Where each run's log goes (agy-logs/<worker id>.log). */
  logDir: string;
}

/** How much of a run's log is read for its conversation id: it's named within its first few hundred lines. */
const LOG_HEAD = 1024 * 1024;
const LOG_EVERY_MS = 2000;
/** What its desk says while its screen shows it asking something. */
const ASKED = 'Waiting for you in its terminal';

function readHead(file: string): string {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(LOG_HEAD);
    return buf.toString('utf8', 0, readSync(fd, buf, 0, LOG_HEAD, 0));
  } finally {
    closeSync(fd);
  }
}

/** A run with no hooks has its conversation id read off its log, so it can be resumed. */
function readConversation(h: WorkerHandle<AgyState>, now = Date.now()) {
  const s = h.state;
  if (h.info.sessionId || !s.logFile || now - (s.logReadAt ?? 0) < LOG_EVERY_MS) return;
  s.logReadAt = now;
  let id: string | undefined;
  try {
    id = agyLogConversation(readHead(s.logFile));
  } catch {
    return; // not written yet
  }
  if (!id) return;
  h.info.sessionId = id;
  h.persist();
}

export const agy: ProviderAdapter<AgyState, AgySetup> = {
  id: 'agy',
  // What agy sets in its own shells. GEMINI_API_KEY stays: a worker signs in with it when it's set.
  scrubEnv: [
    'ANTIGRAVITY_AGENT', 'ANTIGRAVITY_AGENTAPI_EXE', 'ANTIGRAVITY_APP_DATA_DIR', 'ANTIGRAVITY_CONVERSATION_ID', 'ANTIGRAVITY_CSRF_TOKEN',
    'ANTIGRAVITY_LS_ADDRESS', 'ANTIGRAVITY_LS_VERSION', 'ANTIGRAVITY_PROJECT_ID', 'ANTIGRAVITY_SOURCE_METADATA', 'ANTIGRAVITY_TRAJECTORY_ID',
  ],
  createState: () => ({ hooked: false }),
  prepare: ({ dataDir }) => ({ hook: writeAgyHook(dataDir), logDir: path.join(dataDir, 'agy-logs') }),
  launch({ h, args, prompt, resumeSessionId, cwd, setup }) {
    const { info } = h;
    addAgyHooks(cwd, setup.hook, info.id);
    mkdirSync(setup.logDir, { recursive: true, mode: 0o700 });
    const logFile = path.join(setup.logDir, `${info.id}.log`);
    // Its conversation is the first one this run's log names: not one from a run before.
    rmSync(logFile, { force: true });
    h.state.hooked = false;
    h.state.logFile = logFile;
    h.state.logReadAt = undefined;
    // A resumed conversation takes the worker's model and effort again: they're flags of the run, not of the conversation.
    return { args: agyArgs(args, { model: info.model, effort: info.effort, logFile, conversation: resumeSessionId, prompt }), rotateToken: true };
  },
  exited: ({ info }, cwd) => removeAgyHooks(cwd, info.id),
  titleNoise: /^(?:agy|antigravity(?: cli)?)$/i,
  hook: {
    strictJson: true,
    handle(h, event, payload) {
      const report = normalizeAgyHook(event, payload);
      if (!report) return false;
      const { info } = h;
      h.state.hooked = true;
      const first = report.event === 'PreInvocation' && report.invocation === 0;
      // A conversation started over inside the terminal (/clear) fires nothing of its own: its first
      // model call is the first the office hears of it. Mid-turn, another conversation is a subagent's.
      if (first && info.sessionId && info.sessionId !== report.sessionId && info.status !== 'working' && info.status !== 'needs_input') {
        reduceLifecycle(h, { sessionId: report.sessionId, event: 'SessionStart', source: 'clear' });
      }
      if (report.event === 'PreInvocation') return reduceLifecycle(h, { sessionId: report.sessionId, event: 'UserPromptSubmit' });
      if (report.event === 'Stop') return reduceLifecycle(h, { sessionId: report.sessionId, event: 'Stop' });
      // It only says which tool ran once it has: that's what it's doing, and a prompt for it was answered.
      if (!reduceLifecycle(h, { sessionId: report.sessionId, event: 'PostToolUse' })) return false;
      if (report.tool) {
        info.activity = truncate(report.tool, 80);
        info.action = toolAction(report.tool);
        h.noteTool(info.activity);
        h.emit();
      }
      return true;
    },
  },
  screen: {
    blocked: agyBlocked,
    watch(h, text) {
      readConversation(h);
      const seen = agyScreen(text);
      const s = h.info.status;
      // Answered, or turned down: what it was waiting on is over.
      if (s === 'needs_input' && (seen === 'working' || seen === 'idle') && h.info.activity === ASKED) h.info.activity = undefined;
      if (seen === 'asking') {
        if (s === 'working' || s === 'idle' || s === 'done') {
          h.info.activity = ASKED;
          h.setStatus('needs_input');
        }
      } else if (seen === 'working') {
        // A prompt that was answered; and with no hooks on this run, any turn starting.
        if (s === 'needs_input' || (!h.state.hooked && (s === 'idle' || s === 'done'))) h.setStatus('working');
      } else if (seen === 'idle') {
        // A prompt turned down ends the turn; with no hooks on this run, so does any turn ending.
        if (s === 'needs_input' || (!h.state.hooked && s === 'working')) h.setStatus('done');
      }
    },
  },
};
