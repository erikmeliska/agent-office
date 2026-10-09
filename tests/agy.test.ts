import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  addAgyHooks,
  agyArgs,
  agyBlocked,
  agyLogConversation,
  agyScreen,
  normalizeAgyHook,
  removeAgyHooks,
  withoutAgyLaunchArgs,
  writeAgyHook,
} from '../src/server/agy.js';
import { fetchAgyModels, MODEL_LISTERS, type ModelCommandRunner } from '../src/server/models.js';
import { agy } from '../src/server/providers/agy.js';
import { PROVIDERS } from '../src/server/providers/index.js';
import type { WorkerHandle } from '../src/server/workers/types.js';
import { AGY_MODELS, PROVIDER_META, isValidAgyModel } from '../src/shared/providers.js';
import type { WorkerInfo, WorkerStatus } from '../src/shared/protocol.js';
import { configuredProvider, providerCommand } from '../src/server/agents.js';

function scratch(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-office-agy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const hooksFile = (cwd: string) => path.join(cwd, '.agents', 'hooks.json');
const readHooks = (cwd: string) => JSON.parse(readFileSync(hooksFile(cwd), 'utf8')) as Record<string, any>;

/** A worker's handle as the manager hands it to the adapter, recording what it's moved to. */
function handle(info: Partial<WorkerInfo> = {}) {
  const statuses: WorkerStatus[] = [];
  const h = {
    info: { id: 'w1', status: 'idle', ...info } as WorkerInfo,
    state: agy.createState!(),
    running: true,
    bootBlocked: false,
    leftNeedsInputAt: 0,
    failStreak: 0,
    tracker: undefined as never,
    setStatus(status: WorkerStatus) {
      h.info.status = status;
      statuses.push(status);
    },
    emit() {},
    persist() {},
    notePrompt() {},
    noteTool() {},
    notePr() {},
    clearTask() {},
    scheduleScan() {},
    prompt: () => undefined,
  } satisfies WorkerHandle<ReturnType<NonNullable<typeof agy.createState>>>;
  return { h, statuses };
}

test('agy is a provider: its adapter, its row, its executable and its model lister', () => {
  assert.equal(PROVIDERS.agy, agy);
  assert.equal(PROVIDER_META.agy.bin, 'agy');
  assert.equal(PROVIDER_META.agy.takesEffort, true);
  assert.equal(PROVIDER_META.agy.models?.catalog, true);
  assert.equal(MODEL_LISTERS.agy, fetchAgyModels);
  assert.equal(configuredProvider('/home/me/.local/bin/agy'), 'agy');
  assert.equal(providerCommand('agy', 'claude'), 'agy');
});

test('launches agy interactively with its model, effort, own log and prompt, and resumes its conversation', (t) => {
  const dir = scratch(t);
  const cwd = path.join(dir, 'worktree');
  mkdirSync(cwd);
  const setup = agy.prepare!({ dataDir: path.join(dir, 'data'), dshProfile: 'acp' });
  const log = path.join(dir, 'data', 'agy-logs', 'w1.log');
  const { h } = handle({ model: 'gemini-3.8-flash-high', effort: 'max' });
  const fresh = agy.launch({ h, args: ['--sandbox', '--model', 'other', '-p', 'x', '--dangerously-skip-permissions'], prompt: 'fix the login', cwd, setup });
  assert.deepEqual(fresh.args, ['--sandbox', '--model', 'gemini-3.8-flash-high', '--effort', 'max', '--log-file', log, '--prompt-interactive=fix the login']);
  assert.equal(fresh.rotateToken, true);
  // Its hook is in the folder it works in.
  assert.ok(readHooks(cwd)['agent-office-w1']);

  const resumed = agy.launch({ h, args: [], resumeSessionId: 'c5b00cee-1111-4222-8333-944445555666', prompt: '-n is a flag', cwd, setup });
  assert.deepEqual(resumed.args, ['--model', 'gemini-3.8-flash-high', '--effort', 'max', '--log-file', log, '--conversation', 'c5b00cee-1111-4222-8333-944445555666', '--prompt-interactive=-n is a flag']);
  // No model or effort picked: agy's own settings.
  const { h: plain } = handle();
  assert.deepEqual(agy.launch({ h: plain, args: [], cwd, setup }).args, ['--log-file', log]);
  agy.exited!(h, cwd);
  assert.equal(existsSync(hooksFile(cwd)), false);
});

test('strips launch flags the office sets itself, print mode and skipping permission prompts', () => {
  assert.deepEqual(
    withoutAgyLaunchArgs(['--sandbox', '--model', 'x', '--effort=high', '-c', '--continue', '--conversation', 'abc', '-i', 'hi', '--print', 'p', '--output-format', 'json', '--dangerously-skip-permissions', '--mode', 'plan', '--add-dir', '/x', '--', 'tail']),
    ['--sandbox', '--mode', 'plan', '--add-dir', '/x'],
  );
  assert.deepEqual(agyArgs(['--model', 'x'], {}), []);
});

test('agy model ids are checked before they reach the command line', () => {
  for (const ok of ['gemini-3.8-flash-high', 'claude-opus-5-5-low', 'gpt-oss-120b-medium', 'auto']) assert.equal(isValidAgyModel(ok), true, ok);
  for (const bad of ['', '--yolo', '-m', 'gemini 3', 'a/b', 'x;rm', 'x'.repeat(129), 42, undefined]) assert.equal(isValidAgyModel(bad), false, String(bad));
  assert.ok(AGY_MODELS.some((m) => m.id === 'gemini-3.8-flash-high'));
  for (const m of AGY_MODELS) assert.equal(isValidAgyModel(m.id), true, m.id);
});

test('reads `agy models` (id, tab, name), and falls back to the known list when it cannot', async () => {
  let call: unknown;
  const runner: ModelCommandRunner = async (file, args, options) => {
    call = { file, args, options };
    return {
      stdout: 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n\x1b[2mFetching available models...\x1b[0m\nError\n--evil\tEvil\ngemini-3.8-flash-high\tAgain\ngpt-oss-120b-medium\t\n',
      stderr: '',
    };
  };
  assert.deepEqual(await fetchAgyModels('/opt/agy', '/project', runner), [
    { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
    { id: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
    { id: 'gpt-oss-120b-medium' },
  ]);
  assert.deepEqual(call, { file: '/opt/agy', args: ['models'], options: { cwd: '/project', timeout: 30_000, maxBuffer: 1024 * 1024 } });
  const fallback = await fetchAgyModels('agy', '/project', async () => {
    throw new Error('spawn agy ENOENT');
  });
  assert.deepEqual(fallback, AGY_MODELS);
  assert.ok(fallback.some((m) => m.id === 'gemini-3.8-flash-medium'));
  assert.deepEqual(await fetchAgyModels('agy', '/project', async () => ({ stdout: 'You are not signed in.\n', stderr: '' })), AGY_MODELS);
});

test('maps agy hook events, keeping only the conversation id, the counters and the tool name', () => {
  const common = { conversationId: 'c5b00cee', workspacePaths: ['/secret'], transcriptPath: '/secret/t.jsonl', modelName: 'gemini-3.8-flash-low' };
  assert.deepEqual(normalizeAgyHook('PreInvocation', { ...common, invocationNum: 0, initialNumSteps: 1 }), { sessionId: 'c5b00cee', event: 'PreInvocation', invocation: 0 });
  assert.deepEqual(normalizeAgyHook('PostToolUse', { ...common, stepIdx: 3, error: '', toolCall: { name: 'run_command', args: { CommandLine: 'cat .env' } } }), { sessionId: 'c5b00cee', event: 'PostToolUse', tool: 'run_command' });
  assert.deepEqual(normalizeAgyHook('Stop', { ...common, terminationReason: 'NO_TOOL_CALL', fullyIdle: true }), { sessionId: 'c5b00cee', event: 'Stop', reason: 'NO_TOOL_CALL' });
  assert.equal(normalizeAgyHook('PreToolUse', common), undefined);
  assert.equal(normalizeAgyHook('Stop', null), undefined);
  assert.equal(normalizeAgyHook('Stop', {}), undefined);
  // It goes back on the command line as --conversation: nothing that reads as a flag.
  assert.equal(normalizeAgyHook('Stop', { conversationId: '--dangerously-skip-permissions' }), undefined);
  assert.equal(normalizeAgyHook('Stop', { conversationId: 'a b' }), undefined);
});

test('hooks drive a turn: working on a model call, the tool it ran, done when it stops', () => {
  const { h, statuses } = handle({ status: 'idle' });
  assert.equal(agy.hook!.handle(h, 'PreInvocation', { conversationId: 'conv-1', invocationNum: 0 }), true);
  assert.equal(h.info.sessionId, 'conv-1');
  assert.equal(h.state.hooked, true);
  assert.equal(agy.hook!.handle(h, 'PostToolUse', { conversationId: 'conv-1', toolCall: { name: 'run_command' } }), true);
  assert.equal(h.info.activity, 'run_command');
  // A subagent's conversation, mid-turn, is not the desk's.
  assert.equal(agy.hook!.handle(h, 'PreInvocation', { conversationId: 'child', invocationNum: 0 }), false);
  assert.equal(agy.hook!.handle(h, 'Stop', { conversationId: 'child' }), false);
  assert.equal(h.info.sessionId, 'conv-1');
  assert.equal(agy.hook!.handle(h, 'Stop', { conversationId: 'conv-1', terminationReason: 'NO_TOOL_CALL' }), true);
  assert.deepEqual(statuses, ['working', 'done']);
  // At rest, a new conversation is one started over in the terminal (/clear).
  assert.equal(agy.hook!.handle(h, 'PreInvocation', { conversationId: 'conv-2', invocationNum: 0 }), true);
  assert.equal(h.info.sessionId, 'conv-2');
  assert.equal(h.info.status, 'working');
});

const SCREEN = {
  working: '> Say just the word banana.\n⡿  Generating...\n────\n>\n────\nesc to cancel        accept-edits · Gemini 3.8 Flash · low\n\n',
  idle: '  banana\n────\n>\n────\n? for shortcuts        accept-edits · Gemini 3.8 Flash · low\n',
  asking: 'Requesting permission for:\n   ls -a | wc -l\n\nRun this command?\n> 1. Yes, run command\n  4. No, cancel\n\n  ↑/↓ Navigate · tab Amend\nesc to cancel        accept-edits · Gemini 3.8 Flash · low\n',
  trust: 'Do you trust the contents of this project?\n\n> Yes, I trust this folder\n  No, exit\n\n  ↑/↓ Navigate · enter Confirm      accept-edits · Gemini 3.8 Flash · low\n',
  login: ' Welcome to the Antigravity CLI. You are currently not signed in.\n\n Select login method:\n > 1. Google OAuth\n2. Use a Google Cloud project\n\n↑/↓ Navigate · enter Select\n',
  signingIn: ' Welcome to the Antigravity CLI. You are currently not signed in.\n\n ⣷  Signing in...\n',
};

test('reads the trust and sign-in screens, and not the moment it checks its sign-in', () => {
  assert.match(agyBlocked(SCREEN.trust) ?? '', /trust this folder/);
  assert.match(agyBlocked(SCREEN.login) ?? '', /signed in/);
  assert.match(agyBlocked('Verify your account to continue. https://example.com') ?? '', /verified/);
  assert.equal(agyBlocked(SCREEN.signingIn), undefined);
  assert.equal(agyBlocked(SCREEN.idle), undefined);
  assert.equal(agyBlocked(SCREEN.working), undefined);
});

test('reads working, asking and at rest off its footer', () => {
  assert.equal(agyScreen(SCREEN.working), 'working');
  assert.equal(agyScreen(SCREEN.idle), 'idle');
  assert.equal(agyScreen(SCREEN.asking), 'asking');
  assert.equal(agyScreen(SCREEN.trust), undefined);
  assert.equal(agyScreen(''), undefined);
});

test('with no hooks on the run, the screen says how it is doing', () => {
  const { h, statuses } = handle({ status: 'idle' });
  agy.screen!.watch!(h, SCREEN.working);
  agy.screen!.watch!(h, SCREEN.asking);
  assert.equal(h.info.activity, 'Waiting for you in its terminal');
  agy.screen!.watch!(h, SCREEN.working);
  agy.screen!.watch!(h, SCREEN.idle);
  agy.screen!.watch!(h, SCREEN.idle);
  assert.deepEqual(statuses, ['working', 'needs_input', 'working', 'done']);
});

test('with hooks on the run, the screen only says what they cannot: a prompt waiting on you', () => {
  const { h, statuses } = handle({ status: 'idle' });
  agy.hook!.handle(h, 'PreInvocation', { conversationId: 'conv-1', invocationNum: 0 });
  agy.hook!.handle(h, 'Stop', { conversationId: 'conv-1' });
  // The footer lags the Stop hook by a frame: that's no new turn.
  agy.screen!.watch!(h, SCREEN.working);
  assert.equal(h.info.status, 'done');
  agy.hook!.handle(h, 'PreInvocation', { conversationId: 'conv-1', invocationNum: 0 });
  agy.screen!.watch!(h, SCREEN.asking);
  // Answered: its tool runs.
  agy.hook!.handle(h, 'PostToolUse', { conversationId: 'conv-1', toolCall: { name: 'run_command' } });
  agy.screen!.watch!(h, SCREEN.idle);
  assert.deepEqual(statuses, ['working', 'done', 'working', 'needs_input', 'working']);
});

test('a run with no hooks has its conversation read off its own log, so it can be resumed', (t) => {
  const dir = scratch(t);
  const setup = agy.prepare!({ dataDir: path.join(dir, 'data'), dshProfile: 'acp' });
  const { h } = handle();
  agy.launch({ h, args: [], cwd: dir, setup });
  agy.screen!.watch!(h, SCREEN.idle);
  assert.equal(h.info.sessionId, undefined);
  writeFileSync(path.join(dir, 'data', 'agy-logs', 'w1.log'), [
    'I1009 21:11:32.387248     189 conversation_manager.go:575] Starting new conversation (agent=false)',
    'I1009 21:11:32.394379     189 server.go:1274] Created conversation 4da9bbbb-8270-461f-b506-76c164e59e7e',
    'I1009 21:11:32.396086     189 conversation_manager.go:967] Streaming conversation 4da9bbbb-8270-461f-b506-76c164e59e7e',
    'I1009 21:11:40.000000     189 conversation_manager.go:967] Streaming conversation 99999999-8270-461f-b506-76c164e59e7e',
  ].join('\n'));
  h.state.logReadAt = 0;
  agy.screen!.watch!(h, SCREEN.idle);
  assert.equal(h.info.sessionId, '4da9bbbb-8270-461f-b506-76c164e59e7e');
  assert.equal(agyLogConversation('Streaming conversation --evil'), undefined);
});

test('puts a worker\'s hook in its folder\'s .agents/hooks.json and takes the file away with it', (t) => {
  const dir = scratch(t);
  const cwd = path.join(dir, 'worktree');
  mkdirSync(cwd);
  execFileSync('git', ['init', '-q', cwd]);
  const hook = writeAgyHook(path.join(dir, 'data'));
  assert.equal(addAgyHooks(cwd, hook, 'abc123'), true);
  const entry = readHooks(cwd)['agent-office-abc123'];
  assert.deepEqual(Object.keys(entry), ['PreInvocation', 'PostToolUse', 'Stop']);
  assert.ok(entry.PreInvocation[0].command.endsWith(` 'PreInvocation' 'abc123'`));
  assert.equal(entry.PostToolUse[0].matcher, '*');
  assert.ok(entry.PostToolUse[0].hooks[0].command.includes(hook));
  assert.equal(entry.Stop[0].timeout, 5);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }), '');
  // Workers sharing a folder keep their own.
  assert.equal(addAgyHooks(cwd, hook, 'other'), true);
  removeAgyHooks(cwd, 'abc123');
  assert.deepEqual(Object.keys(readHooks(cwd)), ['agent-office-other']);
  removeAgyHooks(cwd, 'other');
  assert.equal(existsSync(hooksFile(cwd)), false);
  assert.equal(existsSync(path.join(cwd, '.agents')), false);
  removeAgyHooks(cwd, 'other');
  assert.equal(addAgyHooks(cwd, hook, "bad'id"), false);
});

test('a project\'s own .agents/hooks.json keeps its hooks and comes back byte for byte', (t) => {
  const dir = scratch(t);
  const hook = writeAgyHook(path.join(dir, 'data'));
  mkdirSync(path.join(dir, '.agents'));
  writeFileSync(path.join(dir, '.agents', 'rules.md'), 'be kind\n');
  const original = '{\n\t"lint": {\n\t\t"PostToolUse": [{ "matcher": "run_command", "hooks": [{ "command": "./lint.sh" }] }]\n\t}\n}';
  writeFileSync(hooksFile(dir), original);
  assert.equal(addAgyHooks(dir, hook, 'abc123'), true);
  assert.deepEqual(Object.keys(readHooks(dir)), ['lint', 'agent-office-abc123']);
  removeAgyHooks(dir, 'abc123');
  assert.equal(readFileSync(hooksFile(dir), 'utf8'), original);
  assert.equal(existsSync(path.join(dir, '.agents', 'rules.md')), true);
  // One the office can't read is left as it is.
  writeFileSync(hooksFile(dir), '{ // ours\n}');
  assert.equal(addAgyHooks(dir, hook, 'abc123'), false);
  assert.equal(readFileSync(hooksFile(dir), 'utf8'), '{ // ours\n}');
});

/** Runs the helper as agy would for one hook, and says what the office's hook server got. */
async function runHelper(t: { after(fn: () => void): void }, argv: string[], env: Record<string, string>, input: unknown) {
  const dir = scratch(t);
  const received: { url?: string; authorization?: string; body?: unknown }[] = [];
  const server = createServer((req, res) => {
    if (req.method !== 'POST') return void res.writeHead(404).end();
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const child = spawn(process.execPath, [writeAgyHook(dir), ...argv], {
      env: { PATH: process.env.PATH, AGENT_OFFICE_HOOK_URL: `http://127.0.0.1:${address.port}`, AGENT_OFFICE_HOOK_TOKEN: 'hook-token', ...env },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const stdout = await new Promise<string>((resolve, reject) => {
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.on('error', reject);
      child.on('close', () => resolve(output));
      child.stdin.end(JSON.stringify(input));
    });
    return { stdout, received };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('helper forwards only the bounded fields, for its own worker, and always answers {}', async (t) => {
  const input = { conversationId: 'conv-1', toolCall: { name: 'run_command', args: { CommandLine: 'cat .env' } }, transcriptPath: '/secret', stepIdx: 3 };
  const own = await runHelper(t, ['PostToolUse', 'w1'], { AGENT_OFFICE_WORKER_ID: 'w1' }, input);
  assert.equal(own.stdout, '{}');
  assert.deepEqual(own.received, [{ url: '/hooks/agy?worker=w1&event=PostToolUse', authorization: 'Bearer hook-token', body: { conversationId: 'conv-1', toolCall: { name: 'run_command' } } }]);
  // Another worker's agy in the same folder runs it too: it doesn't speak for this one.
  const other = await runHelper(t, ['Stop', 'w1'], { AGENT_OFFICE_WORKER_ID: 'w2' }, { conversationId: 'conv-9' });
  assert.equal(other.stdout, '{}');
  assert.deepEqual(other.received, []);
  // Someone's agy outside the office: nothing to report to.
  const outside = await runHelper(t, ['Stop', 'w1'], { AGENT_OFFICE_HOOK_URL: '' }, { conversationId: 'conv-9' });
  assert.equal(outside.stdout, '{}');
});
