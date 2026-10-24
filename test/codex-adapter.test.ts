import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

import { DEFAULT_SETTINGS, type IntermediateMessage, type UserSettings } from '../src/adapters/base.js';
import { CodexAdapter, mapCodexEffort, type CodexSpawn } from '../src/adapters/codex.js';

interface SpawnCapture {
  command?: string;
  args?: string[];
  options?: SpawnOptions;
  stdin: string;
}

const jsonl = (events: unknown[]) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

function createFakeSpawn(stdoutText: string, closeCode = 0, stderrText = ''): { spawn: CodexSpawn; capture: SpawnCapture } {
  const capture: SpawnCapture = { stdin: '' };
  const spawn: CodexSpawn = (command, args, options) => {
    capture.command = command;
    capture.args = [...args];
    capture.options = options;

    const child = new EventEmitter() as unknown as ChildProcess;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk: string) => { capture.stdin += chunk; });
    Object.assign(child, { stdin, stdout, stderr, killed: false, exitCode: null, pid: 4243, kill: () => true });

    queueMicrotask(() => {
      // Split mid-line to exercise incremental line buffering.
      const cut = Math.floor(stdoutText.length / 2);
      stdout.write(stdoutText.slice(0, cut));
      stdout.end(stdoutText.slice(cut));
      stderr.end(stderrText);
      setImmediate(() => {
        Object.assign(child, { exitCode: closeCode });
        child.emit('close', closeCode, null);
      });
    });
    return child;
  };
  return { spawn, capture };
}

function settings(overrides: Partial<UserSettings> = {}): UserSettings {
  return { ...DEFAULT_SETTINGS, sessionIds: {}, workDir: '/fixture-work', ...overrides };
}

const OK_EVENTS = jsonl([{ type: 'thread.started', thread_id: 'thr_new' }, { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'OK' } },
  { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 } }]);

test('new session: exec --json with bypass, effort, and stdin prompt; stores real thread id', async () => {
  const fake = createFakeSpawn(OK_EVENTS);
  const result = await new CodexAdapter(fake.spawn).execute('hello', {
    settings: settings({ mode: 'auto', effort: 'max', model: 'gpt-x' }),
  });

  assert.equal(fake.capture.command, 'codex');
  assert.deepEqual(fake.capture.args, [
    'exec', '--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check',
    '-m', 'gpt-x', '-c', 'model_reasoning_effort="max"',
  ]);
  assert.equal(fake.capture.stdin, 'hello');
  assert.equal(fake.capture.options?.cwd, '/fixture-work');
  assert.deepEqual(result, { text: 'OK', thinking: undefined, sessionId: 'thr_new', error: false, sessionExpired: false });
});

test('resume: every option precedes `resume <id>`, images last', async () => {
  const fake = createFakeSpawn(jsonl([{ type: 'thread.started', thread_id: 'thr_old' },
    { type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'again' } }, { type: 'turn.completed' }]));
  const result = await new CodexAdapter(fake.spawn).execute('look', {
    settings: settings({
      mode: 'auto', sandbox: 'workspace-write', model: 'gpt-x', effort: 'med', search: true,
      profile: 'work', addDir: '/extra', sessionIds: { codex: 'thr_old' },
    }),
    extraArgs: ['--strict-config'],
    media: [
      { type: 'image', path: '/m/a.png', fileName: 'a.png' },
      { type: 'image', path: '/m/b.jpg', fileName: 'b.jpg' },
    ],
  });

  assert.deepEqual(fake.capture.args, [
    'exec', '--json', '--sandbox', 'workspace-write', '-c', 'approval_policy="never"', '--skip-git-repo-check',
    '-m', 'gpt-x', '--profile', 'work', '--add-dir', '/extra',
    '-c', 'model_reasoning_effort="medium"', '-c', 'web_search="live"', '--strict-config',
    'resume', 'thr_old', '--image', '/m/a.png', '--image', '/m/b.jpg',
  ]);
  // Image-only media goes through --image, so the prompt is untouched.
  assert.equal(fake.capture.stdin, 'look');
  assert.equal(result.sessionId, 'thr_old');
  assert.equal(result.text, 'again');
});

test('mode mapping: safe → workspace-write + never, plan → read-only; unknown effort dropped', async () => {
  const safe = createFakeSpawn(OK_EVENTS);
  await new CodexAdapter(safe.spawn).execute('x', { settings: settings({ mode: 'safe', effort: 'weird' }) });
  assert.deepEqual(safe.capture.args, ['exec', '--json', '--sandbox', 'workspace-write', '-c', 'approval_policy="never"', '--skip-git-repo-check']);

  const plan = createFakeSpawn(OK_EVENTS);
  await new CodexAdapter(plan.spawn).execute('x', { settings: settings({ mode: 'plan', effort: '' }) });
  assert.deepEqual(plan.capture.args, ['exec', '--json', '--sandbox', 'read-only', '-c', 'approval_policy="never"', '--skip-git-repo-check']);

  assert.equal(mapCodexEffort('xhigh'), 'xhigh');
  assert.equal(mapCodexEffort('minimal'), 'low');
  assert.equal(mapCodexEffort('bogus'), undefined);
});

test('legacy "last" sentinel starts a new session instead of `resume --last`', async () => {
  const fake = createFakeSpawn(OK_EVENTS);
  const result = await new CodexAdapter(fake.spawn).execute('x', { settings: settings({ sessionIds: { codex: 'last' } }) });
  assert.ok(!fake.capture.args!.includes('resume'));
  assert.ok(!fake.capture.args!.includes('--last'));
  assert.equal(result.sessionId, 'thr_new');
});

test('non-image media still goes through the text prompt', async () => {
  const fake = createFakeSpawn(OK_EVENTS);
  await new CodexAdapter(fake.spawn).execute('read it', {
    settings: settings({ workDir: '' }),
    media: [{ type: 'file', path: '/m/doc.pdf', fileName: 'doc.pdf', size: 2048 }, { type: 'image', path: '/m/c.png', fileName: 'c.png' }],
  });
  assert.match(fake.capture.stdin, /doc\.pdf/);
  assert.doesNotMatch(fake.capture.stdin, /c\.png/);
  assert.deepEqual(fake.capture.args!.slice(-2), ['--image', '/m/c.png']);
});

test('item events map to intermediate messages; every agent_message streams; final answer is the last one', async () => {
  const fake = createFakeSpawn(jsonl([
    { type: 'thread.started', thread_id: 'thr_ev' },
    { type: 'item.completed', item: { id: 'w', type: 'error', message: 'clamping hook timeout' } },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: 'thinking hard' } },
    { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Let me check.' } },
    { type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'ls -la', status: 'in_progress' } },
    { type: 'item.updated', item: { id: 'c1', type: 'command_execution', command: 'ls -la', status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'ls -la', aggregated_output: 'x', exit_code: 0, status: 'completed' } },
    { type: 'item.completed', item: { id: 'f1', type: 'file_change', changes: [{ path: '/w/src/a.ts', kind: 'update' }, { path: '/w/b.ts', kind: 'add' }], status: 'completed' } },
    { type: 'item.started', item: { id: 'p1', type: 'mcp_tool_call', server: 'docs', tool: 'search', arguments: {}, status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'p1', type: 'mcp_tool_call', server: 'docs', tool: 'search', arguments: {}, error: { message: 'boom' }, status: 'failed' } },
    { type: 'item.completed', item: { id: 's1', type: 'web_search', query: 'codex json' } },
    { type: 'item.started', item: { id: 't1', type: 'todo_list', items: [{ text: 'a', completed: false }, { text: 'b', completed: false }] } },
    { type: 'item.updated', item: { id: 't1', type: 'todo_list', items: [{ text: 'a', completed: true }, { text: 'b', completed: false }] } },
    { type: 'item.completed', item: { id: 'm2', type: 'agent_message', text: 'Done: 你好' } },
    { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } },
  ]));
  const activity: IntermediateMessage[] = [];
  const result = await new CodexAdapter(fake.spawn).execute('x', {
    settings: settings(), onIntermediate: (m) => activity.push(m),
  });

  assert.deepEqual(activity, [
    { type: 'thinking', content: 'thinking hard' },
    { type: 'text', content: 'Let me check.' },
    { type: 'tool_use', toolName: 'Bash', content: '- Shell Command: `ls -la`' },
    { type: 'tool_result', toolName: 'Bash', content: '  ↳ Exit: 0' },
    { type: 'tool_use', toolName: 'Edit', content: '- Edit File: `a.ts`\n- Write File: `b.ts`' },
    { type: 'tool_use', toolName: 'docs.search', content: '- docs.search' },
    { type: 'tool_result', toolName: 'docs.search', content: '  ↳ Error: boom' },
    { type: 'tool_use', toolName: 'WebSearch', content: '- WebSearch: `codex json`' },
    { type: 'tool_use', toolName: 'TodoWrite', content: '- TodoWrite: 0/2' },
    { type: 'tool_use', toolName: 'TodoWrite', content: '- TodoWrite: 1/2' },
    { type: 'text', content: 'Done: 你好' },
  ]);
  assert.equal(result.text, 'Done: 你好');
  assert.equal(result.thinking, 'thinking hard');
  assert.equal(result.error, false);
});

test('compact mode suppresses intermediate messages', async () => {
  const fake = createFakeSpawn(OK_EVENTS);
  const activity: IntermediateMessage[] = [];
  await new CodexAdapter(fake.spawn).execute('x', { settings: settings({ msgMode: 'compact' }), onIntermediate: (m) => activity.push(m) });
  assert.equal(activity.length, 0);
});

test('turn.failed yields a readable error and keeps the thread id', async () => {
  const fake = createFakeSpawn(jsonl([{ type: 'thread.started', thread_id: 'thr_f' }, { type: 'turn.started' },
    { type: 'turn.failed', error: { message: 'model overloaded' } }]), 1);
  const result = await new CodexAdapter(fake.spawn).execute('x', { settings: settings() });
  assert.equal(result.error, true);
  assert.equal(result.text, 'Codex 出错: model overloaded');
  assert.equal(result.sessionId, 'thr_f');
  assert.equal(result.sessionExpired, false);
});

test('missing resumed session is flagged sessionExpired', async () => {
  const fake = createFakeSpawn('', 1, 'Error: No saved session found with ID thr_gone. Run `codex exec` without resume.');
  const result = await new CodexAdapter(fake.spawn).execute('x', { settings: settings({ sessionIds: { codex: 'thr_gone' } }) });
  assert.equal(result.error, true);
  assert.equal(result.sessionExpired, true);
  assert.equal(result.sessionId, undefined);
  assert.match(result.text, /No saved session found/);
});

test('stream error event without resume is an error but not sessionExpired; ephemeral drops id', async () => {
  const fake = createFakeSpawn(jsonl([{ type: 'thread.started', thread_id: 'thr_e' }, { type: 'error', message: 'stream disconnected' }]), 1);
  const result = await new CodexAdapter(fake.spawn).execute('x', { settings: settings({ ephemeral: true }) });
  assert.equal(result.error, true);
  assert.equal(result.sessionExpired, false);
  assert.equal(result.sessionId, undefined);
  assert.equal(result.text, 'Codex 出错: stream disconnected');
  assert.ok(fakeArgsHas(fake.capture, '--ephemeral'));
});

function fakeArgsHas(capture: SpawnCapture, flag: string): boolean {
  return !!capture.args?.includes(flag);
}
