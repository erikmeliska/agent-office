// Antigravity CLI (agy): its hooks, the helper they run, its command line, and what its screen and
// log say about it.
//
// agy reads lifecycle hooks from ~/.gemini/config/hooks.json, which is the person's own and the
// office never touches, from plugins, and from .agents/hooks.json in the folder it runs in (and the
// folders above it, up to the project's root). Nothing moves the global one, so each worker's hook
// goes into the .agents/hooks.json of the folder it works in as it starts, under a name of its own,
// and comes out again when it ends. agy only loads a folder's hooks when that folder was already
// trusted as it started: the first run in a folder it asks to trust reports nothing until it's
// resumed, and its screen is read instead (see agyScreen).
import { chmodSync, existsSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { excludeFromGit } from './config.js';

/**
 * agy's hook events the office listens to, and the lifecycle event each one is (see
 * workers/lifecycle.ts). PreToolUse isn't one: a PreToolUse hook has to answer with a decision, and
 * an empty one denies the tool, so the office would be deciding for the person.
 */
export const AGY_HOOK_EVENTS = {
  PreInvocation: 'UserPromptSubmit',
  PostToolUse: 'PostToolUse',
  Stop: 'Stop',
} as const;

export type AgyHookName = keyof typeof AGY_HOOK_EVENTS;

/** The bounded event shape forwarded to the worker bridge. */
export interface AgyHookEvent {
  sessionId: string;
  event: AgyHookName;
  /** PreInvocation: which model call of the turn this is (0 is the first, right after a prompt). */
  invocation?: number;
  tool?: string;
  /** Stop: why the turn ended (`NO_TOOL_CALL`, `error`, ...). */
  reason?: string;
}

const MAX_ID = 160;
/** A conversation id goes back on the command line (`--conversation <id>`), so it's never taken as anything but an id. */
const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const HOOK_FILE = 'agent-office-agy-hook.cjs';
const HOOK_TIMEOUT_S = 5;
/** The name of the office's entry for a worker in a hooks.json: one per worker, so workers sharing a folder never touch each other's. */
const ENTRY_PREFIX = 'agent-office-';

function bounded(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text && text.length <= max ? text : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Validate and compact an agy hook payload: only the conversation id, the tool's name and the turn's counters get through. */
export function normalizeAgyHook(event: string, payload: unknown): AgyHookEvent | undefined {
  if (!Object.hasOwn(AGY_HOOK_EVENTS, event) || !isRecord(payload)) return undefined;
  const sessionId = payload.conversationId;
  if (typeof sessionId !== 'string' || !CONVERSATION_ID.test(sessionId)) return undefined;
  const name = event as AgyHookName;
  const result: AgyHookEvent = { sessionId, event: name };
  if (name === 'PreInvocation' && Number.isSafeInteger(payload.invocationNum) && (payload.invocationNum as number) >= 0) result.invocation = payload.invocationNum as number;
  if (name === 'PostToolUse') {
    const tool = bounded(isRecord(payload.toolCall) ? payload.toolCall.name : undefined, MAX_ID);
    if (tool) result.tool = tool;
  }
  if (name === 'Stop') {
    const reason = bounded(payload.terminationReason, MAX_ID);
    if (reason) result.reason = reason;
  }
  return result;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

/** Write the self-contained helper invoked by agy's command hooks. */
export function writeAgyHook(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, HOOK_FILE);
  writeFileSync(file, AGY_HOOK_SOURCE, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

function hooksPath(cwd: string): string {
  return path.join(cwd, '.agents', 'hooks.json');
}

/** The folder's hooks.json as it is, 'none' when there isn't one, or undefined for one the office can't read (it's left alone). */
function readHooks(file: string): { config: Record<string, unknown>; text: string } | 'none' | undefined {
  if (!existsSync(file)) return 'none';
  try {
    const text = readFileSync(file, 'utf8');
    const config = JSON.parse(text.replace(/^﻿/, '')) as unknown;
    return isRecord(config) ? { config, text } : undefined;
  } catch {
    return undefined;
  }
}

/** `config` as text, laid out the way `like` was. */
function format(config: unknown, like?: string): string {
  const indent = (like && /^([ \t]+)\S/m.exec(like)?.[1]) || '  ';
  return JSON.stringify(config, null, indent) + (like && !like.endsWith('\n') ? '' : '\n');
}

/** A project's own hooks.json as it was before the office's first entry went in, to put back exactly. */
const originals = new Map<string, string>();

/**
 * Puts a worker's hook in the .agents/hooks.json of the folder it works in, next to whatever the
 * project has there. It's named after its worker, and the helper only speaks for that one, so
 * workers sharing a folder (the board agents, in the project itself) don't report for each other.
 * Says whether it's in: a hooks.json the office can't read is left as it is.
 */
export function addAgyHooks(cwd: string, hook: string, workerId: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(workerId)) return false;
  const file = hooksPath(cwd);
  const found = readHooks(file);
  if (!found) return false;
  const config = found === 'none' ? {} : found.config;
  const before = found === 'none' ? undefined : found.text;
  // The project's own file, untouched until now: kept to put back as it was (see removeAgyHooks).
  if (before !== undefined && !before.includes(HOOK_FILE)) originals.set(file, before);
  const handler = (event: AgyHookName) => ({ type: 'command', command: [process.execPath, hook, event, workerId].map(shellQuote).join(' '), timeout: HOOK_TIMEOUT_S });
  config[ENTRY_PREFIX + workerId] = {
    PreInvocation: [handler('PreInvocation')],
    PostToolUse: [{ matcher: '*', hooks: [handler('PostToolUse')] }],
    Stop: [handler('Stop')],
  };
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, format(config, before));
  } catch {
    return false;
  }
  // A file the office made is no change of the worker's: git doesn't list it.
  if (before === undefined) excludeFromGit(cwd, '.agents/hooks.json');
  return true;
}

/** Takes a worker's hook out again, and the file with it when nothing else is in it. */
export function removeAgyHooks(cwd: string, workerId: string) {
  const file = hooksPath(cwd);
  const found = readHooks(file);
  if (!found || found === 'none' || !found.text.includes(HOOK_FILE)) return;
  const { config, text } = found;
  delete config[ENTRY_PREFIX + workerId];
  const shared = Object.keys(config).some((key) => key.startsWith(ENTRY_PREFIX) && JSON.stringify(config[key]).includes(HOOK_FILE));
  const original = shared ? undefined : originals.get(file);
  if (!shared) originals.delete(file);
  try {
    if (original !== undefined && JSON.stringify(JSON.parse(original.replace(/^﻿/, ''))) === JSON.stringify(config)) {
      writeFileSync(file, original);
    } else if (!Object.keys(config).length) {
      unlinkSync(file);
      try {
        rmdirSync(path.dirname(file)); // only when the office's file was all it held
      } catch {
        // the project has other things in .agents
      }
    } else {
      writeFileSync(file, format(config, text));
    }
  } catch {
    // The folder is gone (a worktree that was deleted), or can't be written: nothing to take out.
  }
}

/**
 * Drop launch flags the office sets itself, the ones that would take a worker out of its terminal
 * (print mode) or into another conversation, and the one that skips agy's permission prompts (the
 * office never passes it).
 */
export function withoutAgyLaunchArgs(args: string[]): string[] {
  const skipValue = new Set([
    '--model', '--effort', '--conversation', '--log-file', '-i', '--prompt-interactive', '-p', '--print', '--prompt',
    '--output-format', '--input-format', '--json-schema', '--print-timeout',
  ]);
  const skipFlag = new Set(['--dangerously-skip-permissions', '--continue', '-c', '--new-project', '--remote-control']);
  const clean: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break;
    if (skipFlag.has(arg)) continue;
    if (skipValue.has(arg)) {
      i++;
      continue;
    }
    if ([...skipValue, ...skipFlag].some((flag) => flag.startsWith('--') && arg.startsWith(`${flag}=`))) continue;
    clean.push(arg);
  }
  return clean;
}

/** One run's command line: model and effort (resumed too: they're the session's flags, not the conversation's), its log, the conversation it resumes, and its prompt. */
export function agyArgs(base: string[], o: { model?: string; effort?: string; logFile?: string; conversation?: string; prompt?: string }): string[] {
  const args = withoutAgyLaunchArgs(base);
  if (o.model) args.push('--model', o.model);
  if (o.effort) args.push('--effort', o.effort);
  if (o.logFile) args.push('--log-file', o.logFile);
  if (o.conversation) args.push('--conversation', o.conversation);
  // -i takes the prompt as its value: a prompt starting with '-' still goes in whole, after '='.
  if (o.prompt) args.push(`--prompt-interactive=${o.prompt}`);
  return args;
}

/** The conversation a run's own log (`--log-file`) says it streams first: the one it started, or resumed. */
export function agyLogConversation(log: string): string | undefined {
  const id = /\bStreaming conversation ([A-Za-z0-9][A-Za-z0-9_-]{0,127})\b/.exec(log)?.[1];
  return id && CONVERSATION_ID.test(id) ? id : undefined;
}

/** What an agy worker's desk says when its screen shows it can't be used yet. */
export function agyBlocked(text: string): string | undefined {
  if (/Do you trust the contents of this project\?/i.test(text)) return 'Antigravity asks to trust this folder — open the terminal and confirm';
  if (/Select login method/i.test(text) || (/You are currently not signed in/i.test(text) && !/Signing in\.\.\./i.test(text))) {
    return "Antigravity isn't signed in on this machine — open the terminal and log in";
  }
  if (/Verify your account to continue/i.test(text)) return 'Antigravity wants its account verified — open the terminal';
  return undefined;
}

/**
 * What agy's screen says it's doing, from its footer: `esc to cancel` while a turn runs, `? for
 * shortcuts` at rest, and a picker (`↑/↓ Navigate`) during a turn is it asking: a permission prompt
 * or a question. Undefined when the screen doesn't say (a /command's panel, a redraw).
 */
export function agyScreen(text: string): 'working' | 'asking' | 'idle' | undefined {
  const lines = text.split('\n').filter((l) => l.trim());
  const footer = lines.slice(-3).join('\n');
  if (/esc to cancel/i.test(footer)) return /↑\/↓ Navigate|Requesting permission for:/.test(text) ? 'asking' : 'working';
  if (/\? for shortcuts/.test(footer)) return 'idle';
  return undefined;
}

/**
 * The helper reads the hook's stdin and the worker bridge environment, and forwards only the
 * conversation id, the event, the model call's number, the tool's name and why a turn stopped. It
 * always answers `{}`: nothing injected and no stop blocked.
 */
export const AGY_HOOK_SOURCE = String.raw`'use strict';
const MAX = 16 * 1024 * 1024;
const EVENTS = new Set(${JSON.stringify(Object.keys(AGY_HOOK_EVENTS))});
const MAX_ID = 160;
const allowed = (value, max) => typeof value === 'string' && value.trim() && value.trim().length <= max ? value.trim() : undefined;
let answered = false;
const finish = () => { if (!answered) process.stdout.write('{}'); answered = true; };
const event = process.argv[2];
const worker = process.argv[3];
let size = 0;
let overflow = false;
const chunks = [];
process.stdin.on('data', (chunk) => {
  if (overflow) return;
  size += chunk.length;
  if (size > MAX) { overflow = true; chunks.length = 0; return; }
  chunks.push(chunk);
});
process.stdin.on('error', finish);
process.stdin.on('end', async () => {
  const base = process.env.AGENT_OFFICE_HOOK_URL;
  const token = process.env.AGENT_OFFICE_HOOK_TOKEN;
  // Every agy session in this folder runs this: only the worker it was written for reports.
  if (overflow || !EVENTS.has(event) || !base || !token || !worker || process.env.AGENT_OFFICE_WORKER_ID !== worker) return finish();
  let input;
  try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return finish(); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return finish();
  const conversation = allowed(input.conversationId, MAX_ID);
  if (!conversation) return finish();
  const body = { conversationId: conversation };
  if (event === 'PreInvocation' && Number.isSafeInteger(input.invocationNum)) body.invocationNum = input.invocationNum;
  if (event === 'PostToolUse' && input.toolCall && typeof input.toolCall === 'object') {
    const tool = allowed(input.toolCall.name, MAX_ID);
    if (tool) body.toolCall = { name: tool };
  }
  if (event === 'Stop') {
    const reason = allowed(input.terminationReason, MAX_ID);
    if (reason) body.terminationReason = reason;
  }
  try {
    const url = new URL('/hooks/agy', base);
    url.searchParams.set('worker', worker);
    url.searchParams.set('event', event);
    await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2000),
    });
  } catch {}
  finish();
});
`;
