import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

import { DEFAULT_SETTINGS, type IntermediateMessage, type UserSettings } from '../src/adapters/base.js';
import { GeminiAdapter, type GeminiSpawn } from '../src/adapters/gemini.js';

interface SpawnCall {
  command: string;
  args: string[];
  options: SpawnOptions;
  stdin: string;
}

interface FakeRun {
  /** stdout chunks, written one by one (lets tests split a JSON line across chunks). */
  stdout?: string[];
  stderr?: string;
  code?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function jsonl(events: object[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

function createFakeSpawn(runs: FakeRun[]): { spawn: GeminiSpawn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawn: GeminiSpawn = (command, args, options) => {
    const run = runs[calls.length] ?? runs[runs.length - 1];
    const call: SpawnCall = { command, args: [...args], options, stdin: '' };
    calls.push(call);

    const child = new EventEmitter() as unknown as ChildProcess;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk: string) => { call.stdin += chunk; });
    Object.assign(child, { stdin, stdout, stderr, killed: false, exitCode: null, pid: 4242, kill: () => true });

    queueMicrotask(async () => {
      for (const chunk of run.stdout ?? []) {
        stdout.write(chunk);
        await new Promise((r) => setImmediate(r));
      }
      stdout.end();
      stderr.end(run.stderr ?? '');
      await new Promise((r) => setImmediate(r));
      const code = run.code ?? 0;
      Object.assign(child, { exitCode: code });
      child.emit('close', code, null);
    });
    return child;
  };
  return { spawn, calls };
}

function settings(over: Partial<UserSettings> = {}): UserSettings {
  return { ...DEFAULT_SETTINGS, sessionIds: {}, workDir: '/fixture-work', ...over };
}

const TURN = jsonl([
  { type: 'init', timestamp: 't', session_id: 'ses-from-init', model: 'gemini-2.5-pro' },
  { type: 'message', timestamp: 't', role: 'user', content: 'hi' },
  { type: 'message', timestamp: 't', role: 'assistant', content: 'Let me ', delta: true },
  { type: 'message', timestamp: 't', role: 'assistant', content: 'check the files.', delta: true },
  { type: 'tool_use', timestamp: 't', tool_name: 'run_shell_command', tool_id: 'c1', parameters: { command: 'ls -la' } },
  { type: 'tool_result', timestamp: 't', tool_id: 'c1', status: 'success', output: 'a.txt\nExit code 0' },
  { type: 'tool_use', timestamp: 't', tool_name: 'write_file', tool_id: 'c2', parameters: { file_path: '/w/b.txt', content: 'x' } },
  { type: 'tool_result', timestamp: 't', tool_id: 'c2', status: 'error', output: '', error: { type: 'X', message: 'disk said no' } },
  { type: 'message', timestamp: 't', role: 'assistant', content: 'Done: ', delta: true },
  { type: 'message', timestamp: 't', role: 'assistant', content: 'one file.', delta: true },
  { type: 'error', timestamp: 't', severity: 'warning', message: 'loop detected, ignore' },
  { type: 'result', timestamp: 't', status: 'success', stats: { total_tokens: 10, duration_ms: 1234, tool_calls: 2 } },
]);

test('Gemini new session: argv, trust env, stdin, stream-json aggregation', async () => {
  const fake = createFakeSpawn([{ stdout: [TURN.slice(0, 250), TURN.slice(250)] }]);
  const activity: IntermediateMessage[] = [];
  const adapter = new GeminiAdapter(fake.spawn);

  const result = await adapter.execute('  prompt  ', {
    settings: settings({ model: 'gemini-2.5-pro', includeDirs: '../a,../b', extensions: 'ext1' }),
    extraArgs: ['--fixture-extra'],
    onIntermediate: (m) => activity.push(m),
  });

  assert.equal(fake.calls.length, 1);
  const call = fake.calls[0];
  assert.equal(call.command, 'gemini');
  const sidIdx = call.args.indexOf('--session-id');
  assert.ok(sidIdx > 0);
  const generated = call.args[sidIdx + 1];
  assert.match(generated, UUID_RE);
  assert.deepEqual(call.args, [
    '--output-format', 'stream-json',
    '--approval-mode', 'yolo',
    '-m', 'gemini-2.5-pro',
    '--include-directories', '../a,../b',
    '-e', 'ext1',
    '--session-id', generated,
    '--fixture-extra',
  ]);
  assert.equal(call.options.cwd, '/fixture-work');
  assert.equal((call.options.env as NodeJS.ProcessEnv).GEMINI_CLI_TRUST_WORKSPACE, 'true');
  assert.equal(call.stdin, '  prompt  ');

  assert.deepEqual(result, {
    text: 'Let me check the files.\n\nDone: one file.',
    sessionId: 'ses-from-init',
    duration: 1234,
    error: false,
    sessionExpired: false,
  });
  assert.deepEqual(activity, [
    { type: 'text', content: 'Let me check the files.' },
    { type: 'tool_use', content: '- Shell Command: `ls -la`', toolName: 'run_shell_command' },
    { type: 'tool_result', content: '  ↳ Exit: 0', toolName: 'run_shell_command' },
    { type: 'tool_use', content: '- Write File: `b.txt`', toolName: 'write_file' },
    { type: 'tool_result', content: '  ↳ Error', toolName: 'write_file' },
    { type: 'text', content: 'Done: one file.' },
  ]);
});

test('Gemini compact mode emits nothing but keeps the full final text', async () => {
  const fake = createFakeSpawn([{ stdout: [TURN] }]);
  const activity: IntermediateMessage[] = [];
  const result = await new GeminiAdapter(fake.spawn).execute('p', {
    settings: settings({ msgMode: 'compact' }),
    onIntermediate: (m) => activity.push(m),
  });
  assert.deepEqual(activity, []);
  assert.equal(result.text, 'Let me check the files.\n\nDone: one file.');
});

test('Gemini resume passes --resume and falls back to the stored id', async () => {
  const body = jsonl([
    { type: 'message', role: 'assistant', content: 'again', delta: true },
    { type: 'result', status: 'success', stats: {} },
  ]);
  const fake = createFakeSpawn([{ stdout: [body] }]);
  const result = await new GeminiAdapter(fake.spawn).execute('p', {
    settings: settings({ sessionIds: { gemini: 'ses-old' } }),
  });
  assert.ok(fake.calls[0].args.includes('--resume'));
  assert.equal(fake.calls[0].args[fake.calls[0].args.indexOf('--resume') + 1], 'ses-old');
  assert.ok(!fake.calls[0].args.includes('--session-id'));
  assert.equal(result.sessionId, 'ses-old');
  assert.equal(result.text, 'again');
  assert.equal(result.duration, undefined);
});

test('Gemini resume failure marks the session expired', async () => {
  const fake = createFakeSpawn([{
    stderr: 'Error resuming session: Invalid session identifier "ses-gone".\n  Use --list-sessions to see available sessions',
    code: 42,
  }]);
  const result = await new GeminiAdapter(fake.spawn).execute('p', {
    settings: settings({ sessionIds: { gemini: 'ses-gone' } }),
  });
  assert.equal(result.error, true);
  assert.equal(result.sessionExpired, true);
  // Router clears then persists result.sessionId — echoing the dead id back would loop forever.
  assert.equal(result.sessionId, undefined);
  assert.match(result.text, /Invalid session identifier/);
});

test('Gemini non-session failure on a resumed session does not echo the stored id', async () => {
  const fake = createFakeSpawn([{ stderr: '[API Error: quota exceeded (Status: RESOURCE_EXHAUSTED)]', code: 1 }]);
  const result = await new GeminiAdapter(fake.spawn).execute('p', {
    settings: settings({ sessionIds: { gemini: 'ses-keep' } }),
  });
  assert.equal(result.error, true);
  assert.equal(result.sessionExpired, false);
  assert.equal(result.sessionId, undefined);
  assert.match(result.text, /配额已用尽/);
});

test('Gemini /mode maps to approval modes; explicit approvalMode wins', async () => {
  const cases: Array<[Partial<UserSettings>, string]> = [
    [{ mode: 'auto' }, 'yolo'],
    [{ mode: 'safe' }, 'default'],
    [{ mode: 'plan' }, 'plan'],
    [{ mode: 'safe', approvalMode: 'auto_edit' }, 'auto_edit'],
  ];
  for (const [over, expected] of cases) {
    const fake = createFakeSpawn([{ stdout: [jsonl([{ type: 'result', status: 'success', stats: {} }])] }]);
    await new GeminiAdapter(fake.spawn).execute('p', { settings: settings(over) });
    const args = fake.calls[0].args;
    assert.equal(args[args.indexOf('--approval-mode') + 1], expected, JSON.stringify(over));
  }
  assert.deepEqual(new GeminiAdapter().capabilities.modes, ['auto', 'safe', 'plan']);
});

test('Gemini safe mode surfaces a readable notice when confirmation-required tools are denied', async () => {
  const body = jsonl([
    { type: 'init', session_id: 's1', model: 'm' },
    { type: 'message', role: 'assistant', content: 'I will write it.', delta: true },
    { type: 'tool_use', tool_name: 'write_file', tool_id: 'w', parameters: { file_path: 'x' } },
    { type: 'tool_result', tool_id: 'w', status: 'error', output: '', error: { type: 'E', message: 'Tool execution for "WriteFile" requires user confirmation, which is not supported in non-interactive mode.' } },
    { type: 'message', role: 'assistant', content: 'Could not write.', delta: true },
    { type: 'result', status: 'success', stats: { duration_ms: 5 } },
  ]);
  const fake = createFakeSpawn([{ stdout: [body] }]);
  const activity: IntermediateMessage[] = [];
  const result = await new GeminiAdapter(fake.spawn).execute('p', {
    settings: settings({ mode: 'safe' }),
    onIntermediate: (m) => activity.push(m),
  });
  assert.equal(result.error, false);
  assert.match(result.text, /^I will write it\.\n\nCould not write\.\n\n\[Gemini 在非交互模式下.*\/mode auto\]$/s);
  // Text was streamed, so the notice must be streamed too (router only sends a footer).
  assert.match(activity[activity.length - 1].content, /\/mode auto/);
});

test('Gemini auth failure points at API key / Vertex / Antigravity', async () => {
  const body = jsonl([
    { type: 'result', status: 'error', error: { type: 'FatalAuthenticationError', message: 'Manual authorization is required but the current session is non-interactive.' }, stats: { duration_ms: 0 } },
  ]);
  const fake = createFakeSpawn([{ stdout: [body], code: 41 }]);
  const result = await new GeminiAdapter(fake.spawn).execute('p', { settings: settings() });
  assert.equal(result.error, true);
  assert.equal(result.sessionExpired, false);
  assert.equal(result.sessionId, undefined, 'startup failure must not persist a dangling session id');
  assert.match(result.text, /GEMINI_API_KEY/);
  assert.match(result.text, /Vertex/);
  assert.match(result.text, /agy/);
});

test('Gemini model-not-found and quota errors keep friendly hints', async () => {
  const notFound = createFakeSpawn([{ stderr: '[API Error: Requested entity was not found. (Status: NOT_FOUND)]', code: 1 }]);
  const r1 = await new GeminiAdapter(notFound.spawn).execute('p', { settings: settings({ model: 'gemini-9' }) });
  assert.equal(r1.error, true);
  assert.match(r1.text, /模型 "gemini-9" 不存在/);

  const quota = jsonl([
    { type: 'init', session_id: 's', model: 'm' },
    { type: 'error', severity: 'error', message: '[API Error: Resource has been exhausted (Status: RESOURCE_EXHAUSTED)] switch to another /auth method' },
    { type: 'result', status: 'error', stats: {} },
  ]);
  const q = createFakeSpawn([{ stdout: [quota], code: 1 }]);
  const r2 = await new GeminiAdapter(q.spawn).execute('p', { settings: settings() });
  assert.equal(r2.error, true);
  assert.equal(r2.sessionId, 's', 'a session the CLI reported via init is still adopted on error');
  assert.match(r2.text, /配额已用尽/);
});

test('Gemini retries without --session-id on CLIs that predate it', async () => {
  const fake = createFakeSpawn([
    { stderr: 'Unknown argument: session-id', code: 1 },
    { stdout: [jsonl([
      { type: 'init', session_id: 'ses-legacy', model: 'm' },
      { type: 'message', role: 'assistant', content: 'ok', delta: true },
      { type: 'result', status: 'success', stats: {} },
    ])] },
  ]);
  const result = await new GeminiAdapter(fake.spawn).execute('p', { settings: settings() });
  assert.equal(fake.calls.length, 2);
  assert.ok(fake.calls[0].args.includes('--session-id'));
  assert.ok(!fake.calls[1].args.includes('--session-id'));
  assert.equal(fake.calls[1].stdin, 'p');
  assert.deepEqual(result, { text: 'ok', sessionId: 'ses-legacy', duration: undefined, error: false, sessionExpired: false });
});

test('Gemini respects an explicit GEMINI_CLI_TRUST_WORKSPACE override', async () => {
  const prev = process.env.GEMINI_CLI_TRUST_WORKSPACE;
  process.env.GEMINI_CLI_TRUST_WORKSPACE = 'false';
  try {
    const fake = createFakeSpawn([{ stdout: [jsonl([{ type: 'result', status: 'success', stats: {} }])] }]);
    await new GeminiAdapter(fake.spawn).execute('p', { settings: settings() });
    assert.equal((fake.calls[0].options.env as NodeJS.ProcessEnv).GEMINI_CLI_TRUST_WORKSPACE, 'false');
  } finally {
    if (prev === undefined) delete process.env.GEMINI_CLI_TRUST_WORKSPACE;
    else process.env.GEMINI_CLI_TRUST_WORKSPACE = prev;
  }
});
