import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Router } from '../src/bridge/router.js';
import { InboundTaskStore } from '../src/bridge/task-store.js';
import { ILinkClient } from '../src/ilink/client.js';
import { QuotaManager } from '../src/ilink/quota.js';
import type { PermissionRequest } from '../src/adapters/base.js';
import type { BridgeConfig } from '../src/config.js';
import type { Credentials, WeixinMessage } from '../src/ilink/types.js';
import type { OutboxItem } from '../src/ilink/outbox.js';

// WeChat tool approvals (C1): adapters call opts.requestPermission; the Router asks the
// user, waits for a numbered reply and maps it back to the agent's option id.

type Execute = (prompt: string, opts: any) => Promise<{ text: string; error?: boolean }>;

const FULL_OPTIONS: PermissionRequest['options'] = [
  { id: 'opt-once', name: 'Allow once', kind: 'allow_once' },
  { id: 'opt-always', name: 'Always allow', kind: 'allow_always' },
  { id: 'opt-reject', name: 'Reject', kind: 'reject_once' },
];

const CONFIG: BridgeConfig = {
  defaultTool: 'claude',
  maxResponseChunkSize: 2000,
  cliTimeout: 300_000,
  typingInterval: 5000,
  allowedUsers: [],
  allowAllUsers: true,
  workDir: process.cwd(),
  tools: {},
};

function message(uid = 'u1', id = 1): WeixinMessage {
  return {
    message_id: id,
    from_user_id: uid,
    to_user_id: 'bot',
    client_id: 'client',
    create_time_ms: Date.now(),
    message_type: 1,
    message_state: 0,
    context_token: 'ctx',
    item_list: [],
  };
}

/** Router over a fake iLink and a registry of fake adapters keyed by tool name. */
function createRouter(adapters: Record<string, Execute>) {
  const messages: Array<{ uid: string; text: string; options?: { priority?: string } }> = [];
  const calls: string[] = [];
  const ilink = {
    sendText: async (uid: string, text: string, options?: { priority?: string }) => { messages.push({ uid, text, options }); },
    startTyping: async () => () => {},
    recoverPending: async () => [],
    getDeliveryStatus: () => ({ quota: { generation: 1 }, pending: [], failed: [] }),
    onMessage: () => {},
  };
  const names = Object.keys(adapters);
  const displayName = (name: string) => name[0].toUpperCase() + name.slice(1);
  const registry = {
    isAvailable: (name: string) => names.includes(name),
    getNameByDisplayName: (display: string) => names.find((name) => displayName(name) === display),
    getAvailableNames: () => names,
    getAll: () => names.map((name) => ({ name, displayName: displayName(name) })),
    get: (name: string) => (adapters[name] ? {
      name,
      displayName: displayName(name),
      capabilities: { sessionResume: false },
      execute: (prompt: string, opts: any) => { calls.push(`${name}:${prompt.split('\n')[0]}`); return adapters[name](prompt, opts); },
    } : undefined),
  };
  const state = new Map<string, any>();
  const sessions = {
    get: (uid: string) => {
      if (!state.has(uid)) state.set(uid, { defaultTool: names[0], sessionIds: {}, msgMode: 'compact', mode: 'safe' });
      return state.get(uid);
    },
    update: (uid: string, partial: object) => Object.assign(sessions.get(uid), partial),
    setSession: () => {},
    clearSession: () => {},
  };
  const router = new Router(ilink as any, registry as any, sessions as any, CONFIG) as any;
  return {
    router,
    messages,
    calls,
    approvals: () => messages.filter((m) => /^\w+ 请求权限：/.test(m.text)),
    /** Deliver a user reply the way a fresh inbound would reach the Router. */
    reply: (text: string, uid = 'u1') => router.handle(message(uid), text, ''),
  };
}

async function waitFor(condition: () => boolean, label = 'condition'): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Adapter that asks for permission once per request and reports what it was told. */
function approvingAdapter(results: Array<string | null>, requests: PermissionRequest[] = [{ title: 'Run `npm test`', kind: 'execute', options: FULL_OPTIONS }]): Execute {
  return async (_prompt, opts) => {
    for (const req of requests) results.push(await opts.requestPermission(req));
    return { text: `results: ${results.join(',')}` };
  };
}

// "2" is a bridge-side session grant: the agent is told allow_once, never its persistent allow_always.
for (const [reply, expected] of [['1', 'opt-once'], ['2', 'opt-once'], ['3', 'opt-reject']] as const) {
  test(`reply ${reply} maps to option ${expected} and never reaches the agent as a prompt`, async () => {
    const results: Array<string | null> = [];
    const { router, messages, calls, approvals, reply: send } = createRouter({ claude: approvingAdapter(results) });

    const run = router.exec('u1', 'claude', 'do it');
    await waitFor(() => approvals().length === 1, 'approval prompt');
    const prompt = approvals()[0];
    assert.equal(prompt.text, 'Claude 请求权限：Run `npm test`\n1. 允许一次\n2. 本会话总是允许此类操作（execute）\n3. 拒绝\n— 回复数字；5 分钟无回复自动拒绝');
    assert.equal(prompt.options?.priority, 'control');

    await send(reply);
    await run;

    assert.deepEqual(results, [expected]);
    assert.deepEqual(calls, ['claude:do it']);
    assert.match(messages.at(-1)!.text, new RegExp(`results: ${expected}`));
    assert.equal(router.interactions.size, 0);
  });
}

test('choices follow the offered options: no allow_once hides 1, no allow option leaves only 3', async () => {
  const results: Array<string | null> = [];
  const { router, messages, approvals, reply } = createRouter({
    claude: approvingAdapter(results, [
      { title: 'Edit a.ts', kind: 'edit', options: FULL_OPTIONS.filter((o) => o.kind !== 'allow_once') },
      { title: 'Fetch url', kind: 'fetch', options: FULL_OPTIONS.filter((o) => o.kind === 'reject_once') },
    ]),
  });

  const run = router.exec('u1', 'claude', 'do it');
  await waitFor(() => approvals().length === 1);
  assert.match(approvals()[0].text, /请求权限：Edit a\.ts\n2\. 本会话总是允许此类操作（edit）\n3\. 拒绝\n/);
  await reply('1');
  assert.match(messages.at(-1)!.text, /^请回复 2\/3（Claude 请求权限：Edit a\.ts）\n再次无效将自动拒绝$/);
  assert.equal(messages.at(-1)!.options?.priority, 'control');
  await reply('2');
  await waitFor(() => approvals().length === 2);
  assert.match(approvals()[1].text, /请求权限：Fetch url\n3\. 拒绝\n/);
  await reply('3');
  await run;
  // Only allow_always was offered for the edit: it is the one allow id we can answer with.
  assert.deepEqual(results, ['opt-always', 'opt-reject']);
});

test('choosing 2 auto-approves later requests of the same kind for that tool until /new', async () => {
  const results: Array<string | null> = [];
  const requests: PermissionRequest[] = [{ title: 'Bash: npm test', options: FULL_OPTIONS }];
  const { router, approvals, reply } = createRouter({
    claude: async (_prompt, opts) => {
      for (const req of requests) results.push(await opts.requestPermission(req));
      return { text: 'ok' };
    },
    codex: async (_prompt, opts) => {
      results.push(await opts.requestPermission({ title: 'Bash: ls', options: FULL_OPTIONS }));
      return { text: 'ok' };
    },
  });

  let run = router.exec('u1', 'claude', 'first');
  await waitFor(() => approvals().length === 1);
  assert.match(approvals()[0].text, /2\. 本会话总是允许此类操作（Bash）/);
  await reply('2');
  await run;

  // Same tool + same rule key ("Bash" from the title) → answered without a WeChat message.
  requests.splice(0, 1, { title: 'Bash: rm -rf dist', options: FULL_OPTIONS }, { title: 'Write: a.ts', options: FULL_OPTIONS });
  run = router.exec('u1', 'claude', 'second');
  await waitFor(() => approvals().length === 2);
  assert.match(approvals()[1].text, /请求权限：Write: a\.ts/);
  await reply('1');
  await run;
  assert.deepEqual(results, ['opt-once', 'opt-once', 'opt-once']);
  assert.equal(approvals().length, 2);

  // The grant is per tool: codex still asks.
  run = router.exec('u1', 'codex', 'third');
  await waitFor(() => approvals().length === 3);
  await reply('3');
  await run;

  // /new ends the session: the Bash grant is gone.
  await router.handleSlash('u1', '/new');
  requests.splice(0, requests.length, { title: 'Bash: npm test', options: FULL_OPTIONS });
  run = router.exec('u1', 'claude', 'fourth');
  await waitFor(() => approvals().length === 4);
  await reply('3');
  await run;
  assert.deepEqual(results.slice(3), ['opt-reject', 'opt-reject']);
});

test('a grant answers same-kind requests already waiting in the queue', async () => {
  const results: Array<string | null> = [];
  const { router, approvals, reply } = createRouter({
    claude: async (_prompt, opts) => {
      results.push(...await Promise.all([
        opts.requestPermission({ title: 'a', kind: 'execute', options: FULL_OPTIONS }),
        opts.requestPermission({ title: 'b', kind: 'execute', options: FULL_OPTIONS }),
        opts.requestPermission({ title: 'c', kind: 'edit', options: FULL_OPTIONS }),
      ]));
      return { text: 'ok' };
    },
  });

  const run = router.exec('u1', 'claude', 'go');
  await waitFor(() => approvals().length === 1);
  await reply('2');
  await waitFor(() => approvals().length === 2);
  assert.match(approvals()[1].text, /请求权限：c/);
  await reply('1');
  await run;
  assert.deepEqual(results, ['opt-once', 'opt-once', 'opt-once']);
});

test('an invalid reply is re-prompted once, then the request is rejected', async () => {
  const results: Array<string | null> = [];
  const { router, messages, calls, reply } = createRouter({ claude: approvingAdapter(results) });

  const run = router.exec('u1', 'claude', 'do it');
  await waitFor(() => messages.length === 1);
  await reply('好的');
  assert.match(messages.at(-1)!.text, /^请回复 1\/2\/3/);
  await reply('随便吧');
  await run;

  assert.deepEqual(results, [null]);
  assert.ok(messages.some((m) => m.text === '未识别的回复，已拒绝：Run `npm test`'));
  // Neither reply was sent to the agent as a new prompt.
  assert.deepEqual(calls, ['claude:do it']);
  assert.equal(router.interactions.size, 0);
});

test('no reply within 5 minutes rejects, and a late bare digit gets a hint instead of a new agent run', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const results: Array<string | null> = [];
  const { router, messages, calls, approvals, reply } = createRouter({ claude: approvingAdapter(results) });

  const run = router.exec('u1', 'claude', 'do it');
  await waitFor(() => approvals().length === 1);
  t.mock.timers.tick(299_999);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(results, []);
  t.mock.timers.tick(1);
  await run;

  assert.deepEqual(results, [null]);
  assert.equal(router.interactions.size, 0);

  await reply('1');
  assert.match(messages.at(-1)!.text, /^没有正在等待回复的提问或审批：上一个已超时或已取消/);
  assert.deepEqual(calls, ['claude:do it']);
});

test('/cancel while an approval is pending rejects it and settles the task', async () => {
  const results: Array<string | null> = [];
  let adapterSignal: AbortSignal | undefined;
  const { router, messages, approvals } = createRouter({
    claude: async (_prompt, opts) => {
      adapterSignal = opts.signal;
      results.push(await opts.requestPermission({ title: 'rm -rf build', options: FULL_OPTIONS }));
      return { text: 'done' };
    },
  });

  const run = router.exec('u1', 'claude', 'do it');
  await waitFor(() => approvals().length === 1);
  await router.handleSlash('u1', '/cancel');
  await run;

  assert.equal(adapterSignal?.aborted, true);
  assert.deepEqual(results, [null]);
  assert.equal(router.interactions.size, 0);
  assert.equal(router.active.size, 0);
  assert.equal(messages.at(-1)!.text, '已取消 claude');
});

test('an adapter-scoped signal aborting also rejects the pending approval', async () => {
  const results: Array<string | null> = [];
  const local = new AbortController();
  const { router, approvals } = createRouter({
    claude: async (_prompt, opts) => {
      const pending = opts.requestPermission({ title: 'write file', options: FULL_OPTIONS }, local.signal);
      results.push(await pending);
      return { text: 'done' };
    },
  });

  const run = router.exec('u1', 'claude', 'do it');
  await waitFor(() => approvals().length === 1);
  local.abort();
  await run;
  assert.deepEqual(results, [null]);
  assert.equal(router.interactions.size, 0);
});

test('concurrent approvals queue per user: one prompt at a time, answered in order', async () => {
  const results: Record<string, string | null> = {};
  const { router, approvals, reply } = createRouter({
    claude: async (_prompt, opts) => {
      const [a, b] = await Promise.all([
        opts.requestPermission({ title: 'first', options: FULL_OPTIONS }),
        opts.requestPermission({ title: 'second', options: FULL_OPTIONS }),
      ]);
      results.first = a;
      results.second = b;
      return { text: 'claude done' };
    },
    codex: async (_prompt, opts) => {
      results.third = await opts.requestPermission({ title: 'third', options: FULL_OPTIONS });
      return { text: 'codex done' };
    },
  });

  const runs = [router.exec('u1', 'claude', 'a'), router.exec('u1', 'codex', 'b')];
  await waitFor(() => approvals().length === 1);
  // Give every request time to register: still only the head is on screen.
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(approvals().length, 1);
  assert.match(approvals()[0].text, /请求权限：first/);

  await reply('1');
  await waitFor(() => approvals().length === 2);
  assert.match(approvals()[1].text, /请求权限：second/);
  await reply('3');
  await waitFor(() => approvals().length === 3);
  assert.match(approvals()[2].text, /^Codex 请求权限：third/);
  await reply('2');
  await Promise.all(runs);

  assert.deepEqual(results, { first: 'opt-once', second: 'opt-reject', third: 'opt-once' });
  assert.equal(router.interactions.size, 0);
});

test('AskUser questions share the queue and still map numbers to labels', async () => {
  let answers: Record<string, string> | undefined;
  let permission: string | null | undefined;
  const { router, messages, reply } = createRouter({
    claude: async (_prompt, opts) => {
      const asked = opts.askUser({ questions: [{ question: 'Which DB?', options: [{ label: 'sqlite' }, { label: 'postgres' }] }] });
      const approved = opts.requestPermission({ title: 'install pg', options: FULL_OPTIONS });
      [answers, permission] = await Promise.all([asked, approved]);
      return { text: 'ok' };
    },
  });

  const run = router.exec('u1', 'claude', 'set up db');
  await waitFor(() => messages.length === 1);
  assert.match(messages[0].text, /^Claude 需要你的回答:\n\n❓ Which DB\?\n {2}1\. sqlite\n {2}2\. postgres\n— Claude \| 等待回复$/);
  assert.equal(messages[0].options?.priority, 'control');
  await reply('2');
  await waitFor(() => messages.length === 2);
  assert.match(messages[1].text, /请求权限：install pg/);
  await reply('1');
  await run;

  assert.deepEqual(answers, { 'Which DB?': 'postgres' });
  assert.equal(permission, 'opt-once');
});

test('an unanswered AskUser question throws on cancel instead of hanging', async () => {
  let failure = '';
  const { router, messages } = createRouter({
    claude: async (_prompt, opts) => {
      try {
        await opts.askUser({ questions: [{ question: 'Proceed?', options: [{ label: 'yes' }] }] });
      } catch (err) {
        failure = (err as Error).message;
      }
      return { text: 'ok' };
    },
  });

  const run = router.exec('u1', 'claude', 'go');
  await waitFor(() => messages.length === 1);
  await router.handleSlash('u1', '/cancel');
  await run;
  assert.equal(failure, '已取消');
});

test('shutdown settles every waiting approval so no adapter is left hanging', async () => {
  const results: Array<string | null> = [];
  const { router, approvals } = createRouter({ claude: approvingAdapter(results) });

  const run = router.exec('u1', 'claude', 'do it');
  await waitFor(() => approvals().length === 1);
  router.stop();
  await run;
  assert.deepEqual(results, [null]);
  assert.equal(router.interactions.size, 0);
});

test('a bare digit with nothing pending still reaches the agent when nothing expired', async () => {
  const { router, calls, reply } = createRouter({ claude: async () => ({ text: 'ok' }) });
  await reply('1');
  await router.whenIdle();
  assert.deepEqual(calls, ['claude:1']);
});

// ─── Real iLink client: quota windows and restart ───────────────────────────

const CREDS: Credentials = { botToken: 'token', baseUrl: 'https://example.test', ilinkBotId: 'account-a', ilinkUserId: 'bot-user' };
const UID = 'user-a';

function inbound(id: number, text: string): WeixinMessage {
  return {
    message_id: id,
    from_user_id: UID,
    to_user_id: 'bot-user',
    client_id: `inbound-${id}`,
    create_time_ms: 1_000 + id,
    message_type: 1,
    message_state: 0,
    context_token: 'ctx-1',
    item_list: [{ type: 1, text_item: { text } }],
  } as WeixinMessage;
}

function boot(dir: string, bootId: string, execute: Execute, maxItemsPerWindow = 10) {
  const client = new ILinkClient(CREDS, {
    outboxPath: join(dir, 'outbox.json'),
    quota: new QuotaManager(join(dir, 'quota.json'), 'account-a', { maxItemsPerWindow }),
    diagnosticsPath: join(dir, 'delivery-diagnostics.jsonl'),
    contextTokensPath: join(dir, 'context_tokens.json'),
    pollCursorPath: join(dir, 'poll_cursor.txt'),
    rateLimitBaseCooldownMs: 0,
    rateLimitMaxCooldownMs: 0,
  });
  const delivered: string[] = [];
  const anyClient = client as any;
  anyClient.sendRawTextMessage = async (_userId: string, _token: string, item: OutboxItem) => { delivered.push(item.text); };
  anyClient.startTyping = async () => () => {};
  const calls: string[] = [];
  const registry = {
    isAvailable: (name: string) => name === 'claude',
    getNameByDisplayName: () => undefined,
    getAvailableNames: () => ['claude'],
    getAll: () => [{ name: 'claude', displayName: 'Claude' }],
    get: (name: string) => (name === 'claude' ? {
      name: 'claude',
      displayName: 'Claude',
      capabilities: { sessionResume: false },
      execute: (prompt: string, opts: any) => { calls.push(prompt.split('\n')[0]); return execute(prompt, opts); },
    } : undefined),
  };
  const settings = { defaultTool: 'claude', sessionIds: {}, msgMode: 'compact', mode: 'safe' };
  const sessions = { get: () => settings, update: (_uid: string, p: object) => Object.assign(settings, p), setSession: () => {}, clearSession: () => {} };
  const store = new InboundTaskStore(join(dir, 'inbound-tasks.json'));
  const router = new Router(client, registry as any, sessions as any, { ...CONFIG, defaultTool: 'claude', workDir: dir }, { taskStore: store, bootId });
  router.start();
  return {
    router,
    store,
    client,
    delivered,
    calls,
    async poll(msgs: WeixinMessage[], cursor: string) {
      anyClient.getUpdates = async () => { anyClient.pendingPollCursor = cursor; return msgs; };
      await anyClient.pollOnce();
    },
    diagnostics(): Array<Record<string, unknown>> {
      return readFileSync(join(dir, 'delivery-diagnostics.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    },
  };
}

test('approval prompt goes out as control priority and the final answer gets the reply window', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wechat-approvals-'));
  const longAnswer = 'x'.repeat(100);
  // Two items per inbound window: the approval spends one of the first window; the answer
  // (sent after the user's reply opened a fresh window) is not cut short by it.
  const proc = boot(dir, 'boot-1', async (_prompt, opts) => {
    const choice = await opts.requestPermission({ title: 'Run `make`', options: FULL_OPTIONS });
    return { text: `${choice}:${longAnswer}` };
  }, 2);

  await proc.poll([inbound(1, 'build it')], 'cursor-1');
  await waitFor(() => proc.delivered.length === 1, 'approval delivered');
  assert.match(proc.delivered[0], /^Claude 请求权限：Run `make`/);

  await proc.poll([inbound(2, '1')], 'cursor-2');
  await proc.router.whenIdle();

  assert.deepEqual(proc.calls, ['build it']);
  assert.equal(proc.delivered.length, 2);
  assert.match(proc.delivered[1], new RegExp(`^opt-once:${longAnswer}\\n\\n— Claude`));
  assert.doesNotMatch(proc.delivered[1], /排队/);
  const tasks = proc.store.list();
  assert.deepEqual(tasks.map((task) => [task.messageId, task.phase, task.completion]), [
    ['1', 'completed', 'delivered'],
    ['2', 'completed', 'no-agent'],
  ]);
  const enqueued = proc.diagnostics().filter((event) => event.event === 'queue-enqueue');
  assert.deepEqual(enqueued.map((event) => event.priority), ['control', 'final']);
});

test('after a restart a bare digit meant for a lost approval gets a hint, not a new agent run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wechat-approvals-'));
  const snapshot = mkdtempSync(join(tmpdir(), 'wechat-approvals-snap-'));
  const first = boot(dir, 'boot-1', async (_prompt, opts) => {
    await opts.requestPermission({ title: 'Run `make`', options: FULL_OPTIONS });
    return { text: 'never delivered' };
  });
  await first.poll([inbound(1, 'build it')], 'cursor-1');
  await waitFor(() => first.delivered.length === 1, 'approval delivered');
  // SIGKILL while the approval waits: the next boot sees exactly this disk state.
  cpSync(dir, snapshot, { recursive: true });
  first.router.stop();
  await first.router.whenIdle();

  const second = boot(snapshot, 'boot-2', async () => ({ text: 'should not run' }));
  await second.poll([inbound(2, '1')], 'cursor-2');
  await second.router.whenIdle();

  assert.deepEqual(second.calls, []);
  assert.ok(second.delivered.some((text) => text.startsWith('⚠️ 桥接服务中断时 claude 仍在执行')));
  assert.match(second.delivered.at(-1)!, /^没有正在等待回复的提问或审批：桥接服务刚重启/);
  const byId = Object.fromEntries(second.store.list().map((task) => [task.messageId, task]));
  assert.equal(byId['1'].phase, 'recovery-required');
  assert.equal(byId['1'].recovery?.reason, 'agent-interrupted');
  assert.equal(byId['2'].completion, 'no-agent');
});

test('a prompt queued behind an exhausted window only starts its 5-minute clock once delivered', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wechat-approvals-'));
  const results: Array<string | null> = [];
  let client!: ILinkClient;
  const proc = boot(dir, 'boot-1', async (_prompt, opts) => {
    // Two items per window: earlier output already spent this one before the agent asks.
    await client.sendText(UID, 'progress 1', { priority: 'intermediate' });
    await client.sendText(UID, 'progress 2', { priority: 'intermediate' });
    results.push(await opts.requestPermission({ title: 'Run `make`', options: FULL_OPTIONS }));
    return { text: 'built' };
  }, 2);
  client = proc.client;
  t.mock.timers.enable({ apis: ['setTimeout'] });

  await proc.poll([inbound(1, 'build it')], 'cursor-1');
  await waitFor(() => client.getDeliveryStatus(UID).pending.length === 1, 'prompt queued');
  assert.equal(proc.delivered.length, 2);
  assert.equal(client.getDeliveryStatus(UID).pending[0].priority, 'control');

  // Ten minutes in the queue: the user never saw it, so it must not have been auto-rejected.
  for (let i = 0; i < 120; i++) t.mock.timers.tick(5_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(results, []);

  // 继续 opens a new window; the queued prompt goes out and only now is the clock armed.
  await proc.poll([inbound(2, '继续')], 'cursor-2');
  await waitFor(() => proc.delivered.length === 3, 'prompt delivered');
  assert.match(proc.delivered[2], /^Claude 请求权限：Run `make`/);
  t.mock.timers.tick(5_000); // the delivery check notices and arms the reply clock
  t.mock.timers.tick(294_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(results, [], 'still inside the 5 minutes counted from delivery');
  t.mock.timers.tick(6_000);
  await proc.router.whenIdle();

  assert.deepEqual(results, [null]);
  assert.deepEqual(proc.calls, ['build it']);
  assert.match(proc.delivered.at(-1)!, /^built\n\n— Claude/);
});

test('cancel still settles a prompt that is waiting in the outbox', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wechat-approvals-'));
  const results: Array<string | null> = [];
  let client!: ILinkClient;
  const proc = boot(dir, 'boot-1', async (_prompt, opts) => {
    await client.sendText(UID, 'progress 1', { priority: 'intermediate' });
    results.push(await opts.requestPermission({ title: 'Run `make`', options: FULL_OPTIONS }));
    return { text: 'built' };
  }, 1);
  client = proc.client;

  await proc.poll([inbound(1, 'build it')], 'cursor-1');
  await waitFor(() => client.getDeliveryStatus(UID).pending.length === 1, 'prompt queued');
  await proc.poll([inbound(2, '/cancel')], 'cursor-2');
  await proc.router.whenIdle();
  assert.deepEqual(results, [null]);
  assert.equal((proc.router as any).interactions.size, 0);
});

for (const mode of ['safe', 'auto'] as const) {
  test(`${mode} mode: streaming ${mode === 'safe' ? 'keeps the last window item for the prompt' : 'is unchanged'}`, async () => {
    const results: Array<string | null> = [];
    const { router, messages, approvals, reply } = createRouter({
      claude: async (_prompt, opts) => {
        opts.onIntermediate({ type: 'text', content: 'part one' });
        opts.onIntermediate({ type: 'tool_use', content: '- Bash: ls' });
        opts.onIntermediate({ type: 'text', content: 'part two' });
        opts.onIntermediate({ type: 'tool_use', content: '- Bash: rm' });
        for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
        if (mode === 'safe') results.push(await opts.requestPermission({ title: 'rm -rf dist', options: FULL_OPTIONS }));
        return { text: 'part one\n\npart two\n\ndone' };
      },
    });
    Object.assign(router.sessions.get('u1'), { mode, msgMode: 'verbose' });
    // A three-item window that shrinks with every message sent.
    router.ilink.getDeliveryStatus = () => ({ quota: { generation: 1, remainingItems: Math.max(0, 3 - messages.length) }, pending: [], failed: [] });

    const run = router.exec('u1', 'claude', 'clean up');
    if (mode === 'safe') {
      await waitFor(() => approvals().length === 1);
      await reply('1');
    }
    await run;

    if (mode === 'auto') {
      assert.deepEqual(messages.slice(0, 3).map((m) => m.text), ['part one', 'Activity\n- Bash: ls', 'part two']);
      return;
    }
    assert.deepEqual(results, ['opt-once']);
    // 'part two' would have spent the last item; it was held and the prompt got it instead.
    assert.deepEqual(messages.slice(0, 3).map((m) => m.text.split('\n')[0]), ['part one', 'Activity', 'Claude 请求权限：rm -rf dist']);
    assert.ok(!messages.some((m) => m.text === 'part two'));
    // Nothing is lost: the held-back text makes the final answer go out in full.
    assert.match(messages.at(-1)!.text, /part two\n\ndone/);
    assert.equal(messages.at(-1)!.options?.priority, 'final');
  });
}

test('nothing streams while a prompt is waiting for the user', async () => {
  const { router, messages, approvals, reply } = createRouter({
    claude: async (_prompt, opts) => {
      const pending = opts.requestPermission({ title: 'write a.ts', options: FULL_OPTIONS });
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
      opts.onIntermediate({ type: 'text', content: 'while waiting' });
      opts.onIntermediate({ type: 'tool_use', content: '- Read: a.ts' });
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
      await pending;
      return { text: 'while waiting\n\nok' };
    },
  });
  Object.assign(router.sessions.get('u1'), { msgMode: 'verbose' });
  const run = router.exec('u1', 'claude', 'go');
  await waitFor(() => approvals().length === 1);
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  await reply('1');
  await run;
  assert.ok(!messages.some((m) => m.text === 'while waiting'));
  assert.match(messages.at(-1)!.text, /^while waiting\n\nok/);
});
