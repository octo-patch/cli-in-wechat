import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

import { DEFAULT_SETTINGS, type IntermediateMessage, type UserSettings } from '../src/adapters/base.js';
import { KimiAdapter, type KimiSpawn } from '../src/adapters/kimi.js';

interface SpawnCapture {
  command?: string;
  args?: string[];
  options?: SpawnOptions;
}

// Shape mirrors PromptJsonWriter / writeResumeHint in @moonshot-ai/kimi-code 2.3.1.
const STREAM_JSONL = [
  { role: 'meta', type: 'system.version', version: '2.3.1' },
  {
    role: 'assistant',
    content: 'Let me look.',
    tool_calls: [{ type: 'function', id: 'call_1', function: { name: 'Bash', arguments: '{"command":"ls"}' } }],
  },
  { role: 'tool', tool_call_id: 'call_1', content: 'a.txt\nb.txt\nExit code 0' },
  { role: 'meta', type: 'turn.step.retrying', failed_attempt: 1, next_attempt: 2, max_attempts: 3 },
  { role: 'assistant', content: '• 两个文件：\n  - a.txt\n  - b.txt' },
  {
    role: 'meta', type: 'session.resume_hint', session_id: 'session_abc',
    command: 'kimi -r session_abc', content: 'To resume this session: kimi -r session_abc',
  },
].map((event) => JSON.stringify(event)).join('\n') + '\n';

function createFakeSpawn(stdoutChunks: string[], stderrText = '', closeCode = 0): {
  spawn: KimiSpawn;
  capture: SpawnCapture;
} {
  const capture: SpawnCapture = {};
  const spawn: KimiSpawn = (command, args, options) => {
    capture.command = command;
    capture.args = [...args];
    capture.options = options;

    const child = new EventEmitter() as unknown as ChildProcess;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, { stdin: null, stdout, stderr, killed: false, exitCode: null, pid: 4243, kill: () => true });

    setImmediate(async () => {
      for (const chunk of stdoutChunks) {
        stdout.write(chunk);
        await new Promise((r) => setImmediate(r));
      }
      stdout.end();
      stderr.end(stderrText);
      await new Promise((r) => setImmediate(r));
      Object.assign(child, { exitCode: closeCode });
      child.emit('close', closeCode, null);
    });
    return child;
  };
  return { spawn, capture };
}

function settings(overrides: Partial<UserSettings> = {}): UserSettings {
  return { ...DEFAULT_SETTINGS, workDir: '/fixture-work', sessionIds: {}, ...overrides };
}

test('Kimi builds stream-json argv with prompt on argv and resumes with -S <id>', async () => {
  const fake = createFakeSpawn([STREAM_JSONL]);
  const adapter = new KimiAdapter(fake.spawn);

  await adapter.execute('say "hi" & 100%', {
    settings: settings({ model: 'kimi-k3', addDir: '/extra', sessionIds: { kimi: 'session_prev' } }),
    extraArgs: ['--fixture-extra'],
  });

  assert.equal(fake.capture.command, 'kimi');
  assert.deepEqual(fake.capture.args, [
    '-S', 'session_prev',
    '-m', 'kimi-k3',
    '--add-dir', '/extra',
    '--output-format', 'stream-json',
    '-p', 'say "hi" & 100%',
    '--fixture-extra',
  ]);
  assert.equal(fake.capture.options?.cwd, '/fixture-work');
  assert.ok(!fake.capture.args!.includes('--continue'));
});

test('Kimi treats the legacy continue sentinel as no session', async () => {
  const fake = createFakeSpawn([STREAM_JSONL]);
  const adapter = new KimiAdapter(fake.spawn);

  const result = await adapter.execute('hello', { settings: settings({ sessionIds: { kimi: 'continue' } }) });

  assert.deepEqual(fake.capture.args, ['--output-format', 'stream-json', '-p', 'hello']);
  assert.equal(result.sessionId, 'session_abc');
  assert.equal(result.error, undefined);
});

test('Kimi parses stream-json into final text, session id and intermediate events', async () => {
  // Split mid-line and mid-character to exercise the line buffer + UTF-8 decoding.
  const bytes = Buffer.from(STREAM_JSONL, 'utf8');
  const cut1 = STREAM_JSONL.indexOf('"tool"') + 3;
  const cut2 = Buffer.from(STREAM_JSONL.slice(0, STREAM_JSONL.indexOf('两'))).length + 1;
  const chunks = [bytes.subarray(0, cut1), bytes.subarray(cut1, cut2), bytes.subarray(cut2)]
    .map((b) => b as unknown as string);
  const fake = createFakeSpawn(chunks, 'kimi: some tool progress\n');
  const activity: IntermediateMessage[] = [];
  const adapter = new KimiAdapter(fake.spawn);

  const result = await adapter.execute('list files', {
    settings: settings({ msgMode: 'normal' }),
    onIntermediate: (m) => activity.push(m),
  });

  assert.deepEqual(result, { text: '• 两个文件：\n  - a.txt\n  - b.txt', sessionId: 'session_abc' });
  assert.deepEqual(activity.map((m) => m.type), ['text', 'tool_use', 'tool_result', 'text']);
  assert.equal(activity[0].content, 'Let me look.');
  assert.equal(activity[1].toolName, 'Bash');
  assert.match(activity[1].content, /ls/);
  assert.deepEqual(activity[2], { type: 'tool_result', content: '  ↳ Exit: 0', toolName: 'Bash' });
  assert.equal(activity[3].content, '• 两个文件：\n  - a.txt\n  - b.txt');
  assert.equal(adapter.capabilities.streaming, true);
  assert.equal(adapter.capabilities.jsonOutput, true);
});

test('Kimi compact mode suppresses intermediate events but keeps the result', async () => {
  const fake = createFakeSpawn([STREAM_JSONL]);
  const activity: IntermediateMessage[] = [];
  const adapter = new KimiAdapter(fake.spawn);

  const result = await adapter.execute('x', {
    settings: settings({ msgMode: 'compact' }),
    onIntermediate: (m) => activity.push(m),
  });

  assert.deepEqual(activity, []);
  assert.equal(result.text, '• 两个文件：\n  - a.txt\n  - b.txt');
});

test('Kimi never returns stderr as the answer when stdout is empty', async () => {
  const stderr = 'kimi version 2.3.1\n• thinking about it...\nWarning: x\nError: provider unauthorized\n';
  const fake = createFakeSpawn([], stderr, 1);
  const adapter = new KimiAdapter(fake.spawn);

  const result = await adapter.execute('x', { settings: settings() });

  assert.equal(result.error, true);
  assert.match(result.text, /^exit 1\n/);
  assert.match(result.text, /provider unauthorized/);
  assert.equal(result.sessionId, undefined);
  assert.equal(result.sessionExpired, false);
});

test('Kimi exit 0 with an empty stdout is still an error, not a stderr answer', async () => {
  const fake = createFakeSpawn([], '• some thinking\n', 0);
  const result = await new KimiAdapter(fake.spawn).execute('x', { settings: settings() });

  assert.equal(result.error, true);
  assert.equal(result.text, 'exit 0\n• some thinking');
});

test('Kimi reports the session lock (exit 4) readably and keeps the session', async () => {
  const line = JSON.stringify({ type: 'error', code: 'session.occupied', message: 'Session "session_prev" is in use' }) + '\n';
  const fake = createFakeSpawn([line], '', 4);
  const result = await new KimiAdapter(fake.spawn).execute('x', {
    settings: settings({ sessionIds: { kimi: 'session_prev' } }),
  });

  assert.equal(result.error, true);
  assert.match(result.text, /会话锁/);
  assert.match(result.text, /is in use/);
  assert.equal(result.sessionId, 'session_prev');
  assert.equal(result.sessionExpired, undefined);
});

test('Kimi flags a missing resumed session as expired', async () => {
  const fake = createFakeSpawn([], 'Error: Session "session_gone" not found.\n', 1);
  const result = await new KimiAdapter(fake.spawn).execute('x', {
    settings: settings({ sessionIds: { kimi: 'session_gone' } }),
  });

  assert.equal(result.error, true);
  assert.equal(result.sessionExpired, true);
  assert.match(result.text, /not found/);
});

test('Kimi flags a session from another directory as expired', async () => {
  const stderr = 'Session "s1" was created under a different directory.\n  cd "/old" && kimi -r s1\n';
  const fake = createFakeSpawn([], stderr, 1);
  const result = await new KimiAdapter(fake.spawn).execute('x', {
    settings: settings({ sessionIds: { kimi: 's1' } }),
  });

  assert.equal(result.sessionExpired, true);
});
