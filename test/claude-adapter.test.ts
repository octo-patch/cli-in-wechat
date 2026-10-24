import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import { DEFAULT_SETTINGS, type IntermediateMessage, type UserSettings } from '../src/adapters/base.js';
import { ClaudeAdapter, type ClaudeQuery, type ClaudeSpawn } from '../src/adapters/claude.js';

type Params = { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options };
type Script = (params: Params) => AsyncGenerator<any>;

const SID = 'sess-1';

function fakeQuery(script: Script) {
  const calls: Params[] = [];
  const query = ((params: Params) => { calls.push(params); return script(params); }) as unknown as ClaudeQuery;
  return { query, calls, load: async () => query };
}

interface SpawnCapture { command?: string; args?: string[]; options?: SpawnOptions; stdin: string; count: number }

function fakeSpawn(stdoutText: string, closeCode = 0): { spawn: ClaudeSpawn; capture: SpawnCapture } {
  const capture: SpawnCapture = { stdin: '', count: 0 };
  const spawn = ((command: string, args: string[], options: SpawnOptions) => {
    capture.count++;
    capture.command = command;
    capture.args = [...args];
    capture.options = options;
    const child = new EventEmitter() as unknown as ChildProcess;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk: string) => { capture.stdin += chunk; });
    Object.assign(child, { stdin, stdout, stderr, killed: false, exitCode: null, pid: 4242, kill: () => true });
    queueMicrotask(() => {
      stdout.end(stdoutText);
      stderr.end();
      Object.assign(child, { exitCode: closeCode });
      child.emit('close', closeCode, null);
    });
    return child;
  }) as unknown as ClaudeSpawn;
  return { spawn, capture };
}

function settings(over: Partial<UserSettings> = {}): UserSettings {
  return { ...DEFAULT_SETTINGS, msgMode: 'normal', sessionIds: {}, ...over };
}

const init = (permissionMode = 'auto') => ({ type: 'system', subtype: 'init', session_id: SID, permissionMode });
const success = (result: string, extra: Record<string, unknown> = {}) => ({
  type: 'result', subtype: 'success', is_error: false, result, session_id: SID, total_cost_usd: 0.0123, ...extra,
});
const assistant = (content: unknown[], parent: string | null = null) => ({
  type: 'assistant', parent_tool_use_id: parent, session_id: SID, message: { role: 'assistant', content },
});
const toolResults = (content: unknown[], parent: string | null = null) => ({
  type: 'user', parent_tool_use_id: parent, session_id: SID, message: { role: 'user', content },
});

const CLI_STDOUT = [
  { type: 'assistant', message: { content: [{ type: 'text', text: 'cli answer' }] } },
  { type: 'result', subtype: 'success', is_error: false, result: 'cli answer', session_id: 'cli-sess', duration_ms: 5, total_cost_usd: 0.5 },
].map((o) => JSON.stringify(o)).join('\n');

test('SDK path maps options, session id, cost, and tool_use_id pairing; skips subagent internals', async () => {
  const fake = fakeQuery(async function* () {
    yield init();
    yield assistant([
      { type: 'thinking', thinking: 'hmm' },
      { type: 'tool_use', id: 'tu_bash', name: 'Bash', input: { command: 'false' } },
      { type: 'tool_use', id: 'tu_agent', name: 'Agent', input: { subagent_type: 'Explore', description: 'look around' } },
    ]);
    // Subagent internals: neither the tool call nor its result may reach WeChat.
    yield assistant([{ type: 'tool_use', id: 'tu_sub', name: 'Read', input: { file_path: '/x/secret.txt' } }], 'tu_agent');
    yield toolResults([{ type: 'tool_result', tool_use_id: 'tu_sub', content: 'secret' }], 'tu_agent');
    yield { type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: 'tu_agent', description: 'look around', session_id: SID };
    yield { type: 'tool_progress', tool_use_id: 'tu_agent', tool_name: 'Agent', parent_tool_use_id: null, elapsed_time_seconds: 3, session_id: SID };
    yield { type: 'system', subtype: 'task_progress', task_id: 't1', description: 'x', usage: {}, session_id: SID };
    // Results arrive in the opposite order of the calls: pairing must follow tool_use_id.
    yield toolResults([{ type: 'tool_result', tool_use_id: 'tu_agent', content: 'Agent completed with no output' }]);
    yield toolResults([{ type: 'tool_result', tool_use_id: 'tu_bash', content: 'Exit code 1' }]);
    yield assistant([{ type: 'text', text: 'done' }]);
    yield success('final');
  });
  const spawn = fakeSpawn(CLI_STDOUT);
  const activity: IntermediateMessage[] = [];
  const adapter = new ClaudeAdapter(fake.load, spawn.spawn);

  const result = await adapter.execute('hi', {
    settings: settings({
      mode: 'auto', effort: 'xhigh', model: 'opus', maxTurns: 7, maxBudget: 2,
      allowedTools: 'Read, Bash', disallowedTools: 'WebFetch,  Write', addDir: '/extra',
      systemPrompt: 'be brief', workDir: '/work', sessionIds: { claude: 'old-sess' },
    }),
    onIntermediate: (m) => activity.push(m),
  });

  assert.equal(spawn.capture.count, 0);
  assert.equal(fake.calls.length, 1);
  const { prompt, options } = fake.calls[0];
  assert.equal(prompt, 'hi');
  assert.equal(options?.permissionMode, 'auto');
  assert.equal(options?.allowDangerouslySkipPermissions, undefined);
  assert.equal(options?.maxTurns, 7);
  assert.equal(options?.effort, 'xhigh');
  assert.equal(options?.model, 'opus');
  assert.equal(options?.maxBudgetUsd, 2);
  assert.deepEqual(options?.allowedTools, ['Read', 'Bash']);
  assert.deepEqual(options?.disallowedTools, ['WebFetch', 'Write']);
  assert.deepEqual(options?.additionalDirectories, ['/extra']);
  assert.deepEqual(options?.systemPrompt, { type: 'preset', preset: 'claude_code', append: 'be brief' });
  assert.equal(options?.resume, 'old-sess');
  assert.equal(options?.cwd, '/work');
  assert.equal(typeof options?.canUseTool, 'function');

  assert.equal(result.text, 'final');
  assert.equal(result.thinking, 'hmm');
  assert.equal(result.sessionId, SID);
  assert.equal(result.cost, 0.0123);
  assert.equal(result.error, false);
  assert.deepEqual(activity, [
    { type: 'thinking', content: 'hmm' },
    { type: 'tool_use', content: '- Shell Command: `false`', toolName: 'Bash' },
    { type: 'tool_use', content: '- Agent: `Explore` — look around', toolName: 'Agent' },
    { type: 'tool_result', content: '  ↳ Completed', toolName: 'Agent' },
    { type: 'tool_result', content: '  ↳ Exit: 1', toolName: 'Bash' },
    { type: 'text', content: 'done' },
  ]);
});

test('SDK error thrown after a result does not re-run the task via the CLI', async () => {
  const fake = fakeQuery(async function* () {
    yield init();
    yield { type: 'result', subtype: 'error_max_turns', is_error: true, session_id: SID, total_cost_usd: 0.2, errors: [] };
    throw new Error('Claude Code process exited with code 1');
  });
  const spawn = fakeSpawn(CLI_STDOUT);
  const adapter = new ClaudeAdapter(fake.load, spawn.spawn);

  const result = await adapter.execute('hi', { settings: settings({ maxTurns: 3 }) });

  assert.equal(spawn.capture.count, 0);
  assert.equal(result.error, true);
  assert.equal(result.sessionId, SID);
  assert.equal(result.cost, 0.2);
  assert.match(result.text, /最大轮数（3）/);
});

test('SDK failure after the first message returns an error instead of falling back', async () => {
  const fake = fakeQuery(async function* () {
    yield init();
    yield assistant([{ type: 'tool_use', id: 'tu1', name: 'Write', input: { file_path: '/a.txt' } }]);
    throw new Error('stream broke');
  });
  const spawn = fakeSpawn(CLI_STDOUT);
  const adapter = new ClaudeAdapter(fake.load, spawn.spawn);

  const result = await adapter.execute('hi', { settings: settings() });

  assert.equal(spawn.capture.count, 0);
  assert.equal(result.error, true);
  assert.equal(result.sessionId, SID, 'session id from init survives the failure');
  assert.match(result.text, /stream broke/);
});

test('SDK that cannot start falls back to the CLI with corrected argv', async () => {
  const cases: Array<{ name: string; load: () => Promise<ClaudeQuery> }> = [
    { name: 'import failure', load: async () => { throw new Error('Cannot find package'); } },
    { name: 'throws before first message', load: fakeQuery(async function* () { throw new Error('spawn ENOENT'); }).load },
  ];
  for (const c of cases) {
    for (const [mode, permissionMode] of [['auto', 'auto'], ['safe', 'default'], ['plan', 'plan']] as const) {
      const spawn = fakeSpawn(CLI_STDOUT);
      const adapter = new ClaudeAdapter(c.load, spawn.spawn);
      const result = await adapter.execute('hello', {
        settings: settings({ mode, maxTurns: 9, effort: 'high', disallowedTools: 'Write', addDir: '/extra', workDir: '/work', sessionIds: { claude: 'old' } }),
      });
      assert.equal(spawn.capture.count, 1, c.name);
      assert.equal(spawn.capture.command, 'claude');
      assert.deepEqual(spawn.capture.args, [
        '-p', '--output-format', 'stream-json', '--verbose',
        '--permission-mode', permissionMode,
        '--max-turns', '9',
        '--effort', 'high',
        '--disallowedTools', 'Write',
        '--add-dir', '/extra',
        '--resume', 'old',
      ], `${c.name} / ${mode}`);
      assert.equal(spawn.capture.options?.cwd, '/work');
      assert.equal(spawn.capture.stdin, 'hello');
      assert.deepEqual(result, { text: 'cli answer', thinking: undefined, sessionId: 'cli-sess', cost: 0.5, duration: 5, error: false, sessionExpired: false });
    }
  }
});

test('safe and plan modes deny non-question tools with a readable reason; AskUserQuestion still asks', async () => {
  for (const [mode, permissionMode] of [['safe', 'default'], ['plan', 'plan'], ['auto', 'auto']] as const) {
    const decisions: any[] = [];
    let asked: any;
    const fake = fakeQuery(async function* (params) {
      yield init(permissionMode);
      const ctx = { signal: new AbortController().signal, toolUseID: 'tu' };
      decisions.push(await params.options!.canUseTool!('Bash', { command: 'rm -rf build' }, ctx));
      decisions.push(await params.options!.canUseTool!('ExitPlanMode', { plan: 'p' }, ctx));
      decisions.push(await params.options!.canUseTool!('AskUserQuestion', { questions: [{ question: 'Q?', options: [{ label: 'A' }] }] }, ctx));
      yield success('ok');
    });
    const adapter = new ClaudeAdapter(fake.load, fakeSpawn(CLI_STDOUT).spawn);
    const result = await adapter.execute('hi', {
      settings: settings({ mode }),
      askUser: async (req) => { asked = req; return { 'Q?': 'A' }; },
    });

    assert.equal(fake.calls[0].options?.permissionMode, permissionMode);
    assert.equal(result.text, 'ok');
    assert.equal(decisions[0].behavior, 'deny', mode);
    assert.ok(decisions[0].message.includes(mode) && decisions[0].message.includes('Bash'), decisions[0].message);
    if (mode === 'safe') assert.match(decisions[0].message, /微信内审批将在后续版本支持；可用 \/mode auto/);
    assert.equal(decisions[1].behavior, 'deny');
    if (mode === 'plan') assert.match(decisions[1].message, /完整计划/);
    assert.deepEqual(asked, { questions: [{ question: 'Q?', options: [{ label: 'A' }] }] });
    assert.deepEqual(decisions[2], {
      behavior: 'allow',
      updatedInput: { questions: [{ question: 'Q?', options: [{ label: 'A' }] }], answers: { 'Q?': 'A' } },
    });
  }
});

test('images are sent natively as base64 blocks via a one-message streaming prompt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-adapter-'));
  try {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-body')]);
    const pngPath = join(dir, 'photo.dat');
    writeFileSync(pngPath, png);
    const bmpPath = join(dir, 'pic.bmp');
    writeFileSync(bmpPath, Buffer.from('BM-not-supported'));
    const docPath = join(dir, 'notes.txt');
    writeFileSync(docPath, 'hello');

    const sent: SDKUserMessage[] = [];
    const fake = fakeQuery(async function* (params) {
      assert.notEqual(typeof params.prompt, 'string');
      for await (const m of params.prompt as AsyncIterable<SDKUserMessage>) sent.push(m);
      yield init();
      yield success('saw it');
    });
    const adapter = new ClaudeAdapter(fake.load, fakeSpawn(CLI_STDOUT).spawn);
    const result = await adapter.execute('what is this', {
      settings: settings(),
      media: [
        { type: 'image', path: pngPath, fileName: 'photo.dat' },
        { type: 'image', path: bmpPath, fileName: 'pic.bmp' },
        { type: 'file', path: docPath, fileName: 'notes.txt', size: 5 },
      ],
    });

    assert.equal(result.text, 'saw it');
    assert.equal(sent.length, 1, 'input stream ends after one message');
    assert.equal(sent[0].type, 'user');
    assert.equal(sent[0].parent_tool_use_id, null);
    const content = sent[0].message.content as any[];
    assert.equal(content.length, 2);
    assert.deepEqual(content[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } });
    assert.equal(content[1].type, 'text');
    assert.match(content[1].text, /notes\.txt/);
    assert.match(content[1].text, /pic\.bmp/, 'unsupported image formats stay as paths');
    assert.doesNotMatch(content[1].text, /photo\.dat/, 'inline images are not listed again');
    assert.match(content[1].text, /用户说：what is this/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('text-only prompts stay a plain string', async () => {
  const fake = fakeQuery(async function* () { yield init(); yield success('ok'); });
  const adapter = new ClaudeAdapter(fake.load, fakeSpawn(CLI_STDOUT).spawn);
  await adapter.execute('plain', { settings: settings({ msgMode: 'compact' }) });
  assert.equal(fake.calls[0].prompt, 'plain');
});

test('cancel and idle timeout return the early session id without falling back', async () => {
  // Cancel: the caller aborts while the SDK is mid-run.
  const ac = new AbortController();
  const cancelFake = fakeQuery(async function* (params) {
    yield init();
    ac.abort();
    if (params.options!.abortController!.signal.aborted) throw new Error('aborted');
    yield success('never');
  });
  const spawn = fakeSpawn(CLI_STDOUT);
  const cancelled = await new ClaudeAdapter(cancelFake.load, spawn.spawn).execute('hi', { settings: settings(), signal: ac.signal });
  assert.deepEqual(cancelled, { text: '已取消', sessionId: SID, error: true });

  // Idle timeout: the SDK goes silent after init until our abort fires.
  const idleFake = fakeQuery(async function* (params) {
    yield init();
    const signal = params.options!.abortController!.signal;
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    throw new Error('aborted');
  });
  const timedOut = await new ClaudeAdapter(idleFake.load, spawn.spawn).execute('hi', { settings: settings(), timeout: 20 });
  assert.equal(timedOut.error, true);
  assert.equal(timedOut.sessionId, SID);
  assert.match(timedOut.text, /执行超时/);
  assert.equal(spawn.capture.count, 0);
});

test('error result on a resumed session is flagged as expired', async () => {
  const fake = fakeQuery(async function* () {
    yield { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: SID, total_cost_usd: 0, errors: ['No conversation found with session ID: old'] };
  });
  const adapter = new ClaudeAdapter(fake.load, fakeSpawn(CLI_STDOUT).spawn);
  const result = await adapter.execute('hi', { settings: settings({ sessionIds: { claude: 'old' } }) });
  assert.equal(result.error, true);
  assert.equal(result.sessionExpired, true);
  assert.match(result.text, /No conversation found/);
});
