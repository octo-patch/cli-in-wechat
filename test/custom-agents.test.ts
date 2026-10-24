import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

import { DEFAULT_SETTINGS } from '../src/adapters/base.js';
import { AcpAdapter } from '../src/adapters/acp/adapter.js';
import { ACP_PRESETS } from '../src/adapters/acp/presets.js';
import { TextAdapter, type TextAgentSpec, type TextSpawn } from '../src/adapters/text.js';
import { AdapterRegistry, resolveAgentAdapters } from '../src/adapters/registry.js';
import { log } from '../src/utils/logger.js';

const settings = { ...DEFAULT_SETTINGS, workDir: '/fixture-work', sessionIds: {} };

function byName(list: { name: string }[]) {
  return new Map(list.map((a) => [a.name, a]));
}

test('validation: bad entries are warned about and skipped, never fatal', (t) => {
  const warn = t.mock.method(log, 'warn', () => {});
  const list = resolveAgentAdapters([
    null,
    { name: 'Bad Name', command: 'x', protocol: 'text' },
    { name: 'claude', command: 'x', protocol: 'text' },
    { name: 'opencode', command: 'x' },
    { name: 'empty-cmd', command: '  ', protocol: 'text' },
    { name: 'no-cmd', protocol: 'acp' },
    { name: 'bad-proto', command: 'x', protocol: 'grpc' },
    { name: 'bad-args', command: 'x', args: 'nope' },
    { name: 'bad-via', command: 'x', protocol: 'text', promptVia: 'file' },
    { name: 'ok-agent', command: 'ok', protocol: 'text' },
  ]);
  assert.equal(warn.mock.callCount(), 9);
  const names = list.map((a) => a.name);
  assert.deepEqual(names, [...ACP_PRESETS.map((p) => p.name), 'ok-agent']);
  // Non-array config is ignored entirely.
  assert.equal(resolveAgentAdapters({ name: 'x' }).length, ACP_PRESETS.length);
  assert.equal(resolveAgentAdapters(undefined).length, ACP_PRESETS.length);
});

test('merge: override preset fields, disable presets, add new acp and text agents', (t) => {
  t.mock.method(log, 'warn', () => {});
  const all = byName(resolveAgentAdapters([
    { name: 'cursor', command: 'agent' },
    { name: 'qoder', command: 'qoder', args: ['--acp', '--x'], displayName: 'Qoder!' },
    { name: 'devin', disabled: true },
    { name: 'my-acp', command: 'my-agent', args: ['acp'], protocol: 'acp', modeIds: { plan: 'p' }, env: { K: 'v' } },
    { name: 'my-text', command: 'llm', args: ['-m', 'x'], protocol: 'text', displayName: 'LLM' },
    { name: 'ghost', command: 'g', protocol: 'text', disabled: true },
  ]));

  const cursor = all.get('cursor') as AcpAdapter;
  const preset = ACP_PRESETS.find((p) => p.name === 'cursor')!;
  assert.ok(cursor instanceof AcpAdapter);
  assert.equal(cursor.command, 'agent');
  assert.deepEqual(cursor.preset.args, preset.args, 'unset fields keep the preset value');
  assert.equal(cursor.displayName, preset.displayName);

  const qoder = all.get('qoder') as AcpAdapter;
  assert.equal(qoder.command, 'qoder');
  assert.deepEqual(qoder.preset.args, ['--acp', '--x']);
  assert.equal(qoder.displayName, 'Qoder!');

  assert.equal(all.has('devin'), false);
  assert.equal(all.has('ghost'), false);

  const mine = all.get('my-acp') as AcpAdapter;
  assert.ok(mine instanceof AcpAdapter);
  assert.equal(mine.displayName, 'my-acp', 'displayName defaults to name');
  assert.deepEqual(mine.preset.modeIds, { plan: 'p' });
  assert.deepEqual(mine.preset.env, { K: 'v' });

  const text = all.get('my-text') as TextAdapter;
  assert.ok(text instanceof TextAdapter);
  assert.deepEqual(text.spec, { name: 'my-text', displayName: 'LLM', command: 'llm', args: ['-m', 'x'], env: undefined, promptVia: 'stdin' });
  assert.deepEqual(text.capabilities.modes, ['auto']);
  assert.equal(text.capabilities.sessionResume, false);
});

test('registry registers config agents alongside native adapters', (t) => {
  t.mock.method(log, 'warn', () => {});
  const registry = new AdapterRegistry([
    { name: 'my-text', command: 'llm', protocol: 'text' },
    { name: 'copilot', disabled: true },
  ]);
  const all = byName(registry.getAll());
  assert.ok(all.get('my-text') instanceof TextAdapter);
  assert.equal(all.has('copilot'), false);
  assert.ok(all.has('claude') && all.has('qwen'));
});

interface Capture { command?: string; args?: string[]; options?: SpawnOptions; stdin: string; killed: number }

/** Fake child: answers with `stdout`/`stderr`/`code` unless `hang`, in which case it only exits when killed. */
function fakeSpawn(opts: { stdout?: string; stderr?: string; code?: number; hang?: boolean }) {
  const capture: Capture = { stdin: '', killed: 0 };
  const spawn: TextSpawn = (command, args, options) => {
    Object.assign(capture, { command, args: [...args], options });
    const child = new EventEmitter() as unknown as ChildProcess;
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    stdin.setEncoding('utf8');
    stdin.on('data', (c: string) => { capture.stdin += c; });
    const exit = (code: number | null) => {
      stdout.end(); stderr.end();
      Object.assign(child, { exitCode: code ?? 1 });
      setImmediate(() => child.emit('close', code, null));
    };
    Object.assign(child, {
      stdin, stdout, stderr, killed: false, exitCode: null, pid: undefined,
      kill: () => { capture.killed++; Object.assign(child, { killed: true }); exit(null); return true; },
    });
    if (!opts.hang) {
      queueMicrotask(() => {
        if (opts.stdout) stdout.write(opts.stdout);
        if (opts.stderr) stderr.write(opts.stderr);
        exit(opts.code ?? 0);
      });
    }
    return child;
  };
  return { spawn, capture };
}

const spec = (over: Partial<TextAgentSpec> = {}): TextAgentSpec => ({
  name: 'my-text', displayName: 'My Text', command: 'llm', args: ['-q'], promptVia: 'stdin', ...over,
});

test('text: prompt on stdin, stdout ANSI-stripped, env and cwd passed', async () => {
  const fake = fakeSpawn({ stdout: '\x1b[32m  hello 世界 \x1b[0m\n' });
  const adapter = new TextAdapter(spec({ env: { FOO: 'bar' } }), fake.spawn);
  const r = await adapter.execute('say hi', { settings, extraArgs: ['--extra'] });
  assert.equal(fake.capture.command, 'llm');
  assert.deepEqual(fake.capture.args, ['-q', '--extra']);
  assert.equal(fake.capture.stdin, 'say hi');
  assert.equal(fake.capture.options?.cwd, '/fixture-work');
  assert.equal((fake.capture.options?.env as Record<string, string>).FOO, 'bar');
  assert.equal(r.text, 'hello 世界');
  assert.equal(r.error, undefined);
  assert.equal(r.sessionId, undefined);
});

test('text: promptVia arg substitutes {prompt} in argv verbatim, stdin unused', async () => {
  const fake = fakeSpawn({ stdout: 'ok' });
  const adapter = new TextAdapter(spec({ args: ['run', '--prompt={prompt}', '{prompt}'], promptVia: 'arg' }), fake.spawn);
  const tricky = 'a & b | "c" %PATH% ^d';
  const r = await adapter.execute(tricky, { settings });
  assert.deepEqual(fake.capture.args, ['run', `--prompt=${tricky}`, tricky]);
  assert.equal((fake.capture.options?.stdio as string[])[0], 'ignore');
  assert.equal(fake.capture.stdin, '');
  assert.equal(r.text, 'ok');

  const noPlaceholder = fakeSpawn({ stdout: 'ok' });
  await new TextAdapter(spec({ args: ['-p'], promptVia: 'arg' }), noPlaceholder.spawn).execute('q', { settings });
  assert.deepEqual(noPlaceholder.capture.args, ['-p', 'q'], 'prompt appended when no placeholder');
});

test('text: media is described in the prompt', async () => {
  const fake = fakeSpawn({ stdout: 'ok' });
  // No workDir → buildMediaPrompt only describes the file (no copy into the work dir).
  await new TextAdapter(spec(), fake.spawn).execute('look', {
    settings: { ...settings, workDir: '' }, media: [{ type: 'image', path: '/tmp/a.png', fileName: 'a.png' }],
  });
  assert.match(fake.capture.stdin, /look/);
  assert.match(fake.capture.stdin, /a\.png/);
});

test('text: non-zero exit is an error and surfaces stderr', async () => {
  const fake = fakeSpawn({ stdout: 'partial', stderr: '\x1b[31mboom\x1b[0m', code: 2 });
  const r = await new TextAdapter(spec(), fake.spawn).execute('q', { settings });
  assert.deepEqual([r.text, r.error], ['boom', true]);
  const silent = fakeSpawn({ code: 3 });
  const r2 = await new TextAdapter(spec(), silent.spawn).execute('q', { settings });
  assert.deepEqual([r2.text, r2.error], ['exit 3', true]);
});

test('text: timeout kills the process and reports it', async () => {
  const fake = fakeSpawn({ hang: true });
  const r = await new TextAdapter(spec(), fake.spawn).execute('q', { settings, timeout: 20 });
  assert.equal(fake.capture.killed, 1);
  assert.equal(r.error, true);
  assert.match(r.text, /超时/);
});

test('text: abort cancels a running process; pre-aborted never spawns', async () => {
  const fake = fakeSpawn({ hang: true });
  const ac = new AbortController();
  const pending = new TextAdapter(spec(), fake.spawn).execute('q', { settings, signal: ac.signal });
  setTimeout(() => ac.abort(), 10);
  const r = await pending;
  assert.equal(fake.capture.killed, 1);
  assert.deepEqual([r.text, r.error], ['已取消', true]);

  const never = fakeSpawn({ stdout: 'x' });
  const ac2 = new AbortController();
  ac2.abort();
  const r2 = await new TextAdapter(spec(), never.spawn).execute('q', { settings, signal: ac2.signal });
  assert.equal(never.capture.command, undefined);
  assert.equal(r2.text, '已取消');
});

test('text: spawn failure resolves with an error instead of throwing', async () => {
  const throwing: TextSpawn = () => { throw new Error('ENOENT'); };
  const r = await new TextAdapter(spec(), throwing).execute('q', { settings });
  assert.equal(r.error, true);
  assert.match(r.text, /无法启动 My Text: ENOENT/);
});
