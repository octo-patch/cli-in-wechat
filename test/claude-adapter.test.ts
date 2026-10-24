import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

import { DEFAULT_SETTINGS, type IntermediateMessage, type UserSettings } from '../src/adapters/base.js';
import { ClaudeAdapter, type ClaudeSpawn } from '../src/adapters/claude.js';

const SID = 'sess-1';

/** A scripted stand-in for `claude -p --input-format stream-json …`: records every JSON line
 *  written to stdin, lets the script emit stdout lines, and exits when stdin is closed. */
class FakeClaude {
  readonly child: ChildProcess;
  readonly written: any[] = [];
  stdinEnded = false;
  killedWith?: string;
  private readonly stdout = new PassThrough();
  private readonly stderr = new PassThrough();
  private waiters: Array<{ pred: (m: any) => boolean; resolve: (m: any) => void }> = [];
  private buf = '';
  private exited = false;

  constructor() {
    const child = new EventEmitter() as unknown as ChildProcess;
    const stdin = new PassThrough();
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        const msg = JSON.parse(line);
        this.written.push(msg);
        const i = this.waiters.findIndex((w) => w.pred(msg));
        if (i >= 0) this.waiters.splice(i, 1)[0].resolve(msg);
      }
    });
    // Like the real CLI: closing stdin after the result lets the process exit.
    stdin.on('end', () => { this.stdinEnded = true; this.exit(0); });
    Object.assign(child, {
      // No pid: on Windows killProc would shell out to `taskkill` for a fake pid and never exit.
      stdin, stdout: this.stdout, stderr: this.stderr, killed: false, exitCode: null, pid: undefined,
      kill: (sig: string) => { this.killedWith = sig; Object.assign(child, { killed: true }); this.exit(null, sig); return true; },
    });
    this.child = child;
  }

  /** Resolves with the next (or an already written) stdin message matching `pred`. */
  next(pred: (m: any) => boolean): Promise<any> {
    const seen = this.written.find(pred);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve) => this.waiters.push({ pred, resolve }));
  }
  userMessage(): Promise<any> { return this.next((m) => m.type === 'user'); }
  emit(...msgs: any[]): void { for (const m of msgs) this.stdout.write(JSON.stringify(m) + '\n'); }
  writeStderr(text: string): void { this.stderr.write(text); }
  exit(code: number | null, signal: string | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => {
      Object.assign(this.child, { exitCode: code });
      this.child.emit('close', code, signal);
    });
  }
}

function fakeSpawn(script: (p: FakeClaude) => void | Promise<void>) {
  const calls: Array<{ command: string; args: string[]; options: SpawnOptions; proc: FakeClaude }> = [];
  const spawn = ((command: string, args: string[], options: SpawnOptions) => {
    const proc = new FakeClaude();
    calls.push({ command, args: [...args], options, proc });
    queueMicrotask(() => { void script(proc); });
    return proc.child;
  }) as unknown as ClaudeSpawn;
  return { spawn, calls };
}

function settings(over: Partial<UserSettings> = {}): UserSettings {
  return { ...DEFAULT_SETTINGS, msgMode: 'normal', sessionIds: {}, ...over };
}

const init = { type: 'system', subtype: 'init', session_id: SID, model: 'm', permissionMode: 'default' };
const success = (result: string, extra: Record<string, unknown> = {}) => ({
  type: 'result', subtype: 'success', is_error: false, result, session_id: SID, total_cost_usd: 0.0123,
  usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 }, ...extra,
});
const assistant = (content: unknown[], parent: string | null = null) => ({
  type: 'assistant', parent_tool_use_id: parent, session_id: SID, message: { role: 'assistant', content },
});
const toolResults = (content: unknown[], parent: string | null = null) => ({
  type: 'user', parent_tool_use_id: parent, session_id: SID, message: { role: 'user', content },
});
const canUseTool = (requestId: string, toolName: string, input: Record<string, unknown>) => ({
  type: 'control_request', request_id: requestId,
  request: { subtype: 'can_use_tool', tool_name: toolName, input, tool_use_id: `tu_${requestId}`, permission_suggestions: [] },
});
const responseTo = (id: string) => (m: any) => m.type === 'control_response' && m.response?.request_id === id;

test('argv, stdin user message, JSONL parsing, tool_use_id pairing, subagent filtering, cost and usage', async () => {
  const fake = fakeSpawn(async (p) => {
    await p.userMessage();
    p.emit(
      init,
      { type: 'keep_alive' },
      assistant([
        { type: 'thinking', thinking: 'hmm' },
        { type: 'tool_use', id: 'tu_bash', name: 'Bash', input: { command: 'false' } },
        { type: 'tool_use', id: 'tu_agent', name: 'Agent', input: { subagent_type: 'Explore', description: 'look around' } },
      ]),
      // Subagent internals: neither the tool call nor its result may reach WeChat.
      assistant([{ type: 'tool_use', id: 'tu_sub', name: 'Read', input: { file_path: '/x/secret.txt' } }], 'tu_agent'),
      toolResults([{ type: 'tool_result', tool_use_id: 'tu_sub', content: 'secret' }], 'tu_agent'),
      { type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: 'tu_agent', description: 'look around', session_id: SID },
      { type: 'tool_progress', tool_use_id: 'tu_agent', tool_name: 'Agent', parent_tool_use_id: null, elapsed_time_seconds: 3, session_id: SID },
      { type: 'system', subtype: 'task_progress', task_id: 't1', description: 'x', usage: {}, session_id: SID },
      // Results arrive in the opposite order of the calls: pairing must follow tool_use_id.
      toolResults([{ type: 'tool_result', tool_use_id: 'tu_agent', content: 'Agent completed with no output' }]),
      toolResults([{ type: 'tool_result', tool_use_id: 'tu_bash', content: 'Exit code 1' }]),
      assistant([{ type: 'text', text: 'done' }]),
      success('final'),
    );
  });
  const activity: IntermediateMessage[] = [];
  const adapter = new ClaudeAdapter(fake.spawn);

  const result = await adapter.execute('hi', {
    settings: settings({
      mode: 'safe', effort: 'xhigh', model: 'opus', maxTurns: 7, maxBudget: 2,
      allowedTools: 'Read,Bash', disallowedTools: 'WebFetch', addDir: '/extra',
      systemPrompt: 'be brief', workDir: '/work', sessionIds: { claude: 'old-sess' },
    }),
    extraArgs: ['--fixture-extra'],
    onIntermediate: (m) => activity.push(m),
  });

  assert.equal(fake.calls.length, 1);
  const { command, args, options, proc } = fake.calls[0];
  assert.equal(command, 'claude');
  assert.deepEqual(args, [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--permission-prompt-tool', 'stdio',
    '--permission-mode', 'default',
    '--max-turns', '7',
    '--effort', 'xhigh',
    '--model', 'opus',
    '--max-budget-usd', '2',
    '--allowedTools', 'Read,Bash',
    '--disallowedTools', 'WebFetch',
    '--append-system-prompt', 'be brief',
    '--add-dir', '/extra',
    '--resume', 'old-sess',
    '--fixture-extra',
  ]);
  assert.equal(options.cwd, '/work');
  assert.deepEqual(proc.written[0], { type: 'control_request', request_id: 'wx_init_1', request: { subtype: 'initialize' } });
  assert.deepEqual(proc.written[1], {
    type: 'user', session_id: '', parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  });
  assert.equal(proc.stdinEnded, true, 'stdin is closed after the result so the CLI exits');

  assert.equal(result.text, 'final');
  assert.equal(result.thinking, 'hmm');
  assert.equal(result.sessionId, SID);
  assert.equal(result.cost, 0.0123);
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 3, cacheReadTokens: 100, cacheWriteTokens: 7 });
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

test('permission flags per mode', async () => {
  for (const [mode, flags] of [
    ['auto', ['--dangerously-skip-permissions']],
    ['safe', ['--permission-mode', 'default']],
    ['plan', ['--permission-mode', 'plan']],
  ] as const) {
    const fake = fakeSpawn(async (p) => { await p.userMessage(); p.emit(init, success('ok')); });
    await new ClaudeAdapter(fake.spawn).execute('x', { settings: settings({ mode, maxTurns: 0, effort: '' }) });
    assert.deepEqual(fake.calls[0].args.slice(8), flags, mode);
  }
});

test('can_use_tool: safe/plan deny with a reason, auto allows, AskUserQuestion round-trips via askUser', async () => {
  for (const mode of ['safe', 'plan', 'auto'] as const) {
    const responses: any[] = [];
    let asked: any;
    const fake = fakeSpawn(async (p) => {
      await p.userMessage();
      p.emit(init);
      p.emit(canUseTool('r1', 'Write', { file_path: '/a.txt', content: 'x' }));
      responses.push(await p.next(responseTo('r1')));
      p.emit(canUseTool('r2', 'ExitPlanMode', { plan: 'p' }));
      responses.push(await p.next(responseTo('r2')));
      p.emit(canUseTool('r3', 'AskUserQuestion', { questions: [{ question: 'Q?', options: [{ label: 'A' }] }] }));
      responses.push(await p.next(responseTo('r3')));
      p.emit(success('ok'));
    });
    const result = await new ClaudeAdapter(fake.spawn).execute('hi', {
      settings: settings({ mode }),
      askUser: async (req) => { asked = req; return { 'Q?': 'A' }; },
    });
    assert.equal(result.text, 'ok');

    const [write, exitPlan, question] = responses.map((r) => r.response);
    assert.equal(write.subtype, 'success');
    if (mode === 'auto') {
      assert.deepEqual(write.response, { behavior: 'allow', updatedInput: { file_path: '/a.txt', content: 'x' }, toolUseID: 'tu_r1' });
    } else {
      assert.equal(write.response.behavior, 'deny', mode);
      assert.equal(write.response.toolUseID, 'tu_r1');
      assert.ok(write.response.message.includes(mode) && write.response.message.includes('Write'), write.response.message);
      assert.equal(exitPlan.response.behavior, 'deny');
    }
    if (mode === 'safe') assert.match(write.response.message, /微信内审批将在后续版本支持；可用 \/mode auto/);
    if (mode === 'plan') assert.match(exitPlan.response.message, /完整计划/);
    assert.deepEqual(asked, { questions: [{ question: 'Q?', options: [{ label: 'A' }] }] });
    assert.deepEqual(responses[2], {
      type: 'control_response',
      response: {
        subtype: 'success', request_id: 'r3',
        response: {
          behavior: 'allow',
          updatedInput: { questions: [{ question: 'Q?', options: [{ label: 'A' }] }], answers: { 'Q?': 'A' } },
          toolUseID: 'tu_r3',
        },
      },
    });
    void question;
  }
});

test('safe mode asks requestPermission: allow once, always allow (suggestions), reject, throw, timeout', async () => {
  const suggestion = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' };
  const asks: any[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const answers: Array<() => Promise<string | null>> = [
    async () => 'allow_once',
    async () => 'allow_always',
    async () => 'reject_once',
    async () => null,
    async () => { throw new Error('boom'); },
    () => new Promise((_, reject) => setTimeout(() => reject(new Error('approval timed out')), 5)),
    async () => 'something_else',
  ];
  const ids = answers.map((_, i) => `p${i}`);
  const responses: any[] = [];
  const fake = fakeSpawn(async (p) => {
    await p.userMessage();
    p.emit(init);
    for (const id of ids) {
      const req = canUseTool(id, 'Bash', { command: 'npm test' });
      (req.request as any).permission_suggestions = [suggestion];
      p.emit(req);
      responses.push((await p.next(responseTo(id))).response.response);
    }
    p.emit(success('ok'));
  });
  let n = 0;
  const result = await new ClaudeAdapter(fake.spawn).execute('hi', {
    settings: settings({ mode: 'safe' }),
    requestPermission: (req, signal) => { asks.push(req); signals.push(signal); return answers[n++](); },
  });
  assert.equal(result.text, 'ok');
  assert.equal(asks.length, answers.length);
  assert.deepEqual(asks[0], {
    title: 'Shell Command: `npm test`',
    kind: 'execute',
    options: [
      { id: 'allow_once', name: '允许一次', kind: 'allow_once' },
      { id: 'allow_always', name: '总是允许', kind: 'allow_always' },
      { id: 'reject_once', name: '拒绝', kind: 'reject_once' },
    ],
  });
  assert.ok(signals.every((s) => s instanceof AbortSignal));
  assert.deepEqual(responses[0], { behavior: 'allow', updatedInput: { command: 'npm test' }, toolUseID: 'tu_p0' });
  assert.deepEqual(responses[1], {
    behavior: 'allow', updatedInput: { command: 'npm test' }, updatedPermissions: [suggestion], toolUseID: 'tu_p1',
  });
  for (const r of responses.slice(2)) {
    assert.deepEqual(r, { behavior: 'deny', message: '用户拒绝了 Bash', toolUseID: r.toolUseID });
  }
});

test('requestPermission: no "always" without suggestions, plan never asks, cancelled ask aborts its signal', async () => {
  // No permission_suggestions (or suppress_always_allow_rule) -> only allow once / reject.
  for (const extra of [{ permission_suggestions: [] }, { permission_suggestions: [{ type: 'addRules' }], suppress_always_allow_rule: true }]) {
    let asked: any;
    const fake = fakeSpawn(async (p) => {
      await p.userMessage();
      const req = canUseTool('r1', 'Write', { file_path: '/a/b.txt', content: 'x' });
      Object.assign(req.request, extra);
      p.emit(init, req);
      await p.next(responseTo('r1'));
      p.emit(success('ok'));
    });
    await new ClaudeAdapter(fake.spawn).execute('hi', {
      settings: settings({ mode: 'safe' }),
      requestPermission: async (req) => { asked = req; return 'allow_always'; },
    });
    assert.deepEqual(asked.options.map((o: any) => o.id), ['allow_once', 'reject_once']);
    assert.equal(asked.kind, 'edit');
    // "always" was not offered, so choosing it anyway is a rejection.
    assert.equal(fake.calls[0].proc.written.find(responseTo('r1')).response.response.behavior, 'deny');
  }

  // Plan mode keeps denying without asking.
  let planAsked = false;
  const plan = fakeSpawn(async (p) => {
    await p.userMessage();
    p.emit(init, canUseTool('r1', 'Write', { file_path: '/a.txt' }));
    await p.next(responseTo('r1'));
    p.emit(success('ok'));
  });
  await new ClaudeAdapter(plan.spawn).execute('hi', {
    settings: settings({ mode: 'plan' }),
    requestPermission: async () => { planAsked = true; return 'allow_once'; },
  });
  assert.equal(planAsked, false);
  assert.equal(plan.calls[0].proc.written.find(responseTo('r1')).response.response.behavior, 'deny');

  // The CLI cancelling the ask aborts the hook's signal and the late answer is dropped.
  let aborted = false;
  const cancel = fakeSpawn(async (p) => {
    await p.userMessage();
    p.emit(init, canUseTool('c1', 'Bash', { command: 'ls' }));
    setTimeout(() => { p.emit({ type: 'control_cancel_request', request_id: 'c1' }); setTimeout(() => p.emit(success('ok')), 10); }, 5);
  });
  await new ClaudeAdapter(cancel.spawn).execute('hi', {
    settings: settings({ mode: 'safe' }),
    requestPermission: (_req, signal) => new Promise((resolve) => {
      signal?.addEventListener('abort', () => { aborted = true; resolve('allow_once'); });
    }),
  });
  assert.equal(aborted, true);
  assert.equal(cancel.calls[0].proc.written.find(responseTo('c1')), undefined);
});

test('unsupported control requests get an error response; cancelled permission asks are not answered', async () => {
  let resolveAsk!: (v: Record<string, string>) => void;
  const fake = fakeSpawn(async (p) => {
    await p.userMessage();
    p.emit(init, { type: 'control_request', request_id: 'h1', request: { subtype: 'hook_callback', callback_id: 'x' } });
    await p.next(responseTo('h1'));
    p.emit(canUseTool('q1', 'AskUserQuestion', { questions: [] }), { type: 'control_cancel_request', request_id: 'q1' });
    setTimeout(() => { resolveAsk({}); setTimeout(() => p.emit(success('ok')), 5); }, 5);
  });
  await new ClaudeAdapter(fake.spawn).execute('hi', {
    settings: settings(),
    askUser: () => new Promise((resolve) => { resolveAsk = resolve; }),
  });
  const written = fake.calls[0].proc.written;
  assert.deepEqual(written.find(responseTo('h1')), {
    type: 'control_response', response: { subtype: 'error', request_id: 'h1', error: 'unsupported control request: hook_callback' },
  });
  assert.equal(written.find(responseTo('q1')), undefined);
});

test('images are sent natively as base64 blocks in the stdin user message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-adapter-'));
  try {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-body')]);
    const pngPath = join(dir, 'photo.dat');
    writeFileSync(pngPath, png);
    const bmpPath = join(dir, 'pic.bmp');
    writeFileSync(bmpPath, Buffer.from('BM-not-supported'));
    const docPath = join(dir, 'notes.txt');
    writeFileSync(docPath, 'hello');

    const fake = fakeSpawn(async (p) => { await p.userMessage(); p.emit(init, success('saw it')); });
    const result = await new ClaudeAdapter(fake.spawn).execute('what is this', {
      settings: settings(),
      media: [
        { type: 'image', path: pngPath, fileName: 'photo.dat' },
        { type: 'image', path: bmpPath, fileName: 'pic.bmp' },
        { type: 'file', path: docPath, fileName: 'notes.txt', size: 5 },
      ],
    });

    assert.equal(result.text, 'saw it');
    const users = fake.calls[0].proc.written.filter((m) => m.type === 'user');
    assert.equal(users.length, 1, 'exactly one user turn per execute');
    const content = users[0].message.content;
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

test('cancel sends an interrupt control request and keeps the early session id', async () => {
  const ac = new AbortController();
  const fake = fakeSpawn(async (p) => {
    await p.userMessage();
    p.emit(init);
    setTimeout(() => ac.abort(), 5);
    await p.next((m) => m.type === 'control_request' && m.request?.subtype === 'interrupt');
    p.emit({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: SID, total_cost_usd: 0.01, errors: [] });
  });
  const result = await new ClaudeAdapter(fake.spawn).execute('hi', { settings: settings(), signal: ac.signal });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].proc.killedWith, undefined, 'graceful interrupt, no kill');
  assert.deepEqual(result, { text: '已取消', sessionId: SID, cost: 0.01, duration: result.duration, error: true });
});

test('a CLI that ignores the interrupt is killed after the grace period', async () => {
  const ac = new AbortController();
  const fake = fakeSpawn(async (p) => { await p.userMessage(); p.emit(init); setTimeout(() => ac.abort(), 5); });
  const result = await new ClaudeAdapter(fake.spawn, 20).execute('hi', { settings: settings(), signal: ac.signal });
  assert.equal(fake.calls[0].proc.killedWith, 'SIGTERM');
  assert.equal(result.text, '已取消');
  assert.equal(result.sessionId, SID);
});

test('idle timeout interrupts a silent run; heartbeats keep it alive', async () => {
  const fake = fakeSpawn(async (p) => {
    await p.userMessage();
    p.emit(init);
    // Heartbeats every 10 ms for 60 ms outlast a 30 ms idle timeout.
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 10));
      p.emit({ type: 'tool_progress', tool_use_id: 't', tool_name: 'Bash', parent_tool_use_id: null, elapsed_time_seconds: i, session_id: SID });
    }
    assert.equal(p.written.some((m) => m.request?.subtype === 'interrupt'), false, 'no interrupt while heartbeats flow');
    await p.next((m) => m.request?.subtype === 'interrupt');
    p.exit(0);
  });
  const result = await new ClaudeAdapter(fake.spawn).execute('hi', { settings: settings(), timeout: 30 });
  assert.equal(result.error, true);
  assert.equal(result.sessionId, SID);
  assert.match(result.text, /执行超时/);
});

test('process exiting without a result is reported once, without re-running', async () => {
  const fake = fakeSpawn(async (p) => { await p.userMessage(); p.emit(init); p.writeStderr('boom: something broke'); p.exit(1); });
  const result = await new ClaudeAdapter(fake.spawn).execute('hi', { settings: settings() });
  assert.equal(fake.calls.length, 1);
  assert.equal(result.error, true);
  assert.equal(result.sessionId, SID);
  assert.match(result.text, /异常退出（code 1）：boom/);
  assert.equal(result.sessionExpired, false);
});

test('stale --resume id is flagged as expired', async () => {
  const fake = fakeSpawn(async (p) => { await p.userMessage(); p.writeStderr('No conversation found with session ID: old\n'); p.exit(1); });
  const result = await new ClaudeAdapter(fake.spawn).execute('hi', { settings: settings({ sessionIds: { claude: 'old' } }) });
  assert.equal(result.error, true);
  assert.equal(result.sessionExpired, true);
});

test('error results get readable text; spawn errors are reported', async () => {
  const fake = fakeSpawn(async (p) => {
    await p.userMessage();
    p.emit(init, { type: 'result', subtype: 'error_max_turns', is_error: true, session_id: SID, total_cost_usd: 0.2, errors: [] });
  });
  const result = await new ClaudeAdapter(fake.spawn).execute('hi', { settings: settings({ maxTurns: 3 }) });
  assert.equal(result.error, true);
  assert.equal(result.cost, 0.2);
  assert.match(result.text, /最大轮数（3）/);

  const enoent = ((() => {
    const child = new EventEmitter() as unknown as ChildProcess;
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    setImmediate(() => child.emit('error', new Error('spawn claude ENOENT')));
    return child;
  }) as unknown) as ClaudeSpawn;
  const failed = await new ClaudeAdapter(enoent).execute('hi', { settings: settings() });
  assert.deepEqual(failed, { text: '无法启动: spawn claude ENOENT', error: true });
});
