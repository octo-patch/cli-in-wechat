import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';

import { DEFAULT_SETTINGS, type IntermediateMessage, type ToolMode, type PermissionRequest } from '../src/adapters/base.js';
import { AcpAdapter, type AcpPreset } from '../src/adapters/acp/adapter.js';
import { ACP_PRESETS } from '../src/adapters/acp/presets.js';
import { AdapterRegistry } from '../src/adapters/registry.js';

const FAKE_AGENT = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));

interface Run {
  adapter: AcpAdapter;
  workDir: string;
  log: () => any[];
  spawned: { command?: string; args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv; child?: ChildProcess };
}

function setup(scenario: Record<string, unknown>, preset: Partial<AcpPreset> = {}): Run {
  const workDir = mkdtempSync(join(tmpdir(), 'acp-test-'));
  const logPath = join(workDir, 'agent-log.jsonl');
  const spawned: Run['spawned'] = {};
  const adapter = new AcpAdapter({
    name: 'fake', displayName: 'Fake ACP', command: process.execPath, args: [FAKE_AGENT],
    env: { FAKE_ACP_SCENARIO: JSON.stringify(scenario), FAKE_ACP_LOG: logPath },
    ...preset,
  }, (command, args, options) => {
    Object.assign(spawned, { command, args: [...args], cwd: options.cwd, env: options.env });
    // Plain spawn (no Windows cmd.exe fallback layer) keeps process lifetime deterministic.
    spawned.child = spawn(command, args, options);
    return spawned.child;
  });
  const log = () => existsSync(logPath)
    ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  // Windows may hold the dir briefly after the agent (whose cwd it was) exits.
  test.after(() => rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return { adapter, workDir, log, spawned };
}

function settings(workDir: string, extra: { mode?: ToolMode; sessionIds?: Record<string, string> } = {}) {
  return { ...DEFAULT_SETTINGS, workDir, mode: extra.mode ?? 'auto', sessionIds: extra.sessionIds ?? {} };
}

const isGone = (child?: ChildProcess) => !!child && (child.exitCode !== null || child.signalCode !== null);

const msg = (text: string, messageId?: string) => ({ update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, ...(messageId ? { messageId } : {}) } });
const thought = (text: string) => ({ update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } } });
const PERMISSION_OPTIONS = [
  { optionId: 'yes-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'yes-always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'no-once', name: 'Reject', kind: 'reject_once' },
];
const permissionStep = { permission: { toolCall: { toolCallId: 'call-1', title: 'Run `rm -rf build`', kind: 'execute' }, options: PERMISSION_OPTIONS } };

test('new session: handshake params, aggregated text/thinking, tool events, set_mode, sessionId', async () => {
  const run = setup({
    loadSession: true,
    modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }, { id: 'yolo', name: 'YOLO' }] },
    prompt: [
      { raw: 'Booting fake agent... (non-JSON noise on stdout)' },
      thought('Let me '), thought('look.'),
      msg('Checking ', 'm1'), msg('files.', 'm1'),
      { update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run  `ls\n -la`', kind: 'execute', status: 'pending' } },
      { update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' } },
      { update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed' } },
      { update: { sessionUpdate: 'tool_call_update', toolCallId: 't-unknown', status: 'completed' } },
      { update: { sessionUpdate: 'plan', entries: [] } },
      msg('Done: ', 'm2'), msg('二 files ok', 'm2'),
    ],
  }, { modeIds: { auto: 'yolo', safe: 'default', plan: 'plan' } });
  const events: IntermediateMessage[] = [];
  const result = await run.adapter.execute('hello', {
    settings: settings(run.workDir), extraArgs: ['--extra'], onIntermediate: (m) => events.push(m),
  });

  assert.equal(run.spawned.command, process.execPath);
  assert.deepEqual(run.spawned.args, [FAKE_AGENT, '--extra']);
  assert.equal(run.spawned.cwd, run.workDir);
  assert.ok(run.spawned.env?.PATH, 'process.env is inherited');

  assert.deepEqual(events, [
    { type: 'thinking', content: 'Let me look.' },
    { type: 'text', content: 'Checking files.' },
    { type: 'tool_use', content: '- Run `ls -la`', toolName: 'execute' },
    { type: 'tool_result', content: '  ↳ Error', toolName: 'execute' },
    { type: 'text', content: 'Done: 二 files ok' },
  ]);
  assert.equal(result.text, 'Checking files.\n\nDone: 二 files ok');
  assert.equal(result.thinking, 'Let me look.');
  assert.equal(result.sessionId, 'sess-new-1');
  assert.equal(result.error, undefined);
  assert.ok(isGone(run.spawned.child), 'agent process has exited before execute resolves');

  const sent = run.log();
  const init = sent.find((m) => m.method === 'initialize');
  assert.equal(init.params.protocolVersion, 1);
  assert.deepEqual(init.params.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
  assert.equal(init.params.clientInfo.name, 'cli-in-wechat');
  const created = sent.find((m) => m.method === 'session/new');
  assert.deepEqual(created.params, { cwd: run.workDir, mcpServers: [] });
  assert.deepEqual(sent.find((m) => m.method === 'session/set_mode').params, { sessionId: 'sess-new-1', modeId: 'yolo' });
  const promptReq = sent.find((m) => m.method === 'session/prompt');
  assert.deepEqual(promptReq.params, { sessionId: 'sess-new-1', prompt: [{ type: 'text', text: 'hello' }] });
});

test('compact mode (no onIntermediate) still returns aggregated result; no set_mode for unknown ids', async () => {
  const run = setup({ modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] }, prompt: [msg('a'), msg('b')] },
    { modeIds: { auto: 'yolo' } });
  const result = await run.adapter.execute('x', { settings: settings(run.workDir) });
  assert.equal(result.text, 'ab');
  assert.equal(result.sessionId, undefined, 'no loadSession → nothing to resume');
  assert.equal(run.log().some((m) => m.method === 'session/set_mode'), false);
});

test('session/load: replayed history (before and after the response) is not forwarded', async () => {
  const run = setup({
    loadSession: true,
    replay: [
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'OLD question' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD answer' } },
      { sessionUpdate: 'tool_call', toolCallId: 'old', title: 'OLD tool' },
    ],
    replayAfter: [{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'OLD thought' } }],
    prompt: [msg('NEW answer')],
  });
  const events: IntermediateMessage[] = [];
  const result = await run.adapter.execute('again', {
    settings: settings(run.workDir, { sessionIds: { fake: 'sess-old' } }), onIntermediate: (m) => events.push(m),
  });
  assert.deepEqual(events, [{ type: 'text', content: 'NEW answer' }]);
  assert.equal(result.text, 'NEW answer');
  assert.equal(result.thinking, undefined);
  assert.equal(result.sessionId, 'sess-old');
  const sent = run.log();
  assert.deepEqual(sent.find((m) => m.method === 'session/load').params, { sessionId: 'sess-old', cwd: run.workDir, mcpServers: [] });
  assert.equal(sent.some((m) => m.method === 'session/new'), false);
  assert.equal(sent.find((m) => m.method === 'session/prompt').params.sessionId, 'sess-old');
});

test('stored session but agent lacks loadSession → session/new', async () => {
  const run = setup({ loadSession: false, prompt: [msg('fresh')] });
  const result = await run.adapter.execute('q', { settings: settings(run.workDir, { sessionIds: { fake: 'sess-old' } }) });
  assert.equal(result.text, 'fresh');
  assert.equal(run.log().some((m) => m.method === 'session/load'), false);
  assert.ok(run.log().some((m) => m.method === 'session/new'));
});

test('session/load failure is reported as an expired session', async () => {
  const run = setup({ loadSession: true, loadError: { code: -32002, message: 'Session not found' } });
  const result = await run.adapter.execute('q', { settings: settings(run.workDir, { sessionIds: { fake: 'gone' } }) });
  assert.equal(result.error, true);
  assert.equal(result.sessionExpired, true);
  assert.match(result.text, /Session not found/);
  assert.equal(run.log().some((m) => m.method === 'session/prompt'), false);
});

function permissionAnswer(run: Run) {
  return run.log().find((m) => m.method === undefined && m.id !== undefined && m.result?.outcome)?.result.outcome;
}

test('permission: auto selects allow_once', async () => {
  const run = setup({ prompt: [permissionStep, msg('ran it')] });
  const result = await run.adapter.execute('q', { settings: settings(run.workDir, { mode: 'auto' }) });
  assert.deepEqual(permissionAnswer(run), { outcome: 'selected', optionId: 'yes-once' });
  assert.equal(result.text, 'ran it');
});

test('permission: auto falls back to allow_always when no allow_once option exists', async () => {
  const run = setup({ prompt: [{ permission: { toolCall: { toolCallId: 'c' }, options: PERMISSION_OPTIONS.slice(1) } }, msg('ok')] });
  await run.adapter.execute('q', { settings: settings(run.workDir, { mode: 'auto' }) });
  assert.deepEqual(permissionAnswer(run), { outcome: 'selected', optionId: 'yes-always' });
});

test('permission: plan rejects without a notice', async () => {
  const run = setup({ prompt: [permissionStep, msg('planned only')] });
  const result = await run.adapter.execute('q', { settings: settings(run.workDir, { mode: 'plan' }) });
  assert.deepEqual(permissionAnswer(run), { outcome: 'selected', optionId: 'no-once' });
  assert.equal(result.text, 'planned only');
});

test('permission: safe without a hook rejects and appends a notice (also streamed)', async () => {
  const run = setup({ prompt: [msg('trying'), permissionStep, msg(' skipped')] });
  const events: IntermediateMessage[] = [];
  const result = await run.adapter.execute('q', { settings: settings(run.workDir, { mode: 'safe' }), onIntermediate: (m) => events.push(m) });
  assert.deepEqual(permissionAnswer(run), { outcome: 'selected', optionId: 'no-once' });
  assert.match(result.text, /^trying skipped\n\n\[安全模式：已拒绝 1 次工具权限请求/);
  assert.match(events.at(-1)!.content, /安全模式/);
  assert.equal(events.at(-1)!.type, 'text');
});

test('permission: safe with requestPermission hook uses the chosen option', async () => {
  const run = setup({ prompt: [permissionStep, msg('approved')] });
  const seen: PermissionRequest[] = [];
  const result = await run.adapter.execute('q', {
    settings: settings(run.workDir, { mode: 'safe' }),
    requestPermission: async (req) => { seen.push(req); return 'yes-always'; },
  });
  assert.deepEqual(seen, [{
    title: 'Run `rm -rf build`', kind: 'execute',
    options: PERMISSION_OPTIONS.map((o) => ({ id: o.optionId, name: o.name, kind: o.kind })),
  }]);
  assert.deepEqual(permissionAnswer(run), { outcome: 'selected', optionId: 'yes-always' });
  assert.equal(result.text, 'approved');
});

test('permission: hook returning null rejects', async () => {
  const run = setup({ prompt: [permissionStep, msg('fine')] });
  await run.adapter.execute('q', { settings: settings(run.workDir, { mode: 'safe' }), requestPermission: async () => null });
  assert.deepEqual(permissionAnswer(run), { outcome: 'selected', optionId: 'no-once' });
});

test('permission: overlapping approvals keep the idle clock off until the last one is answered', async () => {
  const req = (id: string, title: string) => ({ toolCall: { toolCallId: id, title, kind: 'execute' }, options: PERMISSION_OPTIONS });
  const run = setup({ prompt: [{ permissions: [req('c1', 'Run `ls`'), req('c2', 'Run `rm x`')] }, msg('both answered')] });
  let n = 0;
  const result = await run.adapter.execute('q', {
    settings: settings(run.workDir, { mode: 'safe' }),
    timeout: 400,
    // The first answer comes quickly; the second only after well over `timeout` more. The first
    // one's cleanup used to re-arm the idle timer and kill the agent mid-approval.
    requestPermission: () => new Promise((resolve) => setTimeout(() => resolve('yes-once'), n++ === 0 ? 50 : 1_200)),
  });
  assert.equal(result.error, undefined, result.text);
  assert.equal(result.text, 'both answered');
});

const MODES = { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }, { id: 'yolo', name: 'YOLO' }] };
const MODE_IDS = { auto: 'yolo', safe: 'default', plan: 'plan' };

test('set_mode failure in plan rejects the round with a readable error instead of prompting', async () => {
  const run = setup({ modes: MODES, setModeError: { code: -32603, message: 'mode switch broke' }, prompt: [msg('should not run')] }, { modeIds: MODE_IDS });
  const result = await run.adapter.execute('q', { settings: settings(run.workDir, { mode: 'plan' }) });
  assert.equal(result.error, true);
  assert.match(result.text, /^Fake ACP 无法切换到 plan 模式（plan）：.*mode switch broke[\s\S]*为安全起见本轮未执行/);
  assert.equal(result.sessionId, 'sess-new-1');
  assert.equal(run.log().some((m) => m.method === 'session/prompt'), false, 'the prompt never ran');
});

test('set_mode failure in auto is only logged: the prompt still runs', async () => {
  const run = setup({ modes: MODES, setModeError: { code: -32603, message: 'mode switch broke' }, prompt: [msg('ran anyway')] }, { modeIds: MODE_IDS });
  const result = await run.adapter.execute('q', { settings: settings(run.workDir, { mode: 'auto' }) });
  assert.equal(result.text, 'ran anyway');
});

test('cancel: abort sends session/cancel; agent ends the turn with stopReason cancelled', async () => {
  const run = setup({ prompt: [msg('working'), { waitCancel: true }] });
  const ac = new AbortController();
  const events: IntermediateMessage[] = [];
  const pending = run.adapter.execute('q', {
    settings: settings(run.workDir), signal: ac.signal,
    onIntermediate: (m) => events.push(m),
  });
  setTimeout(() => ac.abort(), 300);
  const result = await pending;
  assert.deepEqual(result.text, '已取消');
  assert.equal(result.error, true);
  assert.deepEqual(run.log().find((m) => m.method === 'session/cancel').params, { sessionId: 'sess-new-1' });
});

test('cancel: an agent that ignores session/cancel is killed after the grace period', async () => {
  const run = setup({ prompt: [{ sleep: 30_000 }] });
  const ac = new AbortController();
  const started = Date.now();
  const pending = run.adapter.execute('q', { settings: settings(run.workDir), signal: ac.signal });
  setTimeout(() => ac.abort(), 300);
  const result = await pending;
  assert.equal(result.text, '已取消');
  assert.ok(Date.now() - started < 10_000);
  assert.ok(isGone(run.spawned.child));
});

test('finish: an agent that ignores stdin EOF is killed, and execute still returns promptly', async () => {
  const run = setup({ ignoreEof: true, prompt: [msg('bye')] });
  const started = Date.now();
  const result = await run.adapter.execute('q', { settings: settings(run.workDir) });
  assert.equal(result.text, 'bye');
  assert.ok(isGone(run.spawned.child), 'killed after the EOF grace period');
  assert.ok(Date.now() - started < 5_000);
});

test('cancel: already-aborted signal never spawns', async () => {
  const run = setup({});
  const ac = new AbortController();
  ac.abort();
  const result = await run.adapter.execute('q', { settings: settings(run.workDir), signal: ac.signal });
  assert.equal(result.text, '已取消');
  assert.equal(run.spawned.command, undefined);
});

test('image media becomes a base64 image block when the agent supports images; files go to the text', async () => {
  const run = setup({ image: true, prompt: [msg('seen')] });
  const img = join(run.workDir, 'pic.png');
  const doc = join(run.workDir, 'notes.txt');
  writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  writeFileSync(doc, 'hello');
  await run.adapter.execute('[图片: pic.png]', {
    settings: settings(run.workDir),
    media: [
      { type: 'image', path: img, fileName: 'pic.png', size: 7 },
      { type: 'file', path: doc, fileName: 'notes.txt', size: 5 },
    ],
  });
  const blocks = run.log().find((m) => m.method === 'session/prompt').params.prompt;
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, 'text');
  assert.match(blocks[0].text, /notes\.txt/);
  assert.doesNotMatch(blocks[0].text, /pic\.png\n/);
  assert.deepEqual(blocks[1], { type: 'image', mimeType: 'image/png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64') });
});

test('without image capability, images are described in the text prompt instead', async () => {
  const run = setup({ image: false, prompt: [msg('ok')] });
  const img = join(run.workDir, 'pic.jpg');
  writeFileSync(img, 'jpg');
  await run.adapter.execute('看看', { settings: settings(run.workDir), media: [{ type: 'image', path: img, fileName: 'pic.jpg', size: 3 }] });
  const blocks = run.log().find((m) => m.method === 'session/prompt').params.prompt;
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].text, /pic\.jpg/);
  assert.match(blocks[0].text, /用户说：看看/);
});

test('error: process exits mid-prompt → reports exit and stderr tail', async () => {
  const run = setup({ prompt: [msg('partial'), { stderr: 'fatal: model quota exceeded\n' }, { sleep: 50 }, { exit: 3 }] });
  const result = await run.adapter.execute('q', { settings: settings(run.workDir) });
  assert.equal(result.error, true);
  assert.match(result.text, /Fake ACP 进程意外退出 \(exit 3\)/);
  assert.match(result.text, /model quota exceeded/);
});

test('error: auth required on session/new → login hint', async () => {
  const run = setup({ newError: { code: -32000, message: 'Authentication required' } });
  const result = await run.adapter.execute('q', { settings: settings(run.workDir) });
  assert.equal(result.error, true);
  assert.match(result.text, /需要登录/);
  assert.match(result.text, /Authentication required/);
});

test('error: JSON-RPC error from session/prompt is surfaced', async () => {
  const run = setup({ prompt: [msg('x')], promptError: { code: -32603, message: 'model exploded' } });
  const result = await run.adapter.execute('q', { settings: settings(run.workDir) });
  assert.equal(result.error, true);
  assert.equal(result.text, 'Fake ACP 错误: model exploded');
});

test('error: incompatible protocol version', async () => {
  const run = setup({ protocolVersion: 2 });
  const result = await run.adapter.execute('q', { settings: settings(run.workDir) });
  assert.equal(result.error, true);
  assert.match(result.text, /不兼容的 ACP 协议版本 \(2\)/);
});

test('error: missing binary', async () => {
  const run = setup({}, { command: join(tmpdir(), 'definitely-not-a-real-acp-agent') });
  const result = await run.adapter.execute('q', { settings: settings(run.workDir) });
  assert.equal(result.error, true);
  assert.match(result.text, /无法启动 Fake ACP/);
});

test('idle timeout kills a silent agent and keeps partial text', async () => {
  const run = setup({ prompt: [msg('partial', 'm1'), { update: { sessionUpdate: 'tool_call', toolCallId: 'x', title: 'Think' } }, { sleep: 30_000 }] });
  const result = await run.adapter.execute('q', { settings: settings(run.workDir), timeout: 400 });
  assert.equal(result.error, true);
  assert.match(result.text, /^partial\n\n\[Fake ACP 1s 无输出，已超时终止\]$/);
});

test('refusal stop reason is an error; max_tokens adds a notice', async () => {
  const refused = setup({ prompt: [], stopReason: 'refusal' });
  const r1 = await refused.adapter.execute('q', { settings: settings(refused.workDir) });
  assert.equal(r1.error, true);
  assert.match(r1.text, /拒绝/);
  const truncated = setup({ prompt: [msg('half')], stopReason: 'max_tokens' });
  const r2 = await truncated.adapter.execute('q', { settings: settings(truncated.workDir) });
  assert.equal(r2.error, undefined);
  assert.match(r2.text, /^half\n\n\[已达到 max_tokens 上限/);
});

test('presets: unique short names, ACP launch args present, registered in the registry', () => {
  const names = ACP_PRESETS.map((p) => p.name);
  assert.deepEqual(names, ['qwen', 'copilot', 'cursor', 'codebuddy', 'droid', 'devin', 'qoder', 'minimax']);
  assert.equal(new Set(ACP_PRESETS.map((p) => p.displayName)).size, names.length);
  for (const p of ACP_PRESETS) assert.ok(p.args.some((a) => /acp/.test(a)), `${p.name} launches in ACP mode`);
  const registry = new AdapterRegistry();
  const all = new Map(registry.getAll().map((a) => [a.name, a]));
  for (const name of names) {
    assert.ok(all.get(name) instanceof AcpAdapter, `${name} registered`);
  }
  assert.ok(all.has('claude') && all.has('opencode'), 'existing adapters untouched');
});
